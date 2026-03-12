// Prism — Cloudflare Pages Advanced Mode Worker
// Handles API routes + serves static assets via env.ASSETS

// ── Auto-migrate DB ──
let dbInitPromise = null;
async function ensureDB(db) {
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      await db.batch([
        db.prepare("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))"),
        db.prepare("CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, date TEXT NOT NULL, market TEXT NOT NULL DEFAULT 'tw', type TEXT NOT NULL DEFAULT 'stock', symbol TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL DEFAULT 'long', status TEXT NOT NULL DEFAULT 'open', entry_price REAL, exit_price REAL, quantity REAL, contract_mul REAL, stop_loss REAL, take_profit REAL, fee REAL DEFAULT 0, tax REAL DEFAULT 0, tags TEXT DEFAULT '[]', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id))"),
        db.prepare("CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id))"),
      ]);
      // v2 migration: add account column
      try { await db.prepare("ALTER TABLE trades ADD COLUMN account TEXT NOT NULL DEFAULT ''").run(); } catch {}
      // v3 migration: add image_url column
      try { await db.prepare("ALTER TABLE trades ADD COLUMN image_url TEXT NOT NULL DEFAULT ''").run(); } catch {}
      // v4 migration: add rating column (1-5 stars, 0=unrated)
      try { await db.prepare("ALTER TABLE trades ADD COLUMN rating INTEGER NOT NULL DEFAULT 0").run(); } catch {}
      // v5 migration: daily_journal table
      try { await db.prepare("CREATE TABLE IF NOT EXISTS daily_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, date TEXT NOT NULL, mood INTEGER DEFAULT 3, market_note TEXT DEFAULT '', plan TEXT DEFAULT '', review TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id), UNIQUE(user_id, date))").run(); } catch {}
      // v6 migration: daily_journal enhancements
      try { await db.prepare("ALTER TABLE daily_journal ADD COLUMN discipline INTEGER NOT NULL DEFAULT 0").run(); } catch {}
      try { await db.prepare("ALTER TABLE daily_journal ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'").run(); } catch {}
      try { await db.prepare("ALTER TABLE daily_journal ADD COLUMN takeaway TEXT NOT NULL DEFAULT ''").run(); } catch {}
      try { await db.prepare("ALTER TABLE daily_journal ADD COLUMN starred INTEGER NOT NULL DEFAULT 0").run(); } catch {}
      // v7 migration: trade review scores (discipline, timing, sizing) for process-vs-outcome analysis
      try { await db.prepare("ALTER TABLE trades ADD COLUMN review_discipline INTEGER NOT NULL DEFAULT 0").run(); } catch {}
      try { await db.prepare("ALTER TABLE trades ADD COLUMN review_timing INTEGER NOT NULL DEFAULT 0").run(); } catch {}
      try { await db.prepare("ALTER TABLE trades ADD COLUMN review_sizing INTEGER NOT NULL DEFAULT 0").run(); } catch {}
    })();
  }
  return dbInitPromise;
}

// ── CORS ──
let _currentRequest = null;
function corsHeaders(request) {
  const req = request || _currentRequest;
  const origin = req?.headers?.get('Origin') || '';
  const allowed = ['https://prism-7t8.pages.dev', 'http://localhost:8788', 'http://127.0.0.1:8788', 'http://localhost:3000', 'http://127.0.0.1:3000'];
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}
function jsonRes(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request) },
  });
}
function jsonErr(status, message, request) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

// ── JWT + Password (inline to avoid import issues with Pages bundler) ──
const JWT_ALG = { name: 'HMAC', hash: 'SHA-256' };
const JWT_EXPIRY = 7 * 24 * 60 * 60;

function base64url(input) {
  if (typeof input === 'string') {
    return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const bytes = new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes.buffer;
}

async function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + JWT_EXPIRY };
  const enc = new TextEncoder();
  const headerB64 = base64url(JSON.stringify(header));
  const bodyB64 = base64url(JSON.stringify(body));
  const signingInput = `${headerB64}.${bodyB64}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), JWT_ALG, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  return `${signingInput}.${base64url(sig)}`;
}

async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, bodyB64, sigB64] = parts;
  const enc = new TextEncoder();
  const signingInput = `${headerB64}.${bodyB64}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), JWT_ALG, false, ['verify']);
  const sig = base64urlDecode(sigB64);
  const valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(signingInput));
  if (!valid) return null;
  const payload = JSON.parse(atob(bodyB64.replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return { hash: bufToHex(hash), salt: bufToHex(salt) };
}

async function verifyPassword(password, hash, saltHex) {
  const enc = new TextEncoder();
  const salt = hexToBuf(saltHex);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return bufToHex(derived) === hash;
}

function getJwtSecret(env) {
  const s = env.JWT_SECRET;
  if (!s) {
    console.error('[Prism] CRITICAL: JWT_SECRET 未設定！請立即設定 env.JWT_SECRET，否則認證不安全。');
    return null;
  }
  return s;
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const secret = getJwtSecret(env);
  if (!secret) return null;
  const token = auth.slice(7);
  return await verifyJWT(token, secret);
}

// ── CORS Proxy (migrated from functions/api/proxy.js) ──
const PROXY_ALLOWED = ['mis.twse.com.tw','mis.taifex.com.tw','query1.finance.yahoo.com','query2.finance.yahoo.com','finnhub.io','www.taifex.com.tw','openapi.taifex.com.tw','openapi.twse.com.tw','www.tpex.org.tw','www.sec.gov','api.nasdaq.com','production.dataviz.cnn.io','api.binance.com','fred.stlouisfed.org'];

async function handleProxy(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) return jsonErr(400, 'Missing ?url= parameter');
  let targetUrl;
  try { targetUrl = new URL(target); } catch { return jsonErr(400, 'Invalid URL'); }
  if (!PROXY_ALLOWED.includes(targetUrl.hostname)) return jsonErr(403, 'Host not allowed');
  if (targetUrl.protocol !== 'https:') return jsonErr(403, 'Only HTTPS allowed');
  try {
    const fetchOpts = { method: request.method, headers: {} };
    const ct = request.headers.get('content-type');
    if (ct) fetchOpts.headers['Content-Type'] = ct;
    if (request.method === 'POST') {
      fetchOpts.body = await request.text();
      if (fetchOpts.body.length > 65536) return jsonErr(400, 'Request body too large');
    }
    fetchOpts.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    fetchOpts.headers['Accept'] = 'application/json, text/plain, */*';
    const resp = await fetch(target, fetchOpts);
    const body = await resp.arrayBuffer();
    return new Response(body, {
      status: resp.status,
      headers: { ...corsHeaders(request), 'Content-Type': resp.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'public, max-age=30' },
    });
  } catch (e) { console.error('[Proxy Error]', e); return jsonErr(502, 'Proxy fetch failed'); }
}

// ── Simple In-Memory Rate Limiter (per-worker instance) ──
const _rateLimits = new Map();
function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  const entry = _rateLimits.get(key);
  if (!entry || now - entry.start > windowMs) {
    _rateLimits.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > maxRequests) return false;
  return true;
}

// ── API Route Handlers ──

async function handleRegister(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!checkRateLimit(`reg:${ip}`, 5, 60000)) return jsonErr(429, '請求過於頻繁，請稍後再試');
  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }
  const { username, password } = body;
  if (!username || !password) return jsonErr(400, '請提供使用者名稱和密碼');
  if (username.length < 2 || username.length > 20) return jsonErr(400, '使用者名稱需 2-20 字元');
  if (password.length < 6) return jsonErr(400, '密碼至少需要 6 個字元');
  if (password.length > 128) return jsonErr(400, '密碼過長');
  if (!/^[a-zA-Z0-9_\u4e00-\u9fff]+$/.test(username)) return jsonErr(400, '使用者名稱只能包含英文、數字、底線或中文');

  const db = env.DB;
  const existing = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) return jsonErr(409, '此使用者名稱已被註冊');

  const secret = getJwtSecret(env);
  if (!secret) return jsonErr(500, '伺服器未正確設定認證密鑰');
  const { hash, salt } = await hashPassword(password);
  try {
    await db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)').bind(username, hash, salt).run();
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return jsonErr(409, '此使用者名稱已被註冊');
    throw e;
  }
  const newUser = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  const userId = newUser.id;
  const token = await signJWT({ sub: userId, username }, secret);
  return jsonRes({ token, user: { id: userId, username } }, 201);
}

async function handleLoginPost(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!checkRateLimit(`login:${ip}`, 10, 60000)) return jsonErr(429, '請求過於頻繁，請稍後再試');
  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }
  const { username, password } = body;
  if (!username || !password) return jsonErr(400, '請提供使用者名稱和密碼');

  const db = env.DB;
  const user = await db.prepare('SELECT id, username, password_hash, salt FROM users WHERE username = ?').bind(username).first();
  if (!user) return jsonErr(401, '使用者名稱或密碼錯誤');
  const valid = await verifyPassword(password, user.password_hash, user.salt);
  if (!valid) return jsonErr(401, '使用者名稱或密碼錯誤');

  const secret = getJwtSecret(env);
  if (!secret) return jsonErr(500, '伺服器未正確設定認證密鑰');
  const token = await signJWT({ sub: user.id, username: user.username }, secret);
  return jsonRes({ token, user: { id: user.id, username: user.username } });
}

async function handleMe(request, env) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入或 token 已過期');
  return jsonRes({ user: { id: user.sub, username: user.username } });
}

async function handleGetTrades(request, env) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入');
  const db = env.DB;
  const { results } = await db.prepare('SELECT * FROM trades WHERE user_id = ? ORDER BY date DESC').bind(user.sub).all();
  const trades = results.map(row => ({
    id: row.id, date: row.date, market: row.market, type: row.type,
    symbol: row.symbol, name: row.name, direction: row.direction, status: row.status,
    entryPrice: row.entry_price, exitPrice: row.exit_price, quantity: row.quantity,
    contractMul: row.contract_mul, stopLoss: row.stop_loss, takeProfit: row.take_profit,
    fee: row.fee, tax: row.tax, tags: (() => { try { return JSON.parse(row.tags || '[]'); } catch { return []; } })(), notes: row.notes,
    account: row.account || '', imageUrl: row.image_url || '', rating: row.rating || 0,
    reviewDiscipline: row.review_discipline || 0, reviewTiming: row.review_timing || 0, reviewSizing: row.review_sizing || 0,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  return jsonRes({ trades });
}

async function handleCreateTrade(request, env) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入');
  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }
  if (JSON.stringify(body).length > 32768) return jsonErr(400, '交易資料過大');
  if (!body.symbol?.trim()) return jsonErr(400, '交易代號不可為空');
  if (!body.entryPrice && body.entryPrice !== 0) return jsonErr(400, '進場價格不可為空');
  const VALID_MARKETS = ['tw', 'us', 'crypto'];
  const VALID_TYPES = ['stock', 'etf', 'futures', 'options'];
  const VALID_DIRS = ['long', 'short'];
  const VALID_STATUS = ['open', 'closed'];
  const market = VALID_MARKETS.includes(body.market) ? body.market : 'tw';
  const type = VALID_TYPES.includes(body.type) ? body.type : 'stock';
  const direction = VALID_DIRS.includes(body.direction) ? body.direction : 'long';
  const status = VALID_STATUS.includes(body.status) ? body.status : 'open';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const db = env.DB;
  try {
    await db.prepare(`INSERT INTO trades (id, user_id, date, market, type, symbol, name, direction, status, entry_price, exit_price, quantity, contract_mul, stop_loss, take_profit, fee, tax, tags, notes, account, image_url, rating, review_discipline, review_timing, review_sizing, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id, user.sub, body.date || now, market, type,
      String(body.symbol || '').slice(0, 20), String(body.name || '').slice(0, 100), direction, status,
      body.entryPrice ?? null, body.exitPrice ?? null, body.quantity ?? null,
      body.contractMul ?? null, body.stopLoss ?? null, body.takeProfit ?? null,
      body.fee ?? 0, body.tax ?? 0, JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 20) : []), String(body.notes || '').slice(0, 5000),
      String(body.account || '').slice(0, 50), String(body.imageUrl || '').slice(0, 500), body.rating ?? 0,
      body.reviewDiscipline ?? 0, body.reviewTiming ?? 0, body.reviewSizing ?? 0, now, now
    ).run();
  } catch (e) {
    console.error('[Prism] Create trade error:', e);
    return jsonErr(500, '建立交易失敗');
  }
  return jsonRes({ id }, 201);
}

async function handleUpdateTrade(request, env, tradeId) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入');
  const db = env.DB;
  const existing = await db.prepare('SELECT id FROM trades WHERE id = ? AND user_id = ?').bind(tradeId, user.sub).first();
  if (!existing) return jsonErr(404, '找不到此交易紀錄');
  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }
  if (JSON.stringify(body).length > 32768) return jsonErr(400, '交易資料過大');
  if (!body.date) return jsonErr(400, '日期不可為空');
  const VALID_MARKETS = ['tw', 'us', 'crypto'];
  const VALID_TYPES = ['stock', 'etf', 'futures', 'options'];
  const VALID_DIRS = ['long', 'short'];
  const VALID_STATUS = ['open', 'closed'];
  const now = new Date().toISOString();
  try {
    await db.prepare(`UPDATE trades SET date=?, market=?, type=?, symbol=?, name=?, direction=?, status=?, entry_price=?, exit_price=?, quantity=?, contract_mul=?, stop_loss=?, take_profit=?, fee=?, tax=?, tags=?, notes=?, account=?, image_url=?, rating=?, review_discipline=?, review_timing=?, review_sizing=?, updated_at=? WHERE id=? AND user_id=?`).bind(
      body.date, VALID_MARKETS.includes(body.market) ? body.market : 'tw', VALID_TYPES.includes(body.type) ? body.type : 'stock',
      String(body.symbol || '').slice(0, 20), String(body.name || '').slice(0, 100), VALID_DIRS.includes(body.direction) ? body.direction : 'long', VALID_STATUS.includes(body.status) ? body.status : 'open',
      body.entryPrice ?? null, body.exitPrice ?? null, body.quantity ?? null,
      body.contractMul ?? null, body.stopLoss ?? null, body.takeProfit ?? null,
      body.fee ?? 0, body.tax ?? 0, JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 20) : []), String(body.notes || '').slice(0, 5000),
      String(body.account || '').slice(0, 50), String(body.imageUrl || '').slice(0, 500), body.rating ?? 0,
      body.reviewDiscipline ?? 0, body.reviewTiming ?? 0, body.reviewSizing ?? 0, now,
      tradeId, user.sub
    ).run();
  } catch (e) {
    console.error('[Prism] Update trade error:', e);
    return jsonErr(500, '更新交易失敗');
  }
  return jsonRes({ ok: true });
}

async function handleDeleteTrade(request, env, tradeId) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入');
  const db = env.DB;
  try {
    const result = await db.prepare('DELETE FROM trades WHERE id = ? AND user_id = ?').bind(tradeId, user.sub).run();
    if (result.meta.changes === 0) return jsonErr(404, '找不到此交易紀錄');
  } catch (e) {
    console.error('[Prism] Delete trade error:', e);
    return jsonErr(500, '刪除交易失敗');
  }
  return jsonRes({ ok: true });
}

async function handleGetSettings(request, env) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入');
  const row = await env.DB.prepare('SELECT data FROM user_settings WHERE user_id = ?').bind(user.sub).first();
  let settings = {};
  if (row) { try { settings = JSON.parse(row.data); } catch {} }
  return jsonRes({ settings });
}

async function handleSaveSettings(request, env) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入');
  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }
  const now = new Date().toISOString();
  const data = JSON.stringify(body.settings || {});
  if (data.length > 65536) return jsonErr(400, '設定資料過大');
  await env.DB.prepare('INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data=?, updated_at=?').bind(user.sub, data, now, data, now).run();
  return jsonRes({ ok: true });
}

// ── Daily Journal ──
async function handleGetDailyJournals(request, env) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入');
  const { results } = await env.DB.prepare('SELECT * FROM daily_journal WHERE user_id = ? ORDER BY date DESC LIMIT 100').bind(user.sub).all();
  return jsonRes({ journals: results.map(r => ({ id: r.id, date: r.date, mood: r.mood, marketNote: r.market_note, plan: r.plan, review: r.review, discipline: r.discipline || 0, tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })(), takeaway: r.takeaway || '', starred: r.starred || 0 })) });
}

async function handleSaveDailyJournal(request, env) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入');
  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }
  if (!body.date) return jsonErr(400, '日期不可為空');
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO daily_journal (user_id, date, mood, market_note, plan, review, discipline, tags, takeaway, starred, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET mood=?, market_note=?, plan=?, review=?, discipline=?, tags=?, takeaway=?, starred=?, updated_at=?`).bind(
    user.sub, body.date, body.mood ?? 3, body.marketNote || '', body.plan || '', body.review || '', body.discipline ?? 0, JSON.stringify(body.tags || []), body.takeaway || '', body.starred ?? 0, now,
    body.mood ?? 3, body.marketNote || '', body.plan || '', body.review || '', body.discipline ?? 0, JSON.stringify(body.tags || []), body.takeaway || '', body.starred ?? 0, now
  ).run();
  return jsonRes({ ok: true });
}

// ── Router ──
export default {
  async fetch(request, env, ctx) {
    _currentRequest = request;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS' && path.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Only handle /api/* routes in worker — catch all errors to avoid HTML fallback
    if (path.startsWith('/api/')) {
      try {
        // Proxy doesn't need DB
        if (path === '/api/proxy') return await handleProxy(request);

        // Check DB binding
        if (!env.DB) return jsonErr(500, 'D1 database binding not configured. Please add DB binding in Cloudflare Pages dashboard.');

        // Auto-migrate DB on first API request
        await ensureDB(env.DB);

        // API routes
        if (path === '/api/auth/register' && method === 'POST') return await handleRegister(request, env);
        if (path === '/api/auth/login' && method === 'POST') return await handleLoginPost(request, env);
        if (path === '/api/auth/me' && method === 'GET') return await handleMe(request, env);
        if (path === '/api/trades' && method === 'GET') return await handleGetTrades(request, env);
        if (path === '/api/trades' && method === 'POST') return await handleCreateTrade(request, env);
        if (path === '/api/settings' && method === 'GET') return await handleGetSettings(request, env);
        if (path === '/api/settings' && method === 'PUT') return await handleSaveSettings(request, env);
        if (path === '/api/daily-journal' && method === 'GET') return await handleGetDailyJournals(request, env);
        if (path === '/api/daily-journal' && method === 'PUT') return await handleSaveDailyJournal(request, env);

        // /api/trades/:id
        const tradeMatch = path.match(/^\/api\/trades\/([^/]+)$/);
        if (tradeMatch) {
          const tradeId = tradeMatch[1];
          if (tradeId.length > 50 || !/^[a-zA-Z0-9_-]+$/.test(tradeId)) return jsonErr(400, 'Invalid trade ID');
          if (method === 'PUT') return await handleUpdateTrade(request, env, tradeId);
          if (method === 'DELETE') return await handleDeleteTrade(request, env, tradeId);
        }

        return jsonErr(404, 'API route not found');
      } catch (e) {
        console.error('[Prism API Error]', e);
        return jsonErr(500, 'Internal server error');
      }
    }

    // Serve static assets
    return env.ASSETS.fetch(request);
  }
};
