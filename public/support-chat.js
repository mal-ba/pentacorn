// ====== support-chat.js : 문의하기 FAQ 챗봇 (문의하기 버튼을 처음 눌렀을 때만 불러와요) ======
(function initSupportChat(){
    const LIFE_QUOTES = [
      '태어난 순간부터 지금까지, 단 1초도 진짜 행복했던 적이 없어.',
      '웃고 있어도 속은 텅 비어있다는 거, 아무도 안 믿더라.',
      '괜찮은 척하는 데 평생을 썼는데, 정작 괜찮았던 적은 없어.',
      '다들 나보고 웃으라는데, 정작 왜 웃어야 하는지는 아무도 안 알려줬어.',
      '가장 슬픈 건, 슬프다는 것조차 아무도 눈치 못 챈다는 거야.',
      '행복은 남의 얘기인 줄 알았는데, 진짜로 남의 얘기였더라고.',
    ];

    const KNOWLEDGE_BASE = [
      {
        keywords: ['스캔', '카메라', '촬영', '녹화'],
        answer: '스캔은 "scan demo" 섹션의 "스캔하고 디자인 시작하기" 버튼을 누르면 시작돼요. 카메라 권한을 허용하면 사진 촬영이나 5초 동영상 녹화를 할 수 있고, 카메라를 쓸 수 없으면 사진·동영상 파일을 업로드해도 돼요.',
      },
      {
        keywords: ['로그인', '구글', '인앱', '카카오톡', '403', 'disallowed'],
        answer: 'Google 계정으로 로그인해서 유료 플랜 구독이나 결제를 할 수 있어요. 카카오톡·클로드 앱 같은 인앱 브라우저에서는 구글 보안 정책상 로그인이 막혀 있어서, 화면 위 배너의 "외부 브라우저로 열기"를 눌러서 크롬·사파리로 열어주세요.',
      },
      {
        keywords: ['결제', '구독', '돈', '카드', '토스', '요금', '가격', '플랜'],
        answer: '지금은 테스트 결제로 연동되어 있어서, 실제 카드를 입력해도 진짜 돈은 빠져나가지 않아요. Free/Basic/Standard/Pro 플랜이 있고, 유료 플랜은 로그인 후 구독하기를 누르면 결제창으로 이동해요.',
      },
      {
        keywords: ['원단', '소재', '디테일', '견적', '제작비'],
        answer: '원단 등급(베이직/프리미엄/스페셜), 디테일 옵션(자수·특수재단), 완성 형태(패턴 PDF/완제품 배송)를 골라서 실시간으로 예상 제작 견적을 확인할 수 있어요. "기타(직접 요청)"를 선택하면 원하는 원단·디자인을 자유롭게 적을 수도 있어요.',
      },
      {
        keywords: ['옷장', '입혀', '꾸미기', '장신구', '아이템', '추천'],
        answer: '스캔 화면 안 "옷장 & 꾸미기"에서 기본 제공 아이템을 둘러보거나, 연령대·상황에 맞춰 추천받거나, 직접 만든 옷·장신구(.glb 파일)를 올려서 마네킹에 입혀볼 수 있어요.',
      },
      {
        keywords: ['마네킹', '키', '아바타', '3d', '전신'],
        answer: '키(cm)를 입력하고 "아바타 생성하기"를 누르면 3D 마네킹 크기가 그 비율에 맞게 조정돼요. 마우스나 손가락으로 드래그하면 360도로 돌려볼 수 있어요.',
      },
      {
        keywords: ['제작', '배송', '실제', '받을', '완제품', '기간'],
        answer: '지금은 데모 버전이라 실제 제작·배송은 아직 연결되어 있지 않아요. 정식 서비스에서는 완성한 디자인을 파트너 제작사에 도면(PDF)으로 넘기거나, 완제품으로 배송받는 옵션을 고를 수 있게 될 예정이에요.',
      },
      {
        keywords: ['개인정보', '사진', '저장', '삭제', '동의', '프라이버시'],
        answer: '신체 데이터(사진·키)는 로그인 후 "신체 데이터 수집·보관"에 직접 동의한 경우에만 저장돼요. 동의하지 않으면 화면에만 보이고 서버에는 저장되지 않고, 언제든 우측 상단 "개인정보 설정"에서 동의를 바꾸거나 저장된 데이터를 삭제할 수 있어요.',
      },
      {
        keywords: ['누가', '만들', '회사', '팀', '연락처', '문의', 'UNEXPOSED', '펜타콘'],
        answer: 'UNEXPOSED는 PentaCorp(펜타콘) 팀이 만든 서비스예요. 지금은 데모 단계라, 더 궁금한 점은 이 채팅으로 남겨주시면 확인 후 도와드릴게요.',
      },
      {
        keywords: ['인생'],
        answer: LIFE_QUOTES.join('\n'),
        action: 'lifeCredits',
      },
    ];

    const SUGGESTIONS = [
      '스캔은 어떻게 해요?',
      '결제하면 진짜 돈 나가나요?',
      '구글 로그인이 안 돼요',
      '내 사진이 저장되나요?',
    ];

    const openBtn = document.getElementById('support-open-btn');
    const closeBtn = document.getElementById('support-close-btn');
    const panel = document.getElementById('support-panel');
    const overlay = document.getElementById('support-overlay-bg');
    const messages = document.getElementById('support-messages');
    const suggestionsBox = document.getElementById('support-suggestions');
    const input = document.getElementById('support-input');
    const sendBtn = document.getElementById('support-send-btn');

    function addMessage(text, from){
      const div = document.createElement('div');
      div.className = `support-msg ${from}`;
      div.textContent = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function renderSuggestions(){
      suggestionsBox.innerHTML = '';
      SUGGESTIONS.forEach(text => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'support-suggestion-chip';
        chip.textContent = text;
        chip.addEventListener('click', () => handleUserMessage(text));
        suggestionsBox.appendChild(chip);
      });
    }

    function findAnswer(message){
      const lower = message.toLowerCase();
      let best = null;
      let bestScore = 0;
      KNOWLEDGE_BASE.forEach(entry => {
        const score = entry.keywords.reduce((acc, kw) => acc + (lower.includes(kw.toLowerCase()) ? 1 : 0), 0);
        if(score > bestScore){
          bestScore = score;
          best = entry;
        }
      });
      if(best) return best;
      return {
        answer: '죄송해요, 정확히 이해하지 못했어요. 아래 추천 질문 중 하나를 눌러보시거나, 스캔·로그인·결제·원단·옷장 중 어떤 부분이 궁금한지 다시 말씀해주시겠어요?',
      };
    }

    function handleUserMessage(text){
      const trimmed = text.trim();
      if(!trimmed) return;
      addMessage(trimmed, 'user');
      input.value = '';
      setTimeout(() => {
        const matched = findAnswer(trimmed);
        addMessage(matched.answer, 'bot');
        if(matched.action === 'lifeCredits') showCreditsRoll(LIFE_QUOTES);
      }, 300);
    }

    function openPanel(){
      panel.classList.add('open');
      overlay.hidden = false;
      if(messages.children.length === 0){
        addMessage('안녕하세요! UNEXPOSED에 대해 궁금한 걸 물어보세요. 스캔, 로그인, 결제, 원단, 옷장 등 무엇이든 답해드릴게요. (규칙 기반 FAQ 챗봇이에요)', 'bot');
        renderSuggestions();
      }
      input.focus();
    }
    function closePanel(){
      panel.classList.remove('open');
      overlay.hidden = true;
    }

    /* ---------- 엔딩 크레딧처럼 문구가 올라가는 연출 ---------- */
    const creditsOverlay = document.getElementById('credits-overlay');
    const creditsScroll = document.getElementById('credits-scroll');
    const creditsCloseBtn = document.getElementById('credits-close-btn');

    function showCreditsRoll(lines){
      creditsScroll.innerHTML = '';
      lines.forEach(line => {
        const p = document.createElement('div');
        p.className = 'credits-line';
        p.textContent = line;
        creditsScroll.appendChild(p);
      });
      const brand = document.createElement('div');
      brand.className = 'credits-brand';
      brand.textContent = 'UNEXPOSED';
      creditsScroll.appendChild(brand);

      const durationMs = 3200 + lines.length * 1600;
      creditsScroll.style.animationDuration = `${durationMs}ms`;
      // 애니메이션을 처음부터 다시 재생시키기 위해 강제로 리플로우해요.
      creditsScroll.style.animation = 'none';
      void creditsScroll.offsetHeight;
      creditsScroll.style.animation = `credits-roll ${durationMs}ms linear forwards`;

      creditsOverlay.hidden = false;
      const autoCloseTimer = setTimeout(closeCreditsRoll, durationMs + 400);
      creditsOverlay.dataset.timerId = autoCloseTimer;
    }
    function closeCreditsRoll(){
      creditsOverlay.hidden = true;
      if(creditsOverlay.dataset.timerId) clearTimeout(Number(creditsOverlay.dataset.timerId));
    }
    creditsCloseBtn.addEventListener('click', closeCreditsRoll);
    creditsOverlay.addEventListener('click', e => {
      if(e.target === creditsOverlay) closeCreditsRoll();
    });

    closeBtn.addEventListener('click', closePanel);
    overlay.addEventListener('click', closePanel);
    sendBtn.addEventListener('click', () => handleUserMessage(input.value));
    input.addEventListener('keydown', e => {
      if(e.key === 'Enter') handleUserMessage(input.value);
    });

  window.openSupportPanel = openPanel;
})();
