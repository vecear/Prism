#!/usr/bin/env node
// Prism — Local-only server (single user, no auth, SQLite via node:sqlite)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { randomUUID } from 'crypto';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PRISM_PORT ? +process.env.PRISM_PORT : 3000;
const USER_ID = 1;

// ── Database ──
const db = new DatabaseSync(path.join(__dirname, 'prism.db'));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL DEFAULT 1,
    date TEXT NOT NULL,
    market TEXT NOT NULL DEFAULT 'tw',
    type TEXT NOT NULL DEFAULT 'stock',
    symbol TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    direction TEXT NOT NULL DEFAULT 'long',
    status TEXT NOT NULL DEFAULT 'open',
    entry_price REAL,
    exit_price REAL,
    quantity REAL,
    contract_mul REAL,
    stop_loss REAL,
    take_profit REAL,
    fee REAL DEFAULT 0,
    tax REAL DEFAULT 0,
    tags TEXT DEFAULT '[]',
    notes TEXT DEFAULT '',
    close_date TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS daily_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    mood INTEGER DEFAULT 3,
    market_note TEXT DEFAULT '',
    plan TEXT DEFAULT '',
    review TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, date)
  );
  CREATE TABLE IF NOT EXISTS presets (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS templates (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS app_state (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Incremental migrations (v2–v11 from _worker.js)
const migrations = [
  "ALTER TABLE trades ADD COLUMN account TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE trades ADD COLUMN image_url TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE trades ADD COLUMN rating INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE daily_journal ADD COLUMN discipline INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE daily_journal ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE daily_journal ADD COLUMN takeaway TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE daily_journal ADD COLUMN starred INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN review_discipline INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN review_timing INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN review_sizing INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN pricing_stage TEXT NOT NULL DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_trades_user_date ON trades(user_id, date DESC)",
  "ALTER TABLE trades ADD COLUMN close_date TEXT NOT NULL DEFAULT ''",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch {}
}

db.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)').run(USER_ID, 'local');

// ── Static file MIME types ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

// ── Helpers ──
function jsonOk(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
function jsonErr(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}
// Overall request body cap — must stay >= the largest per-field data limit
// (presets 131072) so a max-size legal payload is not rejected by readBody.
const MAX_BODY = 262144; // 256KB
class BadBodyError extends Error { constructor(message) { super(message); this.status = 400; } }
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > MAX_BODY) reject(new BadBodyError('Request body too large')); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new BadBodyError('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function mapTrade(row) {
  return {
    id: row.id, date: row.date, market: row.market, type: row.type,
    symbol: row.symbol, name: row.name, direction: row.direction, status: row.status,
    entryPrice: row.entry_price, exitPrice: row.exit_price, quantity: row.quantity,
    contractMul: row.contract_mul ?? null, stopLoss: row.stop_loss, takeProfit: row.take_profit,
    fee: row.fee, tax: row.tax,
    tags: (() => { try { return JSON.parse(row.tags || '[]'); } catch { return []; } })(),
    notes: row.notes, account: row.account || '', imageUrl: row.image_url || '',
    rating: row.rating || 0, reviewDiscipline: row.review_discipline || 0,
    reviewTiming: row.review_timing || 0, reviewSizing: row.review_sizing || 0,
    pricingStage: row.pricing_stage || '', closeDate: row.close_date || '',
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const VALID_MARKETS = ['tw', 'us', 'crypto'];
const VALID_TYPES = ['stock', 'etf', 'futures', 'options', 'index_futures', 'stock_futures', 'commodity_futures', 'crypto_contract', 'crypto_spot'];
const VALID_DIRS = ['long', 'short'];
const VALID_STATUS = ['open', 'closed'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;
// 只允許有限數值或 null 入庫，過濾 NaN/Infinity/非數字字串
const num = v => (v == null || v === '') ? null : (Number.isFinite(+v) ? +v : null);

// ── CORS proxy ──
const PROXY_ALLOWED = ['mis.twse.com.tw', 'mis.taifex.com.tw', 'query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'finnhub.io', 'www.taifex.com.tw', 'openapi.taifex.com.tw', 'openapi.twse.com.tw', 'www.tpex.org.tw', 'www.sec.gov', 'api.nasdaq.com', 'production.dataviz.cnn.io', 'api.binance.com', 'fred.stlouisfed.org', 'squeezemetrics.com'];

async function handleProxy(req, res, searchParams) {
  if (!['GET', 'POST'].includes(req.method)) return jsonErr(res, 405, 'Method not allowed');
  const target = searchParams.get('url');
  if (!target) return jsonErr(res, 400, 'Missing ?url= parameter');
  if (target.length > 2048) return jsonErr(res, 400, 'URL too long');
  let targetUrl;
  try { targetUrl = new URL(target); } catch { return jsonErr(res, 400, 'Invalid URL'); }
  if (!PROXY_ALLOWED.includes(targetUrl.hostname)) return jsonErr(res, 403, 'Host not allowed');
  if (targetUrl.protocol !== 'https:') return jsonErr(res, 403, 'Only HTTPS allowed');
  try {
    const opts = {
      method: req.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };
    if (req.method === 'POST') {
      const cl = parseInt(req.headers['content-length'] || '0', 10);
      if (cl > 65536) { req.destroy(); return jsonErr(res, 400, 'Request body too large'); }
      const incomingCT = req.headers['content-type'];
      if (incomingCT) opts.headers['Content-Type'] = incomingCT;
      try {
        opts.body = await new Promise((resolve, reject) => {
          let b = '';
          req.on('data', c => { b += c; if (b.length > 65536) { req.destroy(); reject(new Error('Request body too large')); } });
          req.on('end', () => resolve(b));
          req.on('error', reject);
        });
      } catch { return jsonErr(res, 400, 'Request body too large'); }
    }
    // SSRF 防護：手動跟隨重導，每一跳都重新比對 PROXY_ALLOWED 白名單。
    // 重導語意：依 RFC 7231，跟隨 3xx 時將後續請求改為 GET 並清除 body / Content-Type，
    // 避免把原始 POST body 重送到重導目標（現況唯一 POST 代理目標 taifex 不重導，
    // 但此處理確保白名單若擴充也不會發生 body 重送）。
    let currentTarget = target;
    let hopOpts = { ...opts, headers: { ...opts.headers } };
    let fetchRes;
    for (let hop = 0; ; hop++) {
      fetchRes = await fetch(currentTarget, { ...hopOpts, redirect: 'manual' });
      if (fetchRes.status < 300 || fetchRes.status >= 400) break;
      const loc = fetchRes.headers.get('location');
      if (!loc) break; // 無 Location，直接回傳此回應
      if (hop >= 5) return jsonErr(res, 502, 'Too many redirects');
      let nextUrl;
      try { nextUrl = new URL(loc, currentTarget); } catch { return jsonErr(res, 502, 'Invalid redirect target'); }
      if (nextUrl.protocol !== 'https:') return jsonErr(res, 403, 'Redirect to non-HTTPS blocked');
      if (!PROXY_ALLOWED.includes(nextUrl.hostname)) return jsonErr(res, 403, 'Redirect host not allowed');
      currentTarget = nextUrl.toString();
      // 重導後改用 GET，丟棄 body 與 Content-Type
      if (hopOpts.method !== 'GET') {
        hopOpts.method = 'GET';
        delete hopOpts.body;
        delete hopOpts.headers['Content-Type'];
      }
    }
    const buf = Buffer.from(await fetchRes.arrayBuffer());
    const ct = fetchRes.headers.get('content-type') || '';
    res.writeHead(fetchRes.status, {
      'Content-Type': ct.includes('text/html') ? 'text/plain' : (ct || 'application/json'),
      'Cache-Control': 'private, max-age=30',
    });
    res.end(buf);
  } catch (e) {
    console.error('[Proxy Error]', e.message);
    jsonErr(res, 502, 'Proxy fetch failed');
  }
}

// ── FRED Data Proxy（與雲端 _worker.js handleFred 對齊）──
const FRED_ALLOWED_SERIES = ['BAMLH0A0HYM2', 'T5YIE'];
async function handleFred(req, res, searchParams) {
  const series = searchParams.get('series');
  if (!series || !FRED_ALLOWED_SERIES.includes(series)) return jsonErr(res, 400, 'Invalid or missing series parameter');
  const fredKey = process.env.FRED_API_KEY || '';
  if (!fredKey) return jsonErr(res, 503, '未設定 FRED_API_KEY 環境變數');
  try {
    const apiUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${fredKey}&file_type=json&sort_order=desc&limit=10`;
    const resp = await fetch(apiUrl);
    if (!resp.ok) throw new Error(`FRED API HTTP ${resp.status}`);
    const d = await resp.json();
    const obs = (d.observations || []).filter(o => o.value && o.value !== '.');
    if (obs.length === 0) throw new Error('No observations');
    const header = `observation_date,${series}`;
    const rows = obs.reverse().map(o => `${o.date},${o.value}`);
    const csv = [header, ...rows].join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Cache-Control': 'public, max-age=3600' });
    res.end(csv);
  } catch (e) { console.error('[Prism] FRED fetch failed:', e.message); jsonErr(res, 502, 'FRED fetch failed'); }
}

// ── API route handlers ──
function routeTrades(req, res, method, tradeId, body) {
  // tradeId 格式驗證上移到分派處，使 GET/PUT/DELETE 皆驗證且回傳碼與雲端 (_worker.js) 對稱：
  // 無效 id → 400；有效 id 但方法不支援 (如 GET) → 404（而非 405）
  if (tradeId && (tradeId.length > 50 || !/^[a-zA-Z0-9_-]+$/.test(tradeId))) {
    return jsonErr(res, 400, 'Invalid trade ID');
  }

  if (!tradeId && method === 'GET') {
    const rows = db.prepare('SELECT * FROM trades WHERE user_id = ? ORDER BY date DESC LIMIT 5000').all(USER_ID);
    return jsonOk(res, { trades: rows.map(mapTrade) });
  }

  if (!tradeId && method === 'POST') {
    if (JSON.stringify(body).length > 32768) return jsonErr(res, 400, '交易資料過大');
    if (!body.symbol?.trim()) return jsonErr(res, 400, '交易代號不可為空');
    if (!(parseFloat(body.entryPrice) > 0)) return jsonErr(res, 400, '進場價格必須大於 0');
    if (!(parseFloat(body.quantity) > 0)) return jsonErr(res, 400, '數量必須大於 0');
    if (body.date && !DATE_RE.test(body.date)) return jsonErr(res, 400, '日期格式無效');
    const imgUrl = String(body.imageUrl || '').slice(0, 500);
    if (imgUrl && !imgUrl.startsWith('https://')) return jsonErr(res, 400, 'imageUrl 必須使用 HTTPS');
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO trades (id, user_id, date, market, type, symbol, name, direction, status, entry_price, exit_price, quantity, contract_mul, stop_loss, take_profit, fee, tax, tags, notes, account, image_url, rating, review_discipline, review_timing, review_sizing, pricing_stage, close_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, USER_ID, body.date || now,
        VALID_MARKETS.includes(body.market) ? body.market : 'tw',
        VALID_TYPES.includes(body.type) ? body.type : 'stock',
        String(body.symbol || '').slice(0, 20), String(body.name || '').slice(0, 100),
        VALID_DIRS.includes(body.direction) ? body.direction : 'long',
        VALID_STATUS.includes(body.status) ? body.status : 'open',
        num(body.entryPrice), num(body.exitPrice), num(body.quantity),
        body.contractMul ? parseFloat(body.contractMul) || null : null,
        num(body.stopLoss), num(body.takeProfit),
        num(body.fee) ?? 0, num(body.tax) ?? 0,
        JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 20).map(t => String(t).slice(0, 50)) : []),
        String(body.notes || '').slice(0, 5000), String(body.account || '').slice(0, 50),
        imgUrl,
        num(body.rating) ?? 0, num(body.reviewDiscipline) ?? 0, num(body.reviewTiming) ?? 0, num(body.reviewSizing) ?? 0,
        String(body.pricingStage || '').slice(0, 20), String(body.closeDate || '').slice(0, 30), now, now);
    return jsonOk(res, { id }, 201);
  }

  if (tradeId && method === 'PUT') {
    if (JSON.stringify(body).length > 32768) return jsonErr(res, 400, '交易資料過大');
    const existing = db.prepare('SELECT id FROM trades WHERE id = ? AND user_id = ?').get(tradeId, USER_ID);
    if (!existing) return jsonErr(res, 404, '找不到此交易紀錄');
    if (!body.date) return jsonErr(res, 400, '日期不可為空');
    if (!DATE_RE.test(body.date)) return jsonErr(res, 400, '日期格式無效');
    if (!body.symbol?.trim()) return jsonErr(res, 400, '交易代號不可為空');
    if (!(parseFloat(body.entryPrice) > 0)) return jsonErr(res, 400, '進場價格必須大於 0');
    if (!(parseFloat(body.quantity) > 0)) return jsonErr(res, 400, '數量必須大於 0');
    const imgUrl = String(body.imageUrl || '').slice(0, 500);
    if (imgUrl && !imgUrl.startsWith('https://')) return jsonErr(res, 400, 'imageUrl 必須使用 HTTPS');
    const now = new Date().toISOString();
    db.prepare(`UPDATE trades SET date=?, market=?, type=?, symbol=?, name=?, direction=?, status=?, entry_price=?, exit_price=?, quantity=?, contract_mul=?, stop_loss=?, take_profit=?, fee=?, tax=?, tags=?, notes=?, account=?, image_url=?, rating=?, review_discipline=?, review_timing=?, review_sizing=?, pricing_stage=?, close_date=?, updated_at=? WHERE id=? AND user_id=?`)
      .run(body.date,
        VALID_MARKETS.includes(body.market) ? body.market : 'tw',
        VALID_TYPES.includes(body.type) ? body.type : 'stock',
        String(body.symbol || '').slice(0, 20), String(body.name || '').slice(0, 100),
        VALID_DIRS.includes(body.direction) ? body.direction : 'long',
        VALID_STATUS.includes(body.status) ? body.status : 'open',
        num(body.entryPrice), num(body.exitPrice), num(body.quantity),
        body.contractMul ? parseFloat(body.contractMul) || null : null,
        num(body.stopLoss), num(body.takeProfit),
        num(body.fee) ?? 0, num(body.tax) ?? 0,
        JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 20).map(t => String(t).slice(0, 50)) : []),
        String(body.notes || '').slice(0, 5000), String(body.account || '').slice(0, 50),
        imgUrl,
        num(body.rating) ?? 0, num(body.reviewDiscipline) ?? 0, num(body.reviewTiming) ?? 0, num(body.reviewSizing) ?? 0,
        String(body.pricingStage || '').slice(0, 20), String(body.closeDate || '').slice(0, 30), now,
        tradeId, USER_ID);
    return jsonOk(res, { ok: true });
  }

  if (tradeId && method === 'DELETE') {
    const result = db.prepare('DELETE FROM trades WHERE id = ? AND user_id = ?').run(tradeId, USER_ID);
    if (result.changes === 0) return jsonErr(res, 404, '找不到此交易紀錄');
    return jsonOk(res, { ok: true });
  }

  // 有效 id 但方法不支援 (如 GET) → 404，與 _worker.js 落到 'API route not found' 對稱
  if (tradeId) return jsonErr(res, 404, 'API route not found');
  jsonErr(res, 405, 'Method not allowed');
}

function routeSettings(req, res, method, body) {
  if (method === 'GET') {
    const row = db.prepare('SELECT data FROM user_settings WHERE user_id = ?').get(USER_ID);
    let settings = {};
    if (row) { try { settings = JSON.parse(row.data); } catch {} }
    return jsonOk(res, { settings });
  }
  if (method === 'PUT') {
    const now = new Date().toISOString();
    const data = JSON.stringify(body.settings || {});
    if (data.length > 65536) return jsonErr(res, 400, '設定資料過大');
    db.prepare('INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data=?, updated_at=?')
      .run(USER_ID, data, now, data, now);
    return jsonOk(res, { ok: true });
  }
  jsonErr(res, 405, 'Method not allowed');
}

function routeDailyJournal(req, res, method, body) {
  if (method === 'GET') {
    const rows = db.prepare('SELECT * FROM daily_journal WHERE user_id = ? ORDER BY date DESC LIMIT 100').all(USER_ID);
    return jsonOk(res, {
      journals: rows.map(r => ({
        id: r.id, date: r.date, mood: r.mood, marketNote: r.market_note, plan: r.plan,
        review: r.review, discipline: r.discipline || 0,
        tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })(),
        takeaway: r.takeaway || '', starred: r.starred || 0,
      })),
    });
  }
  if (method === 'PUT') {
    if (JSON.stringify(body).length > 32768) return jsonErr(res, 400, '日記資料過大');
    if (!body.date) return jsonErr(res, 400, '日期不可為空');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return jsonErr(res, 400, '日期格式無效');
    const now = new Date().toISOString();
    const mood = Math.max(1, Math.min(5, parseInt(body.mood) || 3));
    const discipline = Math.max(0, Math.min(5, parseInt(body.discipline) || 0));
    const tags = JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 20).map(t => String(t).slice(0, 50)) : []);
    db.prepare(`INSERT INTO daily_journal (user_id, date, mood, market_note, plan, review, discipline, tags, takeaway, starred, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET mood=?, market_note=?, plan=?, review=?, discipline=?, tags=?, takeaway=?, starred=?, updated_at=?`)
      .run(USER_ID, body.date, mood,
        String(body.marketNote || '').slice(0, 2000),
        String(body.plan || '').slice(0, 5000),
        String(body.review || '').slice(0, 5000),
        discipline, tags,
        String(body.takeaway || '').slice(0, 2000),
        body.starred ? 1 : 0, now,
        mood,
        String(body.marketNote || '').slice(0, 2000),
        String(body.plan || '').slice(0, 5000),
        String(body.review || '').slice(0, 5000),
        discipline, tags,
        String(body.takeaway || '').slice(0, 2000),
        body.starred ? 1 : 0, now);
    return jsonOk(res, { ok: true });
  }
  jsonErr(res, 405, 'Method not allowed');
}

function routePresets(req, res, method, body) {
  if (method === 'GET') {
    const row = db.prepare('SELECT data, updated_at FROM presets WHERE user_id = ?').get(USER_ID);
    let presets = {};
    if (row) { try { presets = JSON.parse(row.data); } catch {} }
    return jsonOk(res, { presets, updatedAt: row?.updated_at || null });
  }
  if (method === 'PUT') {
    const now = new Date().toISOString();
    const data = JSON.stringify(body.presets || {});
    if (data.length > 131072) return jsonErr(res, 400, '預設資料過大');
    db.prepare('INSERT INTO presets (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data=?, updated_at=?')
      .run(USER_ID, data, now, data, now);
    return jsonOk(res, { ok: true, updatedAt: now });
  }
  jsonErr(res, 405, 'Method not allowed');
}

function routeTemplates(req, res, method, body) {
  if (method === 'GET') {
    const row = db.prepare('SELECT data, updated_at FROM templates WHERE user_id = ?').get(USER_ID);
    let templates = [];
    if (row) { try { templates = JSON.parse(row.data); } catch {} }
    return jsonOk(res, { templates, updatedAt: row?.updated_at || null });
  }
  if (method === 'PUT') {
    const now = new Date().toISOString();
    const arr = Array.isArray(body.templates) ? body.templates.slice(0, 50) : [];
    const data = JSON.stringify(arr);
    if (data.length > 65536) return jsonErr(res, 400, '範本資料過大');
    db.prepare('INSERT INTO templates (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data=?, updated_at=?')
      .run(USER_ID, data, now, data, now);
    return jsonOk(res, { ok: true, updatedAt: now });
  }
  jsonErr(res, 405, 'Method not allowed');
}

function routeAppState(req, res, method, body) {
  if (method === 'GET') {
    const row = db.prepare('SELECT data, updated_at FROM app_state WHERE user_id = ?').get(USER_ID);
    let state = {};
    if (row) { try { state = JSON.parse(row.data); } catch {} }
    return jsonOk(res, { state, updatedAt: row?.updated_at || null });
  }
  if (method === 'PUT') {
    const now = new Date().toISOString();
    const data = JSON.stringify(body.state || {});
    if (data.length > 32768) return jsonErr(res, 400, '狀態資料過大');
    db.prepare('INSERT INTO app_state (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data=?, updated_at=?')
      .run(USER_ID, data, now, data, now);
    return jsonOk(res, { ok: true, updatedAt: now });
  }
  jsonErr(res, 405, 'Method not allowed');
}

function routeMigrateTrades(req, res) {
  const rows = db.prepare("SELECT id, market, type, contract_mul, symbol FROM trades WHERE user_id = ? AND type = 'stock' AND contract_mul IS NOT NULL AND contract_mul > 0").all(USER_ID);
  let fixed = 0;
  for (const row of rows) {
    const newType = row.market === 'crypto' ? 'crypto_contract' : 'index_futures';
    db.prepare("UPDATE trades SET type = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(newType, row.id, USER_ID);
    fixed++;
  }
  return jsonOk(res, { ok: true, fixed });
}

// ── HTTP server ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', `http://localhost:${PORT}`);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      // Proxy must read its own body — handle before readBody() drains the stream
      if (pathname === '/api/proxy') return await handleProxy(req, res, url.searchParams);
      if (pathname === '/api/fred') return await handleFred(req, res, url.searchParams);

      let body = {};
      if (['POST', 'PUT'].includes(method)) body = await readBody(req);

      if (pathname === '/api/auth/me') return jsonOk(res, { user: { id: USER_ID, username: 'local' } });
      if (pathname === '/api/auth/register' || pathname === '/api/auth/login') {
        return jsonOk(res, { token: 'local', user: { id: USER_ID, username: 'local' } });
      }
      if (pathname === '/api/trades') return routeTrades(req, res, method, null, body);
      const tradeMatch = pathname.match(/^\/api\/trades\/([^/]+)$/);
      if (tradeMatch) return routeTrades(req, res, method, tradeMatch[1], body);
      if (pathname === '/api/settings') return routeSettings(req, res, method, body);
      if (pathname === '/api/daily-journal') return routeDailyJournal(req, res, method, body);
      if (pathname === '/api/presets') return routePresets(req, res, method, body);
      if (pathname === '/api/templates') return routeTemplates(req, res, method, body);
      if (pathname === '/api/app-state') return routeAppState(req, res, method, body);
      if (pathname === '/api/migrate-trades' && method === 'POST') return routeMigrateTrades(req, res);

      jsonErr(res, 404, 'API route not found');
    } catch (e) {
      if (e instanceof BadBodyError) { jsonErr(res, 400, e.message); return; }
      console.error('[Prism API Error]', e.message);
      jsonErr(res, 500, 'Internal server error');
    }
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname.replace(/\.\./g, '');
  // Strip query string from file path
  filePath = filePath.split('?')[0];
  const absPath = path.join(__dirname, filePath);

  // Security: must stay within project directory
  if (!absPath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) throw new Error('Not a file');
    const ext = path.extname(absPath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // HTML 與 service worker 永不快取，避免改動後使用者看到舊版本
    if (ext === '.html' || absPath.endsWith('sw.js')) {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }
    res.writeHead(200, headers);
    fs.createReadStream(absPath).pipe(res);
  } catch {
    // Fallback: serve index.html for SPA-style navigation
    const indexPath = path.join(__dirname, 'index.html');
    try {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      fs.createReadStream(indexPath).pipe(res);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nPrism 本機伺服器已啟動：${url}\n`);
  console.log('資料庫：prism.db（專案目錄）');
  console.log('按 Ctrl+C 停止伺服器\n');
  // Open browser (Windows)
  exec(`start ${url}`, err => {
    if (err) console.log(`請手動開啟瀏覽器：${url}`);
  });
});
