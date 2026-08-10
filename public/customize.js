// ====== customize.js : 3D/2D 꾸미기 팝업 전용 스크립트 (classic script) ======
// index.html이 이 파일을 동적으로 불러온 뒤, window.openDesignModal3D() 또는
// window.openDesignModal2D() 를 호출해서 팝업을 열어요.
// authState, bodyDataConsentGranted 는 index.html 쪽에서 window에 노출해둔 값을
// 그대로 참조해요 (이 파일에서 따로 선언하지 않아요).

  /* ---------- 원단 색상 실시간 미리보기 (3D 모드에서 옷을 입은 상태면 그 옷 색깔도 같이 바꿔요) ---------- */
  const fabricColorPreview = document.getElementById('fabric-color-preview');
  const fabricColorCustomInput = document.getElementById('fabric-color-custom');
  const fabricColorGarmentNote = document.getElementById('fabric-color-garment-note');

  function applyFabricColorToWornGarment(color){
    if(typeof window.hasGarmentWorn === 'function' && window.hasGarmentWorn() && typeof window.applyGarmentColor === 'function'){
      window.applyGarmentColor(color);
      if(fabricColorGarmentNote){
        fabricColorGarmentNote.textContent = '지금 입혀본 옷 색상에도 바로 반영됐어요.';
        fabricColorGarmentNote.hidden = false;
      }
    } else if(fabricColorGarmentNote){
      fabricColorGarmentNote.hidden = true;
    }
  }

  document.querySelectorAll('.color-swatch[data-color]').forEach(swatch => {
    swatch.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch[data-color]').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      const color = swatch.dataset.color;
      if(fabricColorPreview) fabricColorPreview.style.background = color;
      if(fabricColorCustomInput) fabricColorCustomInput.value = color;
      applyFabricColorToWornGarment(color);
    });
  });
  if(fabricColorCustomInput){
    fabricColorCustomInput.addEventListener('input', () => {
      document.querySelectorAll('.color-swatch[data-color]').forEach(s => s.classList.remove('active'));
      if(fabricColorPreview) fabricColorPreview.style.background = fabricColorCustomInput.value;
      applyFabricColorToWornGarment(fabricColorCustomInput.value);
    });
  }

  function updateTotal(){
    const total = BASE + state.fabric + state.detail + state.finish;
    const totalEl = document.getElementById('calc-total');
    const noteEl = document.querySelector('.calc-total-note');
    const anyCustom = customActive.fabric || customActive.detail;
    if(anyCustom){
      totalEl.textContent = fmt(total) + ' + 협의';
      noteEl.textContent = '기본 제작비 30,000원 + 선택 옵션 (직접 요청 항목은 협의 후 확정)';
    } else {
      totalEl.textContent = fmt(total);
      noteEl.textContent = '기본 제작비 30,000원 + 선택 옵션';
    }
  }

  document.querySelectorAll('.calc-choices').forEach(group => {
    const key = group.dataset.group;
    const multi = group.dataset.multi === 'true';
    group.querySelectorAll('.calc-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const value = parseInt(chip.dataset.value, 10);
        const isCustom = chip.dataset.custom === 'true';
        let chipIsActive;
        if(multi){
          chip.classList.toggle('active');
          chipIsActive = chip.classList.contains('active');
          const activeChips = group.querySelectorAll('.calc-chip.active');
          let sum = 0;
          activeChips.forEach(c => sum += parseInt(c.dataset.value, 10));
          state[key] = sum;
        } else {
          group.querySelectorAll('.calc-chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          chipIsActive = true;
          state[key] = value;
        }
        if(isCustom && (key === 'fabric' || key === 'detail')){
          const customBox = document.getElementById(`calc-custom-${key}`);
          customActive[key] = chipIsActive;
          customBox.hidden = !chipIsActive;
          if(chipIsActive) document.getElementById(`custom-${key}-note`).focus();
        }
        updateTotal();
      });
    });
  });

  updateTotal();

  ['fabric','detail'].forEach(key => {
    const fileInput = document.getElementById(`custom-${key}-file`);
    const preview = document.getElementById(`custom-${key}-file-preview`);
    if(!fileInput) return;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        preview.innerHTML = '';
        const img = document.createElement('img');
        img.src = e.target.result;
        preview.appendChild(img);
      };
      reader.readAsDataURL(file);
    });
  });


  /* ---------- DESIGN WIZARD MODAL ---------- */
  const designModal = document.getElementById('design-modal');
  // (3D/2D 시작 버튼 자체는 index.html에 있고, 이 팝업 로딩이 끝나면 index.html이
  //  window.openDesignModal3D() / window.openDesignModal2D() 를 직접 호출해요)
  const designModalCloseBtn = document.getElementById('design-modal-close');
  const wizardPanelScan = document.getElementById('wizard-panel-scan');
  const wizardPanelCustomize = document.getElementById('wizard-panel-customize');
  const wizardStepIndicator1 = document.getElementById('wizard-step-indicator-1');
  const wizardStepIndicator2 = document.getElementById('wizard-step-indicator-2');
  const wizardToStep2Btn = document.getElementById('wizard-to-step2-btn');
  const wizardToStep1Btn = document.getElementById('wizard-to-step1-btn');
  const wizardFinishBtn = document.getElementById('wizard-finish-btn');
  const wizard3dOnlyBlock = document.getElementById('wizard-3d-only-block');
  const scan2dCharacterPreview = document.getElementById('scan-2d-character-preview');
  const scan2dCharacterImg = document.getElementById('scan-2d-character-img');
  let currentDesignMode = '3d'; // '3d' 또는 '2d'

  function showWizardStep(step){
    const onStep1 = step === 1;
    wizardPanelScan.hidden = !onStep1;
    wizardPanelCustomize.hidden = onStep1;
    wizardStepIndicator1.classList.toggle('active', onStep1);
    wizardStepIndicator2.classList.toggle('active', !onStep1);
    designModal.querySelector('.wizard-header').scrollIntoView({ block: 'nearest' });

    // 2단계(꾸미기)로 넘어갈 때, 2D 모드면 방금 스캔한 사진을 "내 2D 캐릭터"로 보여줘요.
    if(!onStep1){
      const note = document.getElementById('wizard-2d-mode-note');
      const is2D = currentDesignMode === '2d';
      if(note) note.hidden = !is2D;
      if(scan2dCharacterPreview){
        const capturedImg = document.querySelector('#scan-photo-slot img');
        if(is2D && capturedImg && capturedImg.src){
          scan2dCharacterImg.src = capturedImg.src;
          scan2dCharacterPreview.hidden = false;
        } else {
          scan2dCharacterPreview.hidden = true;
        }
      }
    }
  }

  // 3D 모드: 스캔 → 3D 마네킹·옷장 → 원단/색상 꾸미기로 이어지는 흐름이에요.
  function openDesignModal3D(){
    currentDesignMode = '3d';
    designModal.hidden = false;
    if(wizard3dOnlyBlock) wizard3dOnlyBlock.hidden = false;
    setScanStepText(false);
    showWizardStep(1);
    if(typeof window.startMannequinViewerOnce === 'function'){
      window.startMannequinViewerOnce();
    }
  }

  // 2D 모드: 3D 마네킹 없이, 스캔한 사진을 그대로 내 캐릭터로 써서 원단/색상/디테일만 꾸며요.
  function openDesignModal2D(){
    currentDesignMode = '2d';
    designModal.hidden = false;
    if(wizard3dOnlyBlock) wizard3dOnlyBlock.hidden = true; // 3D 마네킹·옷장 부분은 2D에선 필요 없어서 숨겨요.
    setScanStepText(true);
    showWizardStep(1);
  }

  function setScanStepText(is2D){
    const title = document.getElementById('scan-step-title');
    const desc = document.getElementById('scan-step-desc');
    if(title) title.textContent = is2D ? '카메라로 내 2D 캐릭터 만들기' : '카메라로 체형 스캔해보기';
    if(desc) desc.textContent = is2D
      ? '정면 사진을 촬영하거나 업로드하면, 그 사진이 그대로 내 2D 캐릭터가 돼요. 다음 단계에서 원단·색상·디테일로 꾸며볼 수 있어요.'
      : '정면 사진을 촬영하거나 업로드하고 키를 입력하면, 입력한 키 비율에 맞춰 마네킹 아바타 크기가 자동으로 조정돼요. (데모 버전 — 실제 서비스에서는 3D 체형 데이터로 정밀하게 반영돼요)';
  }

  function closeDesignModal(){
    designModal.hidden = true;
  }

  window.openDesignModal3D = openDesignModal3D;
  window.openDesignModal2D = openDesignModal2D;
  window.closeDesignModal = closeDesignModal;
  designModalCloseBtn.addEventListener('click', closeDesignModal);
  wizardToStep2Btn.addEventListener('click', () => showWizardStep(2));
  wizardToStep1Btn.addEventListener('click', () => {
    showWizardStep(1);
    if(currentDesignMode === '3d' && typeof window.startMannequinViewerOnce === 'function'){
      window.startMannequinViewerOnce();
    }
  });
  wizardFinishBtn.addEventListener('click', closeDesignModal);
  designModal.addEventListener('click', e => {
    if(e.target === designModal) closeDesignModal();
  });

  /* ---------- SCAN DEMO ---------- */
  const scanVideo = document.getElementById('scan-video');
  const scanCanvas = document.getElementById('scan-canvas');
  const scanStartBtn = document.getElementById('scan-start-btn');
  const scanCaptureBtn = document.getElementById('scan-capture-btn');
  const scanRecordBtn = document.getElementById('scan-record-btn');
  const scanFileInput = document.getElementById('scan-file-input');
  const scanVideoFileInput = document.getElementById('scan-video-file-input');
  const scanHint = document.getElementById('scan-hint');
  const scanPhotoSlot = document.getElementById('scan-photo-slot');
  const scanHeightInput = document.getElementById('scan-height-input');
  const scanGenerateBtn = document.getElementById('scan-generate-btn');
  const scanStatus = document.getElementById('scan-status');
  const scanAvatarLoading = document.getElementById('scan-avatar-loading');
  const scanAvatarHint = document.getElementById('scan-avatar-hint');
  let scanStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  const RECORD_MS = 5000;

  function showScanPhoto(dataUrl){
    scanPhotoSlot.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    scanPhotoSlot.appendChild(img);
  }

  function showScanVideo(url){
    scanPhotoSlot.innerHTML = '';
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.loop = true;
    video.playsInline = true;
    scanPhotoSlot.appendChild(video);
  }

  function stopScanStream(){
    if(scanStream){
      scanStream.getTracks().forEach(t => t.stop());
      scanStream = null;
    }
  }

  function resetCameraButtons(){
    scanCaptureBtn.hidden = true;
    scanRecordBtn.hidden = true;
    scanStartBtn.hidden = false;
    scanStartBtn.textContent = '다시 촬영';
  }

  scanStartBtn.addEventListener('click', async () => {
    try{
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      scanVideo.srcObject = scanStream;
      scanStartBtn.hidden = true;
      scanCaptureBtn.hidden = false;
      scanRecordBtn.hidden = false;
      scanRecordBtn.disabled = false;
      scanRecordBtn.textContent = '동영상 녹화 (5초)';
      scanHint.textContent = '"사진 촬영"으로 한 장 찍거나, "동영상 녹화"로 한 바퀴 돌면서 5초간 찍어보세요.';
    } catch(err){
      scanHint.textContent = '카메라를 사용할 수 없어요. 아래 업로드 버튼으로 진행해주세요.';
    }
  });

  scanCaptureBtn.addEventListener('click', () => {
    if(!scanStream) return;
    const w = scanVideo.videoWidth || 480;
    const h = scanVideo.videoHeight || 640;
    scanCanvas.width = w;
    scanCanvas.height = h;
    scanCanvas.getContext('2d').drawImage(scanVideo, 0, 0, w, h);
    const dataUrl = scanCanvas.toDataURL('image/png');
    showScanPhoto(dataUrl);
    stopScanStream();
    scanVideo.srcObject = null;
    resetCameraButtons();
    scanHint.textContent = '촬영이 완료됐어요. 키를 입력하고 아바타를 생성해보세요.';
  });

  scanRecordBtn.addEventListener('click', () => {
    if(!scanStream) return;
    let mimeType = 'video/webm';
    if(!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
    recordedChunks = [];
    try{
      mediaRecorder = mimeType ? new MediaRecorder(scanStream, { mimeType }) : new MediaRecorder(scanStream);
    } catch(err){
      scanHint.textContent = '이 브라우저에서는 동영상 녹화가 지원되지 않아요. "사진 촬영"을 이용해주세요.';
      return;
    }
    mediaRecorder.ondataavailable = e => { if(e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      showScanVideo(url);
      stopScanStream();
      scanVideo.srcObject = null;
      resetCameraButtons();
      scanHint.textContent = '녹화가 완료됐어요. 키를 입력하고 아바타를 생성해보세요.';
    };

    mediaRecorder.start();
    scanCaptureBtn.disabled = true;
    scanRecordBtn.disabled = true;
    let secondsLeft = RECORD_MS / 1000;
    scanRecordBtn.textContent = `녹화 중... ${secondsLeft}초`;
    const countdown = setInterval(() => {
      secondsLeft -= 1;
      if(secondsLeft > 0){
        scanRecordBtn.textContent = `녹화 중... ${secondsLeft}초`;
      } else {
        clearInterval(countdown);
      }
    }, 1000);
    setTimeout(() => {
      if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      scanCaptureBtn.disabled = false;
    }, RECORD_MS);
  });

  scanFileInput.addEventListener('change', () => {
    const file = scanFileInput.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      showScanPhoto(e.target.result);
      scanHint.textContent = '사진 업로드가 완료됐어요. 키를 입력하고 아바타를 생성해보세요.';
    };
    reader.readAsDataURL(file);
  });

  scanVideoFileInput.addEventListener('change', () => {
    const file = scanVideoFileInput.files[0];
    if(!file) return;
    const url = URL.createObjectURL(file);
    showScanVideo(url);
    scanHint.textContent = '동영상 업로드가 완료됐어요. 키를 입력하고 아바타를 생성해보세요.';
  });

  scanGenerateBtn.addEventListener('click', () => {
    const height = parseFloat(scanHeightInput.value);
    const validHeight = (height && height >= 120 && height <= 210) ? height : 165;
    if(typeof window.applyHeightToMannequin === 'function'){
      window.applyHeightToMannequin(validHeight);
    }
    scanStatus.textContent = height
      ? `${validHeight}cm 체형 데이터 기반 아바타 생성 완료 (데모)`
      : '키를 입력하지 않아 기본값(165cm) 비율로 생성했어요.';
    saveScanDataIfConsented(validHeight);
  });

  // 로그인 + 신체 데이터 수집에 동의한 경우에만, 방금 찍은 사진과 키를 서버에 저장해요.
  async function saveScanDataIfConsented(heightCm){
    if(!authState.loggedIn || bodyDataConsentGranted !== true) return;
    const imgEl = scanPhotoSlot.querySelector('img');
    let photoThumbnail = null;
    if(imgEl && imgEl.src && imgEl.src.startsWith('data:') && imgEl.src.length < 380000){
      photoThumbnail = imgEl.src;
    }
    try{
      const res = await fetch('/api/scan/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ heightCm, photoThumbnail }),
      });
      const data = await res.json();
      if(data.ok){
        scanStatus.textContent += ' · 동의하신 대로 서버에 저장됐어요.';
      }
    } catch(err){ /* 저장 실패해도 아바타 생성 자체엔 영향 없어요 */ }
  }
