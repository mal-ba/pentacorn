// ====== segment-utils.js : 사진에서 특정 부위(머리카락/얼굴피부/몸피부 등)만 오려내는 공용 도구 ======
// Google의 MediaPipe Image Segmenter를 브라우저 안에서 바로 돌려요(서버로 사진을 보내지 않아요).
// 메이크업 얼굴(makeup.js)이랑 체형 스캔 몸통(customize-3d.js) 양쪽에서 똑같이 이 파일을 가져다 써요.
//
// selfie_multiclass 모델의 카테고리 순서: 0=배경, 1=머리카락, 2=몸피부, 3=얼굴피부, 4=옷, 5=기타
export const SEG_CATEGORY = {
  BACKGROUND: 0,
  HAIR: 1,
  BODY_SKIN: 2,
  FACE_SKIN: 3,
  CLOTHES: 4,
  OTHER: 5,
};

let imageSegmenterPromise = null;

export function getImageSegmenter(){
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

// 픽셀이 주어진 카테고리 목록에 속하는 부분만 남기고(나머지는 투명 처리) 꽉 차게 잘라낸 캔버스를 돌려줘요.
function cropByCategories(srcCanvas, originalImgData, maskData, maskW, maskH, categorySet){
  const w0 = srcCanvas.width, h0 = srcCanvas.height;
  const imgData = new ImageData(new Uint8ClampedArray(originalImgData.data), w0, h0);
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

// 사진 한 장을 AI로 한 번만 분석해서, groups에 정의한 여러 부위를 한꺼번에 오려내요.
// groups 예: { hair: [1], face: [2,3] } → { hair: canvas|null, face: canvas|null }
export async function analyzePhotoBySegments(dataUrl, groups){
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = dataUrl;
  });

  const segmenter = await getImageSegmenter();
  const result = segmenter.segment(img);
  const mask = result.categoryMask;
  const out = {};
  Object.keys(groups).forEach(key => { out[key] = null; });
  if(!mask) return out;

  const maskData = mask.getAsUint8Array();
  const maskW = mask.width, maskH = mask.height;

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = img.naturalWidth;
  srcCanvas.height = img.naturalHeight;
  const ctx = srcCanvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const originalImgData = ctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);

  Object.entries(groups).forEach(([key, categories]) => {
    out[key] = cropByCategories(srcCanvas, originalImgData, maskData, maskW, maskH, new Set(categories));
  });

  if(mask.close) mask.close(); // MPMask는 다 쓰고 나면 메모리를 명시적으로 해제해줘요.
  return out;
}

// 사진의 특정 위쪽 구간 픽셀 색을 평균 내는 대체(fallback) 방식이에요. AI 인식이 실패했을 때만 써요.
export function sampleAverageColorFromPhoto(dataUrl, topFraction = 0.22){
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try{
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const sampleHeight = Math.max(1, Math.floor(img.height * topFraction));
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
