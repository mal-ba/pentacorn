// pentacorn 서비스 워커
// "설치 가능한 앱(PWA)"이 되려면 서비스 워커가 최소한 등록은 되어 있어야 해요.
// 지금은 오프라인 캐싱 같은 고급 기능 없이, 등록 요건만 충족하는 최소 버전이에요.
// (나중에 오프라인에서도 일부 화면이 보이게 하고 싶으면 여기에 캐싱 로직을 추가하면 돼요)

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // 지금은 그냥 네트워크 요청을 그대로 통과시켜요 (캐싱 없음).
});
