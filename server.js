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
const PORT = 3000;
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
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 131072) reject(new Error('Body too large')); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
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
    pricingStage: row.pricing_stage || '', createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const VALID_MARKETS = ['tw', 'us', 'crypto'];
const VALID_TYPES = ['stock', 'etf', 'futures', 'options', 'index_futures', 'stock_futures', 'commodity_futures', 'crypto_contract', 'crypto_spot'];
const VALID_DIRS = ['long', 'short'];
const VALID_STATUS = ['open', 'closed'];

// ── CORS proxy ──
const PROXY_ALLOWED = ['mis.twse.com.tw', 'mis.taifex.com.tw', 'query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'finnhub.io', 'www.taifex.com.tw', 'openapi.taifex.com.tw', 'openapi.twse.com.tw', 'www.tpex.org.tw', 'www.sec.gov', 'api.nasdaq.com', 'production.dataviz.cnn.io', 'api.binance.com', 'fred.stlouisfed.org', 'squeezemetrics.com', 'api.alternative.me'];

async function handleProxy(req, res, searchParams) {
  const target = searchParams.get('url');
  if (!target) return jsonErr(res, 400, 'Missing ?url= parameter');
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
      opts.body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    }
    const fetchRes = await fetch(target, opts);
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

// ── API route handlers ──
function routeTrades(req, res, method, tradeId, body) {
  if (!tradeId && method === 'GET') {
    const rows = db.prepare('SELECT * FROM trades WHERE user_id = ? ORDER BY date DESC LIMIT 5000').all(USER_ID);
    return jsonOk(res, { trades: rows.map(mapTrade) });
  }

  if (!tradeId && method === 'POST') {
    if (!body.symbol?.trim()) return jsonErr(res, 400, '交易代號不可為空');
    if (body.entryPrice == null) return jsonErr(res, 400, '進場價格不可為空');
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO trades (id, user_id, date, market, type, symbol, name, direction, status, entry_price, exit_price, quantity, contract_mul, stop_loss, take_profit, fee, tax, tags, notes, account, image_url, rating, review_discipline, review_timing, review_sizing, pricing_stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, USER_ID, body.date || now,
        VALID_MARKETS.includes(body.market) ? body.market : 'tw',
        VALID_TYPES.includes(body.type) ? body.type : 'stock',
        String(body.symbol || '').slice(0, 20), String(body.name || '').slice(0, 100),
        VALID_DIRS.includes(body.direction) ? body.direction : 'long',
        VALID_STATUS.includes(body.status) ? body.status : 'open',
        body.entryPrice ?? null, body.exitPrice ?? null, body.quantity ?? null,
        body.contractMul ? parseFloat(body.contractMul) || null : null,
        body.stopLoss ?? null, body.takeProfit ?? null,
        body.fee ?? 0, body.tax ?? 0,
        JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 20).map(t => String(t).slice(0, 50)) : []),
        String(body.notes || '').slice(0, 5000), String(body.account || '').slice(0, 50),
        String(body.imageUrl || '').slice(0, 500),
        body.rating ?? 0, body.reviewDiscipline ?? 0, body.reviewTiming ?? 0, body.reviewSizing ?? 0,
        String(body.pricingStage || '').slice(0, 20), now, now);
    return jsonOk(res, { id }, 201);
  }

  if (tradeId && method === 'PUT') {
    const existing = db.prepare('SELECT id FROM trades WHERE id = ? AND user_id = ?').get(tradeId, USER_ID);
    if (!existing) return jsonErr(res, 404, '找不到此交易紀錄');
    if (!body.symbol?.trim()) return jsonErr(res, 400, '交易代號不可為空');
    const now = new Date().toISOString();
    db.prepare(`UPDATE trades SET date=?, market=?, type=?, symbol=?, name=?, direction=?, status=?, entry_price=?, exit_price=?, quantity=?, contract_mul=?, stop_loss=?, take_profit=?, fee=?, tax=?, tags=?, notes=?, account=?, image_url=?, rating=?, review_discipline=?, review_timing=?, review_sizing=?, pricing_stage=?, updated_at=? WHERE id=? AND user_id=?`)
      .run(body.date || now,
        VALID_MARKETS.includes(body.market) ? body.market : 'tw',
        VALID_TYPES.includes(body.type) ? body.type : 'stock',
        String(body.symbol || '').slice(0, 20), String(body.name || '').slice(0, 100),
        VALID_DIRS.includes(body.direction) ? body.direction : 'long',
        VALID_STATUS.includes(body.status) ? body.status : 'open',
        body.entryPrice ?? null, body.exitPrice ?? null, body.quantity ?? null,
        body.contractMul ? parseFloat(body.contractMul) || null : null,
        body.stopLoss ?? null, body.takeProfit ?? null,
        body.fee ?? 0, body.tax ?? 0,
        JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 20).map(t => String(t).slice(0, 50)) : []),
        String(body.notes || '').slice(0, 5000), String(body.account || '').slice(0, 50),
        String(body.imageUrl || '').slice(0, 500),
        body.rating ?? 0, body.reviewDiscipline ?? 0, body.reviewTiming ?? 0, body.reviewSizing ?? 0,
        String(body.pricingStage || '').slice(0, 20), now,
        tradeId, USER_ID);
    return jsonOk(res, { ok: true });
  }

  if (tradeId && method === 'DELETE') {
    const result = db.prepare('DELETE FROM trades WHERE id = ? AND user_id = ?').run(tradeId, USER_ID);
    if (result.changes === 0) return jsonErr(res, 404, '找不到此交易紀錄');
    return jsonOk(res, { ok: true });
  }

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
    if (!body.date) return jsonErr(res, 400, '日期不可為空');
    const now = new Date().toISOString();
    const mood = Math.max(1, Math.min(5, parseInt(body.mood) || 3));
    const discipline = Math.max(0, Math.min(5, parseInt(body.discipline) || 0));
    const tags = JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 20) : []);
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
      let body = {};
      if (['POST', 'PUT'].includes(method)) body = await readBody(req);

      if (pathname === '/api/proxy') return await handleProxy(req, res, url.searchParams);
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
