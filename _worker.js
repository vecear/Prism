// Prism — Cloudflare Pages Advanced Mode Worker
// Handles API routes + serves static assets via env.ASSETS

// ── Auto-migrate DB ──
let dbReady = false;
async function ensureDB(db) {
  if (dbReady) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, date TEXT NOT NULL, market TEXT NOT NULL DEFAULT 'tw', type TEXT NOT NULL DEFAULT 'stock', symbol TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL DEFAULT 'long', status TEXT NOT NULL DEFAULT 'open', entry_price REAL, exit_price REAL, quantity REAL, contract_mul REAL, stop_loss REAL, take_profit REAL, fee REAL DEFAULT 0, tax REAL DEFAULT 0, tags TEXT DEFAULT '[]', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id))").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id))").run();
  dbReady = true;
}

// ── CORS ──
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}
function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
function jsonErr(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
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

async function getUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const secret = env.JWT_SECRET || 'prism-default-secret-change-me';
  return await verifyJWT(token, secret);
}

// ── CORS Proxy (migrated from functions/api/proxy.js) ──
const PROXY_ALLOWED = ['mis.twse.com.tw','mis.taifex.com.tw','query1.finance.yahoo.com','query2.finance.yahoo.com','finnhub.io','www.taifex.com.tw','openapi.taifex.com.tw'];

async function handleProxy(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) return jsonErr(400, 'Missing ?url= parameter');
  let targetUrl;
  try { targetUrl = new URL(target); } catch { return jsonErr(400, 'Invalid URL'); }
  if (!PROXY_ALLOWED.includes(targetUrl.hostname)) return jsonErr(403, `Host not allowed: ${targetUrl.hostname}`);
  try {
    const fetchOpts = { method: request.method, headers: {} };
    const ct = request.headers.get('content-type');
    if (ct) fetchOpts.headers['Content-Type'] = ct;
    if (request.method === 'POST') fetchOpts.body = await request.text();
    fetchOpts.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    fetchOpts.headers['Accept'] = 'application/json, text/plain, */*';
    const resp = await fetch(target, fetchOpts);
    const body = await resp.arrayBuffer();
    return new Response(body, {
      status: resp.status,
      headers: { ...corsHeaders(), 'Content-Type': resp.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'public, max-age=30' },
    });
  } catch (e) { return jsonErr(502, `Fetch failed: ${e.message}`); }
}

// ── API Route Handlers ──

async function handleRegister(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }
  const { username, password } = body;
  if (!username || !password) return jsonErr(400, '請提供使用者名稱和密碼');
  if (username.length < 2 || username.length > 20) return jsonErr(400, '使用者名稱需 2-20 字元');
  if (password.length < 4) return jsonErr(400, '密碼至少需要 4 個字元');
  if (!/^[a-zA-Z0-9_\u4e00-\u9fff]+$/.test(username)) return jsonErr(400, '使用者名稱只能包含英文、數字、底線或中文');

  const db = env.DB;
  const existing = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) return jsonErr(409, '此使用者名稱已被註冊');

  const { hash, salt } = await hashPassword(password);
  const result = await db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)').bind(username, hash, salt).run();
  const userId = result.meta.last_row_id;
  const secret = env.JWT_SECRET || 'prism-default-secret-change-me';
  const token = await signJWT({ sub: userId, username }, secret);
  return jsonRes({ token, user: { id: userId, username } }, 201);
}

async function handleLoginPost(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }
  const { username, password } = body;
  if (!username || !password) return jsonErr(400, '請提供使用者名稱和密碼');

  const db = env.DB;
  const user = await db.prepare('SELECT id, username, password_hash, salt FROM users WHERE username = ?').bind(username).first();
  if (!user) return jsonErr(401, '使用者名稱或密碼錯誤');
  const valid = await verifyPassword(password, user.password_hash, user.salt);
  if (!valid) return jsonErr(401, '使用者名稱或密碼錯誤');

  const secret = env.JWT_SECRET || 'prism-default-secret-change-me';
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
    fee: row.fee, tax: row.tax, tags: JSON.parse(row.tags || '[]'), notes: row.notes,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  return jsonRes({ trades });
}

async function handleCreateTrade(request, env) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入');
  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }
  const id = body.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  const now = new Date().toISOString();
  const db = env.DB;
  await db.prepare(`INSERT INTO trades (id, user_id, date, market, type, symbol, name, direction, status, entry_price, exit_price, quantity, contract_mul, stop_loss, take_profit, fee, tax, tags, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    id, user.sub, body.date || now, body.market || 'tw', body.type || 'stock',
    body.symbol || '', body.name || '', body.direction || 'long', body.status || 'open',
    body.entryPrice || null, body.exitPrice || null, body.quantity || null,
    body.contractMul || null, body.stopLoss || null, body.takeProfit || null,
    body.fee || 0, body.tax || 0, JSON.stringify(body.tags || []), body.notes || '', now, now
  ).run();
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
  const now = new Date().toISOString();
  await db.prepare(`UPDATE trades SET date=?, market=?, type=?, symbol=?, name=?, direction=?, status=?, entry_price=?, exit_price=?, quantity=?, contract_mul=?, stop_loss=?, take_profit=?, fee=?, tax=?, tags=?, notes=?, updated_at=? WHERE id=? AND user_id=?`).bind(
    body.date, body.market || 'tw', body.type || 'stock',
    body.symbol || '', body.name || '', body.direction || 'long', body.status || 'open',
    body.entryPrice || null, body.exitPrice || null, body.quantity || null,
    body.contractMul || null, body.stopLoss || null, body.takeProfit || null,
    body.fee || 0, body.tax || 0, JSON.stringify(body.tags || []), body.notes || '', now,
    tradeId, user.sub
  ).run();
  return jsonRes({ ok: true });
}

async function handleDeleteTrade(request, env, tradeId) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入');
  const db = env.DB;
  const result = await db.prepare('DELETE FROM trades WHERE id = ? AND user_id = ?').bind(tradeId, user.sub).run();
  if (result.meta.changes === 0) return jsonErr(404, '找不到此交易紀錄');
  return jsonRes({ ok: true });
}

async function handleGetSettings(request, env) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入');
  const row = await env.DB.prepare('SELECT data FROM user_settings WHERE user_id = ?').bind(user.sub).first();
  return jsonRes({ settings: row ? JSON.parse(row.data) : {} });
}

async function handleSaveSettings(request, env) {
  const user = await getUser(request, env);
  if (!user) return jsonErr(401, '未登入');
  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }
  const now = new Date().toISOString();
  const data = JSON.stringify(body.settings || {});
  await env.DB.prepare('INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data=?, updated_at=?').bind(user.sub, data, now, data, now).run();
  return jsonRes({ ok: true });
}

// ── Router ──
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS' && path.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Auto-migrate DB on first API request
    if (path.startsWith('/api/') && path !== '/api/proxy' && env.DB) {
      try { await ensureDB(env.DB); } catch (e) {
        return jsonErr(500, 'DB init failed: ' + e.message);
      }
    }

    // API routes
    if (path === '/api/proxy') return handleProxy(request);
    if (path === '/api/auth/register' && method === 'POST') return handleRegister(request, env);
    if (path === '/api/auth/login' && method === 'POST') return handleLoginPost(request, env);
    if (path === '/api/auth/me' && method === 'GET') return handleMe(request, env);
    if (path === '/api/trades' && method === 'GET') return handleGetTrades(request, env);
    if (path === '/api/trades' && method === 'POST') return handleCreateTrade(request, env);
    if (path === '/api/settings' && method === 'GET') return handleGetSettings(request, env);
    if (path === '/api/settings' && method === 'PUT') return handleSaveSettings(request, env);

    // /api/trades/:id
    const tradeMatch = path.match(/^\/api\/trades\/([^/]+)$/);
    if (tradeMatch) {
      const tradeId = tradeMatch[1];
      if (method === 'PUT') return handleUpdateTrade(request, env, tradeId);
      if (method === 'DELETE') return handleDeleteTrade(request, env, tradeId);
    }

    // Serve static assets
    return env.ASSETS.fetch(request);
  }
};
