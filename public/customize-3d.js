// ====== customize-3d.js : 3D/2D 꾸미기 팝업 전용 스크립트 (module script, Three.js) ======
  import * as THREE from 'three';
  import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  import { createAngledPatch, BODY_TORSO_ANGLES, BODY_TORSO_Y } from '/makeup-props.js';
  import { analyzePhotoBySegments, sampleAverageColorFromPhoto, SEG_CATEGORY } from '/segment-utils.js';

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

  // mannequin.glb는 관절(Armature/스킨)이 있는 리깅된 모델이에요. THREE.Box3().setFromObject()는
  // 스킨 변형(관절이 정점을 움직이는 것)을 무시하고 메쉬 노드의 단순 변환만 계산해서 크기를
  // 재는데, 이 모델처럼 관절 계층 중간(Armature)에 큰 스케일(0.01배)이 끼어 있으면 실제
  // 크기와 완전히 다른(최대 100배까지 차이 나는) 값이 나와요 — 마네킹이 감당 안 될 만큼
  // 커지거나 카메라가 이상한 곳에 맺히는 버그가 이것 때문이었어요.
  // 대신 실제 메쉬 지오메트리 자체의 "로컬" 크기(관절·스킨과 무관하게 항상 정확해요, 바인드
  // 포즈 기준)를 직접 재서 써요.
  function findMannequinMesh(root){
    let found = null;
    root.traverse(node => { if(!found && node.isMesh && node.geometry) found = node; });
    return found;
  }
  function getMannequinLocalBounds(root){
    const mesh = findMannequinMesh(root);
    if(!mesh) return null;
    if(!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    if(!box || !isFinite(box.min.y) || !isFinite(box.max.y)) return null;
    return {
      height: box.max.y - box.min.y,
      width: Math.max(box.max.x - box.min.x, box.max.z - box.min.z),
      minY: box.min.y,
      maxY: box.max.y,
    };
  }

  // 옷/장신구 아이템에도 같은 문제가 생길 수 있어요(Meshy 등에서 관절 있는 채로 내보내진
  // 경우). 스킨(SkinnedMesh)이 있으면 메쉬 로컬 지오메트리를 직접 재고, 없으면(대부분의
  // 옷은 이 경우예요) Box3().setFromObject()로 재도 정확해서 그대로 써요.
  function measureObjectBounds(root){
    let skinnedMesh = null;
    root.traverse(node => { if(node.isSkinnedMesh && !skinnedMesh) skinnedMesh = node; });
    if(skinnedMesh && skinnedMesh.geometry){
      if(!skinnedMesh.geometry.boundingBox) skinnedMesh.geometry.computeBoundingBox();
      const box = skinnedMesh.geometry.boundingBox;
      if(box && isFinite(box.min.y) && isFinite(box.max.y)){
        return {
          minY: box.min.y, maxY: box.max.y,
          height: box.max.y - box.min.y,
          width: Math.max(box.max.x - box.min.x, box.max.z - box.min.z),
        };
      }
    }
    // 스킨 없는 일반 옷(대부분의 옷장 아이템)은 이 경로로 와요. Box3().setFromObject(root)를
    // 그냥 쓰면, root의 부모(마네킹)가 지금 어떤 스케일·위치를 갖고 있든 그게 다 섞여서
    // 나와요(옷을 마네킹의 자식으로 붙인 다음에 재기 때문이에요) — 그래서 마네킹 키를
    // 바꿔놨거나 위치를 옮겨놨으면 잘못된 크기가 나와요. 그래서 각 메쉬의 "월드 좌표"를
    // 구한 다음, root 자신의 월드 행렬의 역행렬을 곱해서 "root 기준 로컬 좌표"로 되돌려요 —
    // 이러면 마네킹(부모)이 어떤 상태든 상관없이 항상 옷 자체의 순수한 크기가 나와요.
    root.updateWorldMatrix(true, true);
    const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const box = new THREE.Box3();
    let found = false;
    root.traverse(node => {
      if(node.isMesh && node.geometry){
        if(!node.geometry.boundingBox) node.geometry.computeBoundingBox();
        const nodeBox = node.geometry.boundingBox.clone();
        const localMatrix = new THREE.Matrix4().multiplyMatrices(rootInverse, node.matrixWorld);
        nodeBox.applyMatrix4(localMatrix);
        if(!found){ box.copy(nodeBox); found = true; }
        else box.union(nodeBox);
      }
    });
    if(!found || !isFinite(box.min.y) || !isFinite(box.max.y)){
      return { minY: 0, maxY: 0, height: 0, width: 0 };
    }
    return {
      minY: box.min.y, maxY: box.max.y,
      height: box.max.y - box.min.y,
      width: Math.max(box.max.x - box.min.x, box.max.z - box.min.z),
    };
  }

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
    scanControls.minDistance = 0.3;
    scanControls.maxDistance = 14; // 마네킹 크기를 실제로 측정한 뒤(frameCameraToFullBody) 여기에 맞춰 자동으로 늘어나요.
    scanControls.target.set(0, 1, 0);

    const loader = new GLTFLoader();
    loader.load(
      '/models/mannequin.glb?v=4',
      gltf => {
        try {
          scanMannequin = gltf.scene;
          scanScene.add(scanMannequin);

          // 스킨(관절) 있는 모델은 Box3().setFromObject()로 재면 안 돼서(위 설명 참고),
          // 메쉬 지오메트리 자체의 로컬 크기를 직접 재요. 혹시 메쉬를 못 찾거나(구조가
          // 다른 GLB로 바뀌는 등) 이상한 경우엔 예전 방식(전체 계층 재기)으로 대체해요.
          const localBounds = getMannequinLocalBounds(scanMannequin);
          let rawHeight, rawWidth, rawMinY;
          if(localBounds){
            rawHeight = localBounds.height;
            rawWidth = localBounds.width;
            rawMinY = localBounds.minY;
          } else {
            console.warn('마네킹에서 메쉬를 못 찾았어요 — 예전 방식(전체 계층 측정)으로 대체해요. 스킨/관절이 있는 모델이면 크기가 부정확할 수 있어요.');
            const box0 = new THREE.Box3().setFromObject(scanMannequin);
            rawHeight = box0.max.y - box0.min.y;
            rawWidth = Math.max(box0.max.x - box0.min.x, box0.max.z - box0.min.z);
            rawMinY = box0.min.y;
          }

          // 모델 안에 눈에 안 보이는 이상한 요소(빈 노드, 원점에서 멀리 떨어진 헬퍼 등)가
          // 섞여 있으면 크기가 비정상적으로 크게 나오거나(수백~수천 단위) 0에 가깝게 나올 수
          // 있어요. 그러면 스케일 계산이 완전히 틀어져서 마네킹이 실제로는 화면 밖으로 벗어날
          // 만큼 커지거나 작아지고, 카메라도 엉뚱한 곳을 보게 돼요. 말이 안 되는 값이면
          // 콘솔에 경고를 남기고 안전한 기본값(사람 키다운 범위)으로 대체해요.
          if(!isFinite(rawHeight) || rawHeight <= 0 || rawHeight > 100){
            console.warn(`mannequin.glb 모델 크기가 이상해요 (원본 높이: ${rawHeight}). 기본값(1.6)으로 대체해요. GLB 안에 스케일이 이상한 요소가 섞여 있는지 확인해보세요.`);
            rawHeight = 1.6;
          }
          scanMannequinDefaultHeight = rawHeight;
          scanMannequinDefaultMinY = rawMinY;
          scanMannequinWidthRatio = (rawWidth > 0 && isFinite(rawWidth)) ? rawWidth / scanMannequinDefaultHeight : 0.4;

          applyHeightToMannequin(165);
          if(scanAvatarLoading) scanAvatarLoading.hidden = true;
          if(scanAvatarHint) scanAvatarHint.hidden = false;

          if(pendingTorsoPhotos){
            window.applyBodyTorsoPatchesFromPhotos(pendingTorsoPhotos);
            pendingTorsoPhotos = null;
          }
        } catch(err){
          // 여기서 에러가 나면 예전엔 "불러오는 중" 문구만 뜬 채로 조용히 멈춰서 원인을
          // 알 수 없었어요. 이제는 에러를 콘솔에 남기고, 화면에도 실패했다고 알려줘요.
          console.error('마네킹 초기 설정 중 오류:', err);
          if(scanAvatarLoading) scanAvatarLoading.textContent = '3D 마네킹 설정 중 오류가 발생했어요. (콘솔 확인)';
        }
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
  let mannequinHeadTopY = 1.75; // 매 프레임 다시 재지 않도록, 카메라를 다시 잡을 때(frameCameraToFullBody)만 갱신해요.

  function frameCameraToFullBody(heightMeters){
    if(!scanCamera || !scanControls) return;
    const vFovRad = THREE.MathUtils.degToRad(scanCamera.fov);
    const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * scanCamera.aspect);
    const margin = 1.9; // 위아래·좌우 여유 공간

    // heightMeters(목표 키)를 그대로 믿고 거리를 계산하면, 혹시 스케일 계산이 어떤
    // 이유로든 어긋나서 마네킹이 실제로는 훨씬 크거나 작게 렌더링될 때 카메라가 엉뚱한
    // 거리에 놓여요(예: 실제로 훨씬 큰데 1.65m라고 가정하면 카메라가 너무 가까워져서
    // 다리 부분만 화면 가득 보이게 돼요). 그래서 실제로 지금 화면에 렌더링된 마네킹의
    // 크기를 직접 측정해서 써요 — 이러면 스케일이 어떻게 계산됐든 항상 "실제 눈에 보이는
    // 크기"에 맞춰 전신이 프레임 안에 들어와요.
    let actualHeight = heightMeters;
    let actualWidth = heightMeters * scanMannequinWidthRatio;
    let centerY = mannequinVerticalOffset;

    if(scanMannequin){
      // 스킨(관절) 모델은 Box3().setFromObject()로 전체 계층을 재면 부정확해서(위 설명 참고),
      // 로드할 때 재둔 "메쉬 로컬 크기"에 지금 스케일/위치만 곱해서 실제 크기를 구해요.
      const localBounds = getMannequinLocalBounds(scanMannequin);
      if(localBounds){
        const sx = scanMannequin.scale.x, sy = scanMannequin.scale.y;
        const measuredHeight = localBounds.height * sy;
        if(isFinite(measuredHeight) && measuredHeight > 0){
          actualHeight = measuredHeight;
          centerY = mannequinVerticalOffset + ((localBounds.minY + localBounds.maxY) / 2) * sy;
          mannequinHeadTopY = mannequinVerticalOffset + (localBounds.maxY + (localBounds.maxY - localBounds.minY) * 0.06) * sy; // 이름표는 머리 꼭대기보다 살짝 위에 떠요.
        }
        const measuredWidth = localBounds.width * sx;
        if(isFinite(measuredWidth) && measuredWidth > 0){
          actualWidth = measuredWidth;
        }
      }
    }

    const distanceForHeight = (actualHeight * margin) / (2 * Math.tan(vFovRad / 2));
    const distanceForWidth = (actualWidth * margin) / (2 * Math.tan(hFovRad / 2));
    let distance = Math.max(distanceForHeight, distanceForWidth);
    // 계산값이 이상하면(모델 크기 이상 등으로) 카메라가 마네킹 안에 파묻히거나 무한히
    // 멀어지는 걸 막기 위해, 말이 안 되는 값이면 무난한 기본 거리로 대체해요.
    if(!isFinite(distance) || distance <= 0) distance = 3.5;

    // OrbitControls는 min/maxDistance 범위를 벗어난 위치를 다음 update()에서 강제로
    // 다시 그 범위 안으로 당겨버려요. 그래서 마네킹이 예상보다 훨씬 크게(또는 작게)
    // 렌더링돼서 계산된 distance가 원래 걸어둔 고정 범위(예: 최대 14)를 벗어나면,
    // 힘들게 계산한 값이 적용되자마자 그 상한선에 다시 눌려서 "줌아웃 해도 그 이상은
    // 안 빠지는" 현상이 생겨요. 그래서 범위 자체를 지금 계산된 거리에 맞춰 넉넉하게
    // 늘려줘요(사용자가 손으로 더 당겨볼 여유도 남겨둬요).
    scanControls.minDistance = Math.min(0.3, distance * 0.1);
    scanControls.maxDistance = Math.max(14, distance * 2.5);

    scanCamera.position.set(0, centerY, distance);
    scanControls.target.set(0, centerY, 0);
    scanCamera.updateProjectionMatrix();
    scanControls.update(); // 지금 바로 반영해서, 다음 프레임에 예전 클램프 값으로 되돌아가지 않게 해요.
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
    // 매 프레임 바운딩 박스를 새로 재는 대신, frameCameraToFullBody가 계산해둔 머리 꼭대기
    // 값(mannequinHeadTopY)을 그대로 써요 — 실제 렌더링 크기 기준이라 정확하면서도 가벼워요.
    const headWorldPos = new THREE.Vector3(0, mannequinHeadTopY, 0);
    const ndc = headWorldPos.project(scanCamera);
    if(ndc.z > 1){ scanNameplate.style.display = 'none'; return; }
    scanNameplate.style.display = 'block';
    const x = (ndc.x * 0.5 + 0.5) * container.clientWidth;
    const y = (-(ndc.y * 0.5) + 0.5) * container.clientHeight;
    scanNameplate.style.left = `${x}px`;
    scanNameplate.style.top = `${y}px`;
  }

  window.applyHeightToMannequin = applyHeightToMannequin;

  /* ==========================================================================
     몸통 사진 패치 — 얼굴(makeup.js)과 같은 방식이에요. mannequin.glb는 T포즈라
     팔은 사진(팔을 내린 자세)이랑 안 맞아서 건너뛰고, 포즈 영향이 없는 몸통(어깨선~골반선)
     에만 정면/좌/우/뒤 사진을 곡면 패치로 입혀요.
     ========================================================================== */
  let activeTorsoPatches = [];
  let pendingTorsoPhotos = null;

  window.applyBodyTorsoPatchesFromPhotos = async function(photos){
    if(!scanMannequin){
      pendingTorsoPhotos = photos; // 마네킹이 아직 안 불러와졌으면 대기했다가, 로드되면 자동 적용해요.
      return;
    }
    const scanStatusEl = document.getElementById('scan-status');
    if(scanStatusEl) scanStatusEl.textContent += ' · 몸통 사진을 인식하는 중이에요...';

    const torsoCutouts = {}; // { front, left, right, back }
    for(const key of ['front', 'left', 'right', 'back']){
      const dataUrl = photos[key];
      if(!dataUrl) continue;
      try{
        const segments = await analyzePhotoBySegments(dataUrl, {
          torso: [SEG_CATEGORY.BODY_SKIN, SEG_CATEGORY.CLOTHES], // 피부 + 옷까지 같이 오려서, 지금 입은 옷도 그대로 보이게 해요.
        });
        if(segments.torso) torsoCutouts[key] = segments.torso;
      } catch(err){
        console.error(`몸통(${key}) 사진 AI 인식 실패:`, err);
      }
    }

    // 기존 패치는 지우고 새로 붙여요 (다시 생성했을 때 중복 방지).
    activeTorsoPatches.forEach(p => scanMannequin.remove(p));
    activeTorsoPatches = [];

    BODY_TORSO_ANGLES.forEach(angle => {
      const cutout = torsoCutouts[angle.key];
      if(!cutout) return;
      const patch = createAngledPatch({
        cutoutCanvas: cutout,
        thetaCenter: angle.thetaCenter,
        thetaWidth: angle.thetaWidth,
        yTop: BODY_TORSO_Y.yTop,
        yBottom: BODY_TORSO_Y.yBottom,
        radius: BODY_TORSO_Y.radius,
      });
      if(patch){ scanMannequin.add(patch); activeTorsoPatches.push(patch); }
    });

    if(scanStatusEl){
      scanStatusEl.textContent = Object.keys(torsoCutouts).length > 0
        ? '몸통에 사진을 입혔어요! 옆·뒤가 안 맞으면 다른 각도 사진을 다시 올려보세요.'
        : '몸통 인식에는 실패했어요. 밝은 곳에서 찍은 사진으로 다시 시도해보세요.';
    }
  };

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

  /* ---------- 옷/장신구 입혀보기 (파일 URL 기반, 옷장 아이템 공용) ----------
     상의·하의·아우터·신발·헤어·장신구를 카테고리별로 각각 따로 들고 있어서,
     여러 부위를 동시에 입어볼 수 있어요(예: 상의+하의를 같이 입고 전체 코디 확인). */
  const GARMENT_CATEGORIES = ['top', 'bottom', 'outer', 'shoes', 'hair', 'accessory'];
  const wornGarments = {}; // { top: THREE.Object3D, bottom: ..., ... } — 입은 부위만 키가 존재해요.
  let activeGarmentCategory = null; // 지금 색상/무늬 편집 대상으로 선택된 부위
  const garmentControls = document.getElementById('garment-controls');
  const garmentStatus = document.getElementById('garment-status');
  const garmentColorInput = document.getElementById('garment-color');
  const garmentColorResetBtn = document.getElementById('garment-color-reset-btn');
  const garmentRemoveBtn = document.getElementById('garment-remove-btn');
  const wornGarmentChipsEl = document.getElementById('worn-garment-chips');

  const CATEGORY_LABEL_3D = { top: '상의', bottom: '하의', outer: '아우터', accessory: '장신구', shoes: '신발', hair: '헤어' };

  function activeGarment(){
    return activeGarmentCategory ? wornGarments[activeGarmentCategory] : null;
  }

  // 입고 있는 부위들을 칩으로 보여줘요. 칩을 누르면 그 부위가 "지금 색칠/무늬 편집 대상"이 돼요.
  function renderWornGarmentChips(){
    if(!wornGarmentChipsEl) return;
    const worn = GARMENT_CATEGORIES.filter(cat => wornGarments[cat]);
    if(worn.length === 0){
      wornGarmentChipsEl.innerHTML = '';
      garmentControls.hidden = true;
      return;
    }
    garmentControls.hidden = false;
    wornGarmentChipsEl.innerHTML = worn.map(cat => `
      <button type="button" class="worn-garment-chip${cat === activeGarmentCategory ? ' active' : ''}" data-category="${cat}">
        ${CATEGORY_LABEL_3D[cat] || cat}
      </button>
    `).join('');
    wornGarmentChipsEl.querySelectorAll('.worn-garment-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        activeGarmentCategory = chip.dataset.category;
        renderWornGarmentChips();
        garmentStatus.textContent = `${CATEGORY_LABEL_3D[activeGarmentCategory] || activeGarmentCategory} 색상/무늬를 편집할 수 있어요.`;
        garmentColorInput.value = '#ffffff';
        if(typeof window.refreshPatternPartOptions === 'function') window.refreshPatternPartOptions();
      });
    });
  }

  function applyGarmentColor(hexColor){
    const g = activeGarment();
    if(!g) return;
    g.traverse(node => {
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

  // 무늬/패턴(이미지)을 지금 선택된(활성) 옷 표면에 반복 텍스처로 입혀요. 색상(applyGarmentColor)과는
  // 별개로 같이 쓸 수 있어요 — 텍스처가 색과 곱해져서, 색을 바꾸면 무늬 톤도 같이 바뀌어요.
  // partId를 주면 그 부위(재질)에만 입히고, 안 주면(null) 옷 전체에 입혀요.
  function applyGarmentPatternTexture(imageDataUrl, repeatCount = 4, partId = null){
    const g = activeGarment();
    if(!g) return;
    const loader = new THREE.TextureLoader();
    loader.load(imageDataUrl, texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeatCount, repeatCount);
      g.traverse(node => {
        if(node.isMesh && node.material){
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          materials.forEach(mat => {
            if(partId && mat.uuid !== partId) return; // 특정 부위만 지정했으면, 그 부위 재질에만 입혀요.
            if('map' in mat){
              mat.map = texture;
              mat.needsUpdate = true;
            }
          });
        }
      });
    });
  }

  // 무늬를 지워요. partId를 주면 그 부위만, 안 주면 옷 전체 무늬를 지워요.
  function clearGarmentPatternTexture(partId = null){
    const g = activeGarment();
    if(!g) return;
    g.traverse(node => {
      if(node.isMesh && node.material){
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach(mat => {
          if(partId && mat.uuid !== partId) return;
          if('map' in mat){
            mat.map = null;
            mat.needsUpdate = true;
          }
        });
      }
    });
  }

  // 지금 선택된(활성) 옷을 이루는 부위(재질) 목록을 뽑아요. 옷마다 실제로 몇 개 부위로 나뉘어
  // 있는지가 달라서(소매/몸판이 따로 분리된 옷도 있고, 통짜 재질 하나인 옷도 있어요),
  // 있는 그대로의 개수·이름을 돌려줘요 — 없는 부위를 억지로 만들어내진 않아요.
  function getGarmentParts(){
    const g = activeGarment();
    if(!g) return [];
    const parts = [];
    const seen = new Set();
    let idx = 0;
    g.traverse(node => {
      if(node.isMesh && node.material){
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach(mat => {
          if(seen.has(mat.uuid)) return;
          seen.add(mat.uuid);
          idx++;
          const label = (mat.name && mat.name.trim())
            ? mat.name
            : (node.name && node.name.trim() ? node.name : `부위 ${idx}`);
          parts.push({ id: mat.uuid, label });
        });
      }
    });
    return parts;
  }

  // 원단·디테일 선택(2단계) 화면의 색상 스와치/무늬 선택기에서도 이 함수들을 쓸 수 있게 공유해요.
  window.applyGarmentColor = applyGarmentColor;
  window.applyGarmentPatternTexture = applyGarmentPatternTexture;
  window.clearGarmentPatternTexture = clearGarmentPatternTexture;
  window.getGarmentParts = getGarmentParts;
  window.hasGarmentWorn = function(){ return !!activeGarment(); };

  function wearGarmentFromUrl(url, label, category){
    if(!scanMannequin){
      garmentStatus.textContent = '먼저 마네킹이 다 불러와질 때까지 잠시 기다려주세요.';
      return;
    }
    const cat = category || 'accessory';
    garmentStatus.textContent = `${label || '아이템'}을(를) 불러오는 중...`;
    const loader = new GLTFLoader();
    loader.load(
      url,
      gltf => {
        // 같은 부위(카테고리)에 이미 입은 게 있으면 그것만 벗기고 새로 입혀요.
        // 다른 부위(예: 하의)에 입은 건 그대로 남아있어요 — 상의+하의를 같이 입어볼 수 있어요.
        if(wornGarments[cat]) scanMannequin.remove(wornGarments[cat]);

        const garment = gltf.scene;
        garment.scale.set(1, 1, 1);
        garment.position.set(0, 0, 0);
        // 마네킹의 자식으로 붙여서, 키 조정으로 마네킹 크기가 바뀌면 옷도 같이 커지고 작아져요.
        scanMannequin.add(garment);

        // 옷마다 Meshy에서 만들어진 원래 크기 단위가 제각각이라(예: 몸통보다 훨씬 크게 나올 수 있어요),
        // 마네킹 키를 기준으로 대략 맞는 크기부터 자동으로 시작하게 해요. 스킨(관절) 있는 옷이면
        // measureObjectBounds가 그 문제도 알아서 피해가요(마네킹 크기 버그와 같은 원리).
        const bounds = measureObjectBounds(garment);
        const garmentHeight = bounds.height;
        const CATEGORY_TARGET_FRACTION = {
          top: 0.38,       // 어깨~골반 정도
          outer: 0.5,      // 상의보다 길게 떨어지는 아우터
          bottom: 0.28,    // 허리~무릎 안팎(반바지~짧은 하의 기준, 롱팬츠면 사람이 크기를 더 키울 수 있어요)
          shoes: 0.10,
          hair: 0.16,
          accessory: 0.14,
        };
        let autoScale = 1;
        if(cat === 'top' || cat === 'outer'){
          // 상의·아우터는 세로 길이보다 "소매가 마네킹의 T포즈 팔 벌린 폭과 맞는지"가 훨씬
          // 눈에 잘 띄어요. 옷마다 원래 만들어진 가로세로 비율이 서로 달라서(팔을 넓게 벌린
          // 형태로 만들어진 옷도 있어요), 세로 길이 기준으로 맞추면 소매가 마네킹 팔보다
          // 훨씬 좁아져서 몸에 딱 붙어 보이는 문제가 있었어요. 그래서 마네킹의 실제 팔 벌린
          // 폭에 맞춰 스케일을 잡아요.
          const mannequinWidth = scanMannequinDefaultHeight * scanMannequinWidthRatio;
          if(bounds.width > 0 && mannequinWidth > 0){
            autoScale = mannequinWidth / bounds.width;
          } else if(garmentHeight > 0 && scanMannequinDefaultHeight > 0){
            autoScale = (scanMannequinDefaultHeight * CATEGORY_TARGET_FRACTION[cat]) / garmentHeight; // 폭 정보가 없을 때의 대체 계산
          }
        } else if(garmentHeight > 0 && scanMannequinDefaultHeight > 0){
          const targetFraction = CATEGORY_TARGET_FRACTION[cat] ?? 0.35;
          autoScale = (scanMannequinDefaultHeight * targetFraction) / garmentHeight;
        }
        autoScale = Math.min(Math.max(autoScale, 0.02), 5);

        // 마네킹의 기준점(원점)이 대략 배·허리 높이에 있어서, 아무 위치 지정 없이 입히면
        // 전부 그 지점에서 시작해요. 얼굴 메이크업 때처럼, 마네킹을 직접 측정해서 얻은
        // 실측 좌표를 기준으로 카테고리별 "기준선"에 옷의 위쪽/아래쪽 끝을 맞춰요
        // (그냥 옷 중심을 아무 높이에나 놓는 것보다 훨씬 정확하게 시작돼요).
        //
        // 중요: 옷은 마네킹의 "자식"으로 붙어있어서, 옷의 position은 마네킹 자신의 로컬
        // 좌표계(스케일 1, 원점) 안에서 해석돼요. 그래서 절대 좌표(예: "어깨는 항상 Y=1.28")를
        // 그대로 쓰면, 마네킹 키를 슬라이더로 바꾸거나 "마네킹 상하 위치"를 옮겨놨을 때
        // 마네킹 자신의 스케일·위치가 옷에도 또 한 번 곱해지면서 기준선이 어긋나는 문제가
        // 있었어요(예: 후드가 가슴에 걸리는 등). 그래서 절대 좌표 대신, 마네킹의 실측
        // 로컬 키(scanMannequinDefaultHeight)에 대한 "비율"로 기준선을 잡아요 — 이러면
        // 마네킹을 아무리 옮기거나 크기를 바꿔도 항상 정확히 따라가요.
        //  - 어깨선 ≈ 키의 77.6% (상의·아우터를 이 높이에 걸쳐요)
        //  - 골반/허리선 ≈ 키의 47.3% (하의 허리단을 이 높이에 맞춰요)
        //  - 발바닥 = 마네킹 로컬 최하단 (신발 밑창을 이 높이에 맞춰요)
        //  - 머리 시작 ≈ 키의 78.8% (헤어 아이템 아래쪽을 이 높이부터 올려요)
        //  - 가슴~목 ≈ 키의 69.7% (장신구 등)
        const mannequinBottomY = scanMannequinDefaultMinY;
        const SHOULDER_Y = mannequinBottomY + scanMannequinDefaultHeight * 0.776;
        const WAIST_Y = mannequinBottomY + scanMannequinDefaultHeight * 0.473;
        const HAIR_Y = mannequinBottomY + scanMannequinDefaultHeight * 0.788;
        const CHEST_Y = mannequinBottomY + scanMannequinDefaultHeight * 0.697;

        const scaledMinY = bounds.minY * autoScale;
        const scaledMaxY = bounds.maxY * autoScale;
        let targetY;
        if(cat === 'top' || cat === 'outer'){
          targetY = SHOULDER_Y - scaledMaxY; // 옷의 "위쪽 끝"(어깨선)을 마네킹 어깨선에 맞춰요.
        } else if(cat === 'bottom'){
          targetY = WAIST_Y - scaledMaxY; // 옷의 "위쪽 끝"(허리단)을 마네킹 골반선에 맞춰요.
        } else if(cat === 'shoes'){
          targetY = mannequinBottomY - scaledMinY; // 신발의 "아래쪽 끝"(밑창)을 마네킹 발바닥에 맞춰요.
        } else if(cat === 'hair'){
          targetY = HAIR_Y - scaledMinY; // 헤어의 "아래쪽 끝"을 목 밑동 높이부터 올려요.
        } else {
          targetY = CHEST_Y - (scaledMinY + scaledMaxY) / 2; // 장신구 등은 가슴~목 높이에 중심을 맞춰요.
        }

        garment.position.set(0, targetY, 0);
        garment.scale.set(autoScale, autoScale, autoScale);

        wornGarments[cat] = garment;
        activeGarmentCategory = cat; // 방금 입은 걸 바로 색칠/무늬 편집할 수 있게 활성화해요.
        garmentColorInput.value = '#ffffff';
        renderWornGarmentChips();
        garmentStatus.textContent = `${label || '아이템'}을(를) 몸에 맞춰 입혔어요! (${CATEGORY_LABEL_3D[cat] || cat})`;
        garmentControls.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        // 새 옷을 입었으니, 2단계 무늬 패널의 "적용할 부위" 목록도 새로 고쳐줘요.
        if(typeof window.refreshPatternPartOptions === 'function') window.refreshPatternPartOptions();
      },
      undefined,
      () => {
        garmentStatus.textContent = '아이템을 불러오지 못했어요. .glb 파일이 맞는지 확인해주세요.';
      }
    );
  }

  garmentColorInput.addEventListener('input', () => applyGarmentColor(garmentColorInput.value));
  garmentColorResetBtn.addEventListener('click', () => {
    garmentColorInput.value = '#ffffff';
    applyGarmentColor('#ffffff');
  });

  garmentRemoveBtn.addEventListener('click', () => {
    if(activeGarmentCategory && wornGarments[activeGarmentCategory]){
      scanMannequin.remove(wornGarments[activeGarmentCategory]);
      const removedLabel = CATEGORY_LABEL_3D[activeGarmentCategory] || activeGarmentCategory;
      delete wornGarments[activeGarmentCategory];
      // 남아있는 다른 부위가 있으면 그중 하나를 새로 활성화하고, 없으면 패널을 접어요.
      const remaining = GARMENT_CATEGORIES.filter(cat => wornGarments[cat]);
      activeGarmentCategory = remaining[0] || null;
      renderWornGarmentChips();
      garmentStatus.textContent = `${removedLabel}을(를) 벗었어요.`;
      if(typeof window.refreshPatternPartOptions === 'function') window.refreshPatternPartOptions();
    }
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
