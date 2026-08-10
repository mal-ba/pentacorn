// ====== customize-3d.js : 3D/2D 꾸미기 팝업 전용 스크립트 (module script, Three.js) ======
  import * as THREE from 'three';
  import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

  const scanAvatarLoading = document.getElementById('scan-avatar-loading');
  const scanAvatarHint = document.getElementById('scan-avatar-hint');
  const scanNicknameInput = document.getElementById('scan-nickname-input');
  const scanNameplate = document.getElementById('scan-nameplate');

  /* ---------- 3D 마네킹 뷰어 (Three.js) ---------- */
  let scanScene, scanCamera, scanRenderer, scanControls;
  let scanMannequin = null;
  let scanMannequinDefaultHeight = 0; // 원본(스케일 1) 상태의 모델 높이(scene 단위)
  let scanMannequinDefaultMinY = 0; // 원본(스케일 1) 상태에서 발끝의 y좌표 (옷을 입혀도 이 값은 안 바뀌어요)
  let scanMannequinWidthRatio = 1; // 모델 너비(팔 벌린 폭) / 키 비율

  function initMannequinViewer(){
    const container = document.getElementById('scan-avatar-3d');
    if(!container){
      if(scanAvatarLoading) scanAvatarLoading.textContent = '3D 뷰어를 불러올 수 없어요.';
      return;
    }
    const width = container.clientWidth || 300;
    const height = container.clientHeight || 320;

    scanScene = new THREE.Scene();
    scanCamera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    scanCamera.position.set(0, 1.3, 3.4);

    scanRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    scanRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    scanRenderer.setSize(width, height);
    container.appendChild(scanRenderer.domElement);

    scanScene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 1.3));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
    dirLight.position.set(2, 4, 3);
    scanScene.add(dirLight);

    scanControls = new OrbitControls(scanCamera, scanRenderer.domElement);
    scanControls.enableDamping = true;
    scanControls.enablePan = false;
    scanControls.minDistance = 1.2;
    scanControls.maxDistance = 14;
    scanControls.target.set(0, 1, 0);

    const loader = new GLTFLoader();
    loader.load(
      '/models/mannequin.glb?v=4',
      gltf => {
        scanMannequin = gltf.scene;
        scanScene.add(scanMannequin);

        const box0 = new THREE.Box3().setFromObject(scanMannequin);
        scanMannequinDefaultHeight = box0.max.y - box0.min.y;
        scanMannequinDefaultMinY = box0.min.y;
        const defaultWidth = Math.max(box0.max.x - box0.min.x, box0.max.z - box0.min.z);
        scanMannequinWidthRatio = defaultWidth / scanMannequinDefaultHeight;

        applyHeightToMannequin(165);
        if(scanAvatarLoading) scanAvatarLoading.hidden = true;
        if(scanAvatarHint) scanAvatarHint.hidden = false;
      },
      undefined,
      err => {
        console.error('마네킹 로드 실패:', err);
        if(scanAvatarLoading) scanAvatarLoading.textContent = '3D 마네킹을 불러오지 못했어요.';
      }
    );

    (function renderLoop(){
      requestAnimationFrame(renderLoop);
      if(scanControls) scanControls.update();
      if(scanRenderer && scanScene && scanCamera) scanRenderer.render(scanScene, scanCamera);
      updateNameplatePosition(container);
    })();

    window.addEventListener('resize', () => {
      const w = container.clientWidth, h = container.clientHeight;
      if(!w || !h) return;
      scanCamera.aspect = w / h;
      scanCamera.updateProjectionMatrix();
      scanRenderer.setSize(w, h);
      // 화면 크기가 바뀌면 지금 모델 키에 맞춰 카메라 거리도 다시 계산해요.
      if(scanMannequin) frameCameraToFullBody(lastAppliedHeightMeters);
    });
  }

  let lastAppliedHeightMeters = 1.65;
  let mannequinVerticalOffset = 0; // 사용자가 슬라이더로 직접 조정하는 상하 위치 보정값

  // 모델 키(대략적인 크기)와 팔 벌린 폭이 화면 안에 항상 여유 있게 다 들어오도록,
  // 세로 기준 거리와 가로(T포즈 폭) 기준 거리를 각각 계산해서 더 넉넉한 쪽을 써요.
  // 모델마다 발끝/원점 위치가 제각각이라 자동 계산이 어려운 경우가 있어서,
  // "마네킹 상하 위치" 슬라이더로 직접 눈으로 보면서 맞출 수 있게 해뒀어요.
  function frameCameraToFullBody(heightMeters){
    if(!scanCamera || !scanControls) return;
    const vFovRad = THREE.MathUtils.degToRad(scanCamera.fov);
    const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * scanCamera.aspect);
    const margin = 1.9; // 위아래·좌우 여유 공간

    const widthMeters = heightMeters * scanMannequinWidthRatio;
    const distanceForHeight = (heightMeters * margin) / (2 * Math.tan(vFovRad / 2));
    const distanceForWidth = (widthMeters * margin) / (2 * Math.tan(hFovRad / 2));
    const distance = Math.max(distanceForHeight, distanceForWidth);

    scanCamera.position.set(0, mannequinVerticalOffset, distance);
    scanControls.target.set(0, mannequinVerticalOffset, 0);
    scanCamera.updateProjectionMatrix();
  }

  function applyHeightToMannequin(heightCm){
    if(!scanMannequin || !scanMannequinDefaultHeight) return;
    const targetMeters = heightCm / 100;
    const scale = targetMeters / scanMannequinDefaultHeight;
    scanMannequin.scale.set(scale, scale, scale);

    // 모델마다 원점(기준점) 위치가 제각각이라(허리인 경우도, 발인 경우도 있어요),
    // 자동으로 발을 바닥에 맞추는 대신 "마네킹 상하 위치" 슬라이더 값을 그대로 적용해요.
    scanMannequin.position.y = mannequinVerticalOffset;

    lastAppliedHeightMeters = targetMeters;
    frameCameraToFullBody(targetMeters);

    // 머리 위 이름표: 입력한 이름이 있으면 그걸, 없으면 로그인한 이름을, 그것도 없으면 "게스트"를 표시해요.
    const typedName = scanNicknameInput ? scanNicknameInput.value.trim() : '';
    const fallbackName = '홍길동'; // 로그인 계정의 실제 이름을 자동으로 노출하지 않고, 이름을 안 적으면 예시 이름을 보여줘요.
    if(scanNameplate){
      scanNameplate.textContent = typedName || fallbackName;
      scanNameplate.hidden = false;
    }
  }

  // 매 프레임마다 머리 위(3D 좌표)를 화면 좌표로 변환해서, 카메라를 돌려도
  // 이름표가 항상 머리 위에 붙어 따라오게 해요. "마네킹 상하 위치" 조정값도 같이 반영해요.
  function updateNameplatePosition(container){
    if(!scanNameplate || scanNameplate.hidden || !scanCamera || !scanMannequin) return;
    const headWorldPos = new THREE.Vector3(0, lastAppliedHeightMeters * 0.45 + 0.1 + mannequinVerticalOffset, 0);
    const ndc = headWorldPos.project(scanCamera);
    if(ndc.z > 1){ scanNameplate.style.display = 'none'; return; }
    scanNameplate.style.display = 'block';
    const x = (ndc.x * 0.5 + 0.5) * container.clientWidth;
    const y = (-(ndc.y * 0.5) + 0.5) * container.clientHeight;
    scanNameplate.style.left = `${x}px`;
    scanNameplate.style.top = `${y}px`;
  }

  window.applyHeightToMannequin = applyHeightToMannequin;

  // "마네킹 상하 위치" 슬라이더: 값이 바뀔 때마다 현재 키 기준으로 위치를 다시 계산해요.
  const mannequinVposInput = document.getElementById('mannequin-vpos-input');
  if(mannequinVposInput){
    mannequinVposInput.addEventListener('input', () => {
      mannequinVerticalOffset = parseFloat(mannequinVposInput.value);
      applyHeightToMannequin(Math.round(lastAppliedHeightMeters * 100));
    });
  }

  // 모달이 처음 열릴 때만 3D 뷰어를 초기화해요 (숨겨진 상태에서 초기화하면
  // 컨테이너 크기가 0이라 렌더러가 깨지기 때문에, 실제로 보일 때 시작해요)
  let mannequinViewerStarted = false;
  window.startMannequinViewerOnce = function(){
    if(mannequinViewerStarted) return;
    mannequinViewerStarted = true;
    initMannequinViewer();
  };

  /* ---------- 옷/장신구 입혀보기 (파일 URL 기반, 옷장 아이템 공용) ---------- */
  let currentGarment = null;
  const garmentControls = document.getElementById('garment-controls');
  const garmentStatus = document.getElementById('garment-status');
  const garmentX = document.getElementById('garment-x');
  const garmentY = document.getElementById('garment-y');
  const garmentZ = document.getElementById('garment-z');
  const garmentScaleInput = document.getElementById('garment-scale');
  const garmentColorInput = document.getElementById('garment-color');
  const garmentColorResetBtn = document.getElementById('garment-color-reset-btn');
  const garmentRemoveBtn = document.getElementById('garment-remove-btn');

  function applyGarmentColor(hexColor){
    if(!currentGarment) return;
    currentGarment.traverse(node => {
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
  // 원단·디테일 선택(2단계) 화면의 색상 스와치에서도 이 함수를 쓸 수 있게 공유해요.
  window.applyGarmentColor = applyGarmentColor;
  window.hasGarmentWorn = function(){ return !!currentGarment; };

  function updateGarmentTransform(){
    if(!currentGarment) return;
    currentGarment.position.set(
      parseFloat(garmentX.value),
      parseFloat(garmentY.value),
      parseFloat(garmentZ.value)
    );
    const s = parseFloat(garmentScaleInput.value);
    currentGarment.scale.set(s, s, s);
  }

  function wearGarmentFromUrl(url, label, category){
    if(!scanMannequin){
      garmentStatus.textContent = '먼저 마네킹이 다 불러와질 때까지 잠시 기다려주세요.';
      return;
    }
    garmentStatus.textContent = `${label || '아이템'}을(를) 불러오는 중...`;
    const loader = new GLTFLoader();
    loader.load(
      url,
      gltf => {
        if(currentGarment) scanMannequin.remove(currentGarment);
        currentGarment = gltf.scene;
        currentGarment.scale.set(1, 1, 1);
        currentGarment.position.set(0, 0, 0);
        // 마네킹의 자식으로 붙여서, 키 조정으로 마네킹 크기가 바뀌면 옷도 같이 커지고 작아져요.
        scanMannequin.add(currentGarment);

        // 옷마다 Meshy에서 만들어진 원래 크기 단위가 제각각이라(예: 몸통보다 훨씬 크게 나올 수 있어요),
        // 마네킹 키를 기준으로 대략 맞는 크기부터 자동으로 시작하게 해요. 정확하진 않아서
        // 슬라이더로 미세 조정하는 건 여전히 필요할 수 있어요.
        const garmentBox = new THREE.Box3().setFromObject(currentGarment);
        const garmentHeight = garmentBox.max.y - garmentBox.min.y;
        let autoScale = 1;
        if(garmentHeight > 0 && scanMannequinDefaultHeight > 0){
          const targetFraction = 0.5; // 몸 키의 절반 정도 크기로 시작하는 대략적인 기준값
          autoScale = (scanMannequinDefaultHeight * targetFraction) / garmentHeight;
          autoScale = Math.min(Math.max(autoScale, 0.02), 5);
        }

        // 마네킹의 기준점(원점)이 대략 배·허리 높이에 있어서, 아무 위치 지정 없이 입히면
        // 전부 그 지점에서 시작해요. 카테고리별로 대략적인 시작 높이를 잡아줘서
        // "일단 배에서 시작" 하는 문제를 줄여요 (그래도 정확한 위치는 슬라이더로 맞춰야 해요).
        const categoryYOffset = {
          top: 0.35, outer: 0.35, hair: 1.05, shoes: -0.95, bottom: -0.55, accessory: 0.3, makeup: 1.0,
        }[category] || 0;

        garmentX.value = 0;
        garmentY.value = categoryYOffset.toFixed(2);
        garmentZ.value = 0;
        garmentScaleInput.value = autoScale.toFixed(2);
        garmentColorInput.value = '#ffffff';
        updateGarmentTransform();
        garmentControls.hidden = false;
        garmentStatus.textContent = `${label || '아이템'}을(를) 입혔어요! 크기·위치·색상을 슬라이더로 맞춰보세요.`;
        garmentControls.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
      undefined,
      () => {
        garmentStatus.textContent = '아이템을 불러오지 못했어요. .glb 파일이 맞는지 확인해주세요.';
      }
    );
  }

  [garmentX, garmentY, garmentZ, garmentScaleInput].forEach(el => {
    el.addEventListener('input', updateGarmentTransform);
  });

  garmentColorInput.addEventListener('input', () => applyGarmentColor(garmentColorInput.value));
  garmentColorResetBtn.addEventListener('click', () => {
    garmentColorInput.value = '#ffffff';
    applyGarmentColor('#ffffff');
  });

  garmentRemoveBtn.addEventListener('click', () => {
    if(currentGarment){
      scanMannequin.remove(currentGarment);
      currentGarment = null;
    }
    garmentControls.hidden = true;
    garmentStatus.textContent = '';
  });

  /* ---------- 옷장: 탭 전환 ---------- */
  const wardrobeTabs = document.querySelectorAll('.wardrobe-tab');
  const wardrobePanels = {
    recommend: document.getElementById('wardrobe-panel-recommend'),
    browse: document.getElementById('wardrobe-panel-browse'),
    upload: document.getElementById('wardrobe-panel-upload'),
  };
  wardrobeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      wardrobeTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      Object.entries(wardrobePanels).forEach(([key, panel]) => {
        panel.hidden = key !== tab.dataset.tab;
      });
      if(tab.dataset.tab === 'browse' && !wardrobeBrowseLoaded) loadWardrobeBrowse('');
    });
  });

  const CATEGORY_LABEL = { top: '상의', bottom: '하의', outer: '아우터', accessory: '장신구', shoes: '신발', hair: '헤어', makeup: '메이크업' };

  function wardrobeCardHTML(item, reason){
    const thumb = item.thumbnailUrl
      ? `<img src="${item.thumbnailUrl}" alt="${item.name}">`
      : `<span>${CATEGORY_LABEL[item.category] || item.category}</span>`;
    const wearable = !!item.glbUrl;
    const officialBadge = item.isOfficial ? `<span class="wardrobe-official-badge">공식</span>` : '';
    const editBtn = item.canEdit
      ? `<button type="button" class="wardrobe-edit-btn" data-edit-item-id="${item.id}" data-edit-item-name="${item.name}">사진·3D 파일 채우기</button>`
      : '';
    return `
      <div class="wardrobe-card">
        <div class="wardrobe-card-thumb">${thumb}${officialBadge}</div>
        <div class="wardrobe-card-name">${item.name}</div>
        <div class="wardrobe-card-meta">${CATEGORY_LABEL[item.category] || item.category}${item.color ? ' · ' + item.color : ''}</div>
        ${reason ? `<div class="wardrobe-card-reason">${reason}</div>` : ''}
        <button type="button" data-item-id="${item.id}" ${wearable ? '' : 'disabled'}>
          ${wearable ? '입혀보기' : '3D 모델 준비 중'}
        </button>
        ${editBtn}
      </div>`;
  }

  function wireWearButtons(container, items){
    container.querySelectorAll('button[data-item-id]').forEach(btn => {
      const item = items.find(it => it.id === btn.dataset.itemId);
      if(!item || !item.glbUrl) return;
      // 메이크업 아이템은 이제 몸 마네킹이 아니라 페이지 아래쪽의 독립된 "메이크업" 구역에서 입혀요.
      if(item.category === 'makeup'){
        btn.disabled = true;
        btn.textContent = '메이크업 구역에서 입혀보세요';
      } else {
        btn.addEventListener('click', () => wearGarmentFromUrl(item.glbUrl, item.name, item.category));
      }
    });
    container.querySelectorAll('.wardrobe-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => openWardrobeEditBox(btn.dataset.editItemId, btn.dataset.editItemName));
    });
  }


  /* ---------- 이미 있는 아이템에 사진·3D 파일 채워 넣기 ---------- */
  const wardrobeEditBox = document.getElementById('wardrobe-edit-box');
  const wardrobeEditName = document.getElementById('wardrobe-edit-name');
  const wardrobeEditThumbnail = document.getElementById('wardrobe-edit-thumbnail');
  const wardrobeEditGlb = document.getElementById('wardrobe-edit-glb');
  const wardrobeEditStatus = document.getElementById('wardrobe-edit-status');
  let editingItemId = null;

  function openWardrobeEditBox(itemId, itemName){
    editingItemId = itemId;
    wardrobeEditName.textContent = itemName;
    wardrobeEditThumbnail.value = '';
    wardrobeEditGlb.value = '';
    wardrobeEditStatus.textContent = '';
    wardrobeEditBox.hidden = false;
    wardrobeEditBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  document.getElementById('wardrobe-edit-cancel-btn').addEventListener('click', () => {
    wardrobeEditBox.hidden = true;
    editingItemId = null;
  });

  document.getElementById('wardrobe-edit-save-btn').addEventListener('click', async () => {
    if(!editingItemId) return;
    const thumbnailFile = wardrobeEditThumbnail.files[0];
    const glbFile = wardrobeEditGlb.files[0];
    if(!thumbnailFile && !glbFile){
      wardrobeEditStatus.textContent = '사진이나 3D 파일 중 하나는 선택해주세요.';
      return;
    }
    wardrobeEditStatus.textContent = '저장하는 중...';
    try{
      const formData = new FormData();
      if(thumbnailFile) formData.append('thumbnailFile', thumbnailFile, thumbnailFile.name);
      if(glbFile) formData.append('glbFile', glbFile, glbFile.name);
      const res = await fetch(`/api/wardrobe/${editingItemId}`, {
        method: 'PUT',
        body: formData,
      });
      const data = await res.json();
      if(data.ok){
        wardrobeEditStatus.textContent = '저장됐어요!';
        setTimeout(() => {
          wardrobeEditBox.hidden = true;
          editingItemId = null;
          loadWardrobeBrowse(document.querySelector('.wardrobe-filter-chip.active')?.dataset.category || '');
        }, 700);
      } else {
        wardrobeEditStatus.textContent = data.error || '저장에 실패했어요.';
      }
    } catch(err){
      wardrobeEditStatus.textContent = '저장 중 오류가 발생했어요.';
    }
  });

  /* ---------- 옷장 둘러보기 ---------- */
  let wardrobeBrowseLoaded = false;
  const wardrobeBrowseResults = document.getElementById('wardrobe-browse-results');
  document.querySelectorAll('.wardrobe-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.wardrobe-filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      loadWardrobeBrowse(chip.dataset.category);
    });
  });

  async function loadWardrobeBrowse(category){
    wardrobeBrowseLoaded = true;
    wardrobeBrowseResults.innerHTML = '<p class="wardrobe-hint">불러오는 중...</p>';
    try{
      const url = category ? `/api/wardrobe?category=${encodeURIComponent(category)}` : '/api/wardrobe';
      const res = await fetch(url);
      const data = await res.json();
      if(!data.items || data.items.length === 0){
        wardrobeBrowseResults.innerHTML = '<p class="wardrobe-hint">아직 등록된 아이템이 없어요.</p>';
        return;
      }
      wardrobeBrowseResults.innerHTML = data.items.map(it => wardrobeCardHTML(it)).join('');
      wireWearButtons(wardrobeBrowseResults, data.items);
    } catch(err){
      wardrobeBrowseResults.innerHTML = '<p class="wardrobe-hint">옷장을 불러오지 못했어요.</p>';
    }
  }

  /* ---------- 추천받기 ---------- */
  const recommendResults = document.getElementById('recommend-results');
  document.getElementById('recommend-btn').addEventListener('click', async () => {
    const ageGroup = document.getElementById('recommend-age-select').value;
    const occasion = document.getElementById('recommend-occasion-select').value;
    if(!ageGroup){
      recommendResults.innerHTML = '<p class="wardrobe-hint">연령대를 먼저 선택해주세요.</p>';
      return;
    }
    recommendResults.innerHTML = '<p class="wardrobe-hint">추천을 계산하는 중...</p>';
    try{
      const params = new URLSearchParams({ ageGroup });
      if(occasion) params.set('occasion', occasion);
      const res = await fetch(`/api/wardrobe/recommend?${params.toString()}`);
      const data = await res.json();
      if(!data.recommended || data.recommended.length === 0){
        recommendResults.innerHTML = '<p class="wardrobe-hint">조건에 맞는 추천 아이템이 아직 없어요.</p>';
        return;
      }
      recommendResults.innerHTML = data.recommended.map(it => wardrobeCardHTML(it, it.reason)).join('');
      wireWearButtons(recommendResults, data.recommended);
    } catch(err){
      recommendResults.innerHTML = '<p class="wardrobe-hint">추천을 불러오지 못했어요.</p>';
    }
  });

  /* ---------- 내 아이템 올리기 ---------- */
  const wardrobeUploadLoginNotice = document.getElementById('wardrobe-upload-login-notice');
  const wardrobeUploadForm = document.getElementById('wardrobe-upload-form');
  const uploadStatus = document.getElementById('upload-status');

  function refreshWardrobeUploadAccess(){
    const canUpload = !!(window.authState && window.authState.loggedIn);
    wardrobeUploadLoginNotice.hidden = canUpload;
    wardrobeUploadForm.hidden = !canUpload;
  }
  window.refreshWardrobeUploadAccess = refreshWardrobeUploadAccess; // 로그인 스크립트(classic script)에서도 호출할 수 있게 공유해요.

  function readFileAsDataUrl(file){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  document.getElementById('upload-item-submit-btn').addEventListener('click', async () => {
    const name = document.getElementById('upload-item-name').value.trim();
    const category = document.getElementById('upload-item-category').value;
    const color = document.getElementById('upload-item-color').value.trim();
    const tags = Array.from(document.querySelectorAll('.upload-occasion:checked')).map(el => el.value);
    const ageGroups = Array.from(document.querySelectorAll('.upload-agegroup:checked')).map(el => el.value);
    const thumbnailFile = document.getElementById('upload-item-thumbnail').files[0];
    const glbFile = document.getElementById('upload-item-glb').files[0];

    if(!name){ uploadStatus.textContent = '이름을 입력해주세요.'; return; }
    if(ageGroups.length === 0){ uploadStatus.textContent = '추천 연령대를 1개 이상 선택해주세요.'; return; }
    if(!thumbnailFile){ uploadStatus.textContent = '썸네일 이미지를 선택해주세요.'; return; }

    uploadStatus.textContent = '업로드하는 중...';
    try{
      const formData = new FormData();
      formData.append('name', name);
      formData.append('category', category);
      formData.append('color', color);
      formData.append('tags', JSON.stringify(tags));
      formData.append('ageGroups', JSON.stringify(ageGroups));
      formData.append('thumbnailFile', thumbnailFile, thumbnailFile.name);
      if(glbFile) formData.append('glbFile', glbFile, glbFile.name);

      const res = await fetch('/api/wardrobe', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if(data.ok){
        uploadStatus.textContent = '옷장에 올렸어요! "옷장 둘러보기" 탭에서 확인할 수 있어요.';
        document.getElementById('upload-item-name').value = '';
        document.getElementById('upload-item-color').value = '';
        document.querySelectorAll('.upload-occasion, .upload-agegroup').forEach(el => { el.checked = false; });
        document.getElementById('upload-item-thumbnail').value = '';
        document.getElementById('upload-item-glb').value = '';
        wardrobeBrowseLoaded = false;
        // 메이크업 아이템을 올렸으면, 페이지 아래쪽 독립 메이크업 구역의 목록도 새로고침해요.
        if(typeof window.refreshMakeupWardrobe === 'function') window.refreshMakeupWardrobe();
      } else {
        uploadStatus.textContent = data.error || '업로드에 실패했어요.';
      }
    } catch(err){
      uploadStatus.textContent = '업로드 중 오류가 발생했어요.';
    }
  });

  refreshWardrobeUploadAccess();
