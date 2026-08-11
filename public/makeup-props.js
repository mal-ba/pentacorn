// ====== makeup-props.js : 메이크업 "소품" 오브젝트를 코드로 직접 만들어요 ======
// 얼굴 3D 모델(makeup-face.glb)에 붙일 수 있는 간단한 메이크업 소품들(머리카락/립스틱/블러셔/
// 아이섀도우/아이라이너)을 Three.js 도형(Geometry)으로 직접 만들어요. 업로드된 .glb 파일이
// 따로 없어도, 이 파일 하나로 바로 꾸며볼 수 있어요.
//
// 아래 좌표들은 makeup-face.glb 메쉬의 실제 정점(vertex) 데이터를 분석해서 얻은 값이에요
// (Python으로 얼굴 표면을 깊이별로 스캔해서 코끝/눈/입/이마 위치를 직접 측정했어요).
// 모델을 다른 파일로 바꾸면 이 좌표들도 다시 맞춰야 할 수 있어요.
import * as THREE from 'three';

function makeDecalMaterial(color, opacity){
  return new THREE.MeshStandardMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    roughness: 0.55,
    metalness: 0,
    depthWrite: false, // 얼굴 표면 위에 살짝 떠 있는 느낌으로, z-fighting(깜빡거림)을 막아요.
    polygonOffset: true,
    polygonOffsetFactor: -1, // 얼굴 표면에 파묻히지 않고 살짝 앞에 뜨도록 밀어내요.
  });
}

// 입술 모양에 가깝게 살짝 둥근 평면을 만들어요. (측정한 입 폭 약 0.20 기준)
function createLipstick(color){
  const shape = new THREE.Shape();
  shape.moveTo(-0.1, 0);
  shape.quadraticCurveTo(-0.05, 0.03, 0, 0.022);
  shape.quadraticCurveTo(0.05, 0.03, 0.1, 0);
  shape.quadraticCurveTo(0.05, -0.032, 0, -0.026);
  shape.quadraticCurveTo(-0.05, -0.032, -0.1, 0);
  const geo = new THREE.ShapeGeometry(shape, 12);
  const mesh = new THREE.Mesh(geo, makeDecalMaterial(color, 0.88));
  mesh.name = 'lipstick';
  return mesh;
}

// 양 볼에 둥근 블러셔 두 개. (측정한 볼 중심 X ±0.207 기준)
function createBlush(color){
  const group = new THREE.Group();
  const geo = new THREE.CircleGeometry(0.075, 28);
  const left = new THREE.Mesh(geo, makeDecalMaterial(color, 0.32));
  left.position.set(-0.207, 0, 0);
  const right = new THREE.Mesh(geo, makeDecalMaterial(color, 0.32));
  right.position.set(0.207, 0, 0);
  group.add(left, right);
  group.name = 'blush';
  return group;
}

// 양쪽 눈두덩이에 아이섀도우 두 개. (측정한 눈 중심 X ±0.145 기준, 눈보다 살짝 위)
function createEyeshadow(color){
  const group = new THREE.Group();
  const geo = new THREE.CircleGeometry(0.06, 24);
  geo.scale(1.5, 1, 1); // 눈 모양에 가깝게 가로로 살짝 늘려요.
  const left = new THREE.Mesh(geo, makeDecalMaterial(color, 0.55));
  left.position.set(-0.145, 0, 0);
  const right = new THREE.Mesh(geo, makeDecalMaterial(color, 0.55));
  right.position.set(0.145, 0, 0);
  group.add(left, right);
  group.name = 'eyeshadow';
  return group;
}

// 눈꼬리 라인 느낌의 얇은 선(가는 사각형) 두 개. (측정한 눈 중심 X ±0.145 기준)
function createEyeliner(color){
  const group = new THREE.Group();
  const geo = new THREE.PlaneGeometry(0.05, 0.008);
  const left = new THREE.Mesh(geo, makeDecalMaterial(color, 0.9));
  left.position.set(-0.145, -0.01, 0);
  left.rotation.z = 0.2;
  const right = new THREE.Mesh(geo, makeDecalMaterial(color, 0.9));
  right.position.set(0.145, -0.01, 0);
  right.rotation.z = -0.2;
  group.add(left, right);
  group.name = 'eyeliner';
  return group;
}

// 머리카락 "정수리 캡": 4방향 사진으로도 안 찍히는 머리 꼭대기 부분만 작게 덮는 단색 돔이에요.
// (Y≈0.82부터 정수리 Y=1.0까지만 — 나머지 옆·뒤는 createAngledPatch로 만든 실제 사진이 덮어요)
function createHair(color){
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI * 0.29);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  const dome = new THREE.Mesh(geo, mat);
  dome.scale.set(0.46, 0.46, 0.52);
  dome.position.set(0, 1.0 - 0.46, -0.04);
  group.add(dome);
  group.name = 'hair';
  return group;
}

// 각도별 사진 곡면 패치를 만드는 범용 함수예요. 얼굴(정면/좌/우)이랑 머리카락 밴드(정면/좌/우/뒤)
// 둘 다 이 함수 하나로 만들어요 — 어느 각도에서 찍은 사진인지(thetaCenter)와, 세로로 얼마나
// 덮을지(yTop~yBottom)만 다르게 넣어주면 돼요.
//
// 참고: CylinderGeometry는 각도(theta) 0이 정면(+Z, 카메라 쪽)이에요. theta가 양수면 +X(화면
// 오른쪽), 음수면 -X(화면 왼쪽), π(180도)면 완전히 뒤쪽이에요.
export function createAngledPatch({ cutoutCanvas, thetaCenter = 0, thetaWidth = 2.1, yTop, yBottom, radius = 0.5 }){
  if(!cutoutCanvas) return null;
  const height = yTop - yBottom;
  const thetaStart = thetaCenter - thetaWidth / 2;
  const geo = new THREE.CylinderGeometry(radius, radius, height, 28, 1, true, thetaStart, thetaWidth);

  const texture = new THREE.CanvasTexture(cutoutCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.3,
    side: THREE.DoubleSide,
    roughness: 0.8,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  const patch = new THREE.Mesh(geo, mat);
  patch.position.set(0, yBottom + height / 2, 0);
  patch.name = 'angledPatch';
  return patch;
}

// 각 부위별 각도 정보예요. 얼굴은 턱(Y≈-0.22)~이마 위(Y≈0.58)까지, 머리카락 밴드는
// 이마 위(Y≈0.58)부터 정수리 캡이 시작하는 지점(Y≈0.82)까지를 덮어요.
export const FACE_PATCH_ANGLES = [
  { key: 'front', thetaCenter: 0, thetaWidth: 2.1 },
  { key: 'left', thetaCenter: 1.75, thetaWidth: 1.5 },   // 사진 속 "얼굴 왼쪽"이 보이는 촬영본 → 정면 기준 +X(화면 오른쪽) 방향에 붙여요.
  { key: 'right', thetaCenter: -1.75, thetaWidth: 1.5 }, // "얼굴 오른쪽" 촬영본 → -X(화면 왼쪽) 방향.
];
export const FACE_PATCH_Y = { yTop: 0.58, yBottom: -0.22, radius: 0.5 };

export const HAIR_BAND_ANGLES = [
  { key: 'front', thetaCenter: 0, thetaWidth: 2.6 },
  { key: 'left', thetaCenter: 1.75, thetaWidth: 1.9 },
  { key: 'right', thetaCenter: -1.75, thetaWidth: 1.9 },
  { key: 'back', thetaCenter: Math.PI, thetaWidth: 2.3 },
];
export const HAIR_BAND_Y = { yTop: 0.85, yBottom: 0.55, radius: 0.47 };

// ---------- 몸통(체형 스캔 마네킹, mannequin.glb) 패치 각도 정보 ----------
// mannequin.glb는 팔을 양옆으로 뻗은 T포즈 리깅 캐릭터예요. 팔은 사진(팔을 내린 자세)이랑
// 포즈가 안 맞아서 패치를 안 씌우고, 포즈 영향이 없는 "몸통(어깨선~골반선)"에만 씌워요.
// 좌표는 mannequin.glb(키 1.596 기준)의 정점을 Python으로 직접 측정해서 얻었어요:
//  - 어깨/목 밑동 높이: Y≈1.28
//  - 골반(엉덩이) 높이: Y≈0.78
//  - 허리 폭: X 약 ±0.13
export const BODY_TORSO_ANGLES = [
  { key: 'front', thetaCenter: 0, thetaWidth: 2.1 },
  { key: 'left', thetaCenter: 1.75, thetaWidth: 1.6 },
  { key: 'right', thetaCenter: -1.75, thetaWidth: 1.6 },
  { key: 'back', thetaCenter: Math.PI, thetaWidth: 1.9 },
];
export const BODY_TORSO_Y = { yTop: 1.28, yBottom: 0.78, radius: 0.17 };

// 각 소품의 기본 정보예요. position은 makeup-face.glb 모델을 실제로 측정해서 얻은
// 좌표라, 대부분은 슬라이더 없이도 바로 얼굴에 맞아요. 그래도 조금씩 다르게 나올 수 있어서
// 미세 조정(좌우/위아래/앞뒤/크기) 슬라이더로 마지막 손질을 할 수 있게 해뒀어요.
export const MAKEUP_PROP_DEFS = [
  { id: 'hair', label: '머리카락(정수리)', defaultColor: '#2B2320', create: createHair, position: [0, 0, 0] },
  { id: 'lipstick', label: '립스틱', defaultColor: '#B23A48', create: createLipstick, position: [0, 0.075, 0.545] },
  { id: 'blush', label: '블러셔', defaultColor: '#E8A0A0', create: createBlush, position: [0, 0.20, 0.40] },
  { id: 'eyeshadow', label: '아이섀도우', defaultColor: '#8A6BAE', create: createEyeshadow, position: [0, 0.53, 0.36] },
  { id: 'eyeliner', label: '아이라이너', defaultColor: '#1A1A1A', create: createEyeliner, position: [0, 0.475, 0.375] },
];

// 소품 하나에 색을 다시 입힐 때 써요 (group이든 단일 mesh든 안까지 다 훑어서 칠해요).
export function recolorProp(object3d, hexColor){
  object3d.traverse(node => {
    if(node.isMesh && node.material && node.material.color){
      node.material.color.set(hexColor);
      node.material.needsUpdate = true;
    }
  });
}

