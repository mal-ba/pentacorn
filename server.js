require('dotenv').config();

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
const AUTH_COOKIE_NAME = 'unexposed_auth';
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

const MAX_SCAN_RECORDS_PER_USER = 30; // 무한 증가를 막기 위한 사람당 보관 개수 제한

const PLAN_PRICES = {
  basic: { name: 'Basic', amount: 15000 },
  standard: { name: 'Standard', amount: 45000 },
  pro: { name: 'Pro', amount: 89000 },
};

/* ---------------- 옷장(기본 제공 + 커뮤니티 업로드) ---------------- */

// 업로드한 파일의 원래 이름을 최대한 그대로 살려서 저장해요 (경로 조작 방지를 위한
// 위험한 문자만 걸러내요).
function sanitizeFilename(originalName) {
  const base = path.basename(String(originalName));
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
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
// buffer는 원본 바이너리 그대로 받아요 (base64로 부풀리지 않아서 대용량 파일에도 안전해요).
async function uploadToWardrobeBucket(itemId, buffer, desiredFileName, defaultContentType) {
  const safeName = sanitizeFilename(desiredFileName);
  const storagePath = `${itemId}/${Date.now()}_${safeName}`;
  const contentType = guessContentType(safeName) || defaultContentType;

  const { error } = await supabase.storage
    .from(WARDROBE_BUCKET)
    .upload(storagePath, buffer, { contentType, upsert: false });
  if (error) throw error;

  const { data } = supabase.storage.from(WARDROBE_BUCKET).getPublicUrl(storagePath);
  return { publicUrl: data.publicUrl, storagePath };
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
const ALLOWED_CATEGORIES = ['top', 'bottom', 'outer', 'accessory', 'shoes', 'hair'];

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

// 옷/장신구 파일 업로드용: base64 대신 원본 바이너리 그대로 받아서 용량 부풀림 없이 처리해요.
const wardrobeUpload = multer({
  storage: multer.memoryStorage(),
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

    return res.json({ ok: true, user });
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

  const [{ data: sub }, { data: consent }] = await Promise.all([
    supabase.from('subscriptions').select('*').eq('email', user.email).maybeSingle(),
    supabase.from('body_data_consents').select('*').eq('email', user.email).maybeSingle(),
  ]);

  res.json({
    user,
    subscription: sub
      ? { plan: sub.plan, amount: sub.amount, subscribedAt: sub.subscribed_at, paymentKey: sub.payment_key, orderId: sub.order_id }
      : null,
    bodyDataConsent: consent ? { consent: consent.consent, updatedAt: consent.updated_at } : null,
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
      const uploaded = await uploadToWardrobeBucket(id, glbFile.buffer, fixMulterFilenameEncoding(glbFile.originalname) || `${id}.glb`, 'model/gltf-binary');
      glbUrl = uploaded.publicUrl;
    }
    if (thumbnailFile) {
      const uploaded = await uploadToWardrobeBucket(id, thumbnailFile.buffer, fixMulterFilenameEncoding(thumbnailFile.originalname) || `${id}.png`, 'image/png');
      thumbnailUrl = uploaded.publicUrl;
    }
  } catch (err) {
    console.error('옷장 파일 저장 실패:', err.message || err);
    return res.status(500).json({ ok: false, error: '파일 저장 중 오류가 발생했어요.' });
  }

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
      const uploaded = await uploadToWardrobeBucket(item.id, glbFile.buffer, fixMulterFilenameEncoding(glbFile.originalname) || `${item.id}.glb`, 'model/gltf-binary');
      updates.glb_url = uploaded.publicUrl;
    }
    if (thumbnailFile) {
      await deleteFromWardrobeBucketIfManaged(item.thumbnail_url);
      const uploaded = await uploadToWardrobeBucket(item.id, thumbnailFile.buffer, fixMulterFilenameEncoding(thumbnailFile.originalname) || `${item.id}.png`, 'image/png');
      updates.thumbnail_url = uploaded.publicUrl;
    }
  } catch (err) {
    console.error('옷장 파일 수정 실패:', err.message || err);
    return res.status(500).json({ ok: false, error: '파일 저장 중 오류가 발생했어요.' });
  }

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
    console.log(`UNEXPOSED 서버 실행 중: http://localhost:${PORT}`);
    if (!GOOGLE_CLIENT_ID) console.warn('⚠️  GOOGLE_CLIENT_ID가 비어있어요. .env 파일을 확인하세요.');
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) console.warn('⚠️  Supabase 설정이 비어있어요. .env 파일을 확인하세요.');
  });
}
start();
