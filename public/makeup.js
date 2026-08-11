// ====== makeup.js : 메인 페이지의 독립된 "메이크업" 구역 전용 스크립트 (module script, Three.js) ======
// 체형 스캔(마네킹)과는 완전히 별개의 흐름이에요.
// STEP 1: 얼굴 사진을 찍거나 올려요 → STEP 2: 그 사진을 3D 얼굴 모델(makeup-face.glb)에
// 입혀서 보여주고, 메이크업 소품(makeup-props.js)이나 업로드된 메이크업 아이템으로 꾸며요.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAKEUP_PROP_DEFS, recolorProp, createFacePatch } from '/makeup-props.js';

/* ==========================================================================
   STEP 1 : 얼굴 스캔 (카메라 촬영 / 파일 업로드)
   ========================================================================== */
const scanStepEl = document.getElementById('makeup-scan-step');
const threeDStepEl = document.getElementById('makeup-3d-step');
const scanVideo = document.getElementById('makeup-scan-video');
const scanCanvas = document.getElementById('makeup-scan-canvas');
const scanStartBtn = document.getElementById('makeup-scan-start-btn');
const scanCaptureBtn = document.getElementById('makeup-scan-capture-btn');
const scanFileInput = document.getElementById('makeup-scan-file-input');
const scanPhotoSlot = document.getElementById('makeup-scan-photo-slot');
const scanConfirmBtn = document.getElementById('makeup-scan-confirm-btn');
const rescanBtn = document.getElementById('makeup-rescan-btn');

let scanStream = null;
let capturedDataUrl = null;

function showScanPhoto(dataUrl){
  capturedDataUrl = dataUrl;
  scanPhotoSlot.innerHTML = '';
  const img = document.createElement('img');
  img.src = dataUrl;
  scanPhotoSlot.appendChild(img);
  scanConfirmBtn.disabled = false;
}

function stopScanStream(){
  if(scanStream){
    scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
  }
}

scanStartBtn.addEventListener('click', async () => {
  try{
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    scanVideo.srcObject = scanStream;
    scanStartBtn.hidden = true;
    scanCaptureBtn.hidden = false;
  } catch(err){
    alert('카메라를 켤 수 없어요. 파일 업로드를 이용해주세요.');
  }
});

scanCaptureBtn.addEventListener('click', () => {
  scanCanvas.width = scanVideo.videoWidth;
  scanCanvas.height = scanVideo.videoHeight;
  scanCanvas.getContext('2d').drawImage(scanVideo, 0, 0);
  showScanPhoto(scanCanvas.toDataURL('image/jpeg', 0.92));
  stopScanStream();
  scanCaptureBtn.hidden = true;
  scanStartBtn.hidden = false;
  scanStartBtn.textContent = '다시 촬영';
});

scanFileInput.addEventListener('change', () => {
  const file = scanFileInput.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => showScanPhoto(reader.result);
  reader.readAsDataURL(file);
});

scanConfirmBtn.addEventListener('click', () => {
  if(!capturedDataUrl) return;
  stopScanStream();
  scanStepEl.hidden = true;
  threeDStepEl.hidden = false;
  threeDStepEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  startOrUpdateViewer();
  // 사진에서 머리카락만 실제로 인식해서(AI 모델), 그 모양·색 그대로 3D 머리카락에 입혀줘요.
  applyHairFromPhotoAI(capturedDataUrl);
});

// ---------- 머리카락 AI 인식 (MediaPipe Image Segmenter, 브라우저 안에서 바로 실행) ----------
// 사람 사진을 배경/머리카락/피부/옷 등으로 나눠주는 구글의 공개 모델을 그대로 브라우저에서 돌려요.
// 서버로 사진을 보내지 않고, 사용자 기기 안에서 전부 처리돼요. 혹시 이 모델을 못 불러오면
// (네트워크 문제 등) 자동으로 예전 방식(사진 위쪽 색 평균)으로 대체해요.
const HAIR_CATEGORY_INDEX = 1; // selfie_multiclass 모델의 카테고리 순서: 0=배경,1=머리카락,2=몸피부,3=얼굴피부,4=옷,5=기타
const FACE_CATEGORY_INDEXES = [2, 3]; // 얼굴 패치에는 얼굴 피부 + 목/몸 피부까지 살짝 포함해서, 턱선에서 뚝 끊기지 않게 해요.
let imageSegmenterPromise = null;

function getImageSegmenter(){
  if(!imageSegmenterPromise){
    imageSegmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest');
      const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm');
      return await ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
          delegate: 'CPU', // iOS Safari에서 GPU 딜리게이트를 쓰면 카테고리 순서가 뒤섞이는 알려진 버그가 있어서, 안정적인 CPU로 고정해요.
        },
        outputCategoryMask: true,
        outputConfidenceMasks: false,
        runningMode: 'IMAGE',
      });
    })();
  }
  return imageSegmenterPromise;
}

// 픽셀 좌표 하나가 주어진 카테고리 목록에 속하는지 잘라내서 캔버스로 만드는 공용 함수예요.
// srcCanvas/imgDataOriginal은 이미 만들어둔 걸 재사용해서, 얼굴/머리카락을 한 번의 분석으로 같이 뽑아요.
function cropByCategories(srcCanvas, originalImgData, maskData, maskW, maskH, categorySet){
  const w0 = srcCanvas.width, h0 = srcCanvas.height;
  const imgData = new ImageData(new Uint8ClampedArray(originalImgData.data), w0, h0); // 원본을 복사해서 이 카테고리 전용으로 잘라내요.
  const px = imgData.data;
  const scaleX = maskW / w0, scaleY = maskH / h0;
  let minX = w0, minY = h0, maxX = 0, maxY = 0, found = false;

  for(let y = 0; y < h0; y++){
    const my = Math.min(maskH - 1, Math.floor(y * scaleY));
    for(let x = 0; x < w0; x++){
      const mx = Math.min(maskW - 1, Math.floor(x * scaleX));
      const category = maskData[my * maskW + mx];
      const idx = (y * w0 + x) * 4;
      if(categorySet.has(category)){
        found = true;
        if(x < minX) minX = x;
        if(x > maxX) maxX = x;
        if(y < minY) minY = y;
        if(y > maxY) maxY = y;
      } else {
        px[idx + 3] = 0;
      }
    }
  }
  if(!found) return null;

  const cutCanvas = document.createElement('canvas');
  cutCanvas.width = w0;
  cutCanvas.height = h0;
  cutCanvas.getContext('2d').putImageData(imgData, 0, 0);

  const w = maxX - minX + 1, h = maxY - minY + 1;
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = w;
  cropCanvas.height = h;
  cropCanvas.getContext('2d').drawImage(cutCanvas, minX, minY, w, h, 0, 0, w, h);
  return cropCanvas;
}

// 사진 한 장을 AI로 한 번만 분석해서, 머리카락 오려낸 것과 얼굴 피부 오려낸 것을 같이 돌려줘요.
async function analyzePhotoSegments(dataUrl){
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = dataUrl;
  });

  const segmenter = await getImageSegmenter();
  const result = segmenter.segment(img);
  const mask = result.categoryMask;
  if(!mask) return { hairCutout: null, faceCutout: null };
  const maskData = mask.getAsUint8Array();
  const maskW = mask.width, maskH = mask.height;

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = img.naturalWidth;
  srcCanvas.height = img.naturalHeight;
  const ctx = srcCanvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const originalImgData = ctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);

  const hairCutout = cropByCategories(srcCanvas, originalImgData, maskData, maskW, maskH, new Set([HAIR_CATEGORY_INDEX]));
  const faceCutout = cropByCategories(srcCanvas, originalImgData, maskData, maskW, maskH, new Set(FACE_CATEGORY_INDEXES));

  if(mask.close) mask.close(); // MPMask는 다 쓰고 나면 메모리를 명시적으로 해제해줘요.
  return { hairCutout, faceCutout };
}



// 사진 위쪽(머리카락이 있을 확률이 높은 영역) 픽셀 색을 평균 내서, 대략적인 머리카락 색을 추정해요.
// AI 인식이 실패했을 때만 쓰는 대체(fallback) 방식이에요.
function sampleHairColorFromPhoto(dataUrl){
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try{
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const sampleHeight = Math.max(1, Math.floor(img.height * 0.22));
        const { data } = ctx.getImageData(0, 0, img.width, sampleHeight);
        let r = 0, g = 0, b = 0, count = 0;
        for(let i = 0; i < data.length; i += 4 * 6){
          r += data[i]; g += data[i + 1]; b += data[i + 2];
          count++;
        }
        if(count === 0){ resolve(null); return; }
        r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
        const toHex = v => v.toString(16).padStart(2, '0');
        resolve(`#${toHex(r)}${toHex(g)}${toHex(b)}`);
      } catch(err){
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

let lastHairCutoutCanvas = null;
let pendingHairApply = null;
let pendingFaceApply = null;

// STEP 2 진입 시 자동으로 호출돼요: 사진 한 장을 AI로 분석해서 머리카락과 얼굴을 각각 입혀요.
async function applyHairFromPhotoAI(dataUrl){
  if(statusEl) statusEl.textContent = '사진에서 얼굴과 머리카락을 인식하는 중이에요...';
  let hairCutout = null, faceCutout = null;
  try{
    const segments = await analyzePhotoSegments(dataUrl);
    hairCutout = segments.hairCutout;
    faceCutout = segments.faceCutout;
  } catch(err){
    console.error('AI 인식 실패, 대체 방식으로 진행합니다:', err);
  }

  // 얼굴: 인식된 얼굴 피부 부분을 얼굴 앞면 곡면에 그대로 입혀요 (모델 자체 UV는 안 건드려요).
  if(faceCutout){
    applyFaceToScene(faceCutout);
    if(statusEl) statusEl.textContent = '사진 속 얼굴을 3D 얼굴 앞면에 입혔어요!';
  } else if(statusEl){
    statusEl.textContent = '얼굴 인식에는 실패했어요. 조명이 밝은 정면 사진으로 다시 시도해보세요.';
  }

  // 머리카락: 인식되면 그 모양·색 그대로, 실패하면 색 평균 방식으로 대체해요.
  if(hairCutout){
    applyHairToScene({ cutoutCanvas: hairCutout });
  } else {
    const hex = await sampleHairColorFromPhoto(dataUrl);
    if(hex) applyHairToScene({ color: hex });
  }
}

// 얼굴 패치를 얼굴 모델 앞면에 붙여요 (아직 얼굴 모델이 안 불러와졌으면 대기했다가 나중에 적용).
function applyFaceToScene(cutoutCanvas){
  if(!faceModel){
    pendingFaceApply = cutoutCanvas;
    return;
  }
  if(activeFacePatch){
    faceModel.remove(activeFacePatch);
    activeFacePatch = null;
  }
  const patch = createFacePatch(cutoutCanvas);
  if(patch){
    faceModel.add(patch);
    activeFacePatch = patch;
  }
}

// 머리카락을 얼굴 모델에 실제로 붙여요 (아직 얼굴 모델이 안 불러와졌으면 대기했다가 나중에 적용).
function applyHairToScene({ cutoutCanvas, color }){
  const card = document.getElementById('makeup-prop-card-hair');
  if(!card){
    pendingHairApply = { cutoutCanvas, color };
    return;
  }
  if(cutoutCanvas) lastHairCutoutCanvas = cutoutCanvas;
  const colorInput = card.querySelector('.makeup-prop-color');
  if(color) colorInput.value = color;
  if(activeProps['hair']){
    faceModel.remove(activeProps['hair'].object3d);
    delete activeProps['hair'];
  }
  toggleProp('hair'); // toggleProp이 lastHairCutoutCanvas를 참고해서 새로 만들어줘요.
}

rescanBtn.addEventListener('click', () => {
  threeDStepEl.hidden = true;
  scanStepEl.hidden = false;
  scanStepEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ==========================================================================
   STEP 2 : 3D 얼굴 뷰어 — 사진 속 얼굴/머리카락을 AI로 오려서 앞면에 입혀요.
   ========================================================================== */
const loadingEl = document.getElementById('landing-makeup-loading');
const hintEl = document.getElementById('landing-makeup-hint');

let scene, camera, renderer, controls;
let faceModel = null;
let faceDefaultHeight = 0;
let viewerStarted = false;
let activeFacePatch = null;

function initViewer(){
  const container = document.getElementById('landing-makeup-3d');
  if(!container){
    if(loadingEl) loadingEl.textContent = '3D 뷰어를 불러올 수 없어요.';
    return;
  }
  const width = container.clientWidth || 300;
  const height = container.clientHeight || 420;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
  camera.position.set(0, 0, 2.2);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 1.3));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
  dirLight.position.set(2, 4, 3);
  scene.add(dirLight);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 0.3;
  controls.maxDistance = 10;
  controls.target.set(0, 0, 0);

  const loader = new GLTFLoader();
  loader.load(
    '/models/makeup-face.glb',
    gltf => {
      faceModel = gltf.scene;
      scene.add(faceModel);

      const box0 = new THREE.Box3().setFromObject(faceModel);
      faceDefaultHeight = box0.max.y - box0.min.y;
      const center = box0.getCenter(new THREE.Vector3());
      faceModel.position.sub(center);

      if(loadingEl) loadingEl.hidden = true;
      if(hintEl) hintEl.hidden = false;

      if(pendingFaceApply){
        applyFaceToScene(pendingFaceApply);
        pendingFaceApply = null;
      }
      renderMakeupPropsPanel();
      if(pendingHairApply){
        applyHairToScene(pendingHairApply);
        pendingHairApply = null;
      }
    },
    undefined,
    err => {
      console.error('메이크업 얼굴 모델 로드 실패:', err);
      if(loadingEl) loadingEl.textContent = '3D 얼굴 모델을 아직 못 찾았어요. /models/makeup-face.glb 파일을 올려주세요.';
    }
  );

  (function renderLoop(){
    requestAnimationFrame(renderLoop);
    if(controls) controls.update();
    if(renderer && scene && camera) renderer.render(scene, camera);
  })();

  window.addEventListener('resize', () => {
    const w = container.clientWidth, h = container.clientHeight;
    if(!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
}

function startOrUpdateViewer(){
  if(!viewerStarted){
    viewerStarted = true;
    initViewer();
    loadMakeupWardrobe();
  }
  // 얼굴/머리카락 반영은 applyHairFromPhotoAI()가 별도로 처리해요 (AI 인식 결과를 기다려야 해서).
}

/* ==========================================================================
   메이크업 소품(코드로 만든 오브젝트)으로 꾸미기 — makeup-props.js
   ========================================================================== */
const propsGridEl = document.getElementById('makeup-props-grid');
const activeProps = {}; // { propId: { object3d } }

function propCardHTML(def){
  return `
    <div class="makeup-prop-card" id="makeup-prop-card-${def.id}">
      <div class="makeup-prop-card-head">
        <span class="makeup-prop-card-label">${def.label}</span>
        <input type="color" class="makeup-prop-color" data-prop-id="${def.id}" value="${def.defaultColor}">
      </div>
      <button type="button" class="btn btn-ghost-dark makeup-prop-toggle-btn" data-prop-id="${def.id}">추가하기</button>
      <div class="makeup-prop-fine-tune" data-prop-id="${def.id}" hidden>
        <label>좌우 <input type="range" class="prop-x" data-prop-id="${def.id}" min="-0.25" max="0.25" step="0.005" value="0"></label>
        <label>위아래 <input type="range" class="prop-y" data-prop-id="${def.id}" min="-0.25" max="0.25" step="0.005" value="0"></label>
        <label>앞뒤 <input type="range" class="prop-z" data-prop-id="${def.id}" min="-0.15" max="0.15" step="0.005" value="0"></label>
        <label>크기 <input type="range" class="prop-scale" data-prop-id="${def.id}" min="0.3" max="2.5" step="0.01" value="1"></label>
      </div>
    </div>`;
}

function renderMakeupPropsPanel(){
  if(!propsGridEl) return;
  propsGridEl.innerHTML = MAKEUP_PROP_DEFS.map(propCardHTML).join('');

  propsGridEl.querySelectorAll('.makeup-prop-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleProp(btn.dataset.propId));
  });
  propsGridEl.querySelectorAll('.makeup-prop-color').forEach(input => {
    input.addEventListener('input', () => {
      const active = activeProps[input.dataset.propId];
      if(active) recolorProp(active.object3d, input.value);
    });
  });
  propsGridEl.querySelectorAll('.prop-x, .prop-y, .prop-z, .prop-scale').forEach(input => {
    input.addEventListener('input', () => updatePropTransform(input.dataset.propId));
  });
}

function updatePropTransform(propId){
  const active = activeProps[propId];
  if(!active) return;
  const def = MAKEUP_PROP_DEFS.find(d => d.id === propId);
  const card = document.getElementById(`makeup-prop-card-${propId}`);
  const dx = parseFloat(card.querySelector('.prop-x').value);
  const dy = parseFloat(card.querySelector('.prop-y').value);
  const dz = parseFloat(card.querySelector('.prop-z').value);
  const s = parseFloat(card.querySelector('.prop-scale').value);
  active.object3d.position.set(def.position[0] + dx, def.position[1] + dy, def.position[2] + dz);
  active.object3d.scale.set(s, s, s);
}

function toggleProp(propId){
  const def = MAKEUP_PROP_DEFS.find(d => d.id === propId);
  const card = document.getElementById(`makeup-prop-card-${propId}`);
  const toggleBtn = card.querySelector('.makeup-prop-toggle-btn');
  const fineTune = card.querySelector('.makeup-prop-fine-tune');
  const colorInput = card.querySelector('.makeup-prop-color');

  if(activeProps[propId]){
    // 이미 추가돼 있으면 빼요.
    faceModel.remove(activeProps[propId].object3d);
    delete activeProps[propId];
    toggleBtn.textContent = '추가하기';
    fineTune.hidden = true;
    return;
  }
  if(!faceModel){
    alert('얼굴 모델을 아직 불러오는 중이에요. 잠시만 기다려주세요.');
    return;
  }
  // 머리카락은 사진에서 인식해서 오려낸 실제 이미지(lastHairCutoutCanvas)가 있으면 그걸 써요.
  const object3d = propId === 'hair'
    ? def.create(colorInput.value, lastHairCutoutCanvas)
    : def.create(colorInput.value);
  object3d.position.set(def.position[0], def.position[1], def.position[2]);
  faceModel.add(object3d);
  activeProps[propId] = { object3d };
  toggleBtn.textContent = '빼기';
  fineTune.hidden = false;
}

/* ==========================================================================
   업로드된 메이크업 아이템(.glb) 입혀보기 — 소품과는 별개로, 옷장에 올라온 아이템이에요.
   ========================================================================== */
let currentItem = null;
const fitControls = document.getElementById('landing-makeup-fit-controls');
const statusEl = document.getElementById('landing-makeup-status');
const xInput = document.getElementById('landing-makeup-x');
const yInput = document.getElementById('landing-makeup-y');
const zInput = document.getElementById('landing-makeup-z');
const scaleInput = document.getElementById('landing-makeup-scale');
const colorInput = document.getElementById('landing-makeup-color');
const colorResetBtn = document.getElementById('landing-makeup-color-reset-btn');
const removeBtn = document.getElementById('landing-makeup-remove-btn');

function updateItemTransform(){
  if(!currentItem) return;
  currentItem.position.set(parseFloat(xInput.value), parseFloat(yInput.value), parseFloat(zInput.value));
  const s = parseFloat(scaleInput.value);
  currentItem.scale.set(s, s, s);
}

function applyItemColor(hexColor){
  if(!currentItem) return;
  currentItem.traverse(node => {
    if(node.isMesh && node.material){
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach(mat => {
        if(mat.color){
          mat.color.set(hexColor);
          mat.needsUpdate = true;
        }
      });
    }
  });
}

function wearItemFromUrl(url, label){
  if(!faceModel){
    statusEl.textContent = '먼저 얼굴 모델이 다 불러와질 때까지 잠시 기다려주세요.';
    return;
  }
  statusEl.textContent = `${label || '메이크업'}을(를) 불러오는 중...`;
  const loader = new GLTFLoader();
  loader.load(
    url,
    gltf => {
      if(currentItem) faceModel.remove(currentItem);
      currentItem = gltf.scene;
      currentItem.scale.set(1, 1, 1);
      currentItem.position.set(0, 0, 0);
      faceModel.add(currentItem);

      const itemBox = new THREE.Box3().setFromObject(currentItem);
      const itemHeight = itemBox.max.y - itemBox.min.y;
      let autoScale = 1;
      if(itemHeight > 0 && faceDefaultHeight > 0){
        autoScale = faceDefaultHeight / itemHeight;
        autoScale = Math.min(Math.max(autoScale, 0.02), 5);
      }

      xInput.value = 0;
      yInput.value = 0;
      zInput.value = 0;
      scaleInput.value = autoScale.toFixed(2);
      colorInput.value = '#ffffff';
      updateItemTransform();
      fitControls.hidden = false;
      statusEl.textContent = `${label || '메이크업'}을(를) 적용했어요! 크기·위치·색상을 슬라이더로 맞춰보세요.`;
      fitControls.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
    undefined,
    () => {
      statusEl.textContent = '메이크업 파일을 불러오지 못했어요. .glb 파일이 맞는지 확인해주세요.';
    }
  );
}

if(xInput && yInput && zInput && scaleInput){
  [xInput, yInput, zInput, scaleInput].forEach(el => el.addEventListener('input', updateItemTransform));
}
if(colorInput){
  colorInput.addEventListener('input', () => applyItemColor(colorInput.value));
}
if(colorResetBtn){
  colorResetBtn.addEventListener('click', () => {
    colorInput.value = '#ffffff';
    applyItemColor('#ffffff');
  });
}
if(removeBtn){
  removeBtn.addEventListener('click', () => {
    if(currentItem){
      faceModel.remove(currentItem);
      currentItem = null;
    }
    fitControls.hidden = true;
    statusEl.textContent = '';
  });
}

const resultsEl = document.getElementById('landing-makeup-results');

function cardHTML(item){
  const thumb = item.thumbnailUrl
    ? `<img src="${item.thumbnailUrl}" alt="${item.name}">`
    : `<span>메이크업</span>`;
  const wearable = !!item.glbUrl;
  const officialBadge = item.isOfficial ? `<span class="wardrobe-official-badge">공식</span>` : '';
  return `
    <div class="wardrobe-card">
      <div class="wardrobe-card-thumb">${thumb}${officialBadge}</div>
      <div class="wardrobe-card-name">${item.name}</div>
      <div class="wardrobe-card-meta">메이크업${item.color ? ' · ' + item.color : ''}</div>
      <button type="button" data-item-id="${item.id}" ${wearable ? '' : 'disabled'}>
        ${wearable ? '입혀보기' : '3D 모델 준비 중'}
      </button>
    </div>`;
}

function wireWearButtons(items){
  resultsEl.querySelectorAll('button[data-item-id]').forEach(btn => {
    const item = items.find(it => it.id === btn.dataset.itemId);
    if(!item || !item.glbUrl) return;
    btn.addEventListener('click', () => wearItemFromUrl(item.glbUrl, item.name));
  });
}

let wardrobeLoaded = false;
async function loadMakeupWardrobe(){
  wardrobeLoaded = true;
  resultsEl.innerHTML = '<p class="wardrobe-hint">불러오는 중...</p>';
  try{
    const res = await fetch('/api/wardrobe?category=makeup');
    const data = await res.json();
    if(!data.items || data.items.length === 0){
      resultsEl.innerHTML = '<p class="wardrobe-hint">아직 등록된 메이크업 아이템이 없어요. 3D 디자인 팝업의 "내 아이템 올리기"에서 첫 메이크업을 올려보세요.</p>';
      return;
    }
    resultsEl.innerHTML = data.items.map(it => cardHTML(it)).join('');
    wireWearButtons(data.items);
  } catch(err){
    resultsEl.innerHTML = '<p class="wardrobe-hint">메이크업 아이템을 불러오지 못했어요.</p>';
  }
}

// 3D 디자인 팝업에서 새 메이크업 아이템을 올렸을 때, 이 구역의 목록도 새로고침할 수 있게 열어둬요.
window.refreshMakeupWardrobe = function(){
  wardrobeLoaded = false;
  if(viewerStarted) loadMakeupWardrobe();
};
