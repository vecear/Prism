/* ================================================================
   Prism — Trade Journal (交易紀錄)
   Cloudflare D1 backend + JWT auth
   - Header login on page load
   - "Record Trade" buttons in calculator tabs
   - Navigate to journal for notes
   ================================================================ */
(() => {
'use strict';

const API = (location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'https://prism-7t8.pages.dev/api' : '/api';
const TOKEN_KEY = 'prism_token';
const USER_KEY = 'prism_user_info';
const $ = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];

// XSS escape helper
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── State ──
let authToken = localStorage.getItem(TOKEN_KEY) || '';
let currentUser = (() => { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } })();
let trades = [];
let editingId = null;
let filterState = { market: 'all', type: 'all', tag: 'all', account: 'all', status: 'all', search: '', dateFrom: '', dateTo: '' };
let sortState = { field: 'date', asc: false };
let viewMode = 'list'; // 'list' | 'calendar' | 'stats'
let statsMarketTab = 'overview'; // 'overview' | 'tw' | 'us' | 'crypto'
let liveQuotes = {}; // { "symbol|market": { price, time } }
let alertDismissed = {}; // dismissed SL/TP alerts this session
let calMonth = null; // for calendar view: { year, month }
let quickFilter = 'all'; // 'all' | 'today' | 'open' | 'winners' | 'losers'

// ── API helpers ──
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
  let data;
  try { data = await res.json(); } catch { throw new Error(`HTTP ${res.status}: 伺服器回應格式錯誤`); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadTrades() {
  try { const data = await api('/trades'); trades = data.trades || []; }
  catch (e) { console.warn('[Journal] Load trades failed:', e.message); trades = []; }
  liveQuotes = {}; // 重新載入時清除舊報價
  // One-time cleanup: strip price/quote junk from trade names
  if (trades.length && !localStorage.getItem('j-name-cleaned')) {
    const dirtyTrades = [];
    for (const t of trades) {
      if (!t.name) continue;
      const m = t.name.match(/^(.+?)\s+\d[\d,.]+\s/);
      if (m) { t.name = m[1].replace(/,\s*$/, '').trim(); dirtyTrades.push(t); }
    }
    if (dirtyTrades.length) {
      console.log(`[Journal] Cleaning ${dirtyTrades.length} trade name(s)…`);
      await Promise.all(dirtyTrades.map(t =>
        api(`/trades/${t.id}`, { method: 'PUT', body: JSON.stringify(t) }).catch(() => {})
      ));
    }
    localStorage.setItem('j-name-cleaned', '1');
  }
  // One-time migration: fix trades with wrong type (stock → correct futures/crypto type)
  if (trades.length && !localStorage.getItem('j-type-migrated')) {
    try {
      const res = await api('/migrate-trades', { method: 'POST', body: '{}' });
      if (res.fixed > 0) {
        console.log(`[Journal] Migrated ${res.fixed} trade type(s)`);
        // Reload to get corrected data
        const data = await api('/trades');
        trades = data.trades || [];
      }
    } catch (e) { console.warn('[Journal] Type migration failed:', e.message); }
    localStorage.setItem('j-type-migrated', '1');
  }
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
// ── Format helpers ──
function fmtNum(n, d = 0) { return n == null || isNaN(n) || !isFinite(n) ? '—' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function getPriceOpts(market, type) {
  const s = typeof CFG !== 'undefined' ? CFG : (JSON.parse(localStorage.getItem('tg-settings')) || {});
  const p = v => { const n = parseInt(v); return isNaN(n) ? undefined : n; };
  let prefix;
  if (market === 'crypto') prefix = 'priceDecCrypto';
  else if (market === 'us') {
    if (type === 'options') prefix = 'priceDecUsOpt';
    else if (isFuturesType(type)) prefix = 'priceDecUsFut';
    else prefix = 'priceDecUs';
  } else {
    if (type === 'options') prefix = 'priceDecTwOpt';
    else if (isFuturesType(type)) prefix = 'priceDecTwFut';
    else prefix = 'priceDecTw';
  }
  const defaults = { priceDecTw:2, priceDecTwFut:0, priceDecTwOpt:1, priceDecUs:3, priceDecUsFut:2, priceDecUsOpt:2, priceDecCrypto:4 };
  return {
    dec: p(s[prefix]) ?? defaults[prefix] ?? 2,
    round: s[prefix + 'Round'] !== false,
    trim: s[prefix + 'Trim'] !== false,
  };
}
function fmtPrice(n, market, type) {
  if (n == null || isNaN(n) || !isFinite(n)) return '—';
  const { dec: d, round, trim } = getPriceOpts(market, type);
  if (!round) {
    const str = String(Number(n)), dec = str.includes('.') ? str.split('.')[1].length : 0;
    const digits = Math.min(dec, 10);
    return Number(n).toLocaleString('zh-TW', { minimumFractionDigits: trim ? 0 : digits, maximumFractionDigits: digits });
  }
  return Number(n).toLocaleString('zh-TW', { minimumFractionDigits: trim ? 0 : d, maximumFractionDigits: d });
}
const MKT_CURRENCY = { tw: { sym: 'NT$', d: 0 }, us: { sym: 'US$', d: 2 }, crypto: { sym: 'USDT', d: 2 } };
function fmtMoney(n, market, d) {
  if (n == null || isNaN(n) || !isFinite(n)) return '—';
  const c = MKT_CURRENCY[market] || MKT_CURRENCY.tw;
  const dec = d ?? c.d;
  return (n < 0 ? '-' : '') + c.sym + ' ' + fmtNum(Math.abs(n), dec);
}
// Resolve fee/tax value: if mode is "pct", compute percentage of notional
function resolveFeeVal(inputId, modeId) {
  const raw = parseFloat($('#' + inputId)?.value) || 0;
  const mode = $('#' + modeId)?.dataset.mode || 'fixed';
  if (mode === 'fixed') return raw;
  // pct mode: raw is percentage, compute notional × raw/100
  const en = parseFloat($('#jf-entry')?.value) || 0;
  const ex = parseFloat($('#jf-exit')?.value) || 0;
  const q = parseFloat($('#jf-qty')?.value) || 0;
  const typeVal = $('#jf-type2')?.value || 'stock';
  const mul = (isFuturesType(typeVal) || typeVal === 'options') ? (parseFloat($('#jf-mul')?.value) || 1) : 1; // inline: form values, not trade object
  const notional = (en + (ex || 0)) * q * mul;
  return Math.round(notional * raw / 100 * 100) / 100;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${fmtDate(iso)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function localISOString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ── Type system with futures subcategories ──
const TYPE_LABELS = {
  stock: '股票/現貨', index_futures: '指數期貨', stock_futures: '個股期貨',
  commodity_futures: '原物料期貨', crypto_contract: '加密貨幣合約',
  crypto_spot: '加密貨幣現貨',
  options: '選擇權', etf: 'ETF', futures: '期貨/合約',
};
function isFuturesType(type) {
  return ['futures','index_futures','stock_futures','commodity_futures','crypto_contract'].includes(type);
}
function getContractMul(t) {
  const rawMul = parseFloat(t.contractMul);
  return (isFuturesType(t.type) || t.type === 'options') ? (isNaN(rawMul) || rawMul === 0 ? 1 : rawMul) : 1;
}
function typeLabel(type) { return TYPE_LABELS[type] || type; }

function getDefaultFees() { return { fee: '', tax: '' }; }

// Smart fee/tax calculation based on market + type + price + qty
function calcSmartFees(market, type, entryPrice, qty, contractMul) {
  try {
    const s = JSON.parse(localStorage.getItem('tg-settings')) || {};
    const price = parseFloat(entryPrice) || 0;
    const q = parseFloat(qty) || 0;
    const mul = parseFloat(contractMul) || 1;
    let fee = '', tax = '';

    if (market === 'tw') {
      if (type === 'stock' || type === 'etf') {
        // 台股手續費 = 成交金額 × 0.1425% × 折扣 × 2 (買賣各一次)
        const disc = parseFloat(s.twFeeDisc || '0.5');
        const taxRate = parseFloat(s.twTaxRate || '0.003');
        if (price && q) {
          const amount = price * q;
          fee = String(Math.round(amount * 0.001425 * disc * 2));
          tax = String(Math.round(amount * taxRate));
        }
      } else if (type === 'index_futures' || type === 'futures') {
        // 台灣指數期貨手續費 = 單價/口 × 口數 × 2
        const comm = parseFloat(s.twFutComm || '60');
        if (q) {
          fee = String(Math.round(comm * q * 2));
          tax = String(Math.round(price * mul * q * 0.00002 * 2)); // 期交稅十萬分之二
        }
      } else if (type === 'stock_futures') {
        const comm = parseFloat(s.twStkFutComm || '40');
        if (q) {
          fee = String(Math.round(comm * q * 2));
          tax = String(Math.round(price * mul * q * 0.00002 * 2));
        }
      } else if (type === 'options') {
        const comm = parseFloat(s.twOptComm || '25');
        if (q) fee = String(Math.round(comm * q * 2));
      }
    } else if (market === 'us') {
      if (type === 'stock' || type === 'etf') {
        const comm = parseFloat(s.usComm || '0');
        fee = String(comm * 2);
      } else if (isFuturesType(type) && type !== 'crypto_contract') {
        const comm = parseFloat(s.usFutComm || '2.25');
        if (q) fee = String(Math.round(comm * q * 2 * 100) / 100);
      } else if (type === 'options') {
        const comm = parseFloat(s.usOptComm || '0.65');
        if (q) fee = String(Math.round(comm * q * 2 * 100) / 100);
      }
    }
    // crypto / commodity_futures on US → no default tax
    return { fee, tax };
  } catch { return { fee: '', tax: '' }; }
}

function newTrade() {
  const df = getDefaultFees();
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    date: localISOString(),
    market: 'tw', type: 'stock', symbol: '', name: '',
    direction: 'long', entryPrice: '', exitPrice: '', quantity: '',
    stopLoss: '', takeProfit: '', fee: df.fee, tax: df.tax,
    tags: [], notes: '', status: 'open', contractMul: '',
    account: '', imageUrl: '', rating: 0,
    reviewDiscipline: 0, reviewTiming: 0, reviewSizing: 0,
  };
}

function calcPL(t) {
  const entry = parseFloat(t.entryPrice), exit = parseFloat(t.exitPrice), qty = parseFloat(t.quantity);
  const fee = parseFloat(t.fee) || 0, tax = parseFloat(t.tax) || 0;
  if (isNaN(entry) || isNaN(exit) || isNaN(qty)) return null;
  const mul = getContractMul(t);
  const dir = t.direction === 'long' ? 1 : -1;
  const gross = Math.round(dir * (exit - entry) * qty * mul * 100) / 100;
  const totalFee = Math.round((fee + tax) * 100) / 100;
  return { gross, net: gross - totalFee, fee, tax };
}

function calcUnrealizedPL(t, currentPrice) {
  const entry = parseFloat(t.entryPrice), qty = parseFloat(t.quantity);
  if (isNaN(entry) || isNaN(qty) || isNaN(currentPrice)) return null;
  const mul = getContractMul(t);
  const dir = t.direction === 'long' ? 1 : -1;
  const fee = parseFloat(t.fee) || 0, tax = parseFloat(t.tax) || 0;
  const gross = Math.round(dir * (currentPrice - entry) * qty * mul * 100) / 100;
  return { gross, net: gross - fee - tax, currentPrice };
}

function getLiveQuoteKey(t) { return `${t.symbol}|${t.market}`; }

// ── CSV Export ──
function exportCSV() {
  const cols = ['date','market','type','symbol','name','direction','status','entryPrice','exitPrice','quantity','contractMul','stopLoss','takeProfit','fee','tax','account','rating','tags','notes'];
  const rows = [cols.join(',')];
  for (const t of getFilteredTrades()) {
    rows.push(cols.map(c => {
      let v = t[c] ?? '';
      if (c === 'tags') v = (t.tags || []).join(';');
      v = String(v).replace(/"/g, '""');
      return /[,"\n]/.test(v) ? `"${v}"` : v;
    }).join(','));
  }
  const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `prism-trades-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── CSV Import ──
function importCSV() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { alert('CSV 檔案格式錯誤'); return; }
    const header = parseCSVLine(lines[0]);
    const colMap = {};
    header.forEach((h, i) => colMap[h.trim()] = i);
    const required = ['symbol', 'entryPrice'];
    if (!required.every(r => r in colMap)) { alert('CSV 缺少必要欄位: symbol, entryPrice'); return; }
    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const vals = parseCSVLine(lines[i]);
      if (!vals.length) continue;
      const g = col => (colMap[col] != null ? vals[colMap[col]]?.trim() : '') || '';
      const data = {
        date: g('date') || localISOString(),
        market: g('market') || 'tw', type: g('type') || 'stock',
        symbol: g('symbol'), name: g('name'),
        direction: g('direction') || 'long', status: g('status') || 'closed',
        entryPrice: g('entryPrice'), exitPrice: g('exitPrice'),
        quantity: g('quantity'), contractMul: g('contractMul'),
        stopLoss: g('stopLoss'), takeProfit: g('takeProfit'),
        fee: g('fee'), tax: g('tax'), account: g('account'),
        rating: parseInt(g('rating')) || 0,
        tags: g('tags') ? g('tags').split(';').map(s => s.trim()).filter(Boolean) : [],
        notes: g('notes'),
      };
      try { await api('/trades', { method: 'POST', body: JSON.stringify(data) }); count++; }
      catch (e) { console.error('Import row error:', e); }
    }
    alert(`匯入完成：${count} 筆交易`);
    await loadTrades();
    renderJournal();
  });
  input.click();
}

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// ── Trade Templates (with cloud sync) ──
const TEMPLATE_KEY = 'prism_trade_templates';
function getTemplates() {
  try { return JSON.parse(localStorage.getItem(TEMPLATE_KEY)) || []; } catch { return []; }
}
function _syncTemplatesToServer() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return;
  const templates = getTemplates();
  fetch(`${API}/templates`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ templates }),
  }).catch(e => console.debug('[Prism] Templates sync failed:', e.message));
}
async function loadTemplatesFromServer() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return;
  try {
    const res = await fetch(`${API}/templates`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.templates) && data.templates.length > 0) {
      localStorage.setItem(TEMPLATE_KEY, JSON.stringify(data.templates));
    }
  } catch (e) { console.warn('[Prism] Cloud templates load failed:', e.message); }
}
function saveTemplate(name) {
  const data = {
    name,
    market: $('#jf-market2')?.value || 'tw',
    type: $('#jf-type2')?.value || 'stock',
    direction: $('#jf-dir')?.value || 'long',
    contractMul: $('#jf-mul')?.value || '',
    fee: $('#jf-fee')?.value || '',
    tax: $('#jf-tax')?.value || '',
    account: $('#jf-account')?.value || '',
    tags: $$('.j-tag-btn.active', $('#jf-tags')).map(b => b.dataset.tag),
  };
  const templates = getTemplates();
  const idx = templates.findIndex(t => t.name === name);
  if (idx >= 0) templates[idx] = data; else templates.push(data);
  localStorage.setItem(TEMPLATE_KEY, JSON.stringify(templates));
  _syncTemplatesToServer();
}
function applyTemplate(tpl) {
  if ($('#jf-market2')) $('#jf-market2').value = tpl.market || 'tw';
  if ($('#jf-type2')) { $('#jf-type2').value = tpl.type || 'stock'; $('#jf-type2').dispatchEvent(new Event('change')); }
  if ($('#jf-dir')) $('#jf-dir').value = tpl.direction || 'long';
  if ($('#jf-mul')) $('#jf-mul').value = tpl.contractMul || '';
  if ($('#jf-fee')) { $('#jf-fee').value = tpl.fee || ''; const b = $('#jf-fee-mode'); if (b) { b.dataset.mode = 'fixed'; b.textContent = '元'; } }
  if ($('#jf-tax')) { $('#jf-tax').value = tpl.tax || ''; const b = $('#jf-tax-mode'); if (b) { b.dataset.mode = 'fixed'; b.textContent = '元'; } }
  if ($('#jf-account')) $('#jf-account').value = tpl.account || '';
  const tagsEl = $('#jf-tags');
  if (tagsEl) $$('.j-tag-btn', tagsEl).forEach(b => b.classList.toggle('active', (tpl.tags || []).includes(b.dataset.tag)));
}
function deleteTemplate(name) {
  const templates = getTemplates().filter(t => t.name !== name);
  localStorage.setItem(TEMPLATE_KEY, JSON.stringify(templates));
  _syncTemplatesToServer();
}

// ── Quick Close Trade ──
async function quickCloseTrade(id) {
  const t = trades.find(x => x.id === id);
  if (!t || t.status !== 'open') return;
  const lq = liveQuotes[getLiveQuoteKey(t)];
  if (!lq || !lq.price) { alert('無法取得即時報價，請手動平倉'); return; }
  if (!confirm(`以現價 ${fmtPrice(lq.price, t.market, t.type)} 平倉 ${t.symbol}？`)) return;
  const data = { ...t, exitPrice: lq.price, status: 'closed' };
  try {
    await api(`/trades/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    const idx = trades.findIndex(x => x.id === id);
    if (idx >= 0) trades[idx] = data;
    renderJournal();
  } catch (e) { alert('平倉失敗：' + e.message); }
}

// ── SL/TP Alert Check ──
function checkSLTPAlerts() {
  if (!trades.length || !('Notification' in window)) return;
  const openTrades = trades.filter(t => t.status === 'open' && t.symbol);
  for (const t of openTrades) {
    const lq = liveQuotes[getLiveQuoteKey(t)];
    if (!lq || !lq.price) continue;
    const key = t.id;
    if (alertDismissed[key]) continue;
    const sl = parseFloat(t.stopLoss), tp = parseFloat(t.takeProfit), price = lq.price;
    const dir = t.direction === 'long' ? 1 : -1;
    let hit = null;
    if (!isNaN(sl) && ((dir === 1 && price <= sl) || (dir === -1 && price >= sl))) hit = 'stopLoss';
    if (!isNaN(tp) && ((dir === 1 && price >= tp) || (dir === -1 && price <= tp))) hit = 'takeProfit';
    if (hit) {
      alertDismissed[key] = true;
      const msg = hit === 'stopLoss'
        ? `${t.symbol} 已觸及停損 ${fmtPrice(sl, t.market, t.type)} (現價 ${fmtPrice(price, t.market, t.type)})`
        : `${t.symbol} 已觸及停利 ${fmtPrice(tp, t.market, t.type)} (現價 ${fmtPrice(price, t.market, t.type)})`;
      showSLTPAlert(msg, t.id);
    }
  }
}

function showSLTPAlert(msg, tradeId) {
  // In-app toast
  const toast = document.createElement('div');
  toast.className = 'j-toast j-toast-alert';
  toast.innerHTML = `<span>${esc(msg)}</span><button class="j-toast-btn" data-action="close-trade">快速平倉</button>`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  toast.querySelector('[data-action="close-trade"]')?.addEventListener('click', () => {
    toast.remove();
    quickCloseTrade(tradeId);
  });
  setTimeout(() => { if (toast.parentNode) { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); } }, 10000);
  // Browser notification
  if (Notification.permission === 'granted') {
    new Notification('Prism 交易提醒', { body: msg, icon: '/favicon.ico' });
  }
}

// ── Duplicate Trade ──
function duplicateTrade(id) {
  const t = trades.find(x => x.id === id);
  if (!t) return;
  const nt = { ...t, id: null, date: localISOString(), status: 'open', exitPrice: '', rating: 0 };
  openTradeForm(null, nt);
}

// ── Partial Close ──
async function partialCloseTrade(id) {
  const t = trades.find(x => x.id === id);
  if (!t || t.status !== 'open') return;
  const totalQty = parseFloat(t.quantity);
  if (!totalQty || isNaN(totalQty)) { alert('此交易沒有數量'); return; }
  const closeQtyStr = prompt(`總數量 ${totalQty}，要平倉多少？`);
  if (!closeQtyStr) return;
  const closeQty = parseFloat(closeQtyStr);
  if (isNaN(closeQty) || closeQty <= 0 || closeQty > totalQty) { alert('數量無效'); return; }

  const lq = liveQuotes[getLiveQuoteKey(t)];
  const exitPrice = (lq?.price != null && !isNaN(lq.price)) ? lq.price : parseFloat(prompt('請輸入平倉價格：') || '');
  if (exitPrice == null || isNaN(exitPrice)) { alert('價格無效'); return; }

  const remainQty = totalQty - closeQty;
  const feeRatio = closeQty / totalQty;
  const origFee = parseFloat(t.fee) || 0, origTax = parseFloat(t.tax) || 0;

  // Create closed trade for the closed portion (floor for closed, remainder gets rest to keep total exact)
  const closedFee = Math.floor(origFee * feeRatio), closedTax = Math.floor(origTax * feeRatio);
  const closedData = { ...t, id: undefined, quantity: closeQty, exitPrice, status: 'closed', fee: closedFee, tax: closedTax, date: localISOString() };
  // Update original trade with remaining qty
  const remainData = { ...t, quantity: remainQty, fee: origFee - closedFee, tax: origTax - closedTax };

  try {
    await api('/trades', { method: 'POST', body: JSON.stringify(closedData) });
    await api(`/trades/${id}`, { method: 'PUT', body: JSON.stringify(remainData) });
    await loadTrades();
    renderJournal();
  } catch (e) { alert('部分平倉失敗：' + e.message); }
}

// ── Batch Operations ──
let batchMode = false;
let batchSelected = new Set();

function toggleBatchMode() {
  batchMode = !batchMode;
  batchSelected.clear();
  renderJournal();
}

async function batchDelete() {
  if (!batchSelected.size) return;
  if (!confirm(`確定要刪除 ${batchSelected.size} 筆交易？`)) return;
  const deletedIds = new Set();
  const errors = [];
  await Promise.all([...batchSelected].map(async id => {
    try { await api(`/trades/${id}`, { method: 'DELETE' }); deletedIds.add(id); }
    catch (e) { errors.push(`${id}: ${e.message}`); }
  }));
  trades = trades.filter(t => !deletedIds.has(t.id));
  batchSelected.clear();
  batchMode = false;
  renderJournal();
  if (errors.length) alert(`${deletedIds.size} 筆已刪除，${errors.length} 筆失敗`);
}

async function batchAddTag() {
  if (!batchSelected.size) return;
  const tag = prompt('新增標籤：');
  if (!tag?.trim()) return;
  try {
    for (const id of batchSelected) {
      const t = trades.find(x => x.id === id);
      if (!t) continue;
      const tags = [...new Set([...(t.tags || []), tag.trim()])];
      await api(`/trades/${id}`, { method: 'PUT', body: JSON.stringify({ ...t, tags }) });
      t.tags = tags;
    }
    batchSelected.clear();
    batchMode = false;
    renderJournal();
  } catch (e) { alert('批次加標籤失敗：' + e.message); }
}

async function batchClose() {
  const openIds = [...batchSelected].filter(id => { const t = trades.find(x => x.id === id); return t?.status === 'open'; });
  if (!openIds.length) { alert('沒有選取持倉中的交易'); return; }
  // Snapshot trade data and quotes before confirm to avoid stale references
  const closeJobs = [];
  for (const id of openIds) {
    const t = trades.find(x => x.id === id);
    if (!t) continue;
    const lq = liveQuotes[getLiveQuoteKey(t)];
    if (!lq?.price) continue;
    closeJobs.push({ id, data: { ...t, exitPrice: lq.price, status: 'closed' } });
  }
  if (!closeJobs.length) { alert('無法取得即時報價'); return; }
  if (!confirm(`以即時報價平倉 ${closeJobs.length} 筆持倉？`)) return;
  let closed = 0;
  for (const job of closeJobs) {
    try {
      await api(`/trades/${job.id}`, { method: 'PUT', body: JSON.stringify(job.data) });
      const idx = trades.findIndex(x => x.id === job.id);
      if (idx >= 0) trades[idx] = job.data;
      closed++;
    } catch (e) { console.warn('[Journal] Batch close error:', e.message); }
  }
  batchSelected.clear();
  batchMode = false;
  if (window._showToast) window._showToast(`已平倉 ${closed} 筆`); else alert(`已平倉 ${closed} 筆`);
  renderJournal();
}

// ── Average Cost for same symbol open trades ──
function calcAvgCost(symbol, market) {
  const openTrades = trades.filter(t => t.status === 'open' && t.symbol === symbol && t.market === market);
  if (openTrades.length < 2) return null;
  let totalQty = 0, totalCost = 0;
  for (const t of openTrades) {
    const qty = parseFloat(t.quantity) || 0;
    const entry = parseFloat(t.entryPrice) || 0;
    const dir = t.direction === 'long' ? 1 : -1;
    totalQty += qty * dir;
    totalCost += entry * qty * dir;
  }
  if (totalQty === 0) return null;
  return { avgPrice: totalCost / totalQty, totalQty: Math.abs(totalQty), count: openTrades.length };
}

// ── Daily Journal helpers ──
let dailyJournals = [];

async function loadDailyJournals() {
  try { const data = await api('/daily-journal'); dailyJournals = data.journals || []; }
  catch { dailyJournals = []; }
}

async function saveDailyJournal(date, mood, marketNote, plan, review, discipline, tags, takeaway, starred) {
  await api('/daily-journal', { method: 'PUT', body: JSON.stringify({ date, mood, marketNote, plan, review, discipline: discipline || 0, tags: tags || [], takeaway: takeaway || '', starred: starred || 0 }) });
  await loadDailyJournals();
}

// ── Rating stars HTML ──
function ratingHTML(rating, editable = false, id = '') {
  let h = '<span class="j-rating">';
  for (let i = 1; i <= 5; i++) {
    h += `<span class="j-star ${i <= rating ? 'j-star-on' : ''}" ${editable ? `data-rate="${i}" data-trade-id="${id}"` : ''} ${editable ? 'style="cursor:pointer"' : ''}>${i <= rating ? '★' : '☆'}</span>`;
  }
  return h + '</span>';
}

// ── Export HTML Report ──
function exportReport() {
  const pls = trades.filter(t => t.status === 'closed').map(t => ({ ...t, pl: calcPL(t) })).filter(t => t.pl);
  if (!pls.length) { alert('沒有已平倉交易可供匯出'); return; }
  const ML_FULL = { tw: '台股', us: '美股', crypto: '加密貨幣' };
  const markets = [...new Set(pls.map(t => t.market))];
  const ec = renderEquityCurve(pls);

  // Per-market summary
  const mktSummaries = markets.map(mkt => {
    const mp = pls.filter(t => t.market === mkt);
    const tn = mp.reduce((s, t) => s + t.pl.net, 0);
    const w = mp.filter(t => t.pl.net > 0);
    const wr = (w.length / mp.length * 100).toFixed(1);
    const aw = w.length ? w.reduce((s, t) => s + t.pl.net, 0) / w.length : 0;
    const al = mp.filter(t => t.pl.net <= 0);
    const alv = al.length ? al.reduce((s, t) => s + t.pl.net, 0) / al.length : 0;
    const pf = Math.abs(alv) > 0 ? Math.abs(aw / alv) : Infinity;
    return `<h3>${ML_FULL[mkt] || mkt}</h3>
    <div class="grid">
      <div class="card"><div class="label">淨損益</div><div class="val ${tn >= 0 ? 'green' : 'red'}">${fmtMoney(tn, mkt)}</div></div>
      <div class="card"><div class="label">交易次數</div><div class="val">${mp.length}</div></div>
      <div class="card"><div class="label">勝率</div><div class="val">${wr}%</div></div>
      <div class="card"><div class="label">獲利因子</div><div class="val">${pf === Infinity ? '∞' : pf.toFixed(2)}</div></div>
    </div>`;
  }).join('');

  const byM = {};
  pls.forEach(t => {
    const m = t.date.slice(0, 7);
    if (!byM[m]) byM[m] = {};
    if (!byM[m][t.market]) byM[m][t.market] = { c: 0, n: 0, w: 0 };
    byM[m][t.market].c++; byM[m][t.market].n += t.pl.net; if (t.pl.net > 0) byM[m][t.market].w++;
  });

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Prism 交易報告</title>
  <style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#222}
  h1{border-bottom:2px solid #0284c7;padding-bottom:8px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}
  .card{background:#f5f7fa;border-radius:8px;padding:12px;text-align:center}
  .card .label{font-size:12px;color:#666}.card .val{font-size:20px;font-weight:700;margin-top:4px}
  .green{color:#16a34a}.red{color:#dc2626}
  table{width:100%;border-collapse:collapse;font-size:14px;margin:16px 0}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #ddd}
  th{background:#f0f2f5;font-weight:600}
  svg{max-width:100%}
  @media print{body{padding:0}}</style></head><body>
  <h1>Prism 交易績效報告</h1>
  <p>匯出時間：${new Date().toLocaleString('zh-TW')}</p>
  ${mktSummaries}
  ${ec}
  <h3>月度績效</h3>
  <table><thead><tr><th>月份</th><th>市場</th><th>筆數</th><th>淨損益</th><th>勝率</th></tr></thead><tbody>
  ${Object.entries(byM).sort((a, b) => b[0].localeCompare(a[0])).flatMap(([mo, mkts]) => Object.entries(mkts).map(([mkt, v]) => `<tr><td>${mo}</td><td>${ML_FULL[mkt]||mkt}</td><td>${v.c}</td><td class="${v.n >= 0 ? 'green' : 'red'}">${fmtMoney(v.n, mkt)}</td><td>${(v.w / v.c * 100).toFixed(1)}%</td></tr>`)).join('')}
  </tbody></table>
  <h3>交易明細</h3>
  <table><thead><tr><th>日期</th><th>市場</th><th>代號</th><th>方向</th><th>進場</th><th>出場</th><th>數量</th><th>淨損益</th></tr></thead><tbody>
  ${[...pls].sort((a, b) => b.date.localeCompare(a.date)).map(t => `<tr><td>${t.date?.slice(0, 10)}</td><td>${ML_FULL[t.market]||t.market}</td><td>${esc(t.symbol)}</td><td>${t.direction === 'long' ? '多' : '空'}</td><td>${fmtPrice(parseFloat(t.entryPrice), t.market, t.type)}</td><td>${fmtPrice(parseFloat(t.exitPrice), t.market, t.type)}</td><td>${t.quantity}</td><td class="${t.pl.net >= 0 ? 'green' : 'red'}">${fmtMoney(t.pl.net, t.market)}</td></tr>`).join('')}
  </tbody></table>
  </body></html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `prism-report-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Resolve how to fetch live quote for a given trade
function resolveQuoteSymbol(t) {
  const sym = t.symbol, mkt = t.market;
  // Auto-detect crypto: symbol ending with USDT is always crypto regardless of market field
  const isCrypto = mkt === 'crypto' || /USDT$/i.test(sym.replace(/[\/-]/g, ''));
  if (isCrypto) {
    // Normalize: "BTC/USDT" → "BTCUSDT", "BTC-USDT" → "BTCUSDT", "BTC" → "BTC"
    const clean = sym.replace(/[\/-]/g, '').toUpperCase();
    const src = (typeof CFG !== 'undefined' && CFG.cryptoSource) || 'binance';
    if (src === 'binance') return { method: 'binance', symbol: clean.endsWith('USDT') ? clean : clean + 'USDT' };
    // Yahoo: BTC → BTC-USD, BTCUSDT → BTC-USD
    const base = clean.replace(/USDT$/i, '');
    return { method: 'yahoo', symbol: base + '-USD' };
  }
  if (t.type === 'stock' || t.type === 'etf') return { method: 'stock', code: sym, market: mkt };
  if (isFuturesType(t.type)) {
    if (mkt === 'tw') {
      // TX/MTX/MXF 追蹤同一標的 → CID 'TXF', KindID '1'
      if (['TX','MTX','MXF'].includes(sym)) return { method: 'taifex', kindID: '1', cid: 'TXF' };
      // 其他指數期貨 (TE/TF/XIF/TGF...) → KindID '1', CID 就是 symbol 本身
      if (typeof FP !== 'undefined' && FP.tw?.[sym]) return { method: 'taifex', kindID: '1', cid: sym };
      // 股票期貨 (CDF/DHF...) → 用 STOCK_FUTURES 的 kind
      if (typeof STOCK_FUTURES !== 'undefined' && STOCK_FUTURES[sym]) {
        return { method: 'taifex', kindID: STOCK_FUTURES[sym].kind || '4', cid: sym };
      }
      // 未知合約 → 先試 KindID '1' 再 '4'
      return { method: 'taifex', kindID: '1', cid: sym };
    }
    if (mkt === 'us') {
      // CME/CBOT 期貨：使用主力合約解析
      const cmeBases = { ES:'ES', NQ:'NQ', MES:'MES', MNQ:'MNQ', YM:'YM', MYM:'MYM', NKD:'NKD' };
      if (cmeBases[sym] && typeof PriceService !== 'undefined' && PriceService._cmeContractPair) {
        return { method: 'cme', base: cmeBases[sym] };
      }
      const yfMap = { ES:'ES=F', NQ:'NQ=F', MES:'MES=F', MNQ:'MNQ=F', YM:'YM=F', MYM:'MYM=F' };
      return { method: 'yahoo', symbol: yfMap[sym] || (sym + '=F') };
    }
  }
  if (t.type === 'options') return null;
  return { method: 'stock', code: sym, market: mkt };
}

let _fetchQuotesVersion = 0;
async function fetchOpenTradeQuotes(force = false) {
  if (typeof PriceService === 'undefined') return;
  const thisVersion = ++_fetchQuotesVersion;
  const openTrades = trades.filter(t => t.status === 'open' && t.symbol && t.entryPrice);
  if (force) {
    // Clear cached quotes for open trades so they get re-fetched
    for (const t of openTrades) delete liveQuotes[getLiveQuoteKey(t)];
  }
  const seen = new Set();
  const toFetch = [];
  for (const t of openTrades) {
    const key = getLiveQuoteKey(t);
    if (seen.has(key) || liveQuotes[key]) continue;
    seen.add(key);
    toFetch.push(t);
  }
  if (!toFetch.length) return;

  await Promise.all(toFetch.map(async t => {
    const key = getLiveQuoteKey(t);
    const target = resolveQuoteSymbol(t);
    if (!target) { liveQuotes[key] = { price: null, time: Date.now(), error: '不支援即時報價' }; return; }
    try {
      let q;
      if (target.method === 'taifex') {
        try {
          q = await PriceService._taifexQuote(target.kindID, target.cid);
        } catch {
          // CID 可能需要不同 KindID — 重試
          const fallbackKind = target.kindID === '1' ? '4' : '1';
          try { q = await PriceService._taifexQuote(fallbackKind, target.cid); } catch {}
        }
      } else if (target.method === 'cme') {
        // 查當季+下季，取成交量最高的主力合約
        const pair = PriceService._cmeContractPair(target.base);
        const results = await Promise.all(pair.map(async p => {
          try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(p.symbol)}?range=1d&interval=1d`;
            const r = await PriceService._proxyFetch(url);
            const m = (await r.json())?.chart?.result?.[0]?.meta;
            if (!m?.regularMarketPrice) return null;
            return { price: m.regularMarketPrice, volume: m.regularMarketVolume || 0 };
          } catch { return null; }
        }));
        const valid = results.filter(Boolean);
        if (valid.length) q = valid.reduce((a, b) => b.volume > a.volume ? b : a);
      } else if (target.method === 'binance') {
        const url = `https://api.binance.com/api/v3/ticker/price?symbol=${target.symbol}`;
        const r = await PriceService._proxyFetch(url, 5000);
        const data = await r.json();
        if (data.price) q = { price: parseFloat(data.price) };
      } else if (target.method === 'yahoo') {
        q = await PriceService.yahoo.fetchQuote(target.symbol);
      } else {
        q = await PriceService.fetchStockQuote(target.code, target.market);
      }
      if (thisVersion !== _fetchQuotesVersion) return; // stale request
      if (q && q.price) {
        liveQuotes[key] = { price: q.price, time: Date.now() };
      } else {
        liveQuotes[key] = { price: null, time: Date.now(), error: '無報價' };
      }
    } catch (e) {
      if (thisVersion !== _fetchQuotesVersion) return;
      liveQuotes[key] = { price: null, time: Date.now(), error: e.message };
    }
  }));
}

const TAG_PRESETS = ['突破', '回測', '順勢', '逆勢', '事件', '技術面', '基本面', '短線', '波段', '當沖', '停損', '停利', '加碼', '減碼'];

function getChecklistItems() {
  try { const s = JSON.parse(localStorage.getItem('tg-settings')) || {}; return s.checklist || []; }
  catch { return []; }
}

// ================================================================
//  HEADER AUTH — Show login/user badge in header on page load
// ================================================================
function renderHeaderAuth() {
  const el = $('#header-auth');
  if (!el) return;
  if (authToken && currentUser) {
    el.innerHTML = `<div class="ha-user">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      <span>${esc(currentUser.username)}</span>
    </div>`;
  } else {
    el.innerHTML = '';
  }
}

// ── Login Modal (global, shown on page load or header click) ──
function showLoginModal() {
  // Remove existing
  $('#j-global-modal-overlay')?.remove();
  $('#j-global-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'j-global-modal-overlay';
  overlay.className = 'j-modal-overlay open';
  const modal = document.createElement('div');
  modal.id = 'j-global-modal';
  modal.className = 'j-modal open';
  modal.style.width = '380px';

  modal.innerHTML = `
    <div class="j-modal-header">
      <h3>登入 Prism</h3>
      <button class="j-modal-close" id="jg-close">&times;</button>
    </div>
    <div class="j-modal-body">
      <div class="j-login-tabs" style="margin-bottom:14px">
        <button class="j-lt-btn active" data-mode="login">登入</button>
        <button class="j-lt-btn" data-mode="register">註冊</button>
      </div>
      <div class="j-fg" style="margin-bottom:10px"><label>使用者名稱</label><input type="text" id="jg-user" placeholder="使用者名稱" maxlength="20" autocomplete="username"></div>
      <div class="j-fg" style="margin-bottom:10px"><label>密碼</label><input type="password" id="jg-pass" placeholder="密碼" autocomplete="current-password"></div>
      <div class="j-login-error" id="jg-error"></div>
    </div>
    <div class="j-modal-footer">
      <button class="j-btn-cancel" id="jg-cancel">取消</button>
      <button class="j-btn-save" id="jg-submit">登入</button>
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(modal);
  $('#jg-user')?.focus();

  let mode = 'login';
  $$('.j-lt-btn', modal).forEach(b => b.addEventListener('click', () => {
    $$('.j-lt-btn', modal).forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    mode = b.dataset.mode;
    $('#jg-submit').textContent = mode === 'login' ? '登入' : '註冊';
    $('#jg-error').textContent = '';
  }));

  const close = () => { overlay.remove(); modal.remove(); document.removeEventListener('keydown', loginEsc); };
  const loginEsc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', loginEsc);
  overlay.addEventListener('click', close);
  $('#jg-close').addEventListener('click', close);
  $('#jg-cancel').addEventListener('click', close);

  const submit = async () => {
    const username = $('#jg-user')?.value.trim();
    const password = $('#jg-pass')?.value;
    if (!username || !password) { $('#jg-error').textContent = '請填寫使用者名稱和密碼'; return; }
    const btn = $('#jg-submit');
    btn.disabled = true; btn.textContent = '處理中...';
    $('#jg-error').textContent = '';
    try {
      const data = await api(`/auth/${mode}`, { method: 'POST', body: JSON.stringify({ username, password }) });
      authToken = data.token; currentUser = data.user;
      localStorage.setItem(TOKEN_KEY, authToken);
      localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
      renderHeaderAuth();
      close();
      // Refresh settings panel to show account
      window._stgRendered = false;
      if ($('#settings-panel')?.classList.contains('open')) { renderSettings(); window._stgRendered = true; }
      // Load all cloud data after login
      if (window.loadSettingsFromServer) window.loadSettingsFromServer();
      if (window.loadPresetsFromServer) window.loadPresetsFromServer();
      if (window.loadAppStateFromServer) window.loadAppStateFromServer();
      loadTemplatesFromServer();
      // If journal tab is active, refresh it
      if ($('#tab-journal')?.classList.contains('active')) { await loadTrades(); renderJournal(); }
    } catch (e) {
      $('#jg-error').textContent = e.message;
      btn.disabled = false; btn.textContent = mode === 'login' ? '登入' : '註冊';
    }
  };
  $('#jg-submit').addEventListener('click', submit);
  $$('#jg-user, #jg-pass').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
}

function handleLogout() {
  authToken = ''; currentUser = null; trades = []; liveQuotes = {};
  localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY);
  renderHeaderAuth();
  if ($('#tab-journal')?.classList.contains('active')) renderLogin();
  // Refresh settings panel account section
  window._stgRendered = false;
  if ($('#settings-panel')?.classList.contains('open') && window.renderSettings) { renderSettings(); window._stgRendered = true; }
}

// ================================================================
//  RECORD TRADE — Buttons in calculator tabs
// ================================================================

// Exposed globally so app.js calc functions can call it
window.PrismJournal = {
  isLoggedIn: () => !!(authToken && currentUser),
  showLogin: showLoginModal,
  doLogout: handleLogout,

  // Collect current calculator inputs and save as trade
  recordFromCalc(tabType) {
    if (!authToken || !currentUser) { showLoginModal(); return; }

    let trade = newTrade();
    trade.status = 'open'; // default to open position

    const _gv = id => { const v = parseFloat(document.getElementById(id)?.value); return isNaN(v) ? 0 : v; };
    const _gvOrNull = id => { const v = parseFloat(document.getElementById(id)?.value); return isNaN(v) ? null : v; };

    if (tabType === 'margin') {
      const market = document.querySelector('[data-group="margin-market"] .toggle-btn.active')?.dataset.value || 'tw';
      const dir = document.querySelector('[data-group="margin-direction"] .toggle-btn.active')?.dataset.value || 'cash';
      const tw = market === 'tw';
      trade.market = market;
      trade.direction = (dir === 'short') ? 'short' : 'long';
      trade.symbol = document.getElementById('m-symbol')?.value || '';
      // Auto-detect ETF type from leverage field
      const etfLev = parseFloat(document.getElementById('m-etf-lev')?.value);
      const etfWrapVisible = document.getElementById('m-etf-lev-wrap')?.style.display !== 'none';
      trade.type = (etfWrapVisible || (!isNaN(etfLev) && Math.abs(etfLev) !== 1)) ? 'etf' : 'stock';
      trade.name = document.querySelector('.stock-info strong')?.textContent?.trim() || '';
      const spu = tw ? 1000 : 1;
      const qty = _gv('m-qty');
      trade.quantity = qty ? String(qty * spu) : '';
      if (dir === 'short') {
        trade.entryPrice = document.getElementById('m-sell-price')?.value || '';
        const cp = _gvOrNull('m-current-price') ?? _gvOrNull('m-sell-price');
        trade.exitPrice = cp != null ? String(cp) : '';
      } else {
        trade.entryPrice = document.getElementById('m-buy-price')?.value || '';
        const cp = _gvOrNull('m-current-price') ?? _gvOrNull('m-buy-price');
        trade.exitPrice = cp != null ? String(cp) : '';
      }
      // Calculate fees & tax
      const ts = qty * spu;
      const bp = parseFloat(trade.entryPrice) || 0, ep = parseFloat(trade.exitPrice) || 0;
      if (tw) {
        const disc = parseFloat(document.getElementById('m-fee-disc')?.value || '0.5');
        const feeRate = 0.001425 * disc;
        const taxRate = parseFloat(document.getElementById('m-tax-rate')?.value || '0.003');
        const buyFee = Math.round(Math.max(20, bp * ts * feeRate));
        const sellFee = Math.round(Math.max(20, ep * ts * feeRate));
        const sellTax = Math.round(ep * ts * taxRate);
        trade.fee = String(buyFee + sellFee);
        trade.tax = String(sellTax);
      } else {
        const comm = _gv('m-comm');
        trade.fee = String(comm * 2);
        trade.tax = String(Math.round(ep * ts * 0.0000278 * 100) / 100);
      }
      if (trade.exitPrice) trade.status = 'closed';
    }
    else if (tabType === 'futures') {
      const market = document.querySelector('[data-group="futures-market"] .toggle-btn.active')?.dataset.value || 'tw';
      const dir = document.querySelector('[data-group="futures-direction"] .toggle-btn.active')?.dataset.value || 'long';
      const product = document.querySelector('[data-group="futures-product"] .toggle-btn.active')?.dataset.value || 'index';
      trade.market = market;
      trade.type = product === 'stock' ? 'stock_futures' : 'index_futures';
      trade.direction = dir;
      trade.entryPrice = document.getElementById('f-entry')?.value || '';
      trade.quantity = document.getElementById('f-qty')?.value || '';
      trade.contractMul = document.getElementById('f-mul')?.value || '';
      // Get contract name / symbol
      const sel = document.getElementById('f-contract');
      if (sel && sel.tagName === 'SELECT') {
        trade.symbol = sel.value;
        trade.name = sel.options[sel.selectedIndex]?.text || '';
        // Fallback: if contractMul is empty, get from FP presets
        if (!trade.contractMul && sel.value) {
          const fp = (typeof FP !== 'undefined') ? FP : (window.FP || {});
          const preset = (fp[market] || {})[sel.value];
          if (preset && preset.mul) trade.contractMul = String(preset.mul);
        }
      } else if (product === 'stock') {
        // Stock futures: get symbol from autocomplete input
        const stkInput = document.getElementById('f-stk-input') || document.getElementById('f-sym');
        const stkInfo = document.querySelector('#f-stock-info strong');
        trade.symbol = stkInput?.value?.trim() || '';
        trade.name = stkInfo?.textContent?.trim() || '';
      }
      // Exit price: f-current → f-live-price → f-entry
      const exitVal = _gvOrNull('f-current') ?? _gvOrNull('f-live-price') ?? _gvOrNull('f-entry');
      if (exitVal != null) trade.exitPrice = String(exitVal);
      // Fee & tax
      const entry = _gv('f-entry'), qty = _gv('f-qty'), mul = _gv('f-mul');
      const fComm = _gv('f-comm');
      const fTaxRate = parseFloat(document.getElementById('f-tax-rate')?.value || '0');
      trade.fee = String(fComm * qty * 2);
      trade.tax = String(Math.round(entry * mul * qty * fTaxRate) + Math.round(exitVal * mul * qty * fTaxRate));
      if (trade.exitPrice) trade.status = 'closed';
    }
    else if (tabType === 'options') {
      const market = document.querySelector('[data-group="options-market"] .toggle-btn.active')?.dataset.value || 'tw';
      const side = document.querySelector('[data-group="options-side"] .toggle-btn.active')?.dataset.value || 'buyer';
      trade.market = market;
      trade.type = 'options';
      trade.direction = side === 'buyer' ? 'long' : 'short';
      const optType = document.getElementById('o-type')?.value || 'call';
      const strike = document.getElementById('o-strike')?.value || '';
      trade.entryPrice = document.getElementById('o-premium')?.value || '';
      trade.quantity = document.getElementById('o-qty')?.value || '';
      trade.contractMul = document.getElementById('o-mul')?.value || '';
      trade.symbol = `${optType.toUpperCase()} ${strike}`;
      trade.name = `${optType === 'call' ? 'Call' : 'Put'} ${side === 'buyer' ? '買方' : '賣方'} @ ${strike}`;
      // Fee & tax
      const prem = _gv('o-premium'), qty = _gv('o-qty'), mul = _gv('o-mul');
      const oComm = _gv('o-comm');
      const oTaxRate = parseFloat(document.getElementById('o-tax-rate')?.value || '0');
      trade.fee = String(oComm * qty * 2);
      trade.tax = String(Math.round(prem * mul * qty * oTaxRate) * 2);
    }
    else if (tabType === 'crypto') {
      const mode = document.querySelector('[data-group="crypto-mode"] .toggle-btn.active')?.dataset.value || 'spot';
      const dir = document.querySelector('[data-group="crypto-direction"] .toggle-btn.active')?.dataset.value || 'long';
      trade.market = 'crypto';
      trade.type = mode === 'perp' ? 'crypto_contract' : 'crypto_spot';
      trade.direction = dir;
      // Symbol & name
      const pairSel = document.getElementById('c-pair');
      if (pairSel) {
        trade.symbol = pairSel.value;
        trade.name = pairSel.options[pairSel.selectedIndex]?.text || '';
      }
      trade.entryPrice = document.getElementById('c-entry')?.value || '';
      // Quantity
      const cQty = _gvOrNull('c-qty');
      if (cQty != null) trade.quantity = String(cQty);
      // Exit price
      const exitVal = _gvOrNull('c-current') ?? _gvOrNull('c-live-price');
      if (exitVal != null) trade.exitPrice = String(exitVal);
      // Leverage as contractMul for perp
      if (mode === 'perp') {
        trade.contractMul = document.getElementById('c-leverage')?.value || '1';
      }
      // Fee
      const orderType = document.getElementById('c-order-type')?.value || 'taker';
      const feeRate = orderType === 'maker'
        ? (_gv('c-fee-maker') || 0.02) / 100
        : (_gv('c-fee-taker') || 0.05) / 100;
      const ep = _gv('c-entry'), q = cQty || 0;
      const posValue = ep * q;
      const curValue = (exitVal || ep) * q;
      trade.fee = String((posValue * feeRate + curValue * feeRate).toFixed(2));
      if (trade.exitPrice) trade.status = 'closed';
    }

    openTradeForm(null, trade);
  },

  // Get HTML for the "record trade" button (called from app.js)
  recordBtnHTML(tabType) {
    return `<button class="j-record-btn" onclick="PrismJournal.recordFromCalc('${tabType}')">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
      記錄此交易
    </button>`;
  },

  // Render mini trade list for current symbol in calc tab
  miniTradeListHTML(symbol) {
    if (!authToken || !trades.length || !symbol) return '';
    const matched = trades.filter(t => t.symbol === symbol || t.symbol === symbol.replace('.TW', '')).slice(0, 5);
    if (!matched.length) return '';
    const ML = { tw: '台', us: '美', crypto: '幣' };
    const rows = matched.map(t => {
      const pl = calcPL(t);
      const plStr = pl ? (pl.net >= 0 ? '+' : '') + fmtNum(pl.net, 0) : '—';
      const plCls = pl ? (pl.net >= 0 ? 'tg' : 'tr') : '';
      return `<div class="j-mini-row"><span class="j-mini-date">${fmtDate(t.date)}</span><span class="j-mini-dir j-dir-${t.direction}">${t.direction === 'long' ? '多' : '空'}</span><span class="j-mini-price">${fmtPrice(parseFloat(t.entryPrice), t.market, t.type)}→${t.exitPrice?fmtPrice(parseFloat(t.exitPrice), t.market, t.type):'?'}</span><span class="j-mini-pl ${plCls}">${plStr}</span></div>`;
    }).join('');
    return `<div class="j-mini-trades"><div class="j-mini-title">近期交易紀錄</div>${rows}</div>`;
  }
};

// ================================================================
//  RENDER — Login (for journal tab only)
// ================================================================
function renderLogin() {
  const root = $('#journal-root');
  if (!root) return;
  if (authToken && currentUser) { loadTrades().then(() => renderJournal()); return; }
  root.innerHTML = `<div class="j-login-wrap"><div class="j-login-card card">
    <div class="j-login-icon"><svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--accent)" stroke-width="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
    <h2>交易日誌</h2>
    <p class="j-login-hint">請先登入以使用交易紀錄功能</p>
    <button class="j-login-btn" style="width:100%" onclick="PrismJournal.showLogin()">登入 / 註冊</button>
  </div></div>`;
}

// ================================================================
//  RENDER — Main Journal View
// ================================================================
function renderJournal() {
  const root = $('#journal-root');
  if (!root) return;
  root.innerHTML = `
    <div class="j-header">
      <div class="j-header-left">
        <div class="j-view-toggle">
          <button class="j-vt-btn ${viewMode === 'list' ? 'active' : ''}" data-view="list"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>紀錄</button>
          <button class="j-vt-btn ${viewMode === 'calendar' ? 'active' : ''}" data-view="calendar"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>日曆</button>
          <button class="j-vt-btn ${viewMode === 'stats' ? 'active' : ''}" data-view="stats"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>統計</button>
          <button class="j-vt-btn ${viewMode === 'holdings' ? 'active' : ''}" data-view="holdings"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>庫存</button>
          <button class="j-vt-btn ${viewMode === 'diary' ? 'active' : ''}" data-view="diary"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>日記</button>
        </div>
        <div class="j-csv-btns">
          <button class="j-act-btn" id="j-csv-export" title="匯出 CSV"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
          <button class="j-act-btn" id="j-csv-import" title="匯入 CSV"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></button>
          <button class="j-act-btn" id="j-export-report" title="匯出報表"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></button>
          <button class="j-act-btn ${batchMode?'active':''}" id="j-batch-toggle" title="批次操作" style="${batchMode?'color:var(--accent);border-color:var(--accent)':''}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>
        </div>
        <button class="j-add-btn" id="j-add"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>新增交易</button>
      </div>
    </div><!-- j-header -->
    <div id="j-dashboard"></div>
    <div class="j-filters" id="j-filters"></div>
    <div class="j-body" id="j-body"></div>
  `;
  $('#j-add').addEventListener('click', () => openTradeForm(null));
  $('#j-csv-export')?.addEventListener('click', exportCSV);
  $('#j-csv-import')?.addEventListener('click', importCSV);
  $('#j-export-report')?.addEventListener('click', exportReport);
  $('#j-batch-toggle')?.addEventListener('click', toggleBatchMode);
  $$('.j-vt-btn').forEach(b => b.addEventListener('click', () => { viewMode = b.dataset.view; renderJournal(); }));
  renderDashboard();
  // Quick filter handlers
  $$('.j-qf-chip').forEach(b => {
    if (b.dataset.qf === quickFilter) b.classList.add('active');
    b.addEventListener('click', () => {
      quickFilter = b.dataset.qf;
      $$('.j-qf-chip').forEach(x => x.classList.toggle('active', x.dataset.qf === quickFilter));
      if (viewMode === 'list') renderTradeList();
      else if (viewMode === 'holdings') renderHoldings();
      else if (viewMode === 'stats') renderStats();
    });
  });
  renderFilters();
  if (viewMode === 'list') renderTradeList();
  else if (viewMode === 'holdings') renderHoldings();
  else if (viewMode === 'calendar') renderCalendar();
  else if (viewMode === 'diary') renderDiary();
  else renderStats();
}

// ================================================================
//  Dashboard — P&L Summary
// ================================================================
function renderDashboard() {
  const el = $('#j-dashboard');
  if (!el) return;
  const now = new Date(), todayStr = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).toISOString().slice(0, 10);
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const closed = trades.filter(t => t.status === 'closed');
  const openCount = trades.filter(t => t.status === 'open').length;
  const cls = v => v > 0 ? 'tg' : v < 0 ? 'tr' : '';

  // Per-market P&L for dashboard
  const activeMarkets = [...new Set(trades.map(t => t.market))].filter(m => MKT_CURRENCY[m]);
  const dashByMkt = {};
  for (const m of activeMarkets) {
    const mc = closed.filter(t => t.market === m);
    const calcNet = list => list.map(t => calcPL(t)).filter(Boolean).reduce((s, p) => s + p.net, 0);
    const today = calcNet(mc.filter(t => t.date?.slice(0, 10) === todayStr));
    const week = calcNet(mc.filter(t => t.date?.slice(0, 10) >= weekAgo));
    const month = calcNet(mc.filter(t => t.date?.slice(0, 10) >= monthStart));
    let unreal = 0;
    trades.filter(t => t.status === 'open' && t.market === m).forEach(t => {
      const lq = liveQuotes[getLiveQuoteKey(t)]; if (lq?.price) { const u = calcUnrealizedPL(t, lq.price); if (u) unreal += u.net; }
    });
    if (mc.length || unreal) dashByMkt[m] = { today, week, month, unreal };
  }

  // Quick filter counts
  const todayCount = closed.filter(t => t.date?.slice(0, 10) === todayStr).length;
  const winCount = closed.filter(t => { const pl = calcPL(t); return pl && pl.net > 0; }).length;
  const lossCount = closed.filter(t => { const pl = calcPL(t); return pl && pl.net <= 0; }).length;

  const ML_SHORT = { tw: '台股', us: '美股', crypto: '加密' };
  const mktRows = Object.entries(dashByMkt);
  const hasOpen = openCount > 0;
  let dashHTML = '';
  if (mktRows.length <= 1) {
    // Single market or no trades — simple row
    const m = mktRows[0]?.[0] || 'tw', d = mktRows[0]?.[1] || { today: 0, week: 0, month: 0, unreal: 0 };
    dashHTML = `<div class="j-dashboard">
      <div class="j-dash-item"><span class="j-dash-label">今日</span><span class="j-dash-value ${cls(d.today)}">${fmtMoney(d.today, m)}</span></div>
      <div class="j-dash-item"><span class="j-dash-label">本週</span><span class="j-dash-value ${cls(d.week)}">${fmtMoney(d.week, m)}</span></div>
      <div class="j-dash-item"><span class="j-dash-label">本月</span><span class="j-dash-value ${cls(d.month)}">${fmtMoney(d.month, m)}</span></div>
      <div class="j-dash-item"><span class="j-dash-label">未實現</span><span class="j-dash-value ${cls(d.unreal)}">${d.unreal ? fmtMoney(d.unreal, m) : '—'}</span></div>
      <div class="j-dash-item"><span class="j-dash-label">持倉</span><span class="j-dash-value">${openCount}</span></div>
      ${hasOpen ? `<div class="j-dash-item j-dash-refresh"><button class="j-refresh-quotes-btn" id="j-refresh-quotes" title="更新未平倉報價"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg></button></div>` : ''}
    </div>`;
  } else {
    // Multi-market — per-market rows
    dashHTML = `<div class="j-dashboard j-dashboard-multi">
      <div class="j-dash-header"><div class="j-dash-mkt-label"></div><div>今日</div><div>本週</div><div>本月</div><div>未實現</div></div>
      ${mktRows.map(([m, d]) => `<div class="j-dash-mkt-row">
        <div class="j-dash-mkt-label"><span class="j-badge j-badge-${m}">${ML_SHORT[m]}</span></div>
        <div class="${cls(d.today)}">${fmtMoney(d.today, m)}</div>
        <div class="${cls(d.week)}">${fmtMoney(d.week, m)}</div>
        <div class="${cls(d.month)}">${fmtMoney(d.month, m)}</div>
        <div class="${cls(d.unreal)}">${d.unreal ? fmtMoney(d.unreal, m) : '—'}</div>
      </div>`).join('')}
      <div class="j-dash-row-extra"><span>持倉 <strong>${openCount}</strong></span>${hasOpen ? `<button class="j-refresh-quotes-btn" id="j-refresh-quotes" title="更新未平倉報價"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg></button>` : ''}
      </div>
    </div>`;
  }
  el.innerHTML = dashHTML + `
  <div class="j-quick-filters" id="j-quick-filters">
    <button class="j-qf-chip" data-qf="all">全部<span class="j-qf-count">${trades.length}</span></button>
    <button class="j-qf-chip" data-qf="today">今日<span class="j-qf-count">${todayCount}</span></button>
    <button class="j-qf-chip" data-qf="open">持倉中<span class="j-qf-count">${openCount}</span></button>
    <button class="j-qf-chip" data-qf="winners">獲利<span class="j-qf-count">${winCount}</span></button>
    <button class="j-qf-chip" data-qf="losers">虧損<span class="j-qf-count">${lossCount}</span></button>
  </div>`;

  // Bind refresh quotes button
  $('#j-refresh-quotes')?.addEventListener('click', async () => {
    const btn = $('#j-refresh-quotes');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      await fetchOpenTradeQuotes(true);
      renderDashboard();
      if (viewMode === 'list') renderTradeList();
      checkSLTPAlerts();
    } catch {}
    btn.disabled = false;
    btn.classList.remove('loading');
  });
}

// ================================================================
//  Calendar View
// ================================================================
function renderCalendar() {
  const body = $('#j-body');
  if (!body) return;
  const now = new Date();
  if (!calMonth) calMonth = { year: now.getFullYear(), month: now.getMonth() };
  const { year, month } = calMonth;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Group trades by day
  const dayMap = {};
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  for (const t of trades) {
    if (!t.date?.startsWith(prefix)) continue;
    const day = parseInt(t.date.slice(8, 10));
    if (!dayMap[day]) dayMap[day] = [];
    dayMap[day].push(t);
  }

  let html = `<div class="j-cal-wrap">
    <div class="j-cal-header">
      <button class="j-dt-nav" id="j-cal-prev">&lsaquo;</button>
      <span class="j-cal-title">${year} 年 ${month + 1} 月</span>
      <button class="j-dt-nav" id="j-cal-next">&rsaquo;</button>
    </div>
    <div class="j-cal-grid">
      <div class="j-cal-wh">日</div><div class="j-cal-wh">一</div><div class="j-cal-wh">二</div><div class="j-cal-wh">三</div><div class="j-cal-wh">四</div><div class="j-cal-wh">五</div><div class="j-cal-wh">六</div>`;

  for (let i = 0; i < firstDay; i++) html += '<div class="j-cal-cell j-cal-empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const dayTrades = dayMap[d] || [];
    const closed = dayTrades.filter(t => t.status === 'closed');
    const plByMkt = {};
    closed.forEach(t => { const pl = calcPL(t); if (pl) { if (!plByMkt[t.market]) plByMkt[t.market] = 0; plByMkt[t.market] += pl.net; } });
    const mks = Object.keys(plByMkt);
    const totalPL = mks.reduce((s, m) => s + plByMkt[m], 0);
    const isToday = d === now.getDate() && month === now.getMonth() && year === now.getFullYear();
    const cls = closed.length ? (totalPL > 0 ? 'j-cal-profit' : totalPL < 0 ? 'j-cal-loss' : '') : '';
    const plHTML = mks.length <= 1
      ? (closed.length ? `<span class="j-cal-pl ${totalPL >= 0 ? 'tg' : 'tr'}">${fmtMoney(totalPL, mks[0] || 'tw')}</span>` : '')
      : mks.map(m => `<span class="j-cal-pl ${plByMkt[m] >= 0 ? 'tg' : 'tr'}" style="font-size:.58rem">${fmtMoney(plByMkt[m], m)}</span>`).join('');
    html += `<div class="j-cal-cell ${cls} ${isToday ? 'j-cal-today' : ''}" data-day="${d}">
      <span class="j-cal-day">${d}</span>
      ${dayTrades.length ? `<span class="j-cal-count">${dayTrades.length}筆</span>` : ''}
      ${plHTML}
    </div>`;
  }
  html += '</div></div>';
  body.innerHTML = html;

  $('#j-cal-prev')?.addEventListener('click', () => { calMonth.month--; if (calMonth.month < 0) { calMonth.month = 11; calMonth.year--; } renderCalendar(); });
  $('#j-cal-next')?.addEventListener('click', () => { calMonth.month++; if (calMonth.month > 11) { calMonth.month = 0; calMonth.year++; } renderCalendar(); });
  // Click on day to show trades
  $$('.j-cal-cell[data-day]', body).forEach(cell => {
    cell.addEventListener('click', () => {
      const day = cell.dataset.day;
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      filterState.dateFrom = dateStr;
      filterState.dateTo = dateStr;
      viewMode = 'list';
      renderJournal();
    });
  });
}

// ================================================================
//  Filters
// ================================================================
function _dateRangeValue() {
  const {dateFrom, dateTo} = filterState;
  if (!dateFrom && !dateTo) return 'all';
  // Check preset matches
  const today = new Date(), y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
  const fmt = dt => dt.toISOString().slice(0,10);
  const presets = {
    '7d':  [fmt(new Date(y,m,d-6)), fmt(today)],
    '30d': [fmt(new Date(y,m,d-29)), fmt(today)],
    '90d': [fmt(new Date(y,m,d-89)), fmt(today)],
    'month': [fmt(new Date(y,m,1)), fmt(today)],
    'year': [fmt(new Date(y,0,1)), fmt(today)],
  };
  for (const [k,[f,t]] of Object.entries(presets)) {
    if (dateFrom === f && dateTo === t) return k;
  }
  return 'custom';
}
function _applyDatePreset(val) {
  const today = new Date(), y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
  const fmt = dt => dt.toISOString().slice(0,10);
  if (val === 'all')   { filterState.dateFrom = ''; filterState.dateTo = ''; }
  else if (val === '7d')  { filterState.dateFrom = fmt(new Date(y,m,d-6)); filterState.dateTo = fmt(today); }
  else if (val === '30d') { filterState.dateFrom = fmt(new Date(y,m,d-29)); filterState.dateTo = fmt(today); }
  else if (val === '90d') { filterState.dateFrom = fmt(new Date(y,m,d-89)); filterState.dateTo = fmt(today); }
  else if (val === 'month') { filterState.dateFrom = fmt(new Date(y,m,1)); filterState.dateTo = fmt(today); }
  else if (val === 'year')  { filterState.dateFrom = fmt(new Date(y,0,1)); filterState.dateTo = fmt(today); }
}

function renderFilters() {
  const el = $('#j-filters'); if (!el) return;
  const allTags = [...new Set(trades.flatMap(t => t.tags || []))].sort();
  const allAccounts = [...new Set(trades.map(t => t.account).filter(Boolean))].sort();
  const drv = _dateRangeValue();
  const customActive = drv === 'custom';
  el.innerHTML = `<div class="j-filter-row">
    <div class="j-filter-group">
      <select id="jf-market" class="j-filter-select"><option value="all">全部市場</option><option value="tw" ${filterState.market==='tw'?'selected':''}>台灣</option><option value="us" ${filterState.market==='us'?'selected':''}>美國</option><option value="crypto" ${filterState.market==='crypto'?'selected':''}>加密貨幣</option></select>
      <select id="jf-type" class="j-filter-select"><option value="all">全部類型</option><option value="stock" ${filterState.type==='stock'?'selected':''}>股票</option><option value="futures" ${filterState.type==='futures'?'selected':''}>期貨(全部)</option><option value="index_futures" ${filterState.type==='index_futures'?'selected':''}>指數期貨</option><option value="stock_futures" ${filterState.type==='stock_futures'?'selected':''}>個股期貨</option><option value="commodity_futures" ${filterState.type==='commodity_futures'?'selected':''}>原物料期貨</option><option value="crypto_contract" ${filterState.type==='crypto_contract'?'selected':''}>加密貨幣合約</option><option value="crypto_spot" ${filterState.type==='crypto_spot'?'selected':''}>加密貨幣現貨</option><option value="options" ${filterState.type==='options'?'selected':''}>選擇權</option><option value="etf" ${filterState.type==='etf'?'selected':''}>ETF</option></select>
      <select id="jf-status-filter" class="j-filter-select"><option value="all">全部狀態</option><option value="open" ${filterState.status==='open'?'selected':''}>持倉中</option><option value="closed" ${filterState.status==='closed'?'selected':''}>已平倉</option></select>
      ${allTags.length?`<select id="jf-tag" class="j-filter-select"><option value="all">全部標籤</option>${allTags.map(t=>`<option value="${esc(t)}" ${filterState.tag===t?'selected':''}>${esc(t)}</option>`).join('')}</select>`:''}
      ${allAccounts.length?`<select id="jf-account-filter" class="j-filter-select"><option value="all">全部帳戶</option>${allAccounts.map(a=>`<option value="${esc(a)}" ${filterState.account===a?'selected':''}>${esc(a)}</option>`).join('')}</select>`:''}
    </div>
    <div class="j-filter-group">
      <select id="jf-date-range" class="j-filter-select">
        <option value="all" ${drv==='all'?'selected':''}>全部日期</option>
        <option value="7d" ${drv==='7d'?'selected':''}>近 7 天</option>
        <option value="30d" ${drv==='30d'?'selected':''}>近 30 天</option>
        <option value="90d" ${drv==='90d'?'selected':''}>近 90 天</option>
        <option value="month" ${drv==='month'?'selected':''}>本月</option>
        <option value="year" ${drv==='year'?'selected':''}>今年</option>
        <option value="custom" ${drv==='custom'?'selected':''}>自訂範圍</option>
      </select>
    </div>
    <div class="j-filter-custom-date" id="jf-custom-date" style="${customActive?'':'display:none'}">
      <input type="date" id="jf-from" class="j-filter-date" value="${filterState.dateFrom}">
      <span class="j-filter-sep">~</span>
      <input type="date" id="jf-to" class="j-filter-date" value="${filterState.dateTo}">
    </div>
    <div class="j-filter-search-wrap"><input type="text" id="jf-search" class="j-filter-search" placeholder="搜尋代號/名稱/備註..." value="${filterState.search}"></div>
  </div>`;
  const refresh = () => { if(viewMode==='list')renderTradeList();else if(viewMode==='holdings')renderHoldings();else if(viewMode==='calendar')renderCalendar();else if(viewMode==='diary')renderDiary();else renderStats(); };
  const update = () => {
    filterState.market=$('#jf-market')?.value||'all'; filterState.type=$('#jf-type')?.value||'all'; filterState.tag=$('#jf-tag')?.value||'all';
    filterState.account=$('#jf-account-filter')?.value||'all'; filterState.status=$('#jf-status-filter')?.value||'all'; filterState.search=$('#jf-search')?.value||'';
    refresh();
  };
  $('#jf-date-range')?.addEventListener('change', e => {
    const v = e.target.value;
    if (v === 'custom') {
      $('#jf-custom-date').style.display = '';
      // Don't clear — let user pick
    } else {
      $('#jf-custom-date').style.display = 'none';
      _applyDatePreset(v);
      refresh();
    }
  });
  $('#jf-from')?.addEventListener('change', () => { filterState.dateFrom=$('#jf-from')?.value||''; refresh(); });
  $('#jf-to')?.addEventListener('change', () => { filterState.dateTo=$('#jf-to')?.value||''; refresh(); });
  $$('#j-filters select:not(#jf-date-range),#jf-search').forEach(e=>e.addEventListener('change',update));
  $('#jf-search')?.addEventListener('input',update);
}

function getFilteredTrades() {
  let list=[...trades]; const f=filterState;
  // Quick filters
  if (quickFilter === 'today') { const td = new Date().toISOString().slice(0,10); list = list.filter(t => t.date?.slice(0,10) === td); }
  else if (quickFilter === 'open') list = list.filter(t => t.status === 'open');
  else if (quickFilter === 'winners') list = list.filter(t => { const pl = calcPL(t); return pl && pl.net > 0; });
  else if (quickFilter === 'losers') list = list.filter(t => { const pl = calcPL(t); return pl && pl.net <= 0 && t.status === 'closed'; });
  // Standard filters
  if(f.market!=='all') list=list.filter(t=>t.market===f.market);
  if(f.type!=='all') list=list.filter(t=> f.type==='futures' ? isFuturesType(t.type) : t.type===f.type);
  if(f.tag!=='all') list=list.filter(t=>(t.tags||[]).includes(f.tag));
  if(f.account&&f.account!=='all') list=list.filter(t=>t.account===f.account);
  if(f.status&&f.status!=='all') list=list.filter(t=>t.status===f.status);
  if(f.dateFrom) list=list.filter(t=>t.date>=f.dateFrom);
  if(f.dateTo) list=list.filter(t=>t.date<=f.dateTo+'T23:59:59');
  if(f.search){const s=f.search.toLowerCase();list=list.filter(t=>(t.symbol+t.name+t.notes).toLowerCase().includes(s));}
  const{field,asc}=sortState;
  list.sort((a,b)=>{let va,vb;if(field==='date'){va=a.date;vb=b.date;}else if(field==='symbol'){va=a.symbol;vb=b.symbol;}else if(field==='pl'){const pa=calcPL(a),pb=calcPL(b);va=pa?pa.net:-Infinity;vb=pb?pb.net:-Infinity;}else{va=a[field];vb=b[field];}if(va<vb)return asc?-1:1;if(va>vb)return asc?1:-1;return 0;});
  return list;
}

// ================================================================
//  Trade List
// ================================================================
function renderTradeList() {
  const body=$('#j-body');if(!body)return;
  const filtered=getFilteredTrades();
  if(!filtered.length){body.innerHTML=`<div class="j-empty"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="var(--t3)" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg><p>尚無交易紀錄</p><p class="j-empty-hint">點擊「新增交易」或在計算器分頁點「記錄此交易」</p></div>`;return;}
  const ML={tw:'台灣',us:'美國',crypto:'加密貨幣'},TL=TYPE_LABELS,DL={long:'做多',short:'做空'},DC={long:'j-dir-long',short:'j-dir-short'},SL={open:'持倉中',closed:'已平倉'};
  const si=f=>sortState.field!==f?'<span class="j-sort-icon"></span>':`<span class="j-sort-icon active">${sortState.asc?'&#9650;':'&#9660;'}</span>`;
  const cp=filtered.filter(t=>t.status==='closed').map(t=>calcPL(t)).filter(Boolean);
  const tn=cp.reduce((s,p)=>s+p.net,0),wins=cp.filter(p=>p.net>0).length,wr=cp.length?(wins/cp.length*100).toFixed(1):0;
  // Unrealized P&L for open trades
  const openTrades=filtered.filter(t=>t.status==='open');
  let unrealizedTotal=0,unrealizedCount=0;
  openTrades.forEach(t=>{const lq=liveQuotes[getLiveQuoteKey(t)];if(lq&&lq.price){const upl=calcUnrealizedPL(t,lq.price);if(upl){unrealizedTotal+=upl.net;unrealizedCount++;}}});
  // Batch mode toolbar
  let batchBar = '';
  if (batchMode) {
    batchBar = `<div class="j-batch-bar"><span>已選 <strong id="jb-count">${batchSelected.size}</strong> 筆</span>
      <button class="j-batch-action" id="jb-del">刪除</button>
      <button class="j-batch-action" id="jb-tag">加標籤</button>
      <button class="j-batch-action" id="jb-close">批次平倉</button>
      <button class="j-batch-action" id="jb-cancel">取消</button></div>`;
  }
  let h = batchBar;
  // Avg cost display for open positions
  const openSymbols = [...new Set(filtered.filter(t => t.status === 'open' && t.symbol).map(t => `${t.symbol}|${t.market}`))];
  const avgCostInfos = openSymbols.map(k => { const [sym, mkt] = k.split('|'); const r = calcAvgCost(sym, mkt); if (r) { r.market = mkt; const ft = trades.find(t => t.status === 'open' && t.symbol === sym && t.market === mkt); r.type = ft?.type || 'stock'; } return r; }).filter(Boolean);
  if (avgCostInfos.length) {
    h += `<div class="j-avg-cost-bar">${avgCostInfos.map(a => `<span>${a.count}筆持倉 均價 <strong class="ta">${fmtPrice(a.avgPrice, a.market, a.type)}</strong> 共 ${a.totalQty}</span>`).join(' ')}</div>`;
  }
  // Per-market closed P&L
  const cpByMkt={};
  filtered.filter(t=>t.status==='closed').forEach(t=>{const pl=calcPL(t);if(pl){if(!cpByMkt[t.market])cpByMkt[t.market]={n:0,c:0,w:0};cpByMkt[t.market].n+=pl.net;cpByMkt[t.market].c++;if(pl.net>0)cpByMkt[t.market].w++;}});
  const mktKeys=Object.keys(cpByMkt);
  const closedSummary=mktKeys.length?mktKeys.map(m=>{const v=cpByMkt[m];return `<strong class="${v.n>=0?'tg':'tr'}">${fmtMoney(v.n,m)}</strong>`;}).join(' '):'';
  // Per-market unrealized
  const uplByMkt={};
  openTrades.forEach(t=>{const lq=liveQuotes[getLiveQuoteKey(t)];if(lq&&lq.price){const upl=calcUnrealizedPL(t,lq.price);if(upl){if(!uplByMkt[t.market])uplByMkt[t.market]=0;uplByMkt[t.market]+=upl.net;}}});
  const uplKeys=Object.keys(uplByMkt);
  const uplSummary=uplKeys.length?uplKeys.map(m=>`<strong class="${uplByMkt[m]>=0?'tg':'tr'}">${fmtMoney(uplByMkt[m],m)}</strong>`).join(' '):'';
  h+=`<div class="j-summary-bar"><span>共 <strong>${filtered.length}</strong> 筆</span>${cp.length?`<span>已平倉：${closedSummary}</span><span>勝率：<strong>${wr}%</strong> (${wins}/${cp.length})</span>`:''}${uplKeys.length?`<span>未實現：${uplSummary} <small>(${unrealizedCount}筆)</small></span>`:openTrades.length?`<span>持倉中：<strong>${openTrades.length}</strong> 筆</span>`:''}</div>`;

  // Desktop: table view (condensed — 7 columns instead of 13)
  h+=`<div class="j-table-wrap"><table class="j-table"><thead><tr>${batchMode?'<th><input type="checkbox" id="jb-all"></th>':''}<th class="j-th-sort" data-sort="date">日期 ${si('date')}</th><th class="j-th-sort" data-sort="symbol">標的 ${si('symbol')}</th><th>價格</th><th>數量</th><th class="j-th-sort" data-sort="pl">損益 ${si('pl')}</th><th>狀態</th><th></th></tr></thead><tbody>`;
  for(const t of filtered){
    let plStr='—',plC='tm',plExtra='';
    if(t.status==='open'){
      const qk=getLiveQuoteKey(t),lq=liveQuotes[qk];
      if(lq&&lq.price){const upl=calcUnrealizedPL(t,lq.price);if(upl){plStr=fmtMoney(upl.net,t.market);plC=upl.net>0?'tg':upl.net<0?'tr':'';plExtra=`<div class="j-live-price">現價 ${fmtPrice(lq.price, t.market, t.type)}</div>`;}}
      else if(lq&&lq.error){plStr='<span class="j-live-price" title="'+esc(lq.error)+'">無法取得報價</span>';}
      else{plStr='<span class="j-pl-loading" data-key="'+qk+'">查詢中…</span>';}
    }else{const pl=calcPL(t);if(pl){plStr=fmtMoney(pl.net,t.market);plC=pl.net>0?'tg':pl.net<0?'tr':'';}}
    const tagHtml=(t.tags||[]).length?`<div class="j-td-tags-inline">${t.tags.map(tag=>`<span class="j-tag">${esc(tag)}</span>`).join('')}</div>`:'';
  h+=`<tr class="j-row" data-id="${t.id}">${batchMode?`<td><input type="checkbox" class="j-batch-cb" data-id="${t.id}" ${batchSelected.has(t.id)?'checked':''}></td>`:''}<td class="j-td-date">${fmtDate(t.date)}</td><td class="j-td-sym"><div class="j-sym-row"><strong>${esc(t.symbol)}</strong><span class="j-badge j-badge-${t.market}">${ML[t.market]||t.market}</span><span class="j-badge j-badge-type">${TL[t.type]||t.type}</span><span class="${DC[t.direction]}">${DL[t.direction]}</span></div>${t.name?`<span class="j-sym-name">${esc(t.name)}</span>`:''}</td><td class="j-td-price"><span class="j-td-num">${fmtPrice(parseFloat(t.entryPrice), t.market, t.type)}</span><span class="j-price-arrow">→</span><span class="j-td-num">${t.exitPrice?fmtPrice(parseFloat(t.exitPrice), t.market, t.type):'—'}</span></td><td class="j-td-num">${t.quantity||'—'}</td><td class="j-td-num ${plC}">${plStr}${plExtra}</td><td><span class="j-status j-status-${t.status}">${SL[t.status]}</span>${tagHtml}</td><td class="j-td-actions"><div class="j-actions-wrap">${t.status==='open'?`<button class="j-act-btn j-act-close" data-id="${t.id}" title="快速平倉"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></button>`:''}<button class="j-act-btn j-act-dup" data-id="${t.id}" title="複製交易"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>${t.status==='open'&&parseFloat(t.quantity)>1?`<button class="j-act-btn j-act-partial" data-id="${t.id}" title="部分平倉"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>`:''}<button class="j-act-btn j-act-view" data-id="${t.id}" title="檢視"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button><button class="j-act-btn j-act-edit" data-id="${t.id}" title="編輯"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="j-act-btn j-act-del" data-id="${t.id}" title="刪除"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button></div></td></tr>`;}
  h+='</tbody></table></div>';

  // Mobile: card view
  h+='<div class="j-card-list">';
  for(const t of filtered){
    let cPlStr='—',cPlC='tm',cFeeStr='—',cLiveInfo='';
    if(t.status==='open'){
      const qk=getLiveQuoteKey(t),lq=liveQuotes[qk];
      if(lq&&lq.price){const upl=calcUnrealizedPL(t,lq.price);if(upl){cPlStr=fmtMoney(upl.net,t.market);cPlC=upl.net>0?'tg':upl.net<0?'tr':'';cLiveInfo=`<div class="j-card-field"><span class="j-card-label">現價</span><span class="j-card-val">${fmtPrice(lq.price, t.market, t.type)}</span></div><div class="j-card-field"><span class="j-card-label">未實現損益</span><span class="j-card-val ${cPlC}">${cPlStr}</span></div>`;}}
      else if(lq&&lq.error){cPlStr='—';}
      else{cPlStr='<span class="j-pl-loading" data-key="'+qk+'">…</span>';}
      const fe=parseFloat(t.fee)||0,ta=parseFloat(t.tax)||0;cFeeStr=fmtMoney(fe+ta,t.market);
    }else{const pl=calcPL(t);if(pl){cPlStr=fmtMoney(pl.net,t.market);cPlC=pl.net>0?'tg':pl.net<0?'tr':'';cFeeStr=fmtMoney(pl.fee+pl.tax,t.market);}}
    h+=`<div class="j-card" data-id="${t.id}">
      <div class="j-card-head">
        <div class="j-card-left">
          <span class="j-card-symbol">${esc(t.symbol)}</span>
          <span class="j-badge j-badge-${t.market}">${ML[t.market]||t.market}</span>
          <span class="j-badge j-badge-type">${TL[t.type]||t.type}</span>
          <span class="${DC[t.direction]} j-card-dir">${DL[t.direction]}</span>
        </div>
        <div class="j-card-right">
          <span class="j-card-pl ${cPlC}">${cPlStr}</span>
          <svg class="j-card-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="j-card-sub">
        <span class="j-card-date">${fmtDate(t.date)}</span>
        <span class="j-card-price">${fmtPrice(parseFloat(t.entryPrice), t.market, t.type)} → ${t.exitPrice?fmtPrice(parseFloat(t.exitPrice), t.market, t.type):'—'}</span>
        <span class="j-status j-status-${t.status}">${SL[t.status]}</span>
      </div>
      <div class="j-card-detail">
        <div class="j-card-detail-grid">
          <div class="j-card-field"><span class="j-card-label">數量</span><span class="j-card-val">${t.quantity||'—'}</span></div>
          ${t.contractMul?`<div class="j-card-field"><span class="j-card-label">乘數</span><span class="j-card-val">${t.contractMul}</span></div>`:''}
          <div class="j-card-field"><span class="j-card-label">進場</span><span class="j-card-val">${fmtPrice(parseFloat(t.entryPrice), t.market, t.type)}</span></div>
          <div class="j-card-field"><span class="j-card-label">出場</span><span class="j-card-val">${t.exitPrice?fmtPrice(parseFloat(t.exitPrice), t.market, t.type):'—'}</span></div>
          ${cLiveInfo}
          <div class="j-card-field"><span class="j-card-label">手續費</span><span class="j-card-val">${t.fee?fmtNum(parseFloat(t.fee),0):'—'}</span></div>
          <div class="j-card-field"><span class="j-card-label">交易稅</span><span class="j-card-val">${t.tax?fmtNum(parseFloat(t.tax),0):'—'}</span></div>
          <div class="j-card-field"><span class="j-card-label">總成本</span><span class="j-card-val">${cFeeStr}</span></div>
          <div class="j-card-field"><span class="j-card-label">${t.status==='open'?'未實現損益':'淨損益'}</span><span class="j-card-val ${cPlC}">${cPlStr}</span></div>
        </div>
        ${(t.tags||[]).length?`<div class="j-card-tags">${t.tags.map(tag=>`<span class="j-tag">${esc(tag)}</span>`).join('')}</div>`:''}
        ${t.notes?`<div class="j-card-notes">${esc(t.notes)}</div>`:''}
        <div class="j-card-actions">
          ${t.status==='open'?`<button class="j-act-btn j-act-close" data-id="${t.id}" title="快速平倉"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></button>`:''}
          <button class="j-act-btn j-act-view" data-id="${t.id}" title="檢視"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
          <button class="j-act-btn j-act-edit" data-id="${t.id}" title="編輯"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="j-act-btn j-act-del" data-id="${t.id}" title="刪除"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
        </div>
      </div>
    </div>`;
  }
  h+='</div>';

  body.innerHTML=h;
  $$('.j-th-sort').forEach(th=>th.addEventListener('click',()=>{const f=th.dataset.sort;if(sortState.field===f)sortState.asc=!sortState.asc;else{sortState.field=f;sortState.asc=false;}renderTradeList();}));
  $$('.j-act-view').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openTradeDetail(b.dataset.id);}));
  $$('.j-act-edit').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openTradeForm(b.dataset.id);}));
  $$('.j-act-del').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();deleteTrade(b.dataset.id);}));
  $$('.j-act-close').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();quickCloseTrade(b.dataset.id);}));
  $$('.j-act-dup').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();duplicateTrade(b.dataset.id);}));
  $$('.j-act-partial').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();partialCloseTrade(b.dataset.id);}));
  // Batch mode handlers
  if (batchMode) {
    $$('.j-batch-cb').forEach(cb => cb.addEventListener('change', e => {
      e.stopPropagation();
      if (e.target.checked) batchSelected.add(e.target.dataset.id);
      else batchSelected.delete(e.target.dataset.id);
      const bar = $('#jb-count');
      if (bar) bar.textContent = batchSelected.size;
    }));
    $('#jb-all')?.addEventListener('change', e => {
      filtered.forEach(t => { if (e.target.checked) batchSelected.add(t.id); else batchSelected.delete(t.id); });
      renderTradeList();
    });
    $('#jb-del')?.addEventListener('click', batchDelete);
    $('#jb-tag')?.addEventListener('click', batchAddTag);
    $('#jb-close')?.addEventListener('click', batchClose);
    $('#jb-cancel')?.addEventListener('click', () => { batchMode = false; batchSelected.clear(); renderJournal(); });
  }
  // Desktop: row click
  $$('.j-row').forEach(r=>r.addEventListener('click',()=>openTradeDetail(r.dataset.id)));
  // Mobile: card expand/collapse
  $$('.j-card').forEach(c=>{
    c.querySelector('.j-card-head').addEventListener('click',e=>{
      if(e.target.closest('.j-act-btn'))return;
      c.classList.toggle('expanded');
    });
  });

  // Fetch live quotes for open trades, then re-render once
  const needsFetch = filtered.some(t => t.status === 'open' && t.symbol && !liveQuotes[getLiveQuoteKey(t)]);
  if (needsFetch) {
    fetchOpenTradeQuotes().then(() => {
      if (viewMode === 'list') renderTradeList();
      checkSLTPAlerts();
    });
  }
}

// ================================================================
//  Holdings (庫存)
// ================================================================
function renderHoldings() {
  const body = $('#j-body');
  if (!body) return;

  const openTrades = trades.filter(t => t.status === 'open');
  if (!openTrades.length) {
    body.innerHTML = `<div class="j-empty"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="var(--t3)" stroke-width="1.5"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg><p>目前沒有持倉中的商品</p><p class="j-empty-hint">在計算器分頁點「記錄此交易」新增持倉</p></div>`;
    return;
  }

  const ML = { tw: '台灣', us: '美國', crypto: '加密貨幣' };
  const TL = TYPE_LABELS;
  const DL = { long: '做多', short: '做空' };
  const DC = { long: 'j-dir-long', short: 'j-dir-short' };

  // Group by symbol + market
  const groups = {};
  for (const t of openTrades) {
    const key = `${t.symbol}|${t.market}|${t.direction}`;
    if (!groups[key]) groups[key] = { symbol: t.symbol, market: t.market, direction: t.direction, name: t.name || '', type: t.type, trades: [] };
    groups[key].trades.push(t);
  }

  // Build per-group summary
  const groupList = Object.values(groups).map(g => {
    const totalQty = g.trades.reduce((s, t) => s + (parseFloat(t.quantity) || 0), 0);
    // 加權平均進場價（不含乘數）
    const totalCost = g.trades.reduce((s, t) => s + (parseFloat(t.entryPrice) || 0) * (parseFloat(t.quantity) || 0), 0);
    const avgEntry = totalQty > 0 ? totalCost / totalQty : 0;
    // 計算含乘數的實際投入成本（用於現貨=進場價×數量，期貨=進場價×數量×乘數）
    const totalNotional = g.trades.reduce((s, t) => {
      const ep = parseFloat(t.entryPrice) || 0, q = parseFloat(t.quantity) || 0;
      return s + ep * q * getContractMul(t);
    }, 0);
    const qk = getLiveQuoteKey(g.trades[0]);
    const lq = liveQuotes[qk];
    let unrealized = 0, grossUnrealized = 0, currentPrice = null, hasQuote = false, currentNotional = 0;
    if (lq && lq.price) {
      currentPrice = lq.price;
      hasQuote = true;
      g.trades.forEach(t => {
        const upl = calcUnrealizedPL(t, lq.price);
        if (upl) { unrealized += upl.net; grossUnrealized += upl.gross; }
        const q = parseFloat(t.quantity) || 0;
        currentNotional += lq.price * q * getContractMul(t);
      });
    }
    const totalFee = g.trades.reduce((s, t) => s + (parseFloat(t.fee) || 0) + (parseFloat(t.tax) || 0), 0);
    // 最早和最晚的進場日
    const dates = g.trades.map(t => t.date).filter(Boolean).sort();
    const firstDate = dates[0] || '';
    const lastDate = dates[dates.length - 1] || '';
    return { ...g, totalQty, avgEntry, totalNotional, currentNotional, currentPrice, hasQuote, unrealized, grossUnrealized, totalFee, qk, firstDate, lastDate };
  });

  // Sort by unrealized P&L (worst first for risk awareness), or by symbol if no quotes
  groupList.sort((a, b) => {
    if (a.hasQuote && b.hasQuote) return a.unrealized - b.unrealized;
    if (a.hasQuote) return -1;
    return a.symbol.localeCompare(b.symbol);
  });

  // Totals per market
  const uplByMkt = {};
  let totalUPL = 0;
  groupList.forEach(g => {
    if (g.hasQuote) {
      if (!uplByMkt[g.market]) uplByMkt[g.market] = 0;
      uplByMkt[g.market] += g.unrealized;
      totalUPL += g.unrealized;
    }
  });
  const mktKeys = Object.keys(uplByMkt);
  const uplSummary = mktKeys.map(m => `<strong class="${uplByMkt[m] >= 0 ? 'tg' : 'tr'}">${fmtMoney(uplByMkt[m], m)}</strong>`).join(' ');

  let h = `<div class="j-summary-bar"><span>持倉 <strong>${openTrades.length}</strong> 筆（<strong>${groupList.length}</strong> 檔商品）</span>${mktKeys.length ? `<span>未實現淨損益：${uplSummary}</span>` : ''}</div>`;

  // Desktop: holdings table
  h += `<div class="j-table-wrap"><table class="j-table j-holdings-table"><thead><tr><th>商品</th><th>方向</th><th>數量</th><th>均價</th><th>現價</th><th>成本 / 市值</th><th>未實現淨損益<div style="font-size:.65rem;font-weight:400;color:var(--t3)">(交易成本 / 原損益)</div></th><th>筆數</th><th></th></tr></thead><tbody>`;
  for (const g of groupList) {
    const plC = g.hasQuote ? (g.unrealized > 0 ? 'tg' : g.unrealized < 0 ? 'tr' : '') : 'tm';
    const plStr = g.hasQuote ? fmtMoney(g.unrealized, g.market) : '—';
    const cpStr = g.currentPrice != null ? fmtPrice(g.currentPrice, g.market, g.type) : '<span class="j-pl-loading" data-key="' + g.qk + '">查詢中…</span>';
    const chgPct = g.hasQuote && g.avgEntry > 0 ? ((g.currentPrice - g.avgEntry) / g.avgEntry * 100 * (g.direction === 'long' ? 1 : -1)).toFixed(2) : null;
    const chgStr = chgPct != null ? `<span class="${parseFloat(chgPct) >= 0 ? 'tg' : 'tr'}" style="font-size:.72rem;margin-left:3px">(${parseFloat(chgPct) >= 0 ? '+' : ''}${chgPct}%)</span>` : '';
    const costStr = fmtMoney(g.totalNotional, g.market);
    const mktValStr = g.hasQuote ? fmtMoney(g.currentNotional, g.market) : '—';
    const dateRange = g.trades.length > 1 ? `<span class="j-sym-name">${fmtDate(g.firstDate)} ~ ${fmtDate(g.lastDate)}</span>` : (g.firstDate ? `<span class="j-sym-name">${fmtDate(g.firstDate)}</span>` : '');
    h += `<tr class="j-holding-row" data-symbol="${esc(g.symbol)}" data-market="${g.market}" data-direction="${g.direction}">
      <td class="j-td-sym"><div class="j-sym-row"><strong>${esc(g.symbol)}</strong><span class="j-badge j-badge-${g.market}">${ML[g.market] || g.market}</span><span class="j-badge j-badge-type">${TL[g.type] || g.type}</span></div>${g.name ? `<span class="j-sym-name">${esc(g.name)}</span>` : ''}${dateRange}</td>
      <td><span class="${DC[g.direction]}">${DL[g.direction]}</span></td>
      <td class="j-td-num">${fmtNum(g.totalQty, g.totalQty % 1 ? 4 : 0)}</td>
      <td class="j-td-num">${fmtPrice(g.avgEntry, g.market, g.type)}</td>
      <td class="j-td-num">${cpStr}</td>
      <td class="j-td-num"><div>${costStr}</div>${g.hasQuote ? `<div class="${plC}" style="font-size:.72rem">${mktValStr}</div>` : ''}</td>
      <td class="j-td-num ${plC}"><div>${plStr}${chgStr}</div>${g.hasQuote ? `<div style="font-size:.68rem;color:var(--t3)">(${fmtMoney(g.totalFee, g.market)} / ${fmtMoney(g.grossUnrealized, g.market)})</div>` : ''}</td>
      <td class="j-td-num">${g.trades.length}</td>
      <td class="j-td-actions"><div class="j-actions-wrap"><button class="j-act-btn j-hld-expand" data-key="${esc(g.symbol)}|${g.market}|${g.direction}" title="展開明細"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button></div></td>
    </tr>`;
    // Hidden detail rows (individual trades)
    for (const t of g.trades) {
      let tPlStr = '—', tPlC = 'tm', tGrossStr = '', tFeeTotal = 0;
      if (g.hasQuote) {
        const upl = calcUnrealizedPL(t, g.currentPrice);
        if (upl) { tPlStr = fmtMoney(upl.net, t.market); tPlC = upl.net > 0 ? 'tg' : upl.net < 0 ? 'tr' : ''; tGrossStr = fmtMoney(upl.gross, t.market); }
      }
      tFeeTotal = (parseFloat(t.fee) || 0) + (parseFloat(t.tax) || 0);
      const tQ = parseFloat(t.quantity) || 0;
      const tMul = getContractMul(t);
      const tCost = (parseFloat(t.entryPrice) || 0) * tQ * tMul;
      const tMktVal = g.hasQuote ? g.currentPrice * tQ * tMul : null;
      h += `<tr class="j-holding-detail" data-parent="${esc(g.symbol)}|${g.market}|${g.direction}" style="display:none">
        <td class="j-td-date" style="padding-left:28px">${fmtDate(t.date)}</td>
        <td></td>
        <td class="j-td-num">${t.quantity || '—'}</td>
        <td class="j-td-num">${fmtPrice(parseFloat(t.entryPrice), t.market, t.type)}</td>
        <td class="j-td-num">${g.currentPrice != null ? fmtPrice(g.currentPrice, g.market, g.type) : '—'}</td>
        <td class="j-td-num"><div>${fmtMoney(tCost, t.market)}</div>${tMktVal != null ? `<div class="${tPlC}" style="font-size:.72rem">${fmtMoney(tMktVal, t.market)}</div>` : ''}</td>
        <td class="j-td-num ${tPlC}"><div>${tPlStr}</div>${g.hasQuote ? `<div style="font-size:.68rem;color:var(--t3)">(${fmtMoney(tFeeTotal, t.market)} / ${tGrossStr})</div>` : ''}</td>
        <td></td>
        <td class="j-td-actions"><div class="j-actions-wrap">${`<button class="j-act-btn j-act-close" data-id="${t.id}" title="平倉"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></button><button class="j-act-btn j-act-edit" data-id="${t.id}" title="編輯"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="j-act-btn j-act-del" data-id="${t.id}" title="刪除"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>`}</div></td>
      </tr>`;
    }
  }
  h += '</tbody></table></div>';

  // Mobile: card view
  h += '<div class="j-card-list">';
  for (const g of groupList) {
    const plC = g.hasQuote ? (g.unrealized > 0 ? 'tg' : g.unrealized < 0 ? 'tr' : '') : 'tm';
    const plStr = g.hasQuote ? fmtMoney(g.unrealized, g.market) : '—';
    const cpStr = g.currentPrice != null ? fmtPrice(g.currentPrice, g.market, g.type) : '查詢中…';
    const chgPct = g.hasQuote && g.avgEntry > 0 ? ((g.currentPrice - g.avgEntry) / g.avgEntry * 100 * (g.direction === 'long' ? 1 : -1)).toFixed(2) : null;
    const chgStr = chgPct != null ? ` (${parseFloat(chgPct) >= 0 ? '+' : ''}${chgPct}%)` : '';

    h += `<div class="j-card j-holding-card" data-key="${esc(g.symbol)}|${g.market}|${g.direction}">
      <div class="j-card-head">
        <div class="j-card-left">
          <span class="j-card-symbol">${esc(g.symbol)}</span>
          <span class="j-badge j-badge-${g.market}">${ML[g.market] || g.market}</span>
          <span class="j-badge j-badge-type">${TL[g.type] || g.type}</span>
          <span class="${DC[g.direction]} j-card-dir">${DL[g.direction]}</span>
        </div>
        <div class="j-card-right">
          <span class="j-card-pl ${plC}">${plStr}</span>
          <svg class="j-card-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="j-card-sub">
        <span class="j-card-date">${g.trades.length} 筆</span>
        <span class="j-card-price">均 ${fmtPrice(g.avgEntry, g.market, g.type)} → 現 ${cpStr}</span>
        <span class="${plC}" style="font-size:.72rem">${chgStr}</span>
      </div>
      <div class="j-card-detail">
        <div class="j-card-detail-grid">
          <div class="j-card-field"><span class="j-card-label">總數量</span><span class="j-card-val">${fmtNum(g.totalQty, g.totalQty % 1 ? 4 : 0)}</span></div>
          <div class="j-card-field"><span class="j-card-label">均價</span><span class="j-card-val">${fmtPrice(g.avgEntry, g.market, g.type)}</span></div>
          <div class="j-card-field"><span class="j-card-label">現價</span><span class="j-card-val">${cpStr}</span></div>
          <div class="j-card-field"><span class="j-card-label">建倉期間</span><span class="j-card-val">${g.trades.length > 1 ? fmtDate(g.firstDate) + ' ~ ' + fmtDate(g.lastDate) : fmtDate(g.firstDate)}</span></div>
          <div class="j-card-field j-card-field-wide"><span class="j-card-label">成本 / 市值</span><span class="j-card-val">${fmtMoney(g.totalNotional, g.market)} / ${g.hasQuote ? fmtMoney(g.currentNotional, g.market) : '—'}</span></div>
          <div class="j-card-field j-card-field-wide"><span class="j-card-label">未實現淨損益</span><span class="j-card-val ${plC}">${plStr}${chgStr}${g.hasQuote ? ` <span style="font-size:.68rem;color:var(--t3)">(交易成本 ${fmtMoney(g.totalFee, g.market)} / 原損益 ${fmtMoney(g.grossUnrealized, g.market)})</span>` : ''}</span></div>
        </div>
        <div class="j-holding-sub-trades">
        ${g.trades.map(t => {
          let tPlStr = '—', tPlC = 'tm', tGrossStr = '', tFeeTotal = 0;
          if (g.hasQuote) { const upl = calcUnrealizedPL(t, g.currentPrice); if (upl) { tPlStr = fmtMoney(upl.net, t.market); tPlC = upl.net > 0 ? 'tg' : upl.net < 0 ? 'tr' : ''; tGrossStr = fmtMoney(upl.gross, t.market); } }
          tFeeTotal = (parseFloat(t.fee) || 0) + (parseFloat(t.tax) || 0);
          const tQ = parseFloat(t.quantity) || 0;
          const tRawMul = parseFloat(t.contractMul);
          const tMul = (isFuturesType(t.type) || t.type === 'options') ? (isNaN(tRawMul) || tRawMul === 0 ? 1 : tRawMul) : 1;
          const tCost = (parseFloat(t.entryPrice) || 0) * tQ * tMul;
          const tMktVal = g.hasQuote ? g.currentPrice * tQ * tMul : null;
          return `<div class="j-holding-sub-card">
            <div class="j-sub-card-header">
              <span class="j-card-date">${fmtDate(t.date)}</span>
              <span class="j-holding-sub-actions">
                <button class="j-act-btn j-act-close" data-id="${t.id}" title="平倉"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></button>
                <button class="j-act-btn j-act-edit" data-id="${t.id}" title="編輯"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                <button class="j-act-btn j-act-del" data-id="${t.id}" title="刪除"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
              </span>
            </div>
            <div class="j-sub-card-body">
              <div class="j-sub-card-row"><span class="j-sub-label">進場</span><span>${fmtPrice(parseFloat(t.entryPrice), t.market, t.type)} × ${t.quantity || '—'}</span></div>
              <div class="j-sub-card-row"><span class="j-sub-label">成本 / 市值</span><span>${fmtMoney(tCost, t.market)}${tMktVal != null ? ` / ${fmtMoney(tMktVal, t.market)}` : ''}</span></div>
              <div class="j-sub-card-row"><span class="j-sub-label">淨損益</span><span class="${tPlC}">${tPlStr}${g.hasQuote ? ` <span style="font-size:.68rem;color:var(--t3)">(${fmtMoney(tFeeTotal, t.market)} / ${tGrossStr})</span>` : ''}</span></div>
            </div>
          </div>`;
        }).join('')}
        </div>
      </div>
    </div>`;
  }
  h += '</div>';

  body.innerHTML = h;

  // Event handlers: expand/collapse group details (desktop table)
  $$('.j-hld-expand').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key = btn.dataset.key;
      const rows = $$(`tr.j-holding-detail[data-parent="${key}"]`);
      const isOpen = rows[0]?.style.display !== 'none';
      rows.forEach(r => r.style.display = isOpen ? 'none' : '');
      btn.closest('tr').classList.toggle('expanded', !isOpen);
    });
  });
  // Desktop: row click expands too
  $$('.j-holding-row').forEach(r => {
    r.addEventListener('click', e => {
      if (e.target.closest('.j-act-btn')) return;
      const btn = r.querySelector('.j-hld-expand');
      if (btn) btn.click();
    });
  });
  // Mobile: card expand
  $$('.j-holding-card .j-card-head').forEach(head => {
    head.addEventListener('click', e => {
      if (e.target.closest('.j-act-btn')) return;
      head.closest('.j-card').classList.toggle('expanded');
    });
  });
  // Action buttons
  $$('.j-act-close').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); quickCloseTrade(b.dataset.id); }));
  $$('.j-act-edit').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openTradeForm(b.dataset.id); }));
  $$('.j-act-del').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); deleteTrade(b.dataset.id); }));

  // Fetch live quotes for open trades then re-render
  const needsFetch = openTrades.some(t => !liveQuotes[getLiveQuoteKey(t)]);
  if (needsFetch) {
    fetchOpenTradeQuotes().then(() => {
      if (viewMode === 'holdings') renderHoldings();
    });
  }
}

// ================================================================
//  Equity Curve (SVG)
// ================================================================
function renderEquityCurve(pls) {
  if (!pls || pls.length < 2) return '';
  const sorted = [...pls].sort((a, b) => a.date > b.date ? 1 : -1);
  let cum = 0;
  const points = [{ x: 0, y: 0 }];
  sorted.forEach((t, i) => { cum += t.pl.net; points.push({ x: i + 1, y: cum }); });
  const W = 600, H = 200, pad = 30;
  const maxX = points.length - 1, minY = Math.min(0, ...points.map(p => p.y)), maxY = Math.max(0, ...points.map(p => p.y));
  const rangeY = maxY - minY || 1;
  const sx = x => pad + (x / maxX) * (W - pad * 2);
  const sy = y => H - pad - ((y - minY) / rangeY) * (H - pad * 2);
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const zeroY = sy(0).toFixed(1);
  const finalColor = cum >= 0 ? 'var(--green)' : 'var(--red)';
  const areaD = pathD + ` L${sx(maxX).toFixed(1)},${zeroY} L${sx(0).toFixed(1)},${zeroY} Z`;
  return `<div class="j-stats-section"><h4>淨值曲線</h4>
    <svg viewBox="0 0 ${W} ${H}" class="j-equity-svg">
      <line x1="${pad}" y1="${zeroY}" x2="${W - pad}" y2="${zeroY}" stroke="var(--bdr2)" stroke-dasharray="4"/>
      <path d="${areaD}" fill="${finalColor}" opacity=".1"/>
      <path d="${pathD}" fill="none" stroke="${finalColor}" stroke-width="2" stroke-linejoin="round"/>
      <text x="${pad}" y="${H - 8}" fill="var(--t3)" font-size="10">${sorted[0].date?.slice(0, 10) || ''}</text>
      <text x="${W - pad}" y="${H - 8}" fill="var(--t3)" font-size="10" text-anchor="end">${sorted[sorted.length - 1].date?.slice(0, 10) || ''}</text>
      <text x="${pad - 4}" y="${sy(maxY).toFixed(1)}" fill="var(--t3)" font-size="9" text-anchor="end">${fmtNum(maxY, 0)}</text>
      <text x="${pad - 4}" y="${sy(minY).toFixed(1)}" fill="var(--t3)" font-size="9" text-anchor="end">${fmtNum(minY, 0)}</text>
    </svg></div>`;
}

// ================================================================
//  Monthly Bar Chart (SVG)
// ================================================================
function renderMonthlyBarChart(byM) {
  const months = Object.entries(byM).sort((a, b) => a[0].localeCompare(b[0]));
  if (months.length < 2) return '';
  const vals = months.map(([, v]) => v.n);
  const maxAbs = Math.max(1, ...vals.map(v => Math.abs(v)));
  const W = 600, H = 180, pad = 40, barGap = 4;
  const barW = Math.min(40, (W - pad * 2) / months.length - barGap);
  const zeroY = H / 2;
  const scale = (H / 2 - 20) / maxAbs;

  let bars = '';
  months.forEach(([m, v], i) => {
    const x = pad + i * (barW + barGap);
    const h = Math.abs(v.n) * scale;
    const y = v.n >= 0 ? zeroY - h : zeroY;
    const color = v.n >= 0 ? 'var(--green)' : 'var(--red)';
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}" opacity=".7" rx="2"><title>${m}: ${fmtNum(v.n, 0)}</title></rect>`;
    bars += `<text x="${x + barW / 2}" y="${H - 4}" text-anchor="middle" fill="var(--t3)" font-size="8">${m.slice(5)}</text>`;
  });

  return `<div class="j-stats-section"><h4>月度損益柱狀圖</h4>
    <svg viewBox="0 0 ${W} ${H}" class="j-equity-svg">
      <line x1="${pad}" y1="${zeroY}" x2="${W - pad}" y2="${zeroY}" stroke="var(--bdr2)" stroke-dasharray="4"/>
      ${bars}
    </svg></div>`;
}

// ================================================================
//  P&L Distribution (Histogram)
// ================================================================
function renderPLDistribution(pls) {
  if (pls.length < 5) return '';
  const nets = pls.map(t => t.pl.net).sort((a, b) => a - b);
  const min = nets[0], max = nets[nets.length - 1];
  const range = max - min;
  if (range === 0) return '';
  const buckets = 12;
  const step = range / buckets;
  const bins = Array(buckets).fill(0);
  nets.forEach(n => {
    let idx = Math.floor((n - min) / step);
    if (idx >= buckets) idx = buckets - 1;
    bins[idx]++;
  });
  const maxBin = Math.max(1, ...bins);
  const W = 600, H = 140, pad = 30;
  const barW = (W - pad * 2) / buckets - 2;
  let bars = '';
  bins.forEach((cnt, i) => {
    const x = pad + i * ((W - pad * 2) / buckets) + 1;
    const h = (cnt / maxBin) * (H - pad - 10);
    const y = H - pad - h;
    const midVal = min + (i + 0.5) * step;
    const color = midVal >= 0 ? 'var(--green)' : 'var(--red)';
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}" opacity=".6" rx="1"><title>${fmtNum(min + i * step, 0)} ~ ${fmtNum(min + (i + 1) * step, 0)}: ${cnt}筆</title></rect>`;
  });
  return `<div class="j-stats-section"><h4>損益分布</h4>
    <svg viewBox="0 0 ${W} ${H}" class="j-equity-svg">
      ${bars}
      <text x="${pad}" y="${H - 6}" fill="var(--t3)" font-size="9">${fmtNum(min, 0)}</text>
      <text x="${W - pad}" y="${H - 6}" fill="var(--t3)" font-size="9" text-anchor="end">${fmtNum(max, 0)}</text>
    </svg></div>`;
}

function renderRollingChart(data) {
  const W=500,H=140,pad=40;
  if(data.length<2) return '';
  const maxWr=100,minWr=0;
  const xStep=(W-pad*2)/(data.length-1);
  const pts=data.map((d,i)=>{const x=pad+i*xStep;const y=H-pad-(d.wr-minWr)/(maxWr-minWr)*(H-pad*2);return `${x},${y}`;});
  const line50y=H-pad-(50-minWr)/(maxWr-minWr)*(H-pad*2);
  return `<div class="j-stats-chart"><svg viewBox="0 0 ${W} ${H}" class="j-equity-svg">
    <line x1="${pad}" y1="${line50y}" x2="${W-pad}" y2="${line50y}" stroke="var(--t3)" stroke-width="0.5" stroke-dasharray="4,3"/>
    <text x="${pad-4}" y="${line50y+3}" fill="var(--t3)" font-size="9" text-anchor="end">50%</text>
    <polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>
    <text x="${pad}" y="${H-6}" fill="var(--t3)" font-size="9">#1</text>
    <text x="${W-pad}" y="${H-6}" fill="var(--t3)" font-size="9" text-anchor="end">#${data.length}</text>
    <text x="${pad-4}" y="${pad}" fill="var(--t3)" font-size="9" text-anchor="end">100%</text>
    <text x="${pad-4}" y="${H-pad+3}" fill="var(--t3)" font-size="9" text-anchor="end">0%</text>
    <text x="${W-pad}" y="${pts[pts.length-1].split(',')[1]}" fill="var(--accent)" font-size="10" text-anchor="start" dx="4" dy="3">${data[data.length-1].wr.toFixed(1)}%</text>
  </svg></div>`;
}

// ================================================================
//  Daily Journal View
// ================================================================
let _diaryAutoSaveTimer = null;
let _diaryEditingDate = null; // null = today, string = editing past date

function _getDiaryTradesForDate(dateStr) {
  return trades.filter(t => t.date?.slice(0, 10) === dateStr);
}

function _renderDiaryTrades(dateStr) {
  const dayTrades = _getDiaryTradesForDate(dateStr);
  if (!dayTrades.length) return '';
  const closed = dayTrades.filter(t => t.status === 'closed');
  const plByMkt = {};
  closed.forEach(t => { const pl = calcPL(t); if (pl) { if (!plByMkt[t.market]) plByMkt[t.market] = 0; plByMkt[t.market] += pl.net; } });
  const mks = Object.keys(plByMkt);
  const plSummary = mks.map(m => `<span class="${plByMkt[m] >= 0 ? 'tg' : 'tr'}">${fmtMoney(plByMkt[m], m)}</span>`).join(' ');
  const DL = { long: '多', short: '空' };
  return `<div class="j-diary-trades"><h5>當日交易 (${dayTrades.length} 筆${closed.length ? `，淨損益 ${plSummary}` : ''})</h5>
    ${dayTrades.map(t => {
      const pl = calcPL(t);
      return `<div class="j-diary-trade-row"><span>${esc(t.symbol)} <span class="j-dir-${t.direction}">${DL[t.direction]}</span></span><span>${t.status === 'closed' && pl ? `<span class="${pl.net >= 0 ? 'tg' : 'tr'}">${fmtMoney(pl.net, t.market)}</span>` : '<span class="j-status-open" style="font-size:.7rem;padding:2px 6px">持倉</span>'}</span></div>`;
    }).join('')}
  </div>`;
}

function _calcDiaryStreak() {
  if (!dailyJournals.length) return 0;
  const sorted = [...dailyJournals].sort((a, b) => b.date.localeCompare(a.date));
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    // Skip weekends
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    if (sorted.find(j => j.date === ds)) streak++;
    else break;
  }
  return streak;
}

function _renderMoodTrend() {
  const recent = [...dailyJournals].sort((a, b) => a.date.localeCompare(b.date)).slice(-30).filter(j => j.mood);
  if (recent.length < 3) return '';
  const W = 500, H = 140, pad = 32, topPad = 20;
  const chartH = H - topPad - pad;
  const sx = (i) => pad + (i / (recent.length - 1)) * (W - pad * 2);
  const sy = (m) => topPad + chartH - ((m - 1) / 4) * chartH;
  const moodEmojis = ['', '😞', '😐', '🙂', '😊', '🤩'];

  // Compute daily P&L for each journal date
  const plData = recent.map(j => {
    const dt = _getDiaryTradesForDate(j.date).filter(t => t.status === 'closed');
    return dt.map(t => calcPL(t)).filter(Boolean).reduce((s, p) => s + p.net, 0);
  });
  const maxPL = Math.max(...plData.map(Math.abs), 1);
  const barH = chartH * 0.4;
  const barMid = topPad + chartH * 0.5;
  const barW = Math.max(4, Math.min(16, (W - pad * 2) / recent.length * 0.6));

  // P&L bars
  const bars = recent.map((j, i) => {
    if (!plData[i]) return '';
    const h = Math.abs(plData[i]) / maxPL * barH;
    const isPos = plData[i] >= 0;
    const x = sx(i) - barW / 2;
    const y = isPos ? barMid - h : barMid;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" fill="${isPos?'var(--green)':'var(--red)'}" opacity="0.2" rx="2"><title>${j.date}: ${fmtNum(plData[i],0)}</title></rect>`;
  }).join('');

  // Mood line
  const pathD = recent.map((j, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(j.mood).toFixed(1)}`).join(' ');

  // Dots colored by discipline
  const dots = recent.map((j, i) => {
    const d = j.discipline || 0;
    const color = d >= 4 ? 'var(--green)' : d >= 2 ? 'var(--accent)' : d > 0 ? 'var(--red)' : 'var(--t3)';
    return `<circle cx="${sx(i).toFixed(1)}" cy="${sy(j.mood).toFixed(1)}" r="4" fill="${color}" stroke="var(--bg1)" stroke-width="1.5"><title>${j.date}: ${moodEmojis[j.mood]} 紀律${d}/5 損益${fmtNum(plData[i],0)}</title></circle>`;
  }).join('');

  // Discipline vs P&L correlation text
  const withDisc = recent.filter(j => (j.discipline||0) > 0);
  let corrText = '';
  if (withDisc.length >= 3) {
    const highD = recent.filter(j => (j.discipline||0) >= 4);
    const lowD = recent.filter(j => (j.discipline||0) > 0 && (j.discipline||0) <= 2);
    const plOf = (arr) => arr.reduce((s, j) => {
      const dt = _getDiaryTradesForDate(j.date).filter(t => t.status === 'closed');
      return s + dt.map(t => calcPL(t)).filter(Boolean).reduce((ss, p) => ss + p.net, 0);
    }, 0);
    if (highD.length && lowD.length) {
      const hAvg = plOf(highD) / highD.length, lAvg = plOf(lowD) / lowD.length;
      corrText = `<div class="j-diary-correlation">高紀律 (${highD.length}天) 平均損益 <span class="${hAvg>=0?'tg':'tr'}">${fmtNum(hAvg,0)}</span>　低紀律 (${lowD.length}天) <span class="${lAvg>=0?'tg':'tr'}">${fmtNum(lAvg,0)}</span></div>`;
    }
  }

  return `<div class="j-mood-trend"><svg viewBox="0 0 ${W} ${H}" class="j-equity-svg" style="height:140px">
    <line x1="${pad}" y1="${barMid}" x2="${W-pad}" y2="${barMid}" stroke="var(--bdr)" stroke-width="0.5" stroke-dasharray="3,3"/>
    ${bars}
    <path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
    <text x="${pad}" y="13" fill="var(--t3)" font-size="9">心情+損益趨勢 (近 ${recent.length} 天)</text>
    <text x="${pad-2}" y="${topPad+4}" fill="var(--t3)" font-size="8" text-anchor="end">5</text>
    <text x="${pad-2}" y="${topPad+chartH+2}" fill="var(--t3)" font-size="8" text-anchor="end">1</text>
  </svg>${corrText}</div>`;
}

const DIARY_TAG_PRESETS = ['趨勢', '盤整', '震盪', '跳空', '量縮', '量增', '事件', '財報'];

function _getDiaryFormValues() {
  // Desktop fields have no suffix, mobile fields have -m suffix
  // Use whichever is visible / has content
  const isMobile = !$('.j-diary-cols')?.offsetParent;
  const sfx = isMobile ? '-m' : '';
  return {
    mood: parseInt($('#jd-mood')?.value) || 3,
    marketNote: $(`#jd-market${sfx}`)?.value || '',
    plan: $(`#jd-plan${sfx}`)?.value || '',
    review: $(`#jd-review${sfx}`)?.value || '',
    discipline: parseInt($('#jd-discipline')?.value) || 0,
    tags: isMobile
      ? $$('.jd-tag-btn.jd-tag-mobile.active').map(b => b.dataset.tag)
      : $$('.j-diary-tags-bar .jd-tag-btn.active').map(b => b.dataset.tag),
    takeaway: $(`#jd-takeaway${sfx}`)?.value || '',
    starred: parseInt($('#jd-starred')?.value) || 0,
  };
}

function renderDiary() {
  const body = $('#j-body');
  if (!body) return;
  loadDailyJournals().then(() => {
    const today = new Date().toISOString().slice(0, 10);
    const editDate = _diaryEditingDate || today;
    const isToday = editDate === today;
    const entry = dailyJournals.find(j => j.date === editDate);
    const moodEmojis = ['', '😞', '😐', '🙂', '😊', '🤩'];
    const streak = _calcDiaryStreak();
    const hour = new Date().getHours();
    const defaultTab = (isToday && hour < 14) ? 'pre' : 'post';
    const entryTags = entry?.tags || [];
    const dayTrades = _getDiaryTradesForDate(editDate);
    const closedTrades = dayTrades.filter(t => t.status === 'closed');
    const diaryPlByMkt = {};
    closedTrades.forEach(t => { const pl = calcPL(t); if (pl) { if (!diaryPlByMkt[t.market]) diaryPlByMkt[t.market] = 0; diaryPlByMkt[t.market] += pl.net; } });
    const dayPL = Object.values(diaryPlByMkt).reduce((s, v) => s + v, 0);
    const dayPLDisplay = Object.keys(diaryPlByMkt).map(m => `<strong class="${diaryPlByMkt[m]>=0?'tg':'tr'}">${fmtMoney(diaryPlByMkt[m],m)}</strong>`).join(' ');

    const historyEntries = dailyJournals.filter(j => j.date !== editDate);
    const starred = historyEntries.filter(j => j.starred);

    let h = `<div class="j-diary">
    <div class="j-diary-topbar">
      <div class="j-diary-topbar-left">
        <h4>${isToday ? '今日日記' : `日記 — ${editDate}`}</h4>
        ${streak > 0 ? `<span class="j-diary-streak-inline"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2z"/></svg>${streak}天</span>` : ''}
        <span class="j-diary-auto-saved" id="jd-auto-status">✓ 已儲存</span>
      </div>
      <div class="j-diary-topbar-right">
        <div class="j-diary-checkin-inline">
          <div class="j-mood-picker">${[1,2,3,4,5].map(i => `<button type="button" class="j-mood-btn ${(entry?.mood||3)===i?'active':''}" data-mood="${i}">${moodEmojis[i]}</button>`).join('')}</div>
          <input type="hidden" id="jd-mood" value="${entry?.mood||3}">
          <span class="j-diary-sep"></span>
          <div class="j-diary-discipline">${[1,2,3,4,5].map(i=>`<span class="j-star ${i<=(entry?.discipline||0)?'j-star-on':''}" data-rate="${i}" style="cursor:pointer;font-size:1rem">${i<=(entry?.discipline||0)?'★':'☆'}</span>`).join('')}</div>
          <input type="hidden" id="jd-discipline" value="${entry?.discipline||0}">
        </div>
        <button type="button" class="j-diary-star-btn ${(entry?.starred)?'active':''}" id="jd-star-btn" title="書籤">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="${(entry?.starred)?'var(--yellow)':'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2L15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2z"/></svg>
        </button>
        <input type="hidden" id="jd-starred" value="${entry?.starred||0}">
        ${!isToday ? `<button class="j-btn-cancel" id="jd-back-today" style="padding:3px 10px;font-size:.75rem">回到今天</button>` : ''}
        <button class="j-btn-save j-diary-save-btn" id="jd-save">儲存</button>
      </div>
    </div>
    <div class="j-diary-tags-bar">
      ${DIARY_TAG_PRESETS.map(tag=>`<button type="button" class="jd-tag-btn ${entryTags.includes(tag)?'active':''}" data-tag="${tag}">${tag}</button>`).join('')}
    </div>
    <div class="j-diary-cols">
      <div class="j-diary-col">
        <div class="j-diary-col-head">盤前</div>
        <div class="j-fg"><label>盤勢觀察</label><textarea id="jd-market" rows="3" placeholder="大盤走勢、重要消息...">${esc(entry?.marketNote||'')}</textarea></div>
        <div class="j-fg"><label>交易計畫</label><textarea id="jd-plan" rows="3" placeholder="計畫進出場、觀察標的...">${esc(entry?.plan||'')}</textarea></div>
      </div>
      <div class="j-diary-col">
        <div class="j-diary-col-head">盤後</div>
        <div class="j-fg"><label>收盤檢討</label><textarea id="jd-review" rows="3" placeholder="執行力、情緒管控、改進...">${esc(entry?.review||'')}</textarea></div>
        <div class="j-fg"><label>今日心得</label><input type="text" id="jd-takeaway" value="${esc(entry?.takeaway||'')}" placeholder="今天最重要的學習..."></div>
      </div>
      <div class="j-diary-col j-diary-col-info">
        <div class="j-diary-col-head">資訊</div>
        ${dayTrades.length ? _renderDiaryTrades(editDate) : '<div class="j-diary-no-trades">今日尚無交易</div>'}
        ${closedTrades.length ? `<div class="j-diary-day-summary"><span>今日損益</span>${dayPLDisplay}</div>` : ''}
        ${_renderMoodTrend()}
      </div>
    </div>
    <!-- Mobile tabs (hidden on desktop) -->
    <div class="j-diary-mobile-form">
      <div class="j-diary-checkin-mobile">
        <div class="j-diary-checkin-group"><label class="j-diary-checkin-label">市況</label>
          <div class="j-diary-tags">${DIARY_TAG_PRESETS.map(tag=>`<button type="button" class="jd-tag-btn jd-tag-mobile ${entryTags.includes(tag)?'active':''}" data-tag="${tag}">${tag}</button>`).join('')}</div>
        </div>
      </div>
      <div class="j-diary-tab-bar">
        <button class="j-diary-tab ${defaultTab==='pre'?'active':''}" data-pane="pre">盤前</button>
        <button class="j-diary-tab ${defaultTab==='post'?'active':''}" data-pane="post">盤後</button>
        <button class="j-diary-tab" data-pane="trades">交易${dayTrades.length?` (${dayTrades.length})`:''}</button>
      </div>
      <div class="j-diary-tab-pane ${defaultTab==='pre'?'active':''}" data-pane="pre">
        <div class="j-fg"><label>盤勢觀察</label><textarea id="jd-market-m" rows="3" placeholder="大盤走勢、重要消息...">${esc(entry?.marketNote||'')}</textarea></div>
        <div class="j-fg"><label>交易計畫</label><textarea id="jd-plan-m" rows="3" placeholder="計畫進出場、觀察標的...">${esc(entry?.plan||'')}</textarea></div>
      </div>
      <div class="j-diary-tab-pane ${defaultTab==='post'?'active':''}" data-pane="post">
        <div class="j-fg"><label>收盤檢討</label><textarea id="jd-review-m" rows="3" placeholder="執行力、情緒管控、改進...">${esc(entry?.review||'')}</textarea></div>
        <div class="j-fg"><label>今日心得</label><input type="text" id="jd-takeaway-m" value="${esc(entry?.takeaway||'')}" placeholder="今天最重要的學習..."></div>
      </div>
      <div class="j-diary-tab-pane" data-pane="trades">
        ${dayTrades.length ? _renderDiaryTrades(editDate) : '<div class="j-diary-no-trades">今日尚無交易</div>'}
        ${closedTrades.length ? `<div class="j-diary-day-summary"><span>今日損益</span>${dayPLDisplay}</div>` : ''}
        ${_renderMoodTrend()}
      </div>
      <button class="j-btn-save" id="jd-save-m" style="width:100%;margin-top:8px">儲存日記</button>
    </div>
    ${historyEntries.length ? `<div class="j-diary-list">
      <div class="j-diary-history-header">
        <h4>歷史日記</h4>
        <div class="j-diary-history-filters">
          <button class="jd-filter-btn ${starred.length?'':'disabled'}" id="jd-filter-star" title="只看書籤">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2z"/></svg>
          </button>
        </div>
      </div>
      <input type="text" class="j-diary-search" id="jd-search" placeholder="搜尋日記內容...">
      <div id="jd-history-list">
      ${historyEntries.slice(0,30).map(j => _renderDiaryEntryCard(j, moodEmojis)).join('')}
      </div>
      ${historyEntries.length > 30 ? `<button class="j-diary-load-more" id="jd-load-more">載入更多 (共 ${historyEntries.length} 篇)</button>` : ''}
    </div>` : ''}
    </div>`;
    body.innerHTML = h;

    // === Event Binding ===

    // Auto-save on input (debounce 2s)
    const _triggerDiaryAutoSave = (date) => {
      if (_diaryAutoSaveTimer) clearTimeout(_diaryAutoSaveTimer);
      _diaryAutoSaveTimer = setTimeout(async () => {
        // Verify we're still editing the same date
        if (_diaryEditingDate !== null && _diaryEditingDate !== date) return;
        if (_diaryEditingDate === null && date !== new Date().toISOString().slice(0, 10)) return;
        try {
          const v = _getDiaryFormValues();
          await saveDailyJournal(date, v.mood, v.marketNote, v.plan, v.review, v.discipline, v.tags, v.takeaway, v.starred);
          const el = $('#jd-auto-status');
          if (el) { el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2000); }
        } catch {}
      }, 2000);
    };

    // Back to today
    $('#jd-back-today')?.addEventListener('click', () => { _diaryEditingDate = null; renderDiary(); });

    // Star toggle
    $('#jd-star-btn')?.addEventListener('click', () => {
      const btn = $('#jd-star-btn');
      const input = $('#jd-starred');
      const isStarred = parseInt(input.value) ? 0 : 1;
      input.value = isStarred;
      btn.classList.toggle('active', !!isStarred);
      btn.querySelector('svg').setAttribute('fill', isStarred ? 'var(--yellow)' : 'none');
      _triggerDiaryAutoSave(editDate);
    });

    // Tab switching
    $$('.j-diary-tab', body).forEach(tab => tab.addEventListener('click', () => {
      $$('.j-diary-tab', body).forEach(t => t.classList.remove('active'));
      $$('.j-diary-tab-pane', body).forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $(`.j-diary-tab-pane[data-pane="${tab.dataset.pane}"]`, body)?.classList.add('active');
    }));

    // Discipline picker
    $$('.j-diary-discipline .j-star', body).forEach(s => s.addEventListener('click', () => {
      const rate = parseInt(s.dataset.rate);
      $('#jd-discipline').value = rate;
      $$('.j-diary-discipline .j-star', body).forEach((st, i) => {
        st.textContent = i < rate ? '★' : '☆';
        st.classList.toggle('j-star-on', i < rate);
      });
      _triggerDiaryAutoSave(editDate);
    }));

    // Tag toggle
    $$('.jd-tag-btn', body).forEach(b => b.addEventListener('click', () => {
      b.classList.toggle('active');
      _triggerDiaryAutoSave(editDate);
    }));

    // Click on past entry to edit
    $$('.j-diary-entry[data-date]', body).forEach(el => el.addEventListener('click', () => {
      _diaryEditingDate = el.dataset.date;
      renderDiary();
    }));

    // Mood picker
    $$('.j-mood-btn', body).forEach(b => b.addEventListener('click', () => {
      $$('.j-mood-btn', body).forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      $('#jd-mood').value = b.dataset.mood;
      _triggerDiaryAutoSave(editDate);
    }));

    $$('#jd-market,#jd-plan,#jd-review,#jd-takeaway,#jd-market-m,#jd-plan-m,#jd-review-m,#jd-takeaway-m', body).forEach(el => {
      if (el) el.addEventListener('input', () => _triggerDiaryAutoSave(editDate));
    });

    // Diary search
    let _showStarredOnly = false;
    const _filterHistory = () => {
      const q = ($('#jd-search')?.value || '').toLowerCase().trim();
      $$('.j-diary-entry[data-date]', body).forEach(el => {
        const text = el.textContent.toLowerCase();
        const matchSearch = !q || text.includes(q);
        const matchStar = !_showStarredOnly || el.dataset.starred === '1';
        el.style.display = (matchSearch && matchStar) ? '' : 'none';
      });
    };
    $('#jd-search')?.addEventListener('input', _filterHistory);
    $('#jd-filter-star')?.addEventListener('click', () => {
      _showStarredOnly = !_showStarredOnly;
      $('#jd-filter-star')?.classList.toggle('active', _showStarredOnly);
      _filterHistory();
    });

    // Load more
    let _historyShown = 30;
    $('#jd-load-more')?.addEventListener('click', () => {
      const list = $('#jd-history-list');
      const next = historyEntries.slice(_historyShown, _historyShown + 30);
      list.insertAdjacentHTML('beforeend', next.map(j => _renderDiaryEntryCard(j, moodEmojis)).join(''));
      _historyShown += 30;
      // Re-bind click on new entries only
      const allEntries = $$('.j-diary-entry[data-date]', list);
      allEntries.slice(-next.length).forEach(el => {
        el.onclick = () => { _diaryEditingDate = el.dataset.date; renderDiary(); };
      });
      if (_historyShown >= historyEntries.length) $('#jd-load-more')?.remove();
    });

    // Manual save (desktop + mobile buttons)
    const _manualSave = async (btn, label) => {
      if (_diaryAutoSaveTimer) clearTimeout(_diaryAutoSaveTimer);
      btn.disabled = true; btn.textContent = '儲存中...';
      try {
        const v = _getDiaryFormValues();
        await saveDailyJournal(editDate, v.mood, v.marketNote, v.plan, v.review, v.discipline, v.tags, v.takeaway, v.starred);
        btn.textContent = '✓';
        setTimeout(() => { btn.disabled = false; btn.textContent = label; }, 1500);
      } catch (e) {
        alert('儲存失敗：' + e.message);
        btn.disabled = false; btn.textContent = label;
      }
    };
    $('#jd-save')?.addEventListener('click', () => _manualSave($('#jd-save'), '儲存'));
    $('#jd-save-m')?.addEventListener('click', () => _manualSave($('#jd-save-m'), '儲存日記'));
  });
}

function _renderDiaryEntryCard(j, moodEmojis) {
  const dayTrades = _getDiaryTradesForDate(j.date);
  const closedTrades = dayTrades.filter(t => t.status === 'closed');
  const plByMkt = {};
  closedTrades.forEach(t => { const pl = calcPL(t); if (pl) { if (!plByMkt[t.market]) plByMkt[t.market] = 0; plByMkt[t.market] += pl.net; } });
  const totalPL = Object.values(plByMkt).reduce((s, v) => s + v, 0);
  const hasTrades = closedTrades.length > 0;
  const borderClass = hasTrades ? (totalPL >= 0 ? 'j-diary-border-green' : 'j-diary-border-red') : '';
  const plDisplay = Object.keys(plByMkt).map(m => `<span class="${plByMkt[m] >= 0 ? 'tg' : 'tr'}">${fmtMoney(plByMkt[m], m)}</span>`).join(' ');
  return `<div class="j-diary-entry card ${borderClass}" data-date="${j.date}" data-starred="${j.starred||0}">
    <div class="j-diary-entry-top">
      <div class="j-diary-entry-date">
        <strong>${j.date}</strong>
        ${j.starred?'<svg viewBox="0 0 24 24" width="12" height="12" fill="var(--yellow)" stroke="var(--yellow)" stroke-width="2"><path d="M12 2L15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2z"/></svg>':''}
      </div>
      <div class="j-diary-entry-meta">
        ${dayTrades.length ? `<span class="j-diary-entry-pl">${dayTrades.length}筆 ${plDisplay}</span>` : ''}
        ${j.discipline?`<span class="j-diary-entry-disc">${'★'.repeat(j.discipline)}${'☆'.repeat(5-j.discipline)}</span>`:''}
        <span>${moodEmojis[j.mood||3]}</span>
      </div>
    </div>
    ${(j.tags||[]).length?`<div class="j-diary-entry-tags">${j.tags.map(tag=>`<span class="j-diary-entry-tag">${esc(tag)}</span>`).join('')}</div>`:''}
    ${j.takeaway?`<div class="j-diary-entry-takeaway">💡 ${esc(j.takeaway)}</div>`:''}
    ${j.marketNote?`<div class="j-diary-entry-text"><span class="j-diary-entry-label">盤勢</span> ${esc(j.marketNote.length>80?j.marketNote.slice(0,80)+'...':j.marketNote)}</div>`:''}
    ${j.review?`<div class="j-diary-entry-text"><span class="j-diary-entry-label">檢討</span> ${esc(j.review.length>80?j.review.slice(0,80)+'...':j.review)}</div>`:''}
  </div>`;
}

// ================================================================
//  Statistics
// ================================================================
// Compute stats object from a trade list (all must have .pl attached)
function computeStats(pls) {
  const tn=pls.reduce((s,t)=>s+t.pl.net,0),tf=pls.reduce((s,t)=>s+t.pl.fee,0),tt=pls.reduce((s,t)=>s+t.pl.tax,0);
  const w=pls.filter(t=>t.pl.net>0),l=pls.filter(t=>t.pl.net<=0),wr=pls.length?(w.length/pls.length*100).toFixed(1):'0';
  const aw=w.length?w.reduce((s,t)=>s+t.pl.net,0)/w.length:0,al=l.length?l.reduce((s,t)=>s+t.pl.net,0)/l.length:0;
  const pf=Math.abs(al)>0?Math.abs(aw/al):Infinity;
  const mw=pls.length?pls.reduce((m,t)=>Math.max(m,t.pl.net),-Infinity):0;
  const ml=pls.length?pls.reduce((m,t)=>Math.min(m,t.pl.net),Infinity):0;
  let mcw=0,mcl=0,cw=0,cl=0;
  [...pls].sort((a,b)=>a.date>b.date?1:-1).forEach(t=>{if(t.pl.net>0){cw++;cl=0;mcw=Math.max(mcw,cw);}else{cl++;cw=0;mcl=Math.max(mcl,cl);}});
  const expectancy = pls.length ? (parseFloat(wr)/100 * aw) + ((1-parseFloat(wr)/100) * al) : 0;
  let peak=0,cum2=0,maxDD=0;
  [...pls].sort((a,b)=>a.date>b.date?1:-1).forEach(t=>{cum2+=t.pl.net;if(cum2>peak)peak=cum2;const dd=peak-cum2;if(dd>maxDD)maxDD=dd;});
  const maxDDPct = peak > 0 ? (maxDD/peak*100).toFixed(1) : '0';
  const holdFn = list => list.filter(t=>t.exitPrice&&t.date).map(t=>Math.max(0,Math.round((new Date(t.updatedAt||t.date)-new Date(t.date))/(1000*60*60*24))));
  const holdingDays = holdFn(pls), wHoldDays = holdFn(w), lHoldDays = holdFn(l);
  const avgHold = holdingDays.length ? (holdingDays.reduce((s,d)=>s+d,0)/holdingDays.length).toFixed(1) : '—';
  const wHold = wHoldDays.length ? (wHoldDays.reduce((s,d)=>s+d,0)/wHoldDays.length).toFixed(1) : '—';
  const lHold = lHoldDays.length ? (lHoldDays.reduce((s,d)=>s+d,0)/lHoldDays.length).toFixed(1) : '—';
  const rTrades = pls.filter(t=>{const en=parseFloat(t.entryPrice),sl=parseFloat(t.stopLoss);return !isNaN(en)&&!isNaN(sl)&&en!==sl;});
  const rMultiples = rTrades.map(t=>{const en=parseFloat(t.entryPrice),sl=parseFloat(t.stopLoss),risk=Math.abs(en-sl);return risk>0?t.pl.net/(risk*(parseFloat(t.quantity)||1)*((isFuturesType(t.type)||t.type==='options')?(parseFloat(t.contractMul)||1):1)):0;});
  const avgR = rMultiples.length?(rMultiples.reduce((s,r)=>s+r,0)/rMultiples.length).toFixed(2):'—';
  const byT={},byM={},byTg={},byDow={},byAcct={},byRating={},bySymbol={};
  const byTime={morning:{c:0,n:0,w:0},afternoon:{c:0,n:0,w:0}};
  pls.forEach(t=>{
    if(!byT[t.type])byT[t.type]={c:0,n:0,w:0};byT[t.type].c++;byT[t.type].n+=t.pl.net;if(t.pl.net>0)byT[t.type].w++;
    const mo=t.date.slice(0,7);if(!byM[mo])byM[mo]={c:0,n:0,w:0};byM[mo].c++;byM[mo].n+=t.pl.net;if(t.pl.net>0)byM[mo].w++;
    (t.tags||[]).forEach(tag=>{if(!byTg[tag])byTg[tag]={c:0,n:0,w:0};byTg[tag].c++;byTg[tag].n+=t.pl.net;if(t.pl.net>0)byTg[tag].w++;});
    const d=new Date(t.date).getDay();if(!byDow[d])byDow[d]={c:0,n:0,w:0};byDow[d].c++;byDow[d].n+=t.pl.net;if(t.pl.net>0)byDow[d].w++;
    const h=new Date(t.date).getHours();const slot=h<12?'morning':'afternoon';byTime[slot].c++;byTime[slot].n+=t.pl.net;if(t.pl.net>0)byTime[slot].w++;
    const a=t.account||'(未指定)';if(!byAcct[a])byAcct[a]={c:0,n:0,w:0};byAcct[a].c++;byAcct[a].n+=t.pl.net;if(t.pl.net>0)byAcct[a].w++;
    const r=t.rating||0;if(r>0){if(!byRating[r])byRating[r]={c:0,n:0,w:0};byRating[r].c++;byRating[r].n+=t.pl.net;if(t.pl.net>0)byRating[r].w++;}
    const s=t.symbol||'(未知)';if(!bySymbol[s])bySymbol[s]={c:0,n:0,w:0,name:t.name||s};bySymbol[s].c++;bySymbol[s].n+=t.pl.net;if(t.pl.net>0)bySymbol[s].w++;
  });
  const sorted=[...pls].sort((a,b)=>a.date>b.date?1:-1);
  const rollingData=[];
  for(let i=0;i<sorted.length;i++){const win=sorted.slice(Math.max(0,i-29),i+1);const ww=win.filter(t=>t.pl.net>0).length;rollingData.push({date:sorted[i].date,wr:(ww/win.length*100),cum:win.reduce((s,t)=>s+t.pl.net,0),idx:i+1});}
  let revengeTrades=0,revengeNet=0,afterLossCount=0,afterLossNet=0;
  for(let i=1;i<sorted.length;i++){if(sorted[i-1].pl.net<0){afterLossCount++;afterLossNet+=sorted[i].pl.net;const diffH=(new Date(sorted[i].date)-new Date(sorted[i-1].date))/(1000*60*60);if(diffH<2){revengeTrades++;revengeNet+=sorted[i].pl.net;}}}
  const reviewed=pls.filter(t=>(t.reviewDiscipline||0)>0||(t.reviewTiming||0)>0||(t.reviewSizing||0)>0);
  const avgDisc=reviewed.length?reviewed.reduce((s,t)=>s+(t.reviewDiscipline||0),0)/reviewed.length:0;
  const avgTim=reviewed.length?reviewed.reduce((s,t)=>s+(t.reviewTiming||0),0)/reviewed.length:0;
  const avgSiz=reviewed.length?reviewed.reduce((s,t)=>s+(t.reviewSizing||0),0)/reviewed.length:0;
  const highDisc=reviewed.filter(t=>(t.reviewDiscipline||0)>=4),lowDisc=reviewed.filter(t=>(t.reviewDiscipline||0)<=2&&(t.reviewDiscipline||0)>0);
  const highDiscPL=highDisc.length?highDisc.reduce((s,t)=>s+t.pl.net,0)/highDisc.length:0;
  const lowDiscPL=lowDisc.length?lowDisc.reduce((s,t)=>s+t.pl.net,0)/lowDisc.length:0;
  return {tn,tf,tt,count:pls.length,w,l,wr,aw,al,pf,mw,ml,mcw,mcl,expectancy,maxDD,maxDDPct,avgHold,wHold,lHold,rMultiples,avgR,byT,byM,byTg,byDow,byTime,byAcct,byRating,bySymbol,rollingData,revengeTrades,revengeNet,afterLossCount,afterLossNet,reviewed,avgDisc,avgTim,avgSiz,highDisc,lowDisc,highDiscPL,lowDiscPL,pls,sorted};
}

// Render stats HTML for a specific market (fm = fmtMoney bound to market)
function renderStatsHTML(st, market) {
  const fm = (n, d) => fmtMoney(n, market, d);
  const TL = TYPE_LABELS;
  const dowNames = ['日','一','二','三','四','五','六'];
  const {tn,tf,tt,count,w,l,wr,aw,al,pf,mw,ml,mcw,mcl,expectancy,maxDD,maxDDPct,avgHold,wHold,lHold,rMultiples,avgR,byT,byM,byTg,byDow,byTime,byAcct,byRating,bySymbol,rollingData,revengeTrades,revengeNet,afterLossCount,afterLossNet,reviewed,avgDisc,avgTim,avgSiz,highDisc,lowDisc,highDiscPL,lowDiscPL,pls,sorted} = st;
  return `<div class="j-stats-grid">
    <div class="j-stat-card j-stat-main"><div class="j-stat-label">淨損益</div><div class="j-stat-value ${tn>=0?'tg':'tr'}">${fm(tn)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">交易次數</div><div class="j-stat-value">${count}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">勝率</div><div class="j-stat-value ${parseFloat(wr)>=50?'tg':'tr'}">${wr}%</div><div class="j-stat-sub">${w.length}勝/${l.length}負</div></div>
    <div class="j-stat-card"><div class="j-stat-label">獲利因子</div><div class="j-stat-value">${pf===Infinity?'∞':pf.toFixed(2)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">期望值</div><div class="j-stat-value ${expectancy>=0?'tg':'tr'}">${fm(expectancy)}</div><div class="j-stat-sub">每筆期望報酬</div></div>
    <div class="j-stat-card"><div class="j-stat-label">最大回撤</div><div class="j-stat-value tr">${fm(maxDD)}</div><div class="j-stat-sub">${maxDDPct}%</div></div>
    <div class="j-stat-card"><div class="j-stat-label">平均獲利</div><div class="j-stat-value tg">${fm(aw)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">平均虧損</div><div class="j-stat-value tr">${fm(al)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">最大單筆獲利</div><div class="j-stat-value tg">${fm(mw)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">最大單筆虧損</div><div class="j-stat-value tr">${fm(ml)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">最大連勝</div><div class="j-stat-value">${mcw}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">最大連敗</div><div class="j-stat-value">${mcl}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">平均持倉天數</div><div class="j-stat-value">${avgHold}</div><div class="j-stat-sub">獲利 ${wHold} / 虧損 ${lHold}</div></div>
    ${rMultiples.length?`<div class="j-stat-card"><div class="j-stat-label">平均 R 倍數</div><div class="j-stat-value ${parseFloat(avgR)>=0?'tg':'tr'}">${avgR}R</div><div class="j-stat-sub">${rMultiples.length}筆有停損</div></div>`:''}
    <div class="j-stat-card"><div class="j-stat-label">總手續費</div><div class="j-stat-value ty">${fm(tf)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">總交易稅</div><div class="j-stat-value ty">${fm(tt)}</div></div>
  </div>
  ${renderEquityCurve(pls)}
  ${Object.keys(byT).length>1?`<div class="j-stats-section"><h4>依商品類型</h4><table class="j-stats-table"><thead><tr><th>類型</th><th>筆數</th><th>淨損益</th><th>勝率</th></tr></thead><tbody>${Object.entries(byT).map(([k,v])=>`<tr><td>${TL[k]||k}</td><td>${v.c}</td><td class="${v.n>=0?'tg':'tr'}">${fm(v.n)}</td><td>${(v.w/v.c*100).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>`:''}
  ${Object.keys(byM).length?`<div class="j-stats-section"><h4>月度績效</h4><table class="j-stats-table"><thead><tr><th>月份</th><th>筆數</th><th>淨損益</th><th>勝率</th></tr></thead><tbody>${Object.entries(byM).sort((a,b)=>b[0].localeCompare(a[0])).map(([m,v])=>`<tr><td>${m}</td><td>${v.c}</td><td class="${v.n>=0?'tg':'tr'}">${fm(v.n)}</td><td>${(v.w/v.c*100).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>`:''}
  ${Object.keys(byTg).length?`<div class="j-stats-section"><h4>依標籤</h4><table class="j-stats-table"><thead><tr><th>標籤</th><th>筆數</th><th>淨損益</th><th>勝率</th></tr></thead><tbody>${Object.entries(byTg).sort((a,b)=>b[1].n-a[1].n).map(([tag,v])=>`<tr><td><span class="j-tag">${esc(tag)}</span></td><td>${v.c}</td><td class="${v.n>=0?'tg':'tr'}">${fm(v.n)}</td><td>${(v.w/v.c*100).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>`:''}
  ${Object.keys(byAcct).length>1?`<div class="j-stats-section"><h4>依帳戶</h4><table class="j-stats-table"><thead><tr><th>帳戶</th><th>筆數</th><th>淨損益</th><th>勝率</th></tr></thead><tbody>${Object.entries(byAcct).sort((a,b)=>b[1].n-a[1].n).map(([a,v])=>`<tr><td>${esc(a)}</td><td>${v.c}</td><td class="${v.n>=0?'tg':'tr'}">${fm(v.n)}</td><td>${(v.w/v.c*100).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>`:''}
  ${Object.keys(byRating).length?`<div class="j-stats-section"><h4>依評分</h4><table class="j-stats-table"><thead><tr><th>評分</th><th>筆數</th><th>淨損益</th><th>勝率</th></tr></thead><tbody>${Object.entries(byRating).sort((a,b)=>b[0]-a[0]).map(([r,v])=>`<tr><td>${'★'.repeat(parseInt(r))}${'☆'.repeat(5-parseInt(r))}</td><td>${v.c}</td><td class="${v.n>=0?'tg':'tr'}">${fm(v.n)}</td><td>${(v.w/v.c*100).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>`:''}
  <div class="j-stats-section"><h4>依星期</h4><table class="j-stats-table"><thead><tr><th>星期</th><th>筆數</th><th>淨損益</th><th>勝率</th></tr></thead><tbody>${[1,2,3,4,5,6,0].filter(d=>byDow[d]).map(d=>{const v=byDow[d];return `<tr><td>週${dowNames[d]}</td><td>${v.c}</td><td class="${v.n>=0?'tg':'tr'}">${fm(v.n)}</td><td>${(v.w/v.c*100).toFixed(1)}%</td></tr>`;}).join('')}</tbody></table></div>
  ${byTime.morning.c&&byTime.afternoon.c?`<div class="j-stats-section"><h4>依時段</h4><table class="j-stats-table"><thead><tr><th>時段</th><th>筆數</th><th>淨損益</th><th>勝率</th></tr></thead><tbody><tr><td>上午 (0-12)</td><td>${byTime.morning.c}</td><td class="${byTime.morning.n>=0?'tg':'tr'}">${fm(byTime.morning.n)}</td><td>${(byTime.morning.w/byTime.morning.c*100).toFixed(1)}%</td></tr><tr><td>下午 (12-24)</td><td>${byTime.afternoon.c}</td><td class="${byTime.afternoon.n>=0?'tg':'tr'}">${fm(byTime.afternoon.n)}</td><td>${(byTime.afternoon.w/byTime.afternoon.c*100).toFixed(1)}%</td></tr></tbody></table></div>`:''}
  ${Object.keys(bySymbol).length>1?`<div class="j-stats-section"><h4>依標的績效</h4><table class="j-stats-table"><thead><tr><th>標的</th><th>筆數</th><th>淨損益</th><th>勝率</th><th>均損益</th></tr></thead><tbody>${Object.entries(bySymbol).sort((a,b)=>b[1].n-a[1].n).map(([s,v])=>`<tr><td title="${esc(v.name)}">${esc(s)}</td><td>${v.c}</td><td class="${v.n>=0?'tg':'tr'}">${fm(v.n)}</td><td>${(v.w/v.c*100).toFixed(1)}%</td><td class="${v.n/v.c>=0?'tg':'tr'}">${fm(v.n/v.c)}</td></tr>`).join('')}</tbody></table></div>`:''}
  ${reviewed.length?`<div class="j-stats-section"><h4>覆盤評分分析</h4><div class="j-rv-analysis"><div class="j-rv-avg"><span>平均紀律 <strong>${avgDisc.toFixed(1)}</strong>/5</span><span>平均時機 <strong>${avgTim.toFixed(1)}</strong>/5</span><span>平均倉位 <strong>${avgSiz.toFixed(1)}</strong>/5</span></div>${highDisc.length&&lowDisc.length?`<div class="j-rv-compare"><div class="j-rv-cmp-item"><span class="j-rv-cmp-label">高紀律 (4-5分) 平均損益</span><span class="${highDiscPL>=0?'tg':'tr'}">${fm(highDiscPL)}</span><span class="j-stat-sub">${highDisc.length}筆</span></div><div class="j-rv-cmp-item"><span class="j-rv-cmp-label">低紀律 (1-2分) 平均損益</span><span class="${lowDiscPL>=0?'tg':'tr'}">${fm(lowDiscPL)}</span><span class="j-stat-sub">${lowDisc.length}筆</span></div></div>`:''}</div></div>`:''}
  ${afterLossCount>0?`<div class="j-stats-section"><h4>虧損後行為分析</h4><div class="j-revenge-analysis"><div class="j-revenge-row"><span class="j-dl">虧損後交易</span><span class="j-dv">${afterLossCount} 筆</span><span class="j-dv ${afterLossNet>=0?'tg':'tr'}">${fm(afterLossNet)}</span></div><div class="j-revenge-row"><span class="j-dl">疑似報復性交易</span><span class="j-dv ${revengeTrades>0?'tr':''}">${revengeTrades} 筆</span><span class="j-dv ${revengeNet>=0?'tg':'tr'}">${fm(revengeNet)}</span></div>${revengeTrades>0?`<div class="j-revenge-warn">⚠ 偵測到 ${revengeTrades} 筆在虧損後 2 小時內的交易，平均損益 ${fm(revengeTrades?revengeNet/revengeTrades:0)}</div>`:`<div class="j-revenge-ok">✓ 未偵測到明顯的報復性交易行為</div>`}</div></div>`:''}
  ${rollingData.length>=5?`<div class="j-stats-section"><h4>滾動績效趨勢 (近30筆)</h4>${renderRollingChart(rollingData)}</div>`:''}
  ${renderMonthlyBarChart(st.byM)}
  ${renderPLDistribution(pls)}`;
}

function renderStats() {
  const body=$('#j-body');if(!body)return;
  const allPls=getFilteredTrades().filter(t=>t.status==='closed').map(t=>({...t,pl:calcPL(t)})).filter(t=>t.pl);
  if(!allPls.length){body.innerHTML='<div class="j-empty"><p>尚無已平倉交易可供統計</p></div>';return;}

  // Determine active markets
  const markets=[...new Set(allPls.map(t=>t.market))].filter(m=>MKT_CURRENCY[m]);
  const ML_FULL={tw:'台股 (NT$)',us:'美股 (US$)',crypto:'加密貨幣 (USDT)'};

  // Tab bar
  const showTabs = markets.length > 1;
  let tabBar = '';
  if (showTabs) {
    tabBar = `<div class="j-stats-tabs">
      <button class="j-stats-tab ${statsMarketTab==='overview'?'active':''}" data-stab="overview">全部概覽</button>
      ${markets.map(m=>`<button class="j-stats-tab ${statsMarketTab===m?'active':''}" data-stab="${m}">${ML_FULL[m]||m}</button>`).join('')}
    </div>`;
  } else if (markets.length === 1) {
    // Only one market — force that market's stats
    statsMarketTab = markets[0];
  }

  let content = '';
  if (statsMarketTab === 'overview' && showTabs) {
    // Overview: per-market summary cards side by side
    content = `<div class="j-stats-overview">
      ${markets.map(m => {
        const mPls = allPls.filter(t => t.market === m);
        if (!mPls.length) return '';
        const st = computeStats(mPls);
        const fm = (n) => fmtMoney(n, m);
        return `<div class="j-stats-mkt-card">
          <h4><span class="j-badge j-badge-${m}">${ML_FULL[m]}</span></h4>
          <div class="j-stats-mini-grid">
            <div class="j-stat-card j-stat-main"><div class="j-stat-label">淨損益</div><div class="j-stat-value ${st.tn>=0?'tg':'tr'}">${fm(st.tn)}</div></div>
            <div class="j-stat-card"><div class="j-stat-label">交易次數</div><div class="j-stat-value">${st.count}</div></div>
            <div class="j-stat-card"><div class="j-stat-label">勝率</div><div class="j-stat-value ${parseFloat(st.wr)>=50?'tg':'tr'}">${st.wr}%</div><div class="j-stat-sub">${st.w.length}勝/${st.l.length}負</div></div>
            <div class="j-stat-card"><div class="j-stat-label">獲利因子</div><div class="j-stat-value">${st.pf===Infinity?'∞':st.pf.toFixed(2)}</div></div>
            <div class="j-stat-card"><div class="j-stat-label">期望值</div><div class="j-stat-value ${st.expectancy>=0?'tg':'tr'}">${fm(st.expectancy)}</div></div>
            <div class="j-stat-card"><div class="j-stat-label">最大回撤</div><div class="j-stat-value tr">${fm(st.maxDD)}</div></div>
            <div class="j-stat-card"><div class="j-stat-label">平均獲利</div><div class="j-stat-value tg">${fm(st.aw)}</div></div>
            <div class="j-stat-card"><div class="j-stat-label">平均虧損</div><div class="j-stat-value tr">${fm(st.al)}</div></div>
            <div class="j-stat-card"><div class="j-stat-label">手續費+稅</div><div class="j-stat-value ty">${fm(st.tf+st.tt)}</div></div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="j-stats-section"><p class="j-stat-sub" style="text-align:center;margin:12px 0">切換上方分頁查看各市場完整統計</p></div>`;
  } else {
    // Single market view
    const mkt = statsMarketTab;
    const mPls = showTabs ? allPls.filter(t => t.market === mkt) : allPls;
    if (!mPls.length) {
      content = '<div class="j-empty"><p>此市場無已平倉交易</p></div>';
    } else {
      const st = computeStats(mPls);
      content = renderStatsHTML(st, mkt);
    }
  }

  body.innerHTML = `<div class="j-stats">${tabBar}${content}</div>`;

  // Bind tab clicks
  $$('.j-stats-tab', body).forEach(btn => btn.addEventListener('click', () => {
    statsMarketTab = btn.dataset.stab;
    renderStats();
  }));
}

// ================================================================
//  Trade Form Modal
// ================================================================
function openTradeForm(id, prefill) {
  editingId = id;
  const t = id ? trades.find(x => x.id === id) : (prefill || newTrade());
  if (!t) return;

  // Always use global modal on document.body to avoid z-index / hidden tab issues
  let overlay = $('#j-global-modal-overlay') || (() => { const o = document.createElement('div'); o.id='j-global-modal-overlay'; o.className='j-modal-overlay'; document.body.appendChild(o); return o; })();
  let modal = $('#j-global-modal') || (() => { const m = document.createElement('div'); m.id='j-global-modal'; m.className='j-modal'; document.body.appendChild(m); return m; })();

  modal.innerHTML = `
    <div class="j-modal-header"><h3>${id ? '編輯交易' : '新增交易'}</h3><button class="j-modal-close" id="jf-close">&times;</button></div>
    <div class="j-modal-body">
      <div class="j-form-grid">
        <div class="j-fg j-fg-wide"><label>日期時間</label>
          <div class="j-dt-picker" id="jf-dt-picker">
            <button type="button" class="j-dt-display" id="jf-dt-btn">${t.date ? fmtDateTime(t.date) : '選擇日期時間'}</button>
            <input type="hidden" id="jf-date" value="${t.date}">
            <div class="j-dt-dropdown" id="jf-dt-drop">
              <div class="j-dt-cal-header">
                <button type="button" class="j-dt-nav" id="jf-dt-prev">&lsaquo;</button>
                <span id="jf-dt-month-label"></span>
                <button type="button" class="j-dt-nav" id="jf-dt-next">&rsaquo;</button>
              </div>
              <div class="j-dt-weekdays"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
              <div class="j-dt-days" id="jf-dt-days"></div>
              <div class="j-dt-time-row">
                <label>時間</label>
                <select id="jf-dt-hour">${Array.from({length:24},(_,i)=>`<option value="${i}">${String(i).padStart(2,'0')}</option>`).join('')}</select>
                <span>:</span>
                <select id="jf-dt-min">${Array.from({length:60},(_,i)=>`<option value="${i}">${String(i).padStart(2,'0')}</option>`).join('')}</select>
              </div>
              <div class="j-dt-actions">
                <button type="button" class="j-dt-now" id="jf-dt-now">現在</button>
                <button type="button" class="j-dt-ok" id="jf-dt-ok">確定</button>
              </div>
            </div>
          </div>
        </div>
        <div class="j-fg"><label>市場</label><select id="jf-market2"><option value="tw" ${t.market==='tw'?'selected':''}>台灣</option><option value="us" ${t.market==='us'?'selected':''}>美國</option><option value="crypto" ${t.market==='crypto'?'selected':''}>加密貨幣</option></select></div>
        <div class="j-fg"><label>商品類型</label><select id="jf-type2">
          <option value="stock" ${t.type==='stock'?'selected':''}>股票/現貨</option>
          <option value="index_futures" ${t.type==='index_futures'||(t.type==='futures'&&t.market!=='crypto')?'selected':''}>指數期貨</option>
          <option value="stock_futures" ${t.type==='stock_futures'?'selected':''}>個股期貨</option>
          <option value="commodity_futures" ${t.type==='commodity_futures'?'selected':''}>原物料期貨</option>
          <option value="crypto_contract" ${t.type==='crypto_contract'||(t.type==='futures'&&t.market==='crypto')?'selected':''}>加密貨幣合約</option>
          <option value="crypto_spot" ${t.type==='crypto_spot'?'selected':''}>加密貨幣現貨</option>
          <option value="options" ${t.type==='options'?'selected':''}>選擇權</option>
          <option value="etf" ${t.type==='etf'?'selected':''}>ETF</option>
        </select></div>
        <div class="j-fg"><label>代號</label><div id="jf-sym-wrap" data-init="${esc(t.symbol)}"></div></div>
        <div class="j-fg"><label>名稱</label><input type="text" id="jf-name" value="${esc(t.name)}" placeholder="例：台積電"></div>
        <div class="j-fg"><label>方向</label><select id="jf-dir"><option value="long" ${t.direction==='long'?'selected':''}>做多 (Buy)</option><option value="short" ${t.direction==='short'?'selected':''}>做空 (Sell)</option></select></div>
        <div class="j-fg"><label>狀態</label><select id="jf-status"><option value="open" ${t.status==='open'?'selected':''}>持倉中</option><option value="closed" ${t.status==='closed'?'selected':''}>已平倉</option></select></div>
        <div class="j-fg"><label>進場價格</label><input type="number" id="jf-entry" step="any" value="${t.entryPrice||''}" placeholder="0"></div>
        <div class="j-fg"><label>出場價格</label><input type="number" id="jf-exit" step="any" value="${t.exitPrice||''}" placeholder="未平倉可留空"></div>
        <div class="j-fg"><label>數量 <span class="j-fg-hint">(股數/張數/口數)</span></label><input type="number" id="jf-qty" step="any" value="${t.quantity||''}" placeholder="0"></div>
        <div class="j-fg ${isFuturesType(t.type)||t.type==='options'?'':'j-hidden'}" id="jf-mul-wrap"><label>合約乘數</label><input type="number" id="jf-mul" step="any" value="${t.contractMul||''}" placeholder="例：200 (大台)"></div>
        <div class="j-fg"><label>停損價</label><input type="number" id="jf-sl" step="any" value="${t.stopLoss||''}" placeholder="可選"></div>
        <div class="j-fg"><label>停利價</label><input type="number" id="jf-tp" step="any" value="${t.takeProfit||''}" placeholder="可選"></div>
        <div class="j-fg"><label>手續費</label><div class="j-fee-input-wrap"><input type="number" id="jf-fee" step="any" value="${t.fee||''}" placeholder="0"><button type="button" class="j-fee-mode-btn" id="jf-fee-mode" data-mode="fixed">元</button></div></div>
        <div class="j-fg"><label>交易稅</label><div class="j-fee-input-wrap"><input type="number" id="jf-tax" step="any" value="${t.tax||''}" placeholder="0"><button type="button" class="j-fee-mode-btn" id="jf-tax-mode" data-mode="fixed">元</button></div></div>
        <div class="j-fg"><label>帳戶</label><input type="text" id="jf-account" value="${esc(t.account||'')}" placeholder="例：元大、IB" list="jf-acct-list"><datalist id="jf-acct-list">${[...new Set(trades.map(x=>x.account).filter(Boolean))].map(a=>`<option value="${esc(a)}">`).join('')}</datalist></div>
        <div class="j-fg"><label>截圖網址</label><input type="url" id="jf-image-url" value="${esc(t.imageUrl||'')}" placeholder="貼上圖片連結 (可選)"></div>
        <div class="j-fg"><label>自評 (1-5)</label><div class="j-rating-picker" id="jf-rating">${[1,2,3,4,5].map(i=>`<span class="j-star ${i<=(t.rating||0)?'j-star-on':''}" data-rate="${i}" style="cursor:pointer;font-size:1.2rem">${i<=(t.rating||0)?'★':'☆'}</span>`).join('')}</div><input type="hidden" id="jf-rating-val" value="${t.rating||0}"></div>
      </div>
      <div class="j-review-section">
        <label class="j-review-title">交易覆盤評分</label>
        <div class="j-review-scores">
          <div class="j-review-item"><span class="j-review-label">紀律</span><div class="j-review-picker" data-field="discipline">${[1,2,3,4,5].map(i=>`<button type="button" class="j-rv-dot ${i<=(t.reviewDiscipline||0)?'active':''}" data-val="${i}">${i}</button>`).join('')}</div><input type="hidden" id="jf-rv-discipline" value="${t.reviewDiscipline||0}"></div>
          <div class="j-review-item"><span class="j-review-label">時機</span><div class="j-review-picker" data-field="timing">${[1,2,3,4,5].map(i=>`<button type="button" class="j-rv-dot ${i<=(t.reviewTiming||0)?'active':''}" data-val="${i}">${i}</button>`).join('')}</div><input type="hidden" id="jf-rv-timing" value="${t.reviewTiming||0}"></div>
          <div class="j-review-item"><span class="j-review-label">倉位</span><div class="j-review-picker" data-field="sizing">${[1,2,3,4,5].map(i=>`<button type="button" class="j-rv-dot ${i<=(t.reviewSizing||0)?'active':''}" data-val="${i}">${i}</button>`).join('')}</div><input type="hidden" id="jf-rv-sizing" value="${t.reviewSizing||0}"></div>
        </div>
      </div>
      ${getChecklistItems().length ? `<div class="j-checklist-section">
        <label class="j-review-title">交易前檢查清單</label>
        <div class="j-checklist-items" id="jf-checklist">${getChecklistItems().map((item,i)=>`<label class="j-checklist-item"><input type="checkbox" data-cl="${i}"><span>${esc(item)}</span></label>`).join('')}</div>
      </div>` : ''}
      ${getTemplates().length ? `<div class="j-fg j-fg-wide" style="margin-top:6px"><label>套用模板</label><div class="j-tpl-row">${getTemplates().map(tpl => `<button type="button" class="j-tag-btn j-tpl-btn" data-tpl="${esc(tpl.name)}">${esc(tpl.name)}</button>`).join('')}</div></div>` : ''}
      <div class="j-fg j-fg-wide" style="margin-top:10px"><label>標籤</label>
        <div class="j-tag-picker" id="jf-tags">${TAG_PRESETS.map(tag=>`<button type="button" class="j-tag-btn ${(t.tags||[]).includes(tag)?'active':''}" data-tag="${tag}">${tag}</button>`).join('')}${(t.tags||[]).filter(tag=>!TAG_PRESETS.includes(tag)).map(tag=>`<button type="button" class="j-tag-btn active" data-tag="${tag}">${tag}</button>`).join('')}</div>
        <input type="text" id="jf-custom-tag" placeholder="自訂標籤，按 Enter 新增" class="j-custom-tag-input">
      </div>
      <div class="j-fg j-fg-wide" style="margin-top:10px"><label>策略筆記</label><textarea id="jf-notes" rows="4" placeholder="進出場理由、觀察、檢討...">${t.notes||''}</textarea></div>
      <div class="j-form-pl" id="jf-pl-preview"></div>
    </div>
    <div class="j-modal-footer">
      <button class="j-btn-cancel" id="jf-save-tpl" style="font-size:.76rem;padding:6px 10px" title="儲存為模板">儲存模板</button>
      <span style="flex:1"></span>
      <button class="j-btn-cancel" id="jf-cancel">取消</button>
      <button class="j-btn-save" id="jf-save">${id?'儲存修改':'新增紀錄'}</button>
    </div>
  `;

  overlay.classList.add('open'); modal.classList.add('open');

  // ── DateTime picker logic ──
  {
    const dtBtn = $('#jf-dt-btn'), dtDrop = $('#jf-dt-drop'), dtHidden = $('#jf-date');
    const dtHour = $('#jf-dt-hour'), dtMin = $('#jf-dt-min');
    const dtDays = $('#jf-dt-days'), dtLabel = $('#jf-dt-month-label');
    let dtOpen = false, calYear, calMonth, selDay;

    // Parse initial value
    const initDate = t.date ? new Date(t.date) : new Date();
    calYear = initDate.getFullYear(); calMonth = initDate.getMonth(); selDay = initDate.getDate();
    let selMonth = calMonth, selYear = calYear;
    dtHour.value = initDate.getHours(); dtMin.value = initDate.getMinutes();

    function renderCal() {
      dtLabel.textContent = `${calYear} 年 ${calMonth + 1} 月`;
      const first = new Date(calYear, calMonth, 1).getDay();
      const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
      const today = new Date();
      let html = '';
      for (let i = 0; i < first; i++) html += '<span class="j-dt-day j-dt-empty"></span>';
      for (let d = 1; d <= daysInMonth; d++) {
        const isToday = d === today.getDate() && calMonth === today.getMonth() && calYear === today.getFullYear();
        const isSel = d === selDay && calMonth === selMonth && calYear === selYear;
        html += `<button type="button" class="j-dt-day${isToday ? ' j-dt-today' : ''}${isSel ? ' j-dt-sel' : ''}" data-day="${d}">${d}</button>`;
      }
      dtDays.innerHTML = html;
      $$('.j-dt-day[data-day]', dtDays).forEach(b => b.addEventListener('click', () => {
        selDay = parseInt(b.dataset.day); selMonth = calMonth; selYear = calYear;
        $$('.j-dt-day', dtDays).forEach(x => x.classList.remove('j-dt-sel'));
        b.classList.add('j-dt-sel');
      }));
    }

    function applyDt() {
      const val = `${selYear}-${String(selMonth+1).padStart(2,'0')}-${String(selDay).padStart(2,'0')}T${String(dtHour.value).padStart(2,'0')}:${String(dtMin.value).padStart(2,'0')}`;
      dtHidden.value = val;
      dtBtn.textContent = `${selYear}/${String(selMonth+1).padStart(2,'0')}/${String(selDay).padStart(2,'0')} ${String(dtHour.value).padStart(2,'0')}:${String(dtMin.value).padStart(2,'0')}`;
    }

    function closeDt() { dtOpen = false; dtDrop.classList.remove('open'); }

    dtBtn.addEventListener('click', () => {
      dtOpen = !dtOpen;
      dtDrop.classList.toggle('open', dtOpen);
      if (dtOpen) renderCal();
    });
    // Close on click outside
    modal.addEventListener('click', (e) => { if (dtOpen && !e.target.closest('#jf-dt-picker')) closeDt(); });
    $('#jf-dt-prev').addEventListener('click', () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCal(); });
    $('#jf-dt-next').addEventListener('click', () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCal(); });
    $('#jf-dt-now').addEventListener('click', () => {
      const now = new Date();
      calYear = now.getFullYear(); calMonth = now.getMonth(); selDay = now.getDate();
      selMonth = calMonth; selYear = calYear;
      dtHour.value = now.getHours(); dtMin.value = now.getMinutes();
      renderCal(); applyDt();
    });
    $('#jf-dt-ok').addEventListener('click', () => { applyDt(); closeDt(); });

    // Init display
    applyDt();
  }

  // ── Smart fee/tax auto-fill ──
  function updateSmartFees() {
    const market = $('#jf-market2')?.value || 'tw';
    const type = $('#jf-type2')?.value || 'stock';
    const entry = $('#jf-entry')?.value || '';
    const qty = $('#jf-qty')?.value || '';
    const mul = $('#jf-mul')?.value || '';
    const fees = calcSmartFees(market, type, entry, qty, mul);
    // Smart fill always produces fixed amounts, reset mode to fixed
    if (fees.fee && $('#jf-fee')) { $('#jf-fee').value = fees.fee; const b = $('#jf-fee-mode'); if (b) { b.dataset.mode = 'fixed'; b.textContent = '元'; } }
    if (fees.tax && $('#jf-tax')) { $('#jf-tax').value = fees.tax; const b = $('#jf-tax-mode'); if (b) { b.dataset.mode = 'fixed'; b.textContent = '元'; } }
    $('#jf-fee')?.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ── Symbol field: dropdown vs autocomplete ──
  const DROPDOWN_TYPES = ['index_futures', 'commodity_futures', 'crypto_contract'];

  function getDropdownItems(market, type) {
    if (type === 'index_futures') {
      const fp = (typeof FP !== 'undefined') ? FP : (window.FP || {});
      const pool = fp[market] || {};
      return Object.entries(pool).filter(([k]) => k !== 'STK').map(([k, v]) => ({ code: k, name: v.name, mul: String(v.mul) }));
    }
    if (type === 'commodity_futures') {
      const comms = (typeof COMMODITY_FUTURES !== 'undefined') ? COMMODITY_FUTURES : (window.COMMODITY_FUTURES || []);
      return comms.map(c => ({ code: c.code, name: c.name, mul: String(c.mul) }));
    }
    if (type === 'crypto_contract') {
      const pairs = (typeof CRYPTO_PAIRS !== 'undefined') ? CRYPTO_PAIRS : (window.CRYPTO_PAIRS || []);
      return pairs.map(p => ({ code: p.symbol, name: `${p.name} (${p.base}/${p.quote})`, mul: '' }));
    }
    return [];
  }

  function buildSymbolField() {
    const wrap = $('#jf-sym-wrap'); if (!wrap) return;
    const market = $('#jf-market2')?.value || 'tw';
    const type = $('#jf-type2')?.value || 'stock';
    // Use existing input value, or fall back to data-init (first build)
    const curVal = $('#jf-symbol')?.value || wrap.dataset.init || '';
    delete wrap.dataset.init;

    if (DROPDOWN_TYPES.includes(type)) {
      // ── Dropdown mode ──
      const items = getDropdownItems(market, type);
      const opts = items.map(r =>
        `<option value="${esc(r.code)}" data-name="${esc(r.name)}" data-mul="${r.mul}" ${r.code === curVal ? 'selected' : ''}>${esc(r.code)} — ${esc(r.name)}${r.mul ? ' (×' + r.mul + ')' : ''}</option>`
      ).join('');
      wrap.innerHTML = `<select id="jf-symbol" class="jf-symbol-select">${items.length ? opts : '<option value="">無可用商品</option>'}</select>`;
      const sel = $('#jf-symbol');
      sel.addEventListener('change', () => {
        const opt = sel.options[sel.selectedIndex];
        if (opt) {
          const n = opt.dataset.name || '';
          const m = opt.dataset.mul || '';
          const nameInput = $('#jf-name');
          if (nameInput) nameInput.value = n.replace(/\s*\(.*\)\s*$/, '');
          if (m && $('#jf-mul')) { $('#jf-mul').value = m; $('#jf-mul-wrap')?.classList.remove('j-hidden'); }
        }
        updateSmartFees();
      });
      // Explicitly set value to ensure correct option is selected
      if (curVal && items.some(r => r.code === curVal)) sel.value = curVal;
      // Auto-fill name/mul from initial selection
      sel.dispatchEvent(new Event('change'));
    } else {
      // ── Autocomplete text input mode ──
      wrap.innerHTML = `<div class="sym-ac-wrap" style="position:relative"><input type="text" id="jf-symbol" value="${esc(curVal)}" placeholder="輸入代號或名稱搜尋" autocomplete="off"><div class="sym-ac-list" id="jf-sym-ac"></div></div>`;
      setupSymbolAutocomplete();
    }
  }

  function setupSymbolAutocomplete() {
    const symInput = $('#jf-symbol'), acList = $('#jf-sym-ac');
    if (!symInput || !acList) return;
    let acItems = [], acFocus = -1, skipBlur = false;

    function searchSymbols(query) {
      const market = $('#jf-market2')?.value || 'tw';
      const type = $('#jf-type2')?.value || 'stock';
      const q = query.trim().toUpperCase();
      if (!q) return [];
      const results = [];
      if (type === 'stock' || type === 'etf') {
        if (typeof StockDB !== 'undefined') {
          StockDB.search(market, query).forEach(r => results.push({ code: r.code, name: r.name, group: type === 'etf' ? 'ETF' : '股票', mul: '' }));
        }
      } else if (type === 'stock_futures') {
        if (typeof StockDB !== 'undefined') {
          StockDB.searchStockFutures(query).forEach(r => results.push({ code: r.code, name: r.name, group: '個股期貨', mul: String(r.mul) }));
        }
      } else if (type === 'options') {
        if (typeof StockDB !== 'undefined') {
          StockDB.search(market, query).forEach(r => results.push({ code: r.code, name: r.name, group: '選擇權標的', mul: '' }));
        }
      }
      return results.slice(0, 12);
    }

    const acSearch = debounce(() => {
      const q = symInput.value.trim();
      if (q.length < 1) { acList.classList.remove('open'); acItems = []; return; }
      acItems = searchSymbols(q);
      acFocus = -1;
      if (!acItems.length) { acList.classList.remove('open'); return; }
      acList.innerHTML = acItems.map((r, i) =>
        `<div class="sym-ac-item" data-i="${i}"><span class="sym-code">${esc(r.code)}</span><span class="sym-name">${esc(r.name)}</span><span class="sym-exch">${esc(r.group)}${r.mul ? ' ×' + r.mul : ''}</span></div>`
      ).join('');
      acList.classList.add('open');
    }, 150);

    symInput.addEventListener('input', acSearch);
    symInput.addEventListener('focus', () => { if (acItems.length > 0) acList.classList.add('open'); });
    symInput.addEventListener('blur', () => { if (!skipBlur) setTimeout(() => acList.classList.remove('open'), 150); skipBlur = false; });
    symInput.addEventListener('keydown', e => {
      if (!acList.classList.contains('open') || !acItems.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); acFocus = Math.min(acFocus + 1, acItems.length - 1); acUpdateFocus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); acFocus = Math.max(acFocus - 1, 0); acUpdateFocus(); }
      else if (e.key === 'Enter' && acFocus >= 0) { e.preventDefault(); acPick(acFocus); }
      else if (e.key === 'Escape') { acList.classList.remove('open'); }
    });
    acList.addEventListener('mousedown', e => {
      skipBlur = true;
      const item = e.target.closest('.sym-ac-item');
      if (item) acPick(parseInt(item.dataset.i));
    });
    function acUpdateFocus() {
      $$('.sym-ac-item', acList).forEach((el, i) => el.classList.toggle('focused', i === acFocus));
      const f = acList.children[acFocus];
      if (f) f.scrollIntoView({ block: 'nearest' });
    }
    function acPick(i) {
      const r = acItems[i]; if (!r) return;
      symInput.value = r.code;
      const nameInput = $('#jf-name');
      if (nameInput && r.name) nameInput.value = r.name.replace(/\s*\(.*\)\s*$/, '');
      if (r.mul && $('#jf-mul')) { $('#jf-mul').value = r.mul; $('#jf-mul-wrap')?.classList.remove('j-hidden'); }
      acList.classList.remove('open'); acItems = [];
      updateSmartFees();
    }
  }

  // Build initial symbol field
  buildSymbolField();

  $('#jf-type2').addEventListener('change',()=>{
    $('#jf-mul-wrap')?.classList.toggle('j-hidden',!isFuturesType($('#jf-type2').value) && $('#jf-type2').value !== 'options');
    buildSymbolField();
    updateSmartFees();
  });
  $('#jf-market2').addEventListener('change',()=>{
    buildSymbolField();
    updateSmartFees();
  });

  // Recalculate fees when price/qty changes
  $('#jf-entry')?.addEventListener('change', () => updateSmartFees());
  $('#jf-qty')?.addEventListener('change', () => updateSmartFees());

  // Auto-fill fees on initial load for new trades (not editing)
  if (!id) { setTimeout(updateSmartFees, 50); }

  $$('.j-tag-btn:not(.j-tpl-btn)',modal).forEach(b=>b.addEventListener('click',()=>b.classList.toggle('active')));
  $('#jf-custom-tag').addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();const v=e.target.value.trim();if(!v)return;const c=$('#jf-tags');const ex=$$('.j-tag-btn',c).find(b=>b.dataset.tag===v);if(ex){ex.classList.add('active');}else{const btn=document.createElement('button');btn.type='button';btn.className='j-tag-btn active';btn.dataset.tag=v;btn.textContent=v;btn.addEventListener('click',()=>btn.classList.toggle('active'));c.appendChild(btn);}e.target.value='';});
  // Template buttons
  $$('.j-tpl-btn', modal).forEach(b => b.addEventListener('click', () => {
    const tpl = getTemplates().find(t => t.name === b.dataset.tpl);
    if (tpl) applyTemplate(tpl);
  }));
  // Rating picker
  $$('#jf-rating .j-star', modal).forEach(s => s.addEventListener('click', () => {
    const rate = parseInt(s.dataset.rate);
    $('#jf-rating-val').value = rate;
    $$('#jf-rating .j-star', modal).forEach((st, i) => {
      st.textContent = i < rate ? '★' : '☆';
      st.classList.toggle('j-star-on', i < rate);
    });
  }));
  // Review score pickers (discipline/timing/sizing)
  $$('.j-review-picker', modal).forEach(picker => {
    const field = picker.dataset.field;
    $$('.j-rv-dot', picker).forEach(dot => dot.addEventListener('click', () => {
      const val = parseInt(dot.dataset.val);
      $(`#jf-rv-${field}`).value = val;
      $$('.j-rv-dot', picker).forEach((d, i) => d.classList.toggle('active', i < val));
    }));
  });

  const updatePV=()=>{const p=$('#jf-pl-preview');if(!p)return;const en=parseFloat($('#jf-entry')?.value),ex=parseFloat($('#jf-exit')?.value),q=parseFloat($('#jf-qty')?.value),fe=resolveFeeVal('jf-fee','jf-fee-mode'),ta=resolveFeeVal('jf-tax','jf-tax-mode'),di=$('#jf-dir')?.value==='long'?1:-1,mu=(isFuturesType($('#jf-type2')?.value)||$('#jf-type2')?.value==='options')?(parseFloat($('#jf-mul')?.value)||1):1;if(isNaN(en)||isNaN(ex)||isNaN(q)){p.innerHTML='';return;}const g=di*(ex-en)*q*mu,n=g-fe-ta;p.innerHTML=`<div class="j-pl-box ${n>=0?'j-pl-profit':'j-pl-loss'}"><span>預估損益</span><strong>${fmtNum(n,0)}</strong><span class="j-pl-detail">毛利 ${fmtNum(g,0)} - 費用 ${fmtNum(fe+ta,0)}</span></div>`;};
  const debouncedPV = debounce(updatePV, 150);
  $$('#jf-entry,#jf-exit,#jf-qty,#jf-fee,#jf-tax,#jf-mul',modal).forEach(el=>{if(el)el.addEventListener('input',debouncedPV);});
  $('#jf-dir')?.addEventListener('change',updatePV);$('#jf-type2')?.addEventListener('change',updatePV);updatePV();
  // ── Fee/Tax mode toggle (元 ↔ %) ──
  ['jf-fee-mode', 'jf-tax-mode'].forEach(id => {
    const btn = $('#' + id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = btn.dataset.mode === 'fixed' ? 'pct' : 'fixed';
      btn.dataset.mode = next;
      btn.textContent = next === 'fixed' ? '元' : '%';
      debouncedPV();
    });
  });

  // Save template
  $('#jf-save-tpl')?.addEventListener('click', () => {
    const name = prompt('模板名稱：');
    if (!name?.trim()) return;
    saveTemplate(name.trim());
    alert(`模板「${name.trim()}」已儲存`);
  });

  const closeModal=()=>{overlay.classList.remove('open');modal.classList.remove('open');editingId=null;document.removeEventListener('keydown',escHandler);};
  const escHandler=(e)=>{if(e.key==='Escape')closeModal();};
  document.addEventListener('keydown',escHandler);
  $('#jf-close').addEventListener('click',closeModal);overlay.addEventListener('click',(e)=>{if(e.target===overlay)closeModal();});$('#jf-cancel').addEventListener('click',closeModal);
  $('#jf-save').addEventListener('click',async(e)=>{
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '儲存中...';
    try {
      const goToJournal = !id;
      await saveTrade();
      closeModal();
      if (goToJournal && !$('#tab-journal')?.classList.contains('active')) {
        showSavedToast();
      }
    } catch(err) {
      console.error('Save trade error:', err);
      alert('儲存失敗：' + err.message);
      btn.disabled = false; btn.textContent = id ? '儲存修改' : '新增紀錄';
    }
  });
}

function showSavedToast() {
  const toast = document.createElement('div');
  toast.className = 'j-toast';
  toast.innerHTML = `<span>交易已記錄</span><button class="j-toast-btn" id="j-toast-go">前往交易紀錄寫心得 →</button>`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  const goBtn = toast.querySelector('#j-toast-go');
  goBtn?.addEventListener('click', () => {
    toast.remove();
    // Switch to journal tab
    $$('.main-tab').forEach(x => x.classList.remove('active'));
    const jTab = $$('.main-tab').find(x => x.dataset.tab === 'journal');
    if (jTab) jTab.classList.add('active');
    $$('.tab-content').forEach(x => x.classList.remove('active'));
    $('#tab-journal')?.classList.add('active');
    loadTrades().then(() => renderJournal());
  });
  setTimeout(() => { if (toast.parentNode) { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); } }, 6000);
}

async function saveTrade() {
  const data = {
    id: editingId || (Date.now().toString(36)+Math.random().toString(36).slice(2,7)),
    date:$('#jf-date')?.value||localISOString(),
    market:$('#jf-market2')?.value||'tw', type:$('#jf-type2')?.value||'stock',
    symbol:$('#jf-symbol')?.value.trim()||'', name:$('#jf-name')?.value.trim()||'',
    direction:$('#jf-dir')?.value||'long', status:$('#jf-status')?.value||'open',
    entryPrice:$('#jf-entry')?.value||'', exitPrice:$('#jf-exit')?.value||'',
    quantity:$('#jf-qty')?.value||'', contractMul:$('#jf-mul')?.value||'',
    stopLoss:$('#jf-sl')?.value||'', takeProfit:$('#jf-tp')?.value||'',
    fee:String(resolveFeeVal('jf-fee','jf-fee-mode')||''), tax:String(resolveFeeVal('jf-tax','jf-tax-mode')||''),
    tags:$$('.j-tag-btn.active:not(.j-tpl-btn)',$('#jf-tags')).map(b=>b.dataset.tag),
    notes:$('#jf-notes')?.value||'',
    account:$('#jf-account')?.value.trim()||'',
    imageUrl:$('#jf-image-url')?.value.trim()||'',
    rating:parseInt($('#jf-rating-val')?.value)||0,
    reviewDiscipline:parseInt($('#jf-rv-discipline')?.value)||0,
    reviewTiming:parseInt($('#jf-rv-timing')?.value)||0,
    reviewSizing:parseInt($('#jf-rv-sizing')?.value)||0,
  };
  if(editingId){await api(`/trades/${editingId}`,{method:'PUT',body:JSON.stringify(data)});const idx=trades.findIndex(t=>t.id===editingId);if(idx>=0)trades[idx]=data;}
  else{const res=await api('/trades',{method:'POST',body:JSON.stringify(data)});data.id=res.id;trades.unshift(data);}
  if($('#tab-journal')?.classList.contains('active'))renderJournal();
}

// ================================================================
//  Trade Detail Modal
// ================================================================
function openTradeDetail(id) {
  const t=trades.find(x=>x.id===id);if(!t)return;
  let overlay = $('#j-global-modal-overlay') || (() => { const o = document.createElement('div'); o.id='j-global-modal-overlay'; o.className='j-modal-overlay'; document.body.appendChild(o); return o; })();
  let modal = $('#j-global-modal') || (() => { const m = document.createElement('div'); m.id='j-global-modal'; m.className='j-modal'; document.body.appendChild(m); return m; })();
  const pl=calcPL(t),ML={tw:'台灣',us:'美國',crypto:'加密貨幣'},TL=TYPE_LABELS,DL={long:'做多',short:'做空'},SL={open:'持倉中',closed:'已平倉'};
  const lq=liveQuotes[getLiveQuoteKey(t)],upl=(t.status==='open'&&lq&&lq.price)?calcUnrealizedPL(t,lq.price):null;
  const en=parseFloat(t.entryPrice),sl=parseFloat(t.stopLoss),tp=parseFloat(t.takeProfit);
  const rp=(!isNaN(en)&&!isNaN(sl)&&en)?((Math.abs(en-sl)/en)*100).toFixed(2):null;
  const rwp=(!isNaN(en)&&!isNaN(tp)&&en)?((Math.abs(tp-en)/en)*100).toFixed(2):null;
  const rr=rp&&rwp&&parseFloat(rp)>0?(parseFloat(rwp)/parseFloat(rp)).toFixed(2):null;
  modal.innerHTML=`<div class="j-modal-header"><h3><span class="j-badge j-badge-${t.market}">${ML[t.market]}</span> <strong>${esc(t.symbol)}</strong> ${esc(t.name)}</h3><button class="j-modal-close" id="jd-close">&times;</button></div>
  <div class="j-modal-body"><div class="j-detail-grid">
    <div class="j-detail-item"><span class="j-dl">日期</span><span class="j-dv">${fmtDateTime(t.date)}</span></div>
    <div class="j-detail-item"><span class="j-dl">類型</span><span class="j-dv">${TL[t.type]}</span></div>
    <div class="j-detail-item"><span class="j-dl">方向</span><span class="j-dv j-dir-${t.direction}">${DL[t.direction]}</span></div>
    <div class="j-detail-item"><span class="j-dl">狀態</span><span class="j-dv"><span class="j-status j-status-${t.status}">${SL[t.status]}</span></span></div>
    <div class="j-detail-item"><span class="j-dl">進場價</span><span class="j-dv">${fmtPrice(en, t.market, t.type)}</span></div>
    <div class="j-detail-item"><span class="j-dl">出場價</span><span class="j-dv">${t.exitPrice?fmtPrice(parseFloat(t.exitPrice), t.market, t.type):'—'}</span></div>
    <div class="j-detail-item"><span class="j-dl">數量</span><span class="j-dv">${t.quantity||'—'}</span></div>
    ${(isFuturesType(t.type)||t.type==='options')&&t.contractMul?`<div class="j-detail-item"><span class="j-dl">合約乘數</span><span class="j-dv">${t.contractMul}</span></div>`:''}
    ${t.stopLoss?`<div class="j-detail-item"><span class="j-dl">停損</span><span class="j-dv">${fmtPrice(sl, t.market, t.type)}${rp?` <span class="tr">(${rp}%)</span>`:''}</span></div>`:''}
    ${t.takeProfit?`<div class="j-detail-item"><span class="j-dl">停利</span><span class="j-dv">${fmtPrice(tp, t.market, t.type)}${rwp?` <span class="tg">(${rwp}%)</span>`:''}</span></div>`:''}
    ${rr?`<div class="j-detail-item"><span class="j-dl">風報比</span><span class="j-dv ta">1:${rr}</span></div>`:''}
    ${t.fee?`<div class="j-detail-item"><span class="j-dl">手續費</span><span class="j-dv">${fmtMoney(parseFloat(t.fee),t.market)}</span></div>`:''}
    ${t.tax?`<div class="j-detail-item"><span class="j-dl">交易稅</span><span class="j-dv">${fmtMoney(parseFloat(t.tax),t.market)}</span></div>`:''}
  </div>
  ${pl?`<div class="j-pl-box ${pl.net>=0?'j-pl-profit':'j-pl-loss'} j-pl-detail-box"><div class="j-pl-row"><span>毛損益</span><strong>${fmtMoney(pl.gross,t.market)}</strong></div><div class="j-pl-row"><span>手續費+稅</span><span>-${fmtMoney(pl.fee+pl.tax,t.market)}</span></div><div class="j-pl-row j-pl-total"><span>淨損益</span><strong>${fmtMoney(pl.net,t.market)}</strong></div></div>`:''}
  ${upl?`<div class="j-pl-box ${upl.net>=0?'j-pl-profit':'j-pl-loss'} j-pl-detail-box"><div class="j-pl-row"><span>目前價格</span><strong>${fmtPrice(upl.currentPrice, t.market, t.type)}</strong></div><div class="j-pl-row"><span>未實現毛損益</span><strong>${fmtMoney(upl.gross,t.market)}</strong></div><div class="j-pl-row"><span>手續費+稅</span><span>-${fmtMoney((parseFloat(t.fee)||0)+(parseFloat(t.tax)||0),t.market)}</span></div><div class="j-pl-row j-pl-total"><span>未實現淨損益</span><strong>${fmtMoney(upl.net,t.market)}</strong></div></div>`:''}
  ${(t.tags||[]).length?`<div class="j-detail-tags">${t.tags.map(tag=>`<span class="j-tag">${esc(tag)}</span>`).join('')}</div>`:''}
  ${t.account?`<div class="j-detail-item" style="grid-column:1/-1"><span class="j-dl">帳戶</span><span class="j-dv">${esc(t.account)}</span></div>`:''}
  ${t.rating?`<div class="j-detail-item"><span class="j-dl">自評</span><span class="j-dv">${ratingHTML(t.rating)}</span></div>`:''}
  ${(t.reviewDiscipline||t.reviewTiming||t.reviewSizing)?`<div class="j-detail-review" style="grid-column:1/-1"><span class="j-dl">覆盤評分</span><div class="j-detail-rv-scores"><span>紀律 <strong>${t.reviewDiscipline||0}</strong>/5</span><span>時機 <strong>${t.reviewTiming||0}</strong>/5</span><span>倉位 <strong>${t.reviewSizing||0}</strong>/5</span></div></div>`:''}
  ${t.notes?`<div class="j-detail-notes"><h4>策略筆記</h4><div class="j-notes-content" style="white-space:pre-wrap">${esc(t.notes)}</div></div>`:''}
  ${t.imageUrl && /^https?:\/\//.test(t.imageUrl)?`<div class="j-detail-notes"><h4>交易截圖</h4><img src="${esc(t.imageUrl)}" class="j-detail-img" alt="交易截圖" loading="lazy" onerror="this.style.display='none'"></div>`:''}
  </div><div class="j-modal-footer">${t.status==='open'?`<button class="j-btn-cancel j-detail-close-btn" id="jd-quick-close" style="color:var(--red);border-color:var(--red)">快速平倉</button>`:''}<button class="j-btn-cancel" id="jd-calc" title="在計算器中開啟">計算器</button><button class="j-btn-cancel" id="jd-dup" title="複製為新交易">複製</button><span style="flex:1"></span><button class="j-btn-cancel" id="jd-back">關閉</button><button class="j-btn-save" id="jd-edit">編輯</button></div>`;
  overlay.classList.add('open');modal.classList.add('open');
  const cl=()=>{overlay.classList.remove('open');modal.classList.remove('open');};
  $('#jd-close').addEventListener('click',cl);overlay.addEventListener('click',(e)=>{if(e.target===overlay)cl();});$('#jd-back').addEventListener('click',cl);
  $('#jd-edit').addEventListener('click',()=>{cl();setTimeout(()=>openTradeForm(id),100);});
  $('#jd-quick-close')?.addEventListener('click', () => { cl(); quickCloseTrade(id); });
  $('#jd-dup')?.addEventListener('click', () => { cl(); duplicateTrade(id); });
  $('#jd-calc')?.addEventListener('click', () => {
    cl();
    // Open trade in corresponding calculator tab
    if (window.PrismJournal?.openInCalc) window.PrismJournal.openInCalc(t);
    else {
      // Fallback: switch to appropriate tab
      const tabMap = { stock: 'margin', futures: 'futures', index_futures: 'futures', stock_futures: 'futures', commodity_futures: 'futures', crypto_contract: 'crypto', crypto_spot: 'crypto', options: 'options', etf: 'margin' };
      const tabName = tabMap[t.type] || 'margin';
      const tabEl = $$('.main-tab').find(x => x.dataset.tab === tabName);
      if (tabEl) { tabEl.click(); }
    }
  });
}

async function deleteTrade(id) {
  const t=trades.find(x=>x.id===id);if(!t)return;
  if(!confirm(`確定要刪除 ${t.symbol} ${t.name} 的交易紀錄嗎？`))return;
  try{await api(`/trades/${id}`,{method:'DELETE'});trades=trades.filter(x=>x.id!==id);renderJournal();}catch(e){alert('刪除失敗：'+e.message);}
}

// ================================================================
//  INIT
// ================================================================
async function initJournal() {
  // Verify token on page load
  if (authToken) {
    try {
      const data = await api('/auth/me');
      currentUser = data.user;
      localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
      // Pre-load trades so they're ready for calc tab buttons
      await loadTrades();
      loadDailyJournals();
    } catch {
      authToken = ''; currentUser = null;
      localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY);
    }
  }

  // Render header auth immediately
  renderHeaderAuth();

  // Not logged in: don't auto-popup, show login when user navigates to journal or clicks record

  // Journal tab activation
  document.addEventListener('click', async (e) => {
    const tab = e.target.closest('.main-tab');
    if (tab && tab.dataset.tab === 'journal') {
      if (authToken && currentUser) { await loadTrades(); renderJournal(); }
      else renderLogin();
    }
  });

  // Request notification permission for SL/TP alerts
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // Global keyboard shortcuts
  document.addEventListener('keydown', e => {
    // Skip if inside input/textarea/select
    if (e.target.matches('input,textarea,select')) return;
    // Skip if modal is open
    if ($('.j-modal.open')) return;

    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      if (authToken && currentUser) openTradeForm(null);
      else showLoginModal();
    }
    else if (e.key === '/' || e.key === '？') {
      e.preventDefault();
      const searchInput = $('#jf-search');
      if (searchInput) searchInput.focus();
    }
    else if (e.key >= '1' && e.key <= '5') {
      const tabs = $$('.main-tab');
      const idx = parseInt(e.key) - 1;
      if (tabs[idx]) tabs[idx].click();
    }
    else if (e.key === 'Escape') {
      // Close settings panel
      const sp = $('#settings-panel');
      if (sp?.classList.contains('open')) {
        sp.classList.remove('open');
        $('#settings-overlay')?.classList.remove('open');
      }
    }
  });
}

// Expose openInCalc for trade → calculator linkage
window.PrismJournal.openInCalc = function(t) {
  const tabMap = { stock: 'margin', futures: 'futures', index_futures: 'futures', stock_futures: 'futures', commodity_futures: 'futures', crypto_contract: 'crypto', crypto_spot: 'crypto', options: 'options', etf: 'margin' };
  const tabName = tabMap[t.type] || 'margin';

  // Switch to tab
  $$('.main-tab').forEach(x => x.classList.remove('active'));
  const tabEl = $$('.main-tab').find(x => x.dataset.tab === tabName);
  if (tabEl) tabEl.classList.add('active');
  $$('.tab-content').forEach(x => x.classList.remove('active'));
  $(`#tab-${tabName}`)?.classList.add('active');

  // Fill in values after tab switch
  setTimeout(() => {
    // Set market toggle
    const mktGroup = $(`[data-group="${tabName}-market"]`);
    if (mktGroup) {
      $$('.toggle-btn', mktGroup).forEach(b => {
        b.classList.toggle('active', b.dataset.value === t.market);
      });
    }
    // Set direction toggle
    const dirGroup = $(`[data-group="${tabName}-direction"]`);
    if (dirGroup) {
      const dirVal = t.direction === 'short' ? 'short' : (tabName === 'margin' ? 'cash' : 'long');
      $$('.toggle-btn', dirGroup).forEach(b => {
        b.classList.toggle('active', b.dataset.value === dirVal);
      });
    }

    if (tabName === 'margin') {
      const symInput = document.getElementById('m-symbol');
      if (symInput) { symInput.value = t.symbol; symInput.dispatchEvent(new Event('input')); }
      const qtyInput = document.getElementById('m-qty');
      if (qtyInput && t.quantity) qtyInput.value = t.market === 'tw' ? Math.round(parseFloat(t.quantity) / 1000) : t.quantity;
      const bpInput = document.getElementById(t.direction === 'short' ? 'm-sell-price' : 'm-buy-price');
      if (bpInput && t.entryPrice) bpInput.value = t.entryPrice;
      const cpInput = document.getElementById('m-current-price');
      if (cpInput && t.exitPrice) cpInput.value = t.exitPrice;
    } else if (tabName === 'futures') {
      const entryInput = document.getElementById('f-entry');
      if (entryInput && t.entryPrice) entryInput.value = t.entryPrice;
      const qtyInput = document.getElementById('f-qty');
      if (qtyInput && t.quantity) qtyInput.value = t.quantity;
      const mulInput = document.getElementById('f-mul');
      if (mulInput && t.contractMul) mulInput.value = t.contractMul;
    } else if (tabName === 'options') {
      const premInput = document.getElementById('o-premium');
      if (premInput && t.entryPrice) premInput.value = t.entryPrice;
      const qtyInput = document.getElementById('o-qty');
      if (qtyInput && t.quantity) qtyInput.value = t.quantity;
      const mulInput = document.getElementById('o-mul');
      if (mulInput && t.contractMul) mulInput.value = t.contractMul;
    }
  }, 100);
};

document.addEventListener('DOMContentLoaded', initJournal);
})();
