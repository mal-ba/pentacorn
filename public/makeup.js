// ====== makeup.js : 메인 페이지의 독립된 "메이크업" 구역 전용 스크립트 (module script, Three.js) ======
// 체형 스캔(마네킹)과는 완전히 별개의 흐름이에요.
// STEP 1: 얼굴 사진을 찍거나 올려요 → STEP 2: 그 사진을 3D 얼굴 모델(makeup-face.glb)에
// 입혀서 보여주고, 메이크업 소품(makeup-props.js)이나 업로드된 메이크업 아이템으로 꾸며요.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAKEUP_PROP_DEFS, recolorProp, createAngledPatch, FACE_PATCH_ANGLES, FACE_PATCH_Y, HAIR_BAND_ANGLES, HAIR_BAND_Y } from '/makeup-props.js';
import { SEG_CATEGORY, analyzePhotoBySegments, sampleAverageColorFromPhoto } from '/segment-utils.js';

/* ==========================================================================
   STEP 1 : 얼굴 스캔 — 정면 → 왼쪽 옆모습 → 오른쪽 옆모습 → 뒷모습, 4단계로 찍어요.
   정면·좌·우 사진은 얼굴에, 4장 전부는 머리카락(옆·뒤통수까지)에 쓰여요.
   ========================================================================== */
const SCAN_STAGES = [
  { key: 'front', label: '정면', instruction: '정면을 카메라로 봐주세요. 이 사진으로 얼굴이랑 앞머리를 만들어요.', required: true },
  { key: 'left', label: '왼쪽 옆모습', instruction: '고개를 오른쪽으로 돌려서, 얼굴 왼쪽이 보이게 찍어주세요.', required: false },
  { key: 'right', label: '오른쪽 옆모습', instruction: '고개를 왼쪽으로 돌려서, 얼굴 오른쪽이 보이게 찍어주세요.', required: false },
  { key: 'back', label: '뒷모습', instruction: '뒤돌아서 뒤통수가 보이게 찍어주세요 (다른 사람이 찍어줘도 좋아요).', required: false },
];

const scanStepEl = document.getElementById('makeup-scan-step');
const threeDStepEl = document.getElementById('makeup-3d-step');
const scanVideo = document.getElementById('makeup-scan-video');
const scanCanvas = document.getElementById('makeup-scan-canvas');
const scanStartBtn = document.getElementById('makeup-scan-start-btn');
const scanCaptureBtn = document.getElementById('makeup-scan-capture-btn');
const scanFileInput = document.getElementById('makeup-scan-file-input');
const scanPhotoSlot = document.getElementById('makeup-scan-photo-slot');
const scanNextBtn = document.getElementById('makeup-scan-next-btn');
const scanSkipBtn = document.getElementById('makeup-scan-skip-btn');
const scanConfirmBtn = document.getElementById('makeup-scan-confirm-btn');
const scanStageCounter = document.getElementById('makeup-scan-stage-counter');
const scanStageInstruction = document.getElementById('makeup-scan-stage-instruction');
const scanStageDots = document.getElementById('makeup-scan-stage-dots');
const rescanBtn = document.getElementById('makeup-rescan-btn');

let scanStream = null;
let currentStageIndex = 0;
const capturedPhotos = {}; // { front: dataUrl, left: dataUrl, right: dataUrl, back: dataUrl }
const stageStatus = {}; // { front: 'done'|'skipped', ... }

function stopScanStream(){
  if(scanStream){
    scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
  }
}

function currentStage(){ return SCAN_STAGES[currentStageIndex]; }

function renderStageDots(){
  scanStageDots.querySelectorAll('.stage-dot').forEach(dot => {
    const key = dot.dataset.stage;
    dot.classList.toggle('stage-done', stageStatus[key] === 'done');
    dot.classList.toggle('stage-skipped', stageStatus[key] === 'skipped');
    dot.classList.toggle('stage-current', key === currentStage().key);
  });
}

function renderStageUI(){
  const stage = currentStage();
  scanStageCounter.textContent = `${currentStageIndex + 1}/${SCAN_STAGES.length}`;
  scanStageInstruction.textContent = stage.instruction;
  scanSkipBtn.hidden = stage.required;

  // 이 단계 사진이 이미 있으면 미리보기를 보여주고, 없으면 빈 상태로.
  if(capturedPhotos[stage.key]){
    scanPhotoSlot.innerHTML = '';
    const img = document.createElement('img');
    img.src = capturedPhotos[stage.key];
    scanPhotoSlot.appendChild(img);
    scanNextBtn.disabled = false;
  } else {
    scanPhotoSlot.innerHTML = '<span class="scan-photo-placeholder">촬영하거나 업로드한 사진이 여기에 표시돼요</span>';
    scanNextBtn.disabled = true;
  }

  scanStartBtn.hidden = false;
  scanStartBtn.textContent = capturedPhotos[stage.key] ? '다시 촬영' : '카메라 켜기';
  scanCaptureBtn.hidden = true;
  scanNextBtn.textContent = currentStageIndex === SCAN_STAGES.length - 1 ? '완료' : '다음 각도로 →';

  const doneCount = Object.keys(stageStatus).length;
  scanConfirmBtn.disabled = !(stageStatus.front === 'done'); // 정면만 있으면 바로 만들 수 있게 해요.
  renderStageDots();
}

function savePhotoForCurrentStage(dataUrl){
  const stage = currentStage();
  capturedPhotos[stage.key] = dataUrl;
  stageStatus[stage.key] = 'done';
  renderStageUI();
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
  savePhotoForCurrentStage(scanCanvas.toDataURL('image/jpeg', 0.92));
  stopScanStream();
});

scanFileInput.addEventListener('change', () => {
  const file = scanFileInput.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => savePhotoForCurrentStage(reader.result);
  reader.readAsDataURL(file);
  scanFileInput.value = '';
});

function goToNextStage(){
  stopScanStream();
  if(currentStageIndex < SCAN_STAGES.length - 1){
    currentStageIndex++;
    renderStageUI();
  }
}

scanNextBtn.addEventListener('click', goToNextStage);
scanSkipBtn.addEventListener('click', () => {
  const stage = currentStage();
  if(!capturedPhotos[stage.key]) stageStatus[stage.key] = 'skipped';
  goToNextStage();
});

scanStageDots.querySelectorAll('.stage-dot').forEach((dot, i) => {
  dot.addEventListener('click', () => {
    stopScanStream();
    currentStageIndex = i;
    renderStageUI();
  });
});

scanConfirmBtn.addEventListener('click', () => {
  if(!capturedPhotos.front) return;
  stopScanStream();
  scanStepEl.hidden = true;
  threeDStepEl.hidden = false;
  threeDStepEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  startOrUpdateViewer();
  // 찍은 사진들을 AI로 분석해서, 각도에 맞게 얼굴/머리카락을 입혀줘요.
  applyAllPhotosAI({ ...capturedPhotos });
});

rescanBtn.addEventListener('click', () => {
  threeDStepEl.hidden = true;
  scanStepEl.hidden = false;
  currentStageIndex = 0;
  renderStageUI();
  scanStepEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

renderStageUI();

// ---------- 머리카락·얼굴 AI 인식 (공용 segment-utils.js 사용) ----------
// 혹시 이 모델을 못 불러오면(네트워크 문제 등) 자동으로 예전 방식(사진 위쪽 색 평균)으로 대체해요.
function analyzePhotoSegments(dataUrl){
  return analyzePhotoBySegments(dataUrl, {
    hairCutout: [SEG_CATEGORY.HAIR],
    faceCutout: [SEG_CATEGORY.BODY_SKIN, SEG_CATEGORY.FACE_SKIN], // 얼굴 패치에는 얼굴 피부 + 목/몸 피부까지 살짝 포함해서, 턱선에서 뚝 끊기지 않게 해요.
  });
}
const sampleHairColorFromPhoto = dataUrl => sampleAverageColorFromPhoto(dataUrl, 0.22);

let pendingPhotosApply = null; // 얼굴 모델이 아직 안 불러와졌을 때, 분석 결과를 잠시 담아둬요.
let activeFacePatches = []; // 정면/좌/우 얼굴 패치들
let activeHairBandPatches = []; // 정면/좌/우/뒤 머리카락 밴드 패치들

// STEP 2 진입 시 자동으로 호출돼요: 찍은 사진들(최대 4장)을 각각 AI로 분석해서,
// 각도에 맞는 얼굴 패치·머리카락 밴드를 만들어요.
async function applyAllPhotosAI(photos){
  if(statusEl) statusEl.textContent = '사진에서 얼굴과 머리카락을 인식하는 중이에요... (사진이 많으면 조금 걸려요)';

  const faceCutouts = {}; // { front: canvas, left: canvas, right: canvas }
  const hairCutouts = {}; // { front: canvas, left: canvas, right: canvas, back: canvas }
  let anyFaceFound = false;

  for(const stage of SCAN_STAGES){
    const dataUrl = photos[stage.key];
    if(!dataUrl) continue;
    try{
      const segments = await analyzePhotoSegments(dataUrl);
      if(segments.faceCutout){ faceCutouts[stage.key] = segments.faceCutout; anyFaceFound = true; }
      if(segments.hairCutout) hairCutouts[stage.key] = segments.hairCutout;
    } catch(err){
      console.error(`${stage.label} 사진 AI 인식 실패:`, err);
    }
  }

  applyPhotosToScene({ faceCutouts, hairCutouts, frontDataUrl: photos.front });

  if(anyFaceFound){
    if(statusEl) statusEl.textContent = '사진 속 얼굴·머리카락을 3D에 입혔어요! 각도별로 잘 안 맞으면 소품처럼 슬라이더로 미세조정할 수 있어요.';
  } else if(statusEl){
    statusEl.textContent = '얼굴 인식에는 실패했어요. 조명이 밝은 정면 사진으로 다시 시도해보세요.';
  }
}

// 얼굴 모델이 아직 없으면 대기했다가, 준비되면 실제로 씬에 붙여요.
function applyPhotosToScene(payload){
  if(!faceModel){
    pendingPhotosApply = payload;
    return;
  }
  const { faceCutouts, hairCutouts, frontDataUrl } = payload;

  // 기존에 붙어있던 패치들은 지우고 새로 붙여요 (다시 스캔했을 때 중복 방지).
  activeFacePatches.forEach(p => faceModel.remove(p));
  activeHairBandPatches.forEach(p => faceModel.remove(p));
  activeFacePatches = [];
  activeHairBandPatches = [];

  FACE_PATCH_ANGLES.forEach(angle => {
    const cutout = faceCutouts[angle.key];
    if(!cutout) return;
    const patch = createAngledPatch({
      cutoutCanvas: cutout,
      thetaCenter: angle.thetaCenter,
      thetaWidth: angle.thetaWidth,
      yTop: FACE_PATCH_Y.yTop,
      yBottom: FACE_PATCH_Y.yBottom,
      radius: FACE_PATCH_Y.radius,
    });
    if(patch){ faceModel.add(patch); activeFacePatches.push(patch); }
  });

  HAIR_BAND_ANGLES.forEach(angle => {
    const cutout = hairCutouts[angle.key];
    if(!cutout) return;
    const patch = createAngledPatch({
      cutoutCanvas: cutout,
      thetaCenter: angle.thetaCenter,
      thetaWidth: angle.thetaWidth,
      yTop: HAIR_BAND_Y.yTop,
      yBottom: HAIR_BAND_Y.yBottom,
      radius: HAIR_BAND_Y.radius,
    });
    if(patch){ faceModel.add(patch); activeHairBandPatches.push(patch); }
  });

  // 정수리 캡(작은 단색 돔)은 정면 사진에서 뽑은 머리색으로 자동으로 씌워줘요.
  if(frontDataUrl){
    sampleHairColorFromPhoto(frontDataUrl).then(hex => {
      if(hex) applyHairCrown(hex);
    });
  }
}

// 정수리 캡을 특정 색으로 추가/교체해요.
function applyHairCrown(hex){
  const card = document.getElementById('makeup-prop-card-hair');
  if(!card) return;
  const colorInput = card.querySelector('.makeup-prop-color');
  colorInput.value = hex;
  if(activeProps['hair']){
    faceModel.remove(activeProps['hair'].object3d);
    delete activeProps['hair'];
  }
  toggleProp('hair');
}

/* ==========================================================================
   STEP 2 : 3D 얼굴 뷰어 — 사진 속 얼굴/머리카락을 AI로 오려서 앞면에 입혀요.
   ========================================================================== */
const loadingEl = document.getElementById('landing-makeup-loading');
const hintEl = document.getElementById('landing-makeup-hint');

let scene, camera, renderer, controls;
let faceModel = null;
let faceDefaultHeight = 0;
let viewerStarted = false;

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

      if(pendingPhotosApply){
        applyPhotosToScene(pendingPhotosApply);
        pendingPhotosApply = null;
      }
      renderMakeupPropsPanel();
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
  // 정수리 캡(머리카락)은 이제 사진으로 오려낸 밴드 패치들이 옆/뒤를 덮어주기 때문에,
  // 작은 단색 캡만 만들면 돼요 (색은 정면 사진에서 자동으로 뽑혀서 colorInput에 이미 들어있어요).
  const object3d = def.create(colorInput.value);
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
