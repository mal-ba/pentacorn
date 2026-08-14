// ====== menu-loader.js : 홈이 아닌 개별 페이지(소개/이용방법/개인정보/배송/협력업체/Meshy가이드)에서
// 왼쪽 메뉴를 다시 열 수 있게 해주는 공용 스크립트예요. index.html의 메뉴 로딩 로직과 같은
// /side-menu.html, /side-menu.css를 그대로 재사용해요.
//
// 로그인 영역(#menu-auth-box)은 여기서는 안 채워요 — 로그인에 필요한 GOOGLE_CLIENT_ID는
// 지금 서버에서 index.html/admin.html에만 치환해서 내려주고 있어서, 이 페이지들에선 그
// 값을 알 수 없어요. 빈 채로 둬도 CSS가 알아서 그 영역을 숨겨줘서(side-menu.css의
// .side-menu-auth:empty 규칙) 화면이 어색해 보이지 않아요. 메뉴 목록(소개/이용방법 등)은
// 정상적으로 다 보이고 눌러서 이동할 수 있어요.
(function(){
  const menuToggleBtn = document.getElementById('menu-toggle-btn');
  if(!menuToggleBtn) return;

  let sideMenuLoaded = false;
  let sideMenuLoading = null;

  function loadSideMenuBundle(){
    if(sideMenuLoaded) return Promise.resolve();
    if(sideMenuLoading) return sideMenuLoading;
    sideMenuLoading = (async () => {
      const cssLink = document.createElement('link');
      cssLink.rel = 'stylesheet';
      cssLink.href = '/side-menu.css';
      document.head.appendChild(cssLink);

      const html = await (await fetch('/side-menu.html')).text();
      const mount = document.getElementById('side-menu-mount');
      if(mount) mount.outerHTML = html;

      const overlay = document.getElementById('side-menu-overlay');
      const closeBtn = document.getElementById('side-menu-close-btn');
      if(closeBtn) closeBtn.addEventListener('click', () => { overlay.hidden = true; });
      if(overlay) overlay.addEventListener('click', e => { if(e.target === overlay) overlay.hidden = true; });

      sideMenuLoaded = true;
    })();
    return sideMenuLoading;
  }

  menuToggleBtn.addEventListener('click', async () => {
    await loadSideMenuBundle();
    document.getElementById('side-menu-overlay').hidden = false;
  });
})();
