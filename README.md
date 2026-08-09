# UNEXPOSED 서버 (구글 로그인 + 토스페이먼츠 결제)

기존 데모 HTML을 실제로 동작하는 서버로 만들었어요.
- **Google 로그인**: 진짜 구글 로그인 창이 뜨고, 서버가 토큰을 검증해요.
- **결제**: 토스페이먼츠 결제창으로 이동해서 결제하고, 결제 승인까지 서버가 처리해요.
- 지금은 **테스트 키**로 연동되어 있어서 진짜 카드로 결제해도 돈이 빠져나가지 않아요.

---

## 1. 설치

```bash
cd unexposed-server
npm install
```

## 2. 환경변수 설정

```bash
cp .env.example .env
```

`.env` 파일을 열어서 `GOOGLE_CLIENT_ID`를 채워주세요. (토스페이먼츠 키는 이미 테스트용으로 채워져 있어서 안 건드려도 돼요)

### 구글 클라이언트 ID 만들기 (5분)

1. https://console.cloud.google.com/ 접속 → 구글 계정으로 로그인
2. 상단에서 새 프로젝트 만들기 (예: "unexposed")
3. 왼쪽 메뉴 **API 및 서비스 → OAuth 동의 화면**
   - User Type: **외부(External)** 선택
   - 앱 이름, 이메일 등 기본 정보만 입력하고 저장 (게시 상태는 "테스트"로 둬도 우리끼리 테스트하는 덴 충분해요)
4. 왼쪽 메뉴 **API 및 서비스 → 사용자 인증 정보 → + 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
   - 애플리케이션 유형: **웹 애플리케이션**
   - **승인된 자바스크립트 원본**에 아래 두 개를 추가:
     ```
     http://localhost:3000
     ```
     (나중에 실제 도메인이 생기면 `https://yourdomain.com`도 추가하면 돼요)
   - 만들기를 누르면 **클라이언트 ID**가 나와요. 이 값을 `.env`의 `GOOGLE_CLIENT_ID`에 붙여넣으세요.

## 3. 서버 실행

```bash
npm start
```

브라우저에서 http://localhost:3000 접속하면 사이트가 떠요.

## 4. 테스트 해보기

1. **로그인**: 우측 상단(요금제 섹션)의 "Google 계정으로 로그인" 버튼 클릭 → 실제 구글 계정으로 로그인
2. **결제**: Basic/Standard/Pro 아무 플랜이나 "구독하기" 클릭 → 결제 모달에서 "결제하기" → 토스페이먼츠 결제창이 뜸
3. 테스트 환경이라 **아무 카드 정보(번호, 유효기간 등)를 넣어도 실제로는 승인만 가상으로 처리**돼요. 카드가 없다면 토스 결제창의 "카드" 대신 "가상계좌"나 "휴대폰"을 선택해서 진행해도 테스트가 돼요.
4. 결제가 끝나면 자동으로 사이트로 돌아오면서 "결제 완료" 화면이 뜨고, 요금제 카드에 "✓ 구독 중"으로 표시돼요.

---

## 5. 인터넷에 배포하기 (Render 기준)

로컬에서 잘 되는 걸 확인했다면, 이제 인터넷 어디서나 접속되게 올려보자.

### 5-1. 깃허브에 코드 올리기

Render는 깃허브 저장소랑 연결해서 배포해. 이 폴더를 깃허브 저장소로 만들어서 push 해두자.

```bash
cd unexposed-server
git init
git add .
git commit -m "초기 커밋"
```
그다음 깃허브에서 새 저장소를 만들고 (`.env` 파일은 절대 올리지 마세요! `.gitignore`에 이미 추가돼 있어요) push하면 돼요.

### 5-2. Render에서 배포하기

1. https://render.com 가입 (깃허브 계정으로 가입하면 편해요)
2. 대시보드에서 **New → Web Service** 클릭
3. 방금 만든 깃허브 저장소 선택
4. 설정값 입력:
   - **Name**: 원하는 이름 (예: unexposed-server)
   - **Region**: Singapore (한국에서 제일 가까움)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. **Environment Variables** 섹션에서 `.env`에 있던 값들을 하나씩 추가:
   - `GOOGLE_CLIENT_ID` = 발급받은 값
   - `SESSION_SECRET` = 랜덤 문자열
   - `TOSS_CLIENT_KEY` = `test_ck_D5GePWvyJnrK0W0k6q8gLzN97Eoq`
   - `TOSS_SECRET_KEY` = `test_sk_zXLkKEypNArWmo50nX3lmeaxYG5R`
   - `NODE_ENV` = `production`
6. **Create Web Service** 클릭 → 몇 분 기다리면 `https://unexposed-server.onrender.com` 같은 주소가 생겨요.

### 5-3. 구글 로그인이 새 주소에서도 되게 설정 추가

Render에서 받은 주소(`https://unexposed-server-xxxx.onrender.com`)를 Google Cloud Console → 사용자 인증 정보 → 만든 OAuth 클라이언트 → **승인된 자바스크립트 원본**에 추가로 등록해야 해요. (localhost 주소는 지우지 말고 그대로 두고 새 주소만 추가하면 로컬 테스트도 계속 가능해요)

### Render 무료 요금제에서 주의할 점

- 15분 동안 접속이 없으면 서버가 잠들어요(sleep). 잠든 상태에서 첫 방문자가 오면 서버가 다시 깨어나는 데 30초~1분 정도 걸릴 수 있어요. (데모/투자자 미팅 전엔 미리 한 번 접속해서 깨워두세요)
- 서버가 재시작되면 메모리에 저장된 로그인/구독 정보가 초기화돼요. 데모 단계에선 괜찮지만, 실서비스로 가면 데이터베이스가 꼭 필요해요.

### Railway를 쓰고 싶다면

과정이 거의 똑같아요: https://railway.app 가입 → New Project → Deploy from GitHub repo → 저장소 선택 → Variables 탭에서 위와 같은 환경변수 추가 → 배포. Railway는 무료 크레딧이 소진되면 유료로 전환되니, 사용량을 가끔 확인해주세요.


- **데이터 저장**: 지금은 로그인/구독 정보를 서버 메모리에만 저장해요. **서버를 재시작하면 다 사라져요.** 실제 서비스로 가려면 SQLite나 PostgreSQL 같은 진짜 데이터베이스가 필요해요.
- **매달 자동결제(정기결제)**: 지금 연동한 방식은 "1회 결제"예요. 매달 자동으로 청구되게 하려면 토스페이먼츠의 **자동결제(빌링)** API를 별도로 연동해야 해요 (카드 정보를 한 번 등록해두고 매달 서버가 알아서 결제 요청을 보내는 방식). 다음 단계로 필요하면 말해주세요.
- **실제 서비스로 배포하려면**:
  1. 서버를 인터넷에 올릴 호스팅이 필요해요 (예: Render, Railway, 카페24, AWS 등)
  2. 실제 도메인 + HTTPS 인증서
  3. 구글 클라우드 콘솔의 "승인된 자바스크립트 원본"에 실제 도메인 추가
  4. 토스페이먼츠 https://developers.tosspayments.com 에 가입 → 전자결제 신청(사업자 등록 필요) → 발급받은 **라이브 키**로 `.env`의 토스 키 교체
  5. 세션 저장소도 메모리 대신 Redis 등으로 교체 (서버가 여러 대로 늘어나도 로그인이 유지되도록)

## 파일 구조

```
unexposed-server/
├── package.json
├── .env.example       ← 복사해서 .env로 사용
├── server.js          ← Express 서버 (로그인/결제 API)
└── public/
    ├── index.html          ← 메인 사이트 (기존 데모 + 실제 로그인/결제 연동)
    ├── payment-success.html ← 결제 성공 후 돌아오는 페이지
    └── payment-fail.html    ← 결제 실패/취소 시 돌아오는 페이지
```
