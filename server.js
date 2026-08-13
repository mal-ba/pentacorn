require('dotenv').config();

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const TOSS_CLIENT_KEY = process.env.TOSS_CLIENT_KEY || '';
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const WARDROBE_BUCKET = 'wardrobe-assets';
// 쉼표로 여러 개 등록 가능: 이 이메일로 로그인해서 올린 옷장 아이템은 "공식" 배지가 붙어요.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ── 데이터 저장소: Supabase (Postgres + Storage) ─────────────────
// 서버 메모리/로컬 디스크 대신 Supabase에 저장해서, Render 서버가
// 재시작되거나 잠들었다 깨어나도 데이터와 업로드한 파일이 사라지지 않아요.
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.warn('⚠️  SUPABASE_URL / SUPABASE_SECRET_KEY가 설정되어 있지 않아요. .env 파일을 확인하세요.');
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// ── 로그인 유지 방식 ──────────────────────────────────────────
// express-session(서버 메모리 저장) 대신, 서명된 JWT를 쿠키에 담아서 로그인 상태를
// 유지해요. 이렇게 하면 Render 무료 서버가 15분 넘게 안 쓰여서 잠들었다가 다시
// 깨어나도(=서버 재시작) 로그인이 풀리지 않고, 사용자가 직접 로그아웃하기 전까지
// 계속 로그인 상태가 유지돼요.
const AUTH_COOKIE_NAME = 'pentacorn_auth';
const AUTH_TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365; // 1년

function signAuthToken(user) {
  return jwt.sign(user, SESSION_SECRET, { expiresIn: '365d' });
}
function verifyAuthToken(token) {
  try {
    const decoded = jwt.verify(token, SESSION_SECRET);
    return { email: decoded.email, name: decoded.name, picture: decoded.picture };
  } catch (err) {
    return null;
  }
}

// ADMIN_EMAILS에 등록된 이메일이면 true. requireAdmin 미들웨어와 달리 403을 던지지 않고
// 그냥 boolean만 돌려줘서, 일반 사용자도 /api/me·/api/auth/google 응답에서 안전하게 받을 수 있어요.
function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(String(email || '').toLowerCase());
}

const MAX_SCAN_RECORDS_PER_USER = 30; // 무한 증가를 막기 위한 사람당 보관 개수 제한

const PLAN_PRICES = {
  basic: { name: 'Basic', amount: 15000 },
  standard: { name: 'Standard', amount: 45000 },
  pro: { name: 'Pro', amount: 89000 },
};

/* ---------------- 옷장(기본 제공 + 커뮤니티 업로드) ---------------- */

// 업로드한 파일의 원래 이름을 최대한 살려서 저장하되, Supabase Storage 저장 경로에
// 한글 등 비ASCII 문자가 들어가면 "Invalid key" 오류가 나는 알려진 버그가 있어서
// (https://github.com/supabase/supabase/issues/22974), 저장 경로용 이름에서는
// 한글 등을 밑줄로 바꿔요. 화면에 보이는 아이템 이름(name 필드)은 이 영향을 안 받고
// 그대로 한글로 잘 표시돼요 — 이건 어디까지나 내부 저장 경로에만 해당돼요.
function sanitizeFilename(originalName) {
  const base = path.basename(String(originalName));
  let cleaned = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  cleaned = cleaned.replace(/[^\x00-\x7F]/g, '_'); // 비ASCII(한글 등) 문자를 밑줄로
  cleaned = cleaned.replace(/_+/g, '_'); // 연속된 밑줄은 하나로 정리
  return cleaned.slice(0, 150) || 'file';
}

// multer(내부 busboy)가 한글 등 UTF-8 파일명을 라틴1로 잘못 해석해서 깨뜨리는
// 잘 알려진 문제가 있어요. latin1로 잘못 읽힌 바이트를 다시 utf8로 되돌려줘요.
function fixMulterFilenameEncoding(name) {
  if (!name) return name;
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch (err) {
    return name;
  }
}

// Supabase Storage에 파일을 올리고, 누구나 접근 가능한 공개 URL을 돌려줘요.
// itemId로 폴더를 나눠서, 서로 다른 아이템끼리 파일 이름이 겹쳐도 안전해요.
// filePath는 디스크에 임시로 저장된 파일 경로예요 — 파일 전체를 메모리에 올리지 않고
// 스트림으로 읽어서 그대로 Supabase에 흘려보내요(대용량 파일에도 RAM 부담이 거의 없어요).
async function uploadToWardrobeBucket(itemId, filePath, desiredFileName, defaultContentType) {
  const safeName = sanitizeFilename(desiredFileName);
  const storagePath = `${itemId}/${Date.now()}_${safeName}`;
  const contentType = guessContentType(safeName) || defaultContentType;

  const { error } = await supabase.storage
    .from(WARDROBE_BUCKET)
    .upload(storagePath, fs.createReadStream(filePath), {
      contentType,
      upsert: false,
      duplex: 'half', // Node의 fetch가 스트림 body를 보낼 때 요구하는 옵션이에요.
    });
  if (error) throw error;

  const { data } = supabase.storage.from(WARDROBE_BUCKET).getPublicUrl(storagePath);
  return { publicUrl: data.publicUrl, storagePath };
}

// multer가 diskStorage로 임시 폴더에 남긴 파일들을 정리해요. 업로드 성공/실패 여부와
// 상관없이 항상 호출해서, 임시 폴더에 파일이 계속 쌓이는 걸 막아요.
function cleanupTempUploadFiles(reqFiles){
  if(!reqFiles) return;
  const all = [...(reqFiles.glbFile || []), ...(reqFiles.thumbnailFile || [])];
  for(const f of all){
    fs.unlink(f.path, () => {}); // 실패해도(이미 지워졌거나) 무시해요.
  }
}

function guessContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  return map[ext] || null;
}

// Supabase Storage에 있는 파일이면 지우고, 그 외(깃허브에 직접 올려둔 정적 파일 등)는 건드리지 않아요.
async function deleteFromWardrobeBucketIfManaged(publicUrl) {
  if (!publicUrl) return;
  const marker = `/storage/v1/object/public/${WARDROBE_BUCKET}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return; // 우리 버킷 파일이 아니면(예: /wardrobe-assets/... 깃허브 정적 파일) 그냥 둬요.
  const storagePath = publicUrl.slice(idx + marker.length);
  await supabase.storage.from(WARDROBE_BUCKET).remove([storagePath]);
}

const AGE_GROUPS = ['10s', '20s', '30s40s', '50s+'];
const OCCASIONS = ['casual', 'formal', 'sporty', 'street'];
const ALLOWED_CATEGORIES = ['top', 'bottom', 'outer', 'accessory', 'shoes', 'hair', 'makeup'];

// 서버가 처음 켜질 때, 기본 제공 아이템이 아직 하나도 없으면 한 번만 채워 넣어요.
// (이미 있으면 다시 넣지 않아서, 재배포해도 중복이 안 생겨요)
async function seedBuiltinWardrobeIfEmpty() {
  const { count, error: countError } = await supabase
    .from('wardrobe_items')
    .select('id', { count: 'exact', head: true })
    .eq('uploaded_by', 'builtin');
  if (countError) {
    console.error('옷장 초기 데이터 확인 실패:', countError.message);
    return;
  }
  if (count && count > 0) return; // 이미 씨딩됨

  const items = [
    { name: '화이트 반팔 티셔츠', category: 'top', color: '화이트', tags: ['casual', 'sporty'], age_groups: ['10s', '20s'] },
    {
      name: '데님 청바지', category: 'bottom', color: '다크그레이 워시', tags: ['casual', 'street'], age_groups: ['10s', '20s', '30s40s'],
      glb_url: '/wardrobe-assets/Meshy_AI_Dark_Wash_Wide_Leg_Je_0809163812_texture.glb',
      thumbnail_url: '/wardrobe-assets/0e71311f-8f10-40b9-9b95-68f19b2a548c.jpg',
    },
    {
      name: '블랙 후드 집업', category: 'outer', color: '블랙', tags: ['street', 'casual'], age_groups: ['10s', '20s'],
      glb_url: '/wardrobe-assets/Meshy_AI_Black_Zip_Hoodie_with_0809173452_texture.glb',
      thumbnail_url: '/wardrobe-assets/images.jpg',
    },
    { name: '체크 셔츠', category: 'top', color: '멀티', tags: ['casual', 'formal'], age_groups: ['20s', '30s40s'] },
    { name: '베이직 볼캡', category: 'accessory', color: '블랙', tags: ['casual', 'street', 'sporty'], age_groups: ['10s', '20s'] },
    { name: '골드 도트 목걸이', category: 'accessory', color: '골드', tags: ['formal', 'casual'], age_groups: ['20s', '30s40s', '50s+'] },
  ].map(it => ({ ...it, uploaded_by: 'builtin' }));

  const { error: insertError } = await supabase.from('wardrobe_items').insert(items);
  if (insertError) console.error('옷장 초기 데이터 생성 실패:', insertError.message);
  else console.log('옷장 기본 아이템 6개를 만들었어요.');
}

function isOfficialUploader(uploadedBy) {
  if (uploadedBy === 'builtin') return true;
  return ADMIN_EMAILS.includes(String(uploadedBy).toLowerCase());
}

function canEditItem(item, viewerEmail) {
  if (!viewerEmail) return false;
  if (item.uploaded_by === viewerEmail) return true; // 본인이 올린 아이템
  if (item.uploaded_by === 'builtin' && ADMIN_EMAILS.includes(viewerEmail.toLowerCase())) return true; // 관리자는 기본 제공 아이템도 수정 가능
  return false;
}

function toPublicWardrobeItem(row, viewerEmail) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    color: row.color,
    tags: row.tags || [],
    ageGroups: row.age_groups || [],
    glbUrl: row.glb_url,
    thumbnailUrl: row.thumbnail_url,
    isBuiltin: row.uploaded_by === 'builtin',
    isOfficial: isOfficialUploader(row.uploaded_by),
    uploadedBy: row.uploaded_by === 'builtin' ? null : row.uploaded_by,
    canEdit: canEditItem(row, viewerEmail),
    createdAt: row.created_at,
  };
}

const app = express();
app.set('trust proxy', 1); // Render/Railway 같은 리버스 프록시 뒤에서 secure 쿠키가 정상 동작하도록
app.use(express.json({ limit: '2mb' })); // 신체 스캔 썸네일 등 작은 JSON 요청용 (큰 파일은 multer로 따로 처리)
app.use(cookieParser());

// 옷/장신구 파일 업로드용: RAM에 통째로 올리는 memoryStorage 대신, 잠깐 디스크(임시 폴더)에
// 스트리밍해서 저장해요. 여러 명이 동시에 큰 파일(최대 35MB)을 업로드해도 서버 RAM이
// 한꺼번에 튀지 않아요 — Render 무료 요금제(RAM 512MB)에서 특히 중요해요.
// Supabase로 올린 뒤엔 각 요청 핸들러에서 임시 파일을 바로 지워요.
const wardrobeUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => cb(null, `wardrobe_${crypto.randomUUID()}${path.extname(file.originalname || '')}`),
  }),
  limits: { fileSize: 35 * 1024 * 1024 }, // 파일 하나당 최대 35MB
});

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

// 관리자 사이트도 같은 방식으로 %%GOOGLE_CLIENT_ID%% 를 치환해서 내려줘요.
// (누구나 접속은 할 수 있지만, 로그인 후 ADMIN_EMAILS에 없으면 API가 403을 돌려줘요)
app.get('/admin.html', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'admin.html');
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return res.status(500).send('admin.html을 읽을 수 없어요.');
    res.send(html.replaceAll('%%GOOGLE_CLIENT_ID%%', GOOGLE_CLIENT_ID));
  });
});

// index: false 로 설정해서 static 미들웨어가 '/' 요청에서
// public/index.html을 자동으로 가로채지 않게 해요.
//
// setHeaders로 파일 종류별 캐싱 기간을 다르게 줘요:
// - 아이콘/이미지/GLB/폰트처럼 한번 올리면 잘 안 바뀌는 파일 → 길게 캐싱(30일)
//   그래도 완전히 안전하려면 파일명이 바뀔 때만 갱신되는 게 맞지만, 지금 구조에선
//   가끔 교체될 수 있으니 "immutable"까지는 안 쓰고 30일 정도로만 잡아요.
// - HTML/JS/CSS처럼 자주 수정하는 파일 → 짧게(5분)만 캐싱해서, 배포해도
//   "분명 고쳤는데 반영이 안 된다" 하는 혼란이 안 생기게 해요.
const LONG_CACHE_EXTS = new Set(['.glb', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff', '.woff2']);
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (LONG_CACHE_EXTS.has(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30일
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5분 (html/js/css 등)
    }
  },
}));

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

    const user = {
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    };
    const token = signAuthToken(user);
    res.cookie(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: AUTH_TOKEN_MAX_AGE_MS,
    });

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('email', user.email)
      .maybeSingle();

    return res.json({
      ok: true,
      user,
      isAdmin: isAdminEmail(user.email),
      hasProfile: !!profile, // 참고용으로 남겨둬요 (지금은 프로필 모달을 로그인마다 항상 띄워요).
      profile: profile ? {
        name: profile.name,
        contactEmail: profile.contact_email,
        phone: profile.phone,
        zipcode: profile.zipcode,
        address1: profile.address1,
        address2: profile.address2,
        shippingConsent: profile.shipping_consent,
      } : null,
    });
  } catch (err) {
    console.error('Google 토큰 검증 실패:', err.message);
    return res.status(401).json({ ok: false, error: '로그인 검증에 실패했어요.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const user = verifyAuthToken(req.cookies[AUTH_COOKIE_NAME]);
  if (!user) return res.json({ user: null });

  const [{ data: sub }, { data: consent }, { data: profile }] = await Promise.all([
    supabase.from('subscriptions').select('*').eq('email', user.email).maybeSingle(),
    supabase.from('body_data_consents').select('*').eq('email', user.email).maybeSingle(),
    supabase.from('user_profiles').select('*').eq('email', user.email).maybeSingle(),
  ]);

  res.json({
    user,
    isAdmin: isAdminEmail(user.email),
    subscription: sub
      ? { plan: sub.plan, amount: sub.amount, subscribedAt: sub.subscribed_at, paymentKey: sub.payment_key, orderId: sub.order_id }
      : null,
    bodyDataConsent: consent ? { consent: consent.consent, updatedAt: consent.updated_at } : null,
    profile: profile ? {
      name: profile.name,
      contactEmail: profile.contact_email,
      phone: profile.phone,
      zipcode: profile.zipcode,
      address1: profile.address1,
      address2: profile.address2,
      shippingConsent: profile.shipping_consent,
    } : null,
  });
});

/* ---------------- 프로필(이름·연락처·배송지) ---------------- */
// 로그인 직후 한 번 입력받는 프로필이에요. 배송 정보 수집에 동의한 사람만
// 주소·전화번호가 실제로 저장되고, 동의하지 않으면 이름만 저장돼요(주소류는 비워둬요).
app.post('/api/profile', requireLogin, async (req, res) => {
  const { name, contactEmail, phone, zipcode, address1, address2, shippingConsent } = req.body || {};
  const consent = !!shippingConsent;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ ok: false, error: '이름을 입력해주세요.' });
  }
  if (consent && (!phone || !zipcode || !address1)) {
    return res.status(400).json({ ok: false, error: '배송 정보에 동의하려면 연락처·우편번호·주소를 모두 입력해주세요.' });
  }

  const row = {
    email: req.user.email,
    name: String(name).trim(),
    contact_email: (contactEmail && String(contactEmail).trim()) || req.user.email,
    phone: consent ? String(phone).trim() : null,
    zipcode: consent ? String(zipcode).trim() : null,
    address1: consent ? String(address1).trim() : null,
    address2: consent ? (address2 ? String(address2).trim() : null) : null,
    shipping_consent: consent,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('user_profiles').upsert(row);
  if (error) {
    console.error('프로필 저장 오류:', error);
    return res.status(500).json({ ok: false, error: '저장 중 오류가 발생했어요.' });
  }
  res.json({ ok: true, profile: row });
});

app.get('/api/profile', requireLogin, async (req, res) => {
  const { data } = await supabase.from('user_profiles').select('*').eq('email', req.user.email).maybeSingle();
  res.json({
    profile: data ? {
      name: data.name,
      contactEmail: data.contact_email,
      phone: data.phone,
      zipcode: data.zipcode,
      address1: data.address1,
      address2: data.address2,
      shippingConsent: data.shipping_consent,
    } : null,
  });
});

/* ---------------- 신체 데이터 수집 동의 ---------------- */

function requireLogin(req, res, next) {
  const user = verifyAuthToken(req.cookies[AUTH_COOKIE_NAME]);
  if (!user) {
    return res.status(401).json({ ok: false, error: '로그인이 필요해요.' });
  }
  req.user = user;
  next();
}

// 사람마다 개별적으로 동의/비동의를 선택하고, 언제든 다시 바꿀 수 있어요.
app.post('/api/consent/body-data', requireLogin, async (req, res) => {
  const { consent } = req.body || {};
  if (typeof consent !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'consent 값은 true/false여야 해요.' });
  }
  const { error } = await supabase
    .from('body_data_consents')
    .upsert({ email: req.user.email, consent, updated_at: new Date().toISOString() });
  if (error) return res.status(500).json({ ok: false, error: '저장 중 오류가 발생했어요.' });

  // 동의를 철회하면(false), 그동안 쌓인 데이터도 즉시 삭제해요.
  if (!consent) {
    await supabase.from('body_scan_records').delete().eq('email', req.user.email);
  }
  res.json({ ok: true, consent });
});

app.get('/api/consent/body-data', requireLogin, async (req, res) => {
  const { data } = await supabase.from('body_data_consents').select('*').eq('email', req.user.email).maybeSingle();
  res.json({ consent: data ? { consent: data.consent, updatedAt: data.updated_at } : null });
});

// 동의한 사용자에 한해서만, 스캔한 신체 데이터(키 + 사진 썸네일)를 서버에 쌓아요.
app.post('/api/scan/save', requireLogin, async (req, res) => {
  const { data: consentRecord } = await supabase
    .from('body_data_consents')
    .select('consent')
    .eq('email', req.user.email)
    .maybeSingle();
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

  const { error: insertError } = await supabase.from('body_scan_records').insert({
    email: req.user.email,
    height_cm: Number(heightCm),
    photo_thumbnail: photoThumbnail || null,
  });
  if (insertError) return res.status(500).json({ ok: false, error: '저장 중 오류가 발생했어요.' });

  // 사람당 보관 개수를 넘으면 오래된 것부터 정리해요.
  const { data: allRecords } = await supabase
    .from('body_scan_records')
    .select('id, captured_at')
    .eq('email', req.user.email)
    .order('captured_at', { ascending: true });
  if (allRecords && allRecords.length > MAX_SCAN_RECORDS_PER_USER) {
    const excess = allRecords.slice(0, allRecords.length - MAX_SCAN_RECORDS_PER_USER).map(r => r.id);
    await supabase.from('body_scan_records').delete().in('id', excess);
  }

  const count = Math.min(allRecords ? allRecords.length : 1, MAX_SCAN_RECORDS_PER_USER);
  res.json({ ok: true, count });
});

// 내가 지금까지 쌓은 스캔 기록 목록 (본인만 조회 가능)
app.get('/api/scan/history', requireLogin, async (req, res) => {
  const { data } = await supabase
    .from('body_scan_records')
    .select('height_cm, captured_at')
    .eq('email', req.user.email)
    .order('captured_at', { ascending: false });
  const records = data || [];
  res.json({
    count: records.length,
    records: records.map(r => ({ heightCm: r.height_cm, capturedAt: r.captured_at })),
  });
});

// 지금까지 쌓인 내 스캔 데이터를 전부 삭제 (동의 여부와 무관하게 언제든 가능)
app.delete('/api/scan/history', requireLogin, async (req, res) => {
  await supabase.from('body_scan_records').delete().eq('email', req.user.email);
  res.json({ ok: true });
});

/* ---------------- 옷장(기본 제공 + 커뮤니티 업로드) ---------------- */

// 옷장 전체 목록 (로그인 없이도 누구나 둘러볼 수 있어요)
// 공식(관리자·기본 제공) 아이템을 먼저 보여주고, 그다음 최신순으로 정렬해요.
app.get('/api/wardrobe', async (req, res) => {
  const { category } = req.query;
  const viewer = verifyAuthToken(req.cookies[AUTH_COOKIE_NAME]); // 로그인 안 했으면 null이어도 괜찮아요.

  let query = supabase.from('wardrobe_items').select('*');
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: '옷장을 불러오지 못했어요.' });

  const list = (data || []).slice().sort((a, b) => {
    const officialDiff = Number(isOfficialUploader(b.uploaded_by)) - Number(isOfficialUploader(a.uploaded_by));
    if (officialDiff !== 0) return officialDiff;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  res.json({ items: list.map(row => toPublicWardrobeItem(row, viewer && viewer.email)) });
});

// 로그인한 사용자가 자신이 만든 옷/장신구를 옷장에 올려요.
// glbFile은 선택(없으면 "입혀보기"는 안 되고 카탈로그에만 표시돼요), thumbnail은 필수예요.
app.post('/api/wardrobe', requireLogin, wardrobeUpload.fields([{ name: 'glbFile', maxCount: 1 }, { name: 'thumbnailFile', maxCount: 1 }]), async (req, res) => {
  const { name, category, color } = req.body || {};
  let tags = [];
  let ageGroups = [];
  try {
    tags = JSON.parse(req.body.tags || '[]');
    ageGroups = JSON.parse(req.body.ageGroups || '[]');
  } catch (err) {
    return res.status(400).json({ ok: false, error: '요청 형식이 올바르지 않아요.' });
  }

  if (!name || typeof name !== 'string' || name.length > 60) {
    return res.status(400).json({ ok: false, error: '이름을 1~60자로 입력해주세요.' });
  }
  if (!ALLOWED_CATEGORIES.includes(category)) {
    return res.status(400).json({ ok: false, error: '카테고리가 올바르지 않아요.' });
  }
  const tagList = Array.isArray(tags) ? tags.filter(t => OCCASIONS.includes(t)) : [];
  const ageGroupList = Array.isArray(ageGroups) ? ageGroups.filter(a => AGE_GROUPS.includes(a)) : [];
  if (ageGroupList.length === 0) {
    return res.status(400).json({ ok: false, error: '추천 연령대를 1개 이상 선택해주세요.' });
  }

  const glbFile = req.files && req.files.glbFile && req.files.glbFile[0];
  const thumbnailFile = req.files && req.files.thumbnailFile && req.files.thumbnailFile[0];

  const id = crypto.randomUUID();
  let glbUrl = null;
  let thumbnailUrl = null;

  try {
    if (glbFile) {
      const uploaded = await uploadToWardrobeBucket(id, glbFile.path, fixMulterFilenameEncoding(glbFile.originalname) || `${id}.glb`, 'model/gltf-binary');
      glbUrl = uploaded.publicUrl;
    }
    if (thumbnailFile) {
      const uploaded = await uploadToWardrobeBucket(id, thumbnailFile.path, fixMulterFilenameEncoding(thumbnailFile.originalname) || `${id}.png`, 'image/png');
      thumbnailUrl = uploaded.publicUrl;
    }
  } catch (err) {
    console.error('옷장 파일 저장 실패:', err.message || err);
    cleanupTempUploadFiles(req.files);
    return res.status(500).json({ ok: false, error: '파일 저장 중 오류가 발생했어요.' });
  }
  cleanupTempUploadFiles(req.files);

  const row = {
    id,
    name,
    category,
    color: typeof color === 'string' ? color.slice(0, 20) : '',
    tags: tagList,
    age_groups: ageGroupList,
    glb_url: glbUrl,
    thumbnail_url: thumbnailUrl,
    uploaded_by: req.user.email,
  };
  const { data: inserted, error: insertError } = await supabase.from('wardrobe_items').insert(row).select().single();
  if (insertError) return res.status(500).json({ ok: false, error: '저장 중 오류가 발생했어요.' });

  res.json({ ok: true, item: toPublicWardrobeItem(inserted, req.user.email) });
});

// 본인이 올린 아이템만 삭제할 수 있어요.
app.delete('/api/wardrobe/:id', requireLogin, async (req, res) => {
  const { data: item } = await supabase.from('wardrobe_items').select('*').eq('id', req.params.id).maybeSingle();
  if (!item) return res.status(404).json({ ok: false, error: '아이템을 찾을 수 없어요.' });
  if (item.uploaded_by !== req.user.email) {
    return res.status(403).json({ ok: false, error: '본인이 올린 아이템만 삭제할 수 있어요.' });
  }
  await Promise.all([
    deleteFromWardrobeBucketIfManaged(item.glb_url),
    deleteFromWardrobeBucketIfManaged(item.thumbnail_url),
  ]);
  await supabase.from('wardrobe_items').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// 이미 있는 아이템(기본 제공 카탈로그 포함)에 나중에 3D 파일·사진을 채워 넣을 때 써요.
// 본인이 올린 아이템은 누구나, 기본 제공(builtin) 아이템은 관리자(ADMIN_EMAILS)만 수정할 수 있어요.
app.put('/api/wardrobe/:id', requireLogin, wardrobeUpload.fields([{ name: 'glbFile', maxCount: 1 }, { name: 'thumbnailFile', maxCount: 1 }]), async (req, res) => {
  const { data: item } = await supabase.from('wardrobe_items').select('*').eq('id', req.params.id).maybeSingle();
  if (!item) return res.status(404).json({ ok: false, error: '아이템을 찾을 수 없어요.' });
  if (!canEditItem(item, req.user.email)) {
    return res.status(403).json({ ok: false, error: '이 아이템을 수정할 권한이 없어요.' });
  }

  const glbFile = req.files && req.files.glbFile && req.files.glbFile[0];
  const thumbnailFile = req.files && req.files.thumbnailFile && req.files.thumbnailFile[0];

  const updates = {};
  try {
    if (glbFile) {
      await deleteFromWardrobeBucketIfManaged(item.glb_url);
      const uploaded = await uploadToWardrobeBucket(item.id, glbFile.path, fixMulterFilenameEncoding(glbFile.originalname) || `${item.id}.glb`, 'model/gltf-binary');
      updates.glb_url = uploaded.publicUrl;
    }
    if (thumbnailFile) {
      await deleteFromWardrobeBucketIfManaged(item.thumbnail_url);
      const uploaded = await uploadToWardrobeBucket(item.id, thumbnailFile.path, fixMulterFilenameEncoding(thumbnailFile.originalname) || `${item.id}.png`, 'image/png');
      updates.thumbnail_url = uploaded.publicUrl;
    }
  } catch (err) {
    console.error('옷장 파일 수정 실패:', err.message || err);
    cleanupTempUploadFiles(req.files);
    return res.status(500).json({ ok: false, error: '파일 저장 중 오류가 발생했어요.' });
  }
  cleanupTempUploadFiles(req.files);

  const { data: updated, error: updateError } = await supabase
    .from('wardrobe_items')
    .update(updates)
    .eq('id', item.id)
    .select()
    .single();
  if (updateError) return res.status(500).json({ ok: false, error: '저장 중 오류가 발생했어요.' });

  res.json({ ok: true, item: toPublicWardrobeItem(updated, req.user.email) });
});

// 나이대·상황(캐주얼/포멀/스포티/스트릿)에 맞춰 규칙 기반으로 옷장 아이템을 추천해요.
// (진짜 생성형 AI 추천이 아니라, 태그 매칭 기반의 단순 추천이에요)
app.get('/api/wardrobe/recommend', async (req, res) => {
  const { ageGroup, occasion } = req.query;
  if (!AGE_GROUPS.includes(ageGroup)) {
    return res.status(400).json({ ok: false, error: '연령대를 올바르게 선택해주세요.' });
  }
  const { data, error } = await supabase.from('wardrobe_items').select('*');
  if (error) return res.status(500).json({ ok: false, error: '옷장을 불러오지 못했어요.' });

  const scored = (data || []).map(item => {
    let score = 0;
    if ((item.age_groups || []).includes(ageGroup)) score += 2;
    if (occasion && (item.tags || []).includes(occasion)) score += 2;
    if (item.glb_url) score += 1; // 실제로 입혀볼 수 있는 아이템을 살짝 우대해요.
    if (isOfficialUploader(item.uploaded_by)) score += 1; // 공식 아이템을 살짝 우대해요.
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
    orderName: `pentacorn ${plan.name} 플랜 구독`,
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

    await supabase.from('subscriptions').upsert({
      email: req.user.email,
      plan: plan.name,
      amount: plan.amount,
      subscribed_at: new Date().toISOString(),
      payment_key: paymentKey,
      order_id: orderId,
    });

    res.json({ ok: true, plan: plan.name, amount: plan.amount, payment: data });
  } catch (err) {
    console.error('결제 승인 중 오류:', err);
    res.status(500).json({ ok: false, error: '결제 승인 중 오류가 발생했어요.' });
  }
});

app.get('/api/subscription', requireLogin, async (req, res) => {
  const { data: sub } = await supabase.from('subscriptions').select('*').eq('email', req.user.email).maybeSingle();
  res.json({
    subscription: sub
      ? { plan: sub.plan, amount: sub.amount, subscribedAt: sub.subscribed_at, paymentKey: sub.payment_key, orderId: sub.order_id }
      : null,
  });
});

/* ---------------- 맞춤 제작 주문 + 배송지 (2단계 "무늬·디테일 선택" 화면의 주문하기) ---------------- */
// 가격 위변조를 막기 위해, 클라이언트가 보낸 항목 "금액"이 실제로 우리가 정해둔 값과
// 일치하는지만 검사하고, 최종 금액은 항상 서버가 다시 계산해요.
const ORDER_FABRIC_AMOUNTS = new Set([0, 20000, 40000]);
const ORDER_DETAIL_AMOUNTS = new Set([0, 10000, 15000, 25000]); // 디테일은 중복 선택 가능이라 합산값이에요.
const ORDER_FINISH_AMOUNTS = new Set([0, 30000]);
const ORDER_BASE_PRICE = 30000;

app.post('/api/orders/create-order', requireLogin, async (req, res) => {
  const {
    fabricAmount, detailAmount, finishAmount,
    fabricLabel, detailLabels, finishLabel, fabricNote, detailNote,
    shipping, consent, designMode,
  } = req.body || {};

  const fa = Number(fabricAmount), da = Number(detailAmount), fi = Number(finishAmount);
  if (!ORDER_FABRIC_AMOUNTS.has(fa) || !ORDER_DETAIL_AMOUNTS.has(da) || !ORDER_FINISH_AMOUNTS.has(fi)) {
    return res.status(400).json({ ok: false, error: '옵션 금액이 올바르지 않아요.' });
  }
  const safeDesignMode = (designMode === '3d' || designMode === '2d') ? designMode : null;

  // "완제품 도어투도어 배송"을 선택했을 때만 배송지·동의가 필요해요 (패턴 PDF만이면 배송이 없어요).
  const needsShipping = fi === 30000;
  const s = shipping || {};
  if (needsShipping) {
    if (!consent) {
      return res.status(400).json({ ok: false, error: '배송을 위한 개인정보(배송지) 수집·이용에 동의해주세요.' });
    }
    if (!s.name || !s.phone || !s.zipcode || !s.address1) {
      return res.status(400).json({ ok: false, error: '배송지 정보(이름·연락처·우편번호·주소)를 모두 입력해주세요.' });
    }
  }

  const amount = ORDER_BASE_PRICE + fa + da + fi;
  const orderId = `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const { error } = await supabase.from('orders').insert({
    order_id: orderId,
    email: req.user.email,
    amount,
    design_mode: safeDesignMode,
    fabric_label: fabricLabel || null,
    detail_labels: Array.isArray(detailLabels) ? detailLabels : null,
    finish_label: finishLabel || null,
    fabric_note: fabricNote || null,
    detail_note: detailNote || null,
    shipping_name: needsShipping ? s.name : null,
    shipping_phone: needsShipping ? s.phone : null,
    shipping_zipcode: needsShipping ? s.zipcode : null,
    shipping_address1: needsShipping ? s.address1 : null,
    shipping_address2: needsShipping ? (s.address2 || null) : null,
    shipping_note: needsShipping ? (s.note || null) : null,
    shipping_consent: !!consent,
    status: 'pending',
  });
  if (error) {
    console.error('주문 생성 오류:', error);
    return res.status(500).json({ ok: false, error: '주문 생성 중 오류가 발생했어요.' });
  }

  res.json({ ok: true, orderId, amount, orderName: 'pentacorn 맞춤 제작 주문' });
});

// Toss 결제창에서 successUrl로 돌아온 뒤, 프론트가 이 API로 실제 결제를 승인(confirm)해요.
// (구독 결제의 /api/payments/confirm 과 같은 구조지만, orders 테이블을 써요)
app.post('/api/orders/confirm', requireLogin, async (req, res) => {
  const { paymentKey, orderId, amount } = req.body || {};
  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ ok: false, error: '결제 정보가 부족해요.' });
  }

  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('order_id', orderId)
    .eq('email', req.user.email)
    .maybeSingle();
  if (!order) return res.status(404).json({ ok: false, error: '주문을 찾을 수 없어요.' });
  if (Number(amount) !== Number(order.amount)) {
    return res.status(400).json({ ok: false, error: '결제 금액이 일치하지 않아요.' });
  }

  try {
    const authHeader = 'Basic ' + Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
    const tossRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    });
    const data = await tossRes.json();
    if (!tossRes.ok) {
      console.error('Toss 주문 결제 승인 실패:', data);
      return res.status(400).json({ ok: false, error: data.message || '결제 승인에 실패했어요.' });
    }

    await supabase
      .from('orders')
      .update({ status: 'paid', payment_key: paymentKey, paid_at: new Date().toISOString() })
      .eq('order_id', orderId);

    res.json({ ok: true, amount: order.amount, needsShipping: !!order.shipping_address1 });
  } catch (err) {
    console.error('주문 결제 승인 중 오류:', err);
    res.status(500).json({ ok: false, error: '결제 승인 중 오류가 발생했어요.' });
  }
});

// 관리자(ADMIN_EMAILS에 등록된 이메일)만 통과되는 미들웨어예요.
// "공식" 옷장 배지에 이미 쓰던 것과 같은 ADMIN_EMAILS 목록을 그대로 재사용해요.
function requireAdmin(req, res, next) {
  const email = String(req.user.email || '').toLowerCase();
  if (!ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({ ok: false, error: '관리자 계정으로 로그인해주세요.' });
  }
  next();
}

// 관리자 전용: 배송지가 포함된 전체 주문 목록. (관리자 사이트 admin.html에서 사용해요)
app.get('/api/admin/orders', requireLogin, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: '주문 목록을 불러오지 못했어요.' });
  res.json({ ok: true, orders: data, isAdmin: true });
});

// 관리자 전용: 주문 하나를 완전히 삭제해요. (admin.html의 삭제 버튼에서 사용)
app.delete('/api/admin/orders/:orderId', requireLogin, requireAdmin, async (req, res) => {
  const { error } = await supabase.from('orders').delete().eq('order_id', req.params.orderId);
  if (error) return res.status(500).json({ ok: false, error: '삭제 중 오류가 발생했어요.' });
  res.json({ ok: true });
});

// 관리자 전용: 구독 플랜(Basic/Standard/Pro) 목록. (맞춤 제작 주문과는 별개예요)
app.get('/api/admin/subscriptions', requireLogin, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .order('subscribed_at', { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: '구독 목록을 불러오지 못했어요.' });
  res.json({ ok: true, subscriptions: data });
});

// 관리자 여부만 가볍게 확인할 때 써요 (admin.html이 로그인 직후 이걸로 접근 권한을 확인해요).
app.get('/api/admin/me', requireLogin, requireAdmin, (req, res) => {
  res.json({ ok: true, isAdmin: true });
});

// 업로드 용량 초과 등 multer 에러를 깔끔한 JSON으로 응답해요.
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ ok: false, error: '파일 용량이 너무 커요 (최대 35MB).' });
    }
    return res.status(400).json({ ok: false, error: '파일 업로드 중 오류가 발생했어요.' });
  }
  console.error('처리되지 않은 서버 오류:', err);
  res.status(500).json({ ok: false, error: '서버 오류가 발생했어요.' });
});

async function start() {
  await seedBuiltinWardrobeIfEmpty();
  app.listen(PORT, () => {
    console.log(`pentacorn 서버 실행 중: http://localhost:${PORT}`);
    if (!GOOGLE_CLIENT_ID) console.warn('⚠️  GOOGLE_CLIENT_ID가 비어있어요. .env 파일을 확인하세요.');
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) console.warn('⚠️  Supabase 설정이 비어있어요. .env 파일을 확인하세요.');
  });
}
start();
