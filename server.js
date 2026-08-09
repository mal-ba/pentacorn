require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { OAuth2Client } = require('google-auth-library');

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const TOSS_CLIENT_KEY = process.env.TOSS_CLIENT_KEY || '';
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// 실제 서비스에서는 DB(예: SQLite, PostgreSQL)를 쓰세요.
// 지금은 데모용으로 서버 메모리 + 로컬 파일에만 저장하기 때문에,
// Render 같은 호스팅에서는 재배포/재시작 시 업로드한 파일이 사라질 수 있어요.
const subscriptions = new Map(); // key: email -> { plan, amount, subscribedAt, paymentKey, orderId }
const bodyDataConsents = new Map(); // key: email -> { consent: boolean, updatedAt }
const bodyScanRecords = new Map(); // key: email -> [{ heightCm, photoThumbnail, capturedAt }, ...]
const MAX_SCAN_RECORDS_PER_USER = 30; // 메모리 무한 증가를 막기 위한 사람당 보관 개수 제한

const PLAN_PRICES = {
  basic: { name: 'Basic', amount: 15000 },
  standard: { name: 'Standard', amount: 45000 },
  pro: { name: 'Pro', amount: 89000 },
};

/* ---------------- 옷장(기본 제공 + 커뮤니티 업로드) ---------------- */

const WARDROBE_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'wardrobe');
fs.mkdirSync(WARDROBE_UPLOAD_DIR, { recursive: true });

const AGE_GROUPS = ['10s', '20s', '30s40s', '50s+'];
const OCCASIONS = ['casual', 'formal', 'sporty', 'street'];

// key: id -> { id, name, category, color, tags:[occasion...], ageGroups:[...],
//              glbUrl: '/uploads/wardrobe/xxx.glb' | null, thumbnailUrl, uploadedBy: 'builtin'|email, createdAt }
const wardrobeItems = new Map();

function seedBuiltinWardrobe() {
  const items = [
    { name: '화이트 반팔 티셔츠', category: 'top', color: '화이트', tags: ['casual', 'sporty'], ageGroups: ['10s', '20s'] },
    { name: '데님 청바지', category: 'bottom', color: '블루', tags: ['casual', 'street'], ageGroups: ['10s', '20s', '30s40s'] },
    { name: '블랙 후드 집업', category: 'outer', color: '블랙', tags: ['street', 'casual'], ageGroups: ['10s', '20s'] },
    { name: '체크 셔츠', category: 'top', color: '멀티', tags: ['casual', 'formal'], ageGroups: ['20s', '30s40s'] },
    { name: '베이직 볼캡', category: 'accessory', color: '블랙', tags: ['casual', 'street', 'sporty'], ageGroups: ['10s', '20s'] },
    { name: '골드 도트 목걸이', category: 'accessory', color: '골드', tags: ['formal', 'casual'], ageGroups: ['20s', '30s40s', '50s+'] },
  ];
  items.forEach(it => {
    const id = crypto.randomUUID();
    wardrobeItems.set(id, {
      id,
      name: it.name,
      category: it.category,
      color: it.color,
      tags: it.tags,
      ageGroups: it.ageGroups,
      glbUrl: null, // 기본 제공 아이템은 아직 실제 3D 모델이 없는 카탈로그 항목이에요.
      thumbnailUrl: null,
      uploadedBy: 'builtin',
      createdAt: new Date().toISOString(),
    });
  });
}
seedBuiltinWardrobe();

const app = express();
app.set('trust proxy', 1); // Render/Railway 같은 리버스 프록시 뒤에서 secure 쿠키가 정상 동작하도록
app.use(express.json({ limit: '15mb' })); // 옷/장신구 .glb 업로드(base64)를 위해 넉넉하게 설정
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production', // 배포 환경(HTTPS)에서는 자동으로 true가 돼요.
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7일
    },
  })
);

// index.html 안의 %%GOOGLE_CLIENT_ID%%, %%TOSS_CLIENT_KEY%% 를
// 실제 값으로 치환해서 내려줍니다. (express.static보다 먼저 등록해야
// 정적 파일 서빙이 이 라우트를 가로채지 않아요)
app.get('/', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return res.status(500).send('index.html을 읽을 수 없어요.');
    const rendered = html
      .replaceAll('%%GOOGLE_CLIENT_ID%%', GOOGLE_CLIENT_ID)
      .replaceAll('%%TOSS_CLIENT_KEY%%', TOSS_CLIENT_KEY);
    res.send(rendered);
  });
});

// index: false 로 설정해서 static 미들웨어가 '/' 요청에서
// public/index.html을 자동으로 가로채지 않게 해요.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/* ---------------- Google 로그인 ---------------- */

// 프론트에서 Google Identity Services가 발급한 credential(ID 토큰)을 검증합니다.
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) {
    return res.status(400).json({ ok: false, error: 'credential이 없어요.' });
  }
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({
      ok: false,
      error: '서버에 GOOGLE_CLIENT_ID가 설정되어 있지 않아요. .env 파일을 확인하세요.',
    });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    req.session.user = {
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    };

    return res.json({ ok: true, user: req.session.user });
  } catch (err) {
    console.error('Google 토큰 검증 실패:', err.message);
    return res.status(401).json({ ok: false, error: '로그인 검증에 실패했어요.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const sub = subscriptions.get(req.session.user.email) || null;
  const consent = bodyDataConsents.get(req.session.user.email) || null;
  res.json({ user: req.session.user, subscription: sub, bodyDataConsent: consent });
});

/* ---------------- 신체 데이터 수집 동의 ---------------- */

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: '로그인이 필요해요.' });
  }
  next();
}

// 사람마다 개별적으로 동의/비동의를 선택하고, 언제든 다시 바꿀 수 있어요.
app.post('/api/consent/body-data', requireLogin, (req, res) => {
  const { consent } = req.body || {};
  if (typeof consent !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'consent 값은 true/false여야 해요.' });
  }
  bodyDataConsents.set(req.session.user.email, {
    consent,
    updatedAt: new Date().toISOString(),
  });
  // 동의를 철회하면(false), 그동안 쌓인 데이터도 즉시 삭제해요.
  if (!consent) {
    bodyScanRecords.delete(req.session.user.email);
  }
  res.json({ ok: true, consent });
});

app.get('/api/consent/body-data', requireLogin, (req, res) => {
  const consent = bodyDataConsents.get(req.session.user.email) || null;
  res.json({ consent });
});

// 동의한 사용자에 한해서만, 스캔한 신체 데이터(키 + 사진 썸네일)를 서버에 쌓아요.
app.post('/api/scan/save', requireLogin, (req, res) => {
  const consentRecord = bodyDataConsents.get(req.session.user.email);
  if (!consentRecord || !consentRecord.consent) {
    return res.status(403).json({ ok: false, error: '신체 데이터 수집에 동의하지 않아서 저장할 수 없어요.' });
  }
  const { heightCm, photoThumbnail } = req.body || {};
  if (!heightCm) {
    return res.status(400).json({ ok: false, error: 'heightCm이 필요해요.' });
  }
  // 썸네일은 용량을 제한해요 (base64 기준 대략 300KB 이하만 허용).
  if (photoThumbnail && photoThumbnail.length > 400000) {
    return res.status(400).json({ ok: false, error: '이미지 용량이 너무 커요.' });
  }

  const email = req.session.user.email;
  const list = bodyScanRecords.get(email) || [];
  list.push({
    heightCm: Number(heightCm),
    photoThumbnail: photoThumbnail || null,
    capturedAt: new Date().toISOString(),
  });
  while (list.length > MAX_SCAN_RECORDS_PER_USER) list.shift(); // 오래된 것부터 제거
  bodyScanRecords.set(email, list);

  res.json({ ok: true, count: list.length });
});

// 내가 지금까지 쌓은 스캔 기록 목록 (본인만 조회 가능)
app.get('/api/scan/history', requireLogin, (req, res) => {
  const list = bodyScanRecords.get(req.session.user.email) || [];
  res.json({
    count: list.length,
    records: list.map(r => ({ heightCm: r.heightCm, capturedAt: r.capturedAt })),
  });
});

// 지금까지 쌓인 내 스캔 데이터를 전부 삭제 (동의 여부와 무관하게 언제든 가능)
app.delete('/api/scan/history', requireLogin, (req, res) => {
  bodyScanRecords.delete(req.session.user.email);
  res.json({ ok: true });
});

/* ---------------- 옷장(기본 제공 + 커뮤니티 업로드) ---------------- */

function toPublicWardrobeItem(item) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    color: item.color,
    tags: item.tags,
    ageGroups: item.ageGroups,
    glbUrl: item.glbUrl,
    thumbnailUrl: item.thumbnailUrl,
    isBuiltin: item.uploadedBy === 'builtin',
    uploadedBy: item.uploadedBy === 'builtin' ? null : item.uploadedBy,
    createdAt: item.createdAt,
  };
}

// 옷장 전체 목록 (로그인 없이도 누구나 둘러볼 수 있어요)
app.get('/api/wardrobe', (req, res) => {
  const { category } = req.query;
  let list = Array.from(wardrobeItems.values());
  if (category) list = list.filter(it => it.category === category);
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ items: list.map(toPublicWardrobeItem) });
});

// 로그인한 사용자가 자신이 만든 옷/장신구를 옷장에 올려요.
// glbFile은 선택(없으면 "입혀보기"는 안 되고 카탈로그에만 표시돼요), thumbnail은 필수예요.
app.post('/api/wardrobe', requireLogin, (req, res) => {
  const { name, category, color, tags, ageGroups, glbFileBase64, thumbnailBase64 } = req.body || {};

  if (!name || typeof name !== 'string' || name.length > 60) {
    return res.status(400).json({ ok: false, error: '이름을 1~60자로 입력해주세요.' });
  }
  const allowedCategories = ['top', 'bottom', 'outer', 'accessory', 'shoes'];
  if (!allowedCategories.includes(category)) {
    return res.status(400).json({ ok: false, error: '카테고리가 올바르지 않아요.' });
  }
  const tagList = Array.isArray(tags) ? tags.filter(t => OCCASIONS.includes(t)) : [];
  const ageGroupList = Array.isArray(ageGroups) ? ageGroups.filter(a => AGE_GROUPS.includes(a)) : [];
  if (ageGroupList.length === 0) {
    return res.status(400).json({ ok: false, error: '추천 연령대를 1개 이상 선택해주세요.' });
  }
  if (glbFileBase64 && glbFileBase64.length > 14 * 1024 * 1024) {
    return res.status(400).json({ ok: false, error: '3D 파일 용량이 너무 커요 (최대 약 10MB).' });
  }
  if (thumbnailBase64 && thumbnailBase64.length > 700000) {
    return res.status(400).json({ ok: false, error: '썸네일 이미지 용량이 너무 커요.' });
  }

  const id = crypto.randomUUID();
  let glbUrl = null;
  let thumbnailUrl = null;

  try {
    if (glbFileBase64) {
      const glbBuffer = Buffer.from(glbFileBase64.split(',').pop(), 'base64');
      const glbPath = path.join(WARDROBE_UPLOAD_DIR, `${id}.glb`);
      fs.writeFileSync(glbPath, glbBuffer);
      glbUrl = `/uploads/wardrobe/${id}.glb`;
    }
    if (thumbnailBase64) {
      const match = /^data:image\/(png|jpeg|jpg|webp);base64,/.exec(thumbnailBase64);
      const ext = match ? (match[1] === 'jpeg' ? 'jpg' : match[1]) : 'png';
      const imgBuffer = Buffer.from(thumbnailBase64.split(',').pop(), 'base64');
      const imgPath = path.join(WARDROBE_UPLOAD_DIR, `${id}.${ext}`);
      fs.writeFileSync(imgPath, imgBuffer);
      thumbnailUrl = `/uploads/wardrobe/${id}.${ext}`;
    }
  } catch (err) {
    console.error('옷장 파일 저장 실패:', err);
    return res.status(500).json({ ok: false, error: '파일 저장 중 오류가 발생했어요.' });
  }

  const item = {
    id,
    name,
    category,
    color: typeof color === 'string' ? color.slice(0, 20) : '',
    tags: tagList,
    ageGroups: ageGroupList,
    glbUrl,
    thumbnailUrl,
    uploadedBy: req.session.user.email,
    createdAt: new Date().toISOString(),
  };
  wardrobeItems.set(id, item);

  res.json({ ok: true, item: toPublicWardrobeItem(item) });
});

// 본인이 올린 아이템만 삭제할 수 있어요.
app.delete('/api/wardrobe/:id', requireLogin, (req, res) => {
  const item = wardrobeItems.get(req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: '아이템을 찾을 수 없어요.' });
  if (item.uploadedBy !== req.session.user.email) {
    return res.status(403).json({ ok: false, error: '본인이 올린 아이템만 삭제할 수 있어요.' });
  }
  [item.glbUrl, item.thumbnailUrl].forEach(url => {
    if (!url) return;
    const filePath = path.join(__dirname, 'public', url);
    fs.unlink(filePath, () => {}); // 실패해도 조용히 넘어가요.
  });
  wardrobeItems.delete(req.params.id);
  res.json({ ok: true });
});

// 나이대·상황(캐주얼/포멀/스포티/스트릿)에 맞춰 규칙 기반으로 옷장 아이템을 추천해요.
// (진짜 생성형 AI 추천이 아니라, 태그 매칭 기반의 단순 추천이에요)
app.get('/api/wardrobe/recommend', (req, res) => {
  const { ageGroup, occasion } = req.query;
  if (!AGE_GROUPS.includes(ageGroup)) {
    return res.status(400).json({ ok: false, error: '연령대를 올바르게 선택해주세요.' });
  }
  const list = Array.from(wardrobeItems.values());
  const scored = list.map(item => {
    let score = 0;
    if (item.ageGroups.includes(ageGroup)) score += 2;
    if (occasion && item.tags.includes(occasion)) score += 2;
    if (item.glbUrl) score += 1; // 실제로 입혀볼 수 있는 아이템을 살짝 우대해요.
    return { item, score };
  });
  const recommended = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(s => ({
      ...toPublicWardrobeItem(s.item),
      reason: buildRecommendReason(s.item, ageGroup, occasion),
    }));

  res.json({ ageGroup, occasion: occasion || null, recommended });
});

function buildRecommendReason(item, ageGroup, occasion) {
  const ageLabel = { '10s': '10대', '20s': '20대', '30s40s': '30~40대', '50s+': '50대 이상' }[ageGroup];
  const occasionLabel = { casual: '캐주얼', formal: '포멀', sporty: '스포티', street: '스트릿' }[occasion];
  const parts = [`${ageLabel}에게 잘 어울리는 스타일`];
  if (occasionLabel) parts.push(`${occasionLabel} 상황에 맞음`);
  return parts.join(' · ');
}

/* ---------------- 토스페이먼츠 결제 ---------------- */

// 프론트에서 결제창을 열기 직전에 호출: 서버가 orderId를 발급해서
// 가격 위변조를 막습니다. (클라이언트가 보낸 금액을 그대로 믿지 않아요)
app.post('/api/payments/create-order', requireLogin, (req, res) => {
  const { planKey } = req.body || {};
  const plan = PLAN_PRICES[planKey];
  if (!plan) {
    return res.status(400).json({ ok: false, error: '알 수 없는 플랜이에요.' });
  }
  const orderId = `${planKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  res.json({
    ok: true,
    orderId,
    amount: plan.amount,
    orderName: `UNEXPOSED ${plan.name} 플랜 구독`,
  });
});

// Toss 결제창에서 successUrl로 돌아온 뒤, 프론트가 이 API를 호출해서
// 실제 결제를 승인(confirm)합니다.
app.post('/api/payments/confirm', requireLogin, async (req, res) => {
  const { paymentKey, orderId, amount } = req.body || {};
  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ ok: false, error: '결제 정보가 부족해요.' });
  }

  const planKey = String(orderId).split('_')[0];
  const plan = PLAN_PRICES[planKey];
  if (!plan || Number(amount) !== plan.amount) {
    return res.status(400).json({ ok: false, error: '결제 금액이 일치하지 않아요.' });
  }

  try {
    const authHeader = 'Basic ' + Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
    const tossRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    });
    const data = await tossRes.json();

    if (!tossRes.ok) {
      console.error('Toss 결제 승인 실패:', data);
      return res.status(400).json({ ok: false, error: data.message || '결제 승인에 실패했어요.' });
    }

    subscriptions.set(req.session.user.email, {
      plan: plan.name,
      amount: plan.amount,
      subscribedAt: new Date().toISOString(),
      paymentKey,
      orderId,
    });

    res.json({ ok: true, plan: plan.name, amount: plan.amount, payment: data });
  } catch (err) {
    console.error('결제 승인 중 오류:', err);
    res.status(500).json({ ok: false, error: '결제 승인 중 오류가 발생했어요.' });
  }
});

app.get('/api/subscription', requireLogin, (req, res) => {
  const sub = subscriptions.get(req.session.user.email) || null;
  res.json({ subscription: sub });
});

app.listen(PORT, () => {
  console.log(`UNEXPOSED 서버 실행 중: http://localhost:${PORT}`);
  if (!GOOGLE_CLIENT_ID) {
    console.warn('⚠️  GOOGLE_CLIENT_ID가 비어있어요. .env 파일을 확인하세요.');
  }
});
