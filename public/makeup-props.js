// ====== makeup-props.js : 메이크업 "소품" 오브젝트를 코드로 직접 만들어요 ======
// 얼굴 3D 모델(makeup-face.glb)에 붙일 수 있는 간단한 메이크업 소품들(립스틱/블러셔/
// 아이섀도우/아이라이너)을 Three.js 도형(Geometry)으로 직접 만들어요. 업로드된 .glb 파일이
// 따로 없어도, 이 파일 하나로 바로 꾸며볼 수 있어요.
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
  });
}

// 입술 모양에 가깝게 살짝 둥근 평면을 만들어요.
function createLipstick(color){
  const shape = new THREE.Shape();
  shape.moveTo(-0.09, 0);
  shape.quadraticCurveTo(-0.05, 0.028, 0, 0.02);
  shape.quadraticCurveTo(0.05, 0.028, 0.09, 0);
  shape.quadraticCurveTo(0.05, -0.03, 0, -0.024);
  shape.quadraticCurveTo(-0.05, -0.03, -0.09, 0);
  const geo = new THREE.ShapeGeometry(shape, 12);
  const mesh = new THREE.Mesh(geo, makeDecalMaterial(color, 0.88));
  mesh.name = 'lipstick';
  return mesh;
}

// 양 볼에 둥근 블러셔 두 개.
function createBlush(color){
  const group = new THREE.Group();
  const geo = new THREE.CircleGeometry(0.075, 28);
  const left = new THREE.Mesh(geo, makeDecalMaterial(color, 0.32));
  left.position.set(-0.155, -0.02, 0.01);
  const right = new THREE.Mesh(geo, makeDecalMaterial(color, 0.32));
  right.position.set(0.155, -0.02, 0.01);
  group.add(left, right);
  group.name = 'blush';
  return group;
}

// 양쪽 눈두덩이에 아이섀도우 두 개.
function createEyeshadow(color){
  const group = new THREE.Group();
  const geo = new THREE.CircleGeometry(0.055, 24);
  geo.scale(1.5, 1, 1); // 눈 모양에 가깝게 가로로 살짝 늘려요.
  const left = new THREE.Mesh(geo, makeDecalMaterial(color, 0.55));
  left.position.set(-0.1, 0.02, 0.01);
  const right = new THREE.Mesh(geo, makeDecalMaterial(color, 0.55));
  right.position.set(0.1, 0.02, 0.01);
  group.add(left, right);
  group.name = 'eyeshadow';
  return group;
}

// 눈꼬리 라인 느낌의 얇은 선(가는 사각형) 두 개.
function createEyeliner(color){
  const group = new THREE.Group();
  const geo = new THREE.PlaneGeometry(0.045, 0.008);
  const left = new THREE.Mesh(geo, makeDecalMaterial(color, 0.9));
  left.position.set(-0.125, 0.0, 0.015);
  left.rotation.z = 0.25;
  const right = new THREE.Mesh(geo, makeDecalMaterial(color, 0.9));
  right.position.set(0.125, 0.0, 0.015);
  right.rotation.z = -0.25;
  group.add(left, right);
  group.name = 'eyeliner';
  return group;
}

// 각 소품의 기본 정보예요. position은 "얼굴 모델을 정면에서 봤을 때" 기준 대략적인
// 기본 위치(모델마다 조금씩 다를 수 있어서, 사용자가 슬라이더로 최종 조정해요).
export const MAKEUP_PROP_DEFS = [
  { id: 'lipstick', label: '립스틱', defaultColor: '#B23A48', create: createLipstick, position: [0, -0.62, 0.42] },
  { id: 'blush', label: '블러셔', defaultColor: '#E8A0A0', create: createBlush, position: [0, -0.28, 0.4] },
  { id: 'eyeshadow', label: '아이섀도우', defaultColor: '#8A6BAE', create: createEyeshadow, position: [0, 0.06, 0.42] },
  { id: 'eyeliner', label: '아이라이너', defaultColor: '#1A1A1A', create: createEyeliner, position: [0, 0.06, 0.44] },
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
