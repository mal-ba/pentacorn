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

// 머리카락: 정수리를 덮는 돔 모양이에요. 눈(Y≈0.475)보다 한참 위인 Y≈0.58부터
// 시작해서 정수리(Y=1.0)까지 덮기 때문에, 얼굴(눈·코·입)과는 절대 겹치지 않아요.
//
// cutoutCanvas가 있으면(AI가 사진에서 머리카락만 오려낸 이미지) 그 이미지를 돔의 앞면에
// 텍스처로 입혀서 "그 사람 사진 속 머리카락"이 그대로 보이게 하고, 없으면(인식 실패 시)
// 단색으로 채워요.
function createHair(color, cutoutCanvas){
  const group = new THREE.Group();
  // phi: 정면(+Z)을 중심으로 좌우 약 91.5도씩, 총 183도 정도만 덮어요 (뒤통수는 안 덮음 —
  // 카메라로 정면만 찍은 사진이라 뒤쪽 텍스처가 없기 때문에, 이렇게 해야 안 이상해요).
  // theta: 정수리에서부터 눈썹보다 위(귀 윗부분 정도)까지만 덮어요.
  const geo = new THREE.SphereGeometry(1, 48, 28, Math.PI / 2 - 1.6, 3.2, 0, Math.PI * 0.472);

  let mat;
  if(cutoutCanvas){
    const texture = new THREE.CanvasTexture(cutoutCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    mat = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.3, // 투명한 부분(머리카락이 아닌 부분)은 아예 안 그려서, 네모난 카드처럼 안 보이게 해요.
      side: THREE.DoubleSide,
      roughness: 0.75,
      metalness: 0,
    });
  } else {
    mat = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  }

  const dome = new THREE.Mesh(geo, mat);
  // 머리 폭(X 약 0.41), 앞뒤 깊이(이마~뒤통수)에 맞춰 타원형으로 눌러줘요.
  dome.scale.set(0.46, 0.46, 0.52);
  // 정수리(Y=1.0)에 돔의 꼭짓점이 오도록, 돔 중심을 아래로 내려요. (1.0 - scaleY)
  dome.position.set(0, 1.0 - 0.46, -0.04);
  group.add(dome);
  group.name = 'hair';
  return group;
}

// 각 소품의 기본 정보예요. position은 makeup-face.glb 모델을 실제로 측정해서 얻은
// 좌표라, 대부분은 슬라이더 없이도 바로 얼굴에 맞아요. 그래도 조금씩 다르게 나올 수 있어서
// 미세 조정(좌우/위아래/앞뒤/크기) 슬라이더로 마지막 손질을 할 수 있게 해뒀어요.
export const MAKEUP_PROP_DEFS = [
  { id: 'hair', label: '머리카락', defaultColor: '#2B2320', create: createHair, position: [0, 0, 0] },
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
