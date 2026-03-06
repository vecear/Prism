/* ================================================================
   Prism — Trade Journal (交易紀錄)
   Cloudflare D1 backend + JWT auth
   - Header login on page load
   - "Record Trade" buttons in calculator tabs
   - Navigate to journal for notes
   ================================================================ */
(() => {
'use strict';

const API = '/api';
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
let filterState = { market: 'all', type: 'all', tag: 'all', search: '', dateFrom: '', dateTo: '' };
let sortState = { field: 'date', asc: false };
let viewMode = 'list';

// ── API helpers ──
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadTrades() {
  try { const data = await api('/trades'); trades = data.trades || []; }
  catch { trades = []; }
}

// ── Format helpers ──
function fmtNum(n, d = 0) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }); }
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

function getDefaultFees() {
  try { const s = JSON.parse(localStorage.getItem('tg-settings')) || {}; return { fee: s.defaultFee || '', tax: s.defaultTax || '' }; }
  catch { return { fee: '', tax: '' }; }
}

function newTrade() {
  const df = getDefaultFees();
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    date: new Date().toISOString().slice(0, 16),
    market: 'tw', type: 'stock', symbol: '', name: '',
    direction: 'long', entryPrice: '', exitPrice: '', quantity: '',
    stopLoss: '', takeProfit: '', fee: df.fee, tax: df.tax,
    tags: [], notes: '', status: 'open', contractMul: '',
  };
}

function calcPL(t) {
  const entry = parseFloat(t.entryPrice), exit = parseFloat(t.exitPrice), qty = parseFloat(t.quantity);
  const fee = parseFloat(t.fee) || 0, tax = parseFloat(t.tax) || 0;
  if (isNaN(entry) || isNaN(exit) || isNaN(qty)) return null;
  const mul = t.type === 'futures' ? (parseFloat(t.contractMul) || 1) : 1;
  const dir = t.direction === 'long' ? 1 : -1;
  const gross = dir * (exit - entry) * qty * mul;
  return { gross, net: gross - fee - tax, fee, tax };
}

const TAG_PRESETS = ['突破', '回測', '順勢', '逆勢', '事件', '技術面', '基本面', '短線', '波段', '當沖', '停損', '停利', '加碼', '減碼'];

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
      <button class="ha-logout" id="ha-logout" title="登出">&times;</button>
    </div>`;
    $('#ha-logout')?.addEventListener('click', handleLogout);
  } else {
    el.innerHTML = `<button class="ha-login-btn" id="ha-login-btn">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
      登入
    </button>`;
    $('#ha-login-btn')?.addEventListener('click', showLoginModal);
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
      // Load cloud settings after login
      if (window.loadSettingsFromServer) window.loadSettingsFromServer();
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
  authToken = ''; currentUser = null; trades = [];
  localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY);
  renderHeaderAuth();
  if ($('#tab-journal')?.classList.contains('active')) renderLogin();
}

// ================================================================
//  RECORD TRADE — Buttons in calculator tabs
// ================================================================

// Exposed globally so app.js calc functions can call it
window.PrismJournal = {
  isLoggedIn: () => !!(authToken && currentUser),
  showLogin: showLoginModal,

  // Collect current calculator inputs and save as trade
  recordFromCalc(tabType) {
    if (!authToken || !currentUser) { showLoginModal(); return; }

    let trade = newTrade();
    trade.status = 'open'; // default to open position

    if (tabType === 'margin') {
      const market = document.querySelector('[data-group="margin-market"] .toggle-btn.active')?.dataset.value || 'tw';
      const dir = document.querySelector('[data-group="margin-direction"] .toggle-btn.active')?.dataset.value || 'cash';
      trade.market = market;
      trade.type = 'stock';
      trade.direction = (dir === 'short') ? 'short' : 'long';
      trade.symbol = document.getElementById('m-symbol')?.value || '';
      trade.name = document.querySelector('.stock-info')?.textContent?.split('|')[0]?.trim() || '';
      trade.entryPrice = document.getElementById('m-buy-price')?.value || '';
      trade.quantity = document.getElementById('m-qty')?.value || '';
      const spu = market === 'tw' ? 1000 : 1;
      if (trade.quantity) trade.quantity = String(parseFloat(trade.quantity) * spu);
    }
    else if (tabType === 'futures') {
      const market = document.querySelector('[data-group="futures-market"] .toggle-btn.active')?.dataset.value || 'tw';
      const dir = document.querySelector('[data-group="futures-direction"] .toggle-btn.active')?.dataset.value || 'long';
      trade.market = market;
      trade.type = 'futures';
      trade.direction = dir;
      trade.entryPrice = document.getElementById('f-entry')?.value || '';
      trade.quantity = document.getElementById('f-qty')?.value || '';
      trade.contractMul = document.getElementById('f-mul')?.value || '';
      // Get contract name
      const sel = document.getElementById('f-contract');
      if (sel) { trade.symbol = sel.value; trade.name = sel.options[sel.selectedIndex]?.text || ''; }
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
    const ML = { tw: '台', us: '美' };
    const rows = matched.map(t => {
      const pl = calcPL(t);
      const plStr = pl ? (pl.net >= 0 ? '+' : '') + fmtNum(pl.net, 0) : '—';
      const plCls = pl ? (pl.net >= 0 ? 'tg' : 'tr') : '';
      return `<div class="j-mini-row"><span class="j-mini-date">${fmtDate(t.date)}</span><span class="j-mini-dir j-dir-${t.direction}">${t.direction === 'long' ? '多' : '空'}</span><span class="j-mini-price">${t.entryPrice}→${t.exitPrice || '?'}</span><span class="j-mini-pl ${plCls}">${plStr}</span></div>`;
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
      <div class="j-header-left"><span class="j-user-badge"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${currentUser?.username || ''}</span></div>
      <div class="j-header-right">
        <div class="j-view-toggle">
          <button class="j-vt-btn ${viewMode === 'list' ? 'active' : ''}" data-view="list"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>紀錄</button>
          <button class="j-vt-btn ${viewMode === 'stats' ? 'active' : ''}" data-view="stats"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>統計</button>
        </div>
        <button class="j-add-btn" id="j-add"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>新增交易</button>
      </div>
    </div>
    <div class="j-filters" id="j-filters"></div>
    <div class="j-body" id="j-body"></div>
    <div class="j-modal-overlay" id="j-modal-overlay"></div>
    <div class="j-modal" id="j-modal"></div>
  `;
  $('#j-add').addEventListener('click', () => openTradeForm(null));
  $$('.j-vt-btn').forEach(b => b.addEventListener('click', () => { viewMode = b.dataset.view; renderJournal(); }));
  renderFilters();
  if (viewMode === 'list') renderTradeList(); else renderStats();
}

// ================================================================
//  Filters
// ================================================================
function renderFilters() {
  const el = $('#j-filters'); if (!el) return;
  const allTags = [...new Set(trades.flatMap(t => t.tags || []))].sort();
  el.innerHTML = `<div class="j-filter-row">
    <div class="j-filter-group">
      <select id="jf-market" class="j-filter-select"><option value="all">全部市場</option><option value="tw" ${filterState.market==='tw'?'selected':''}>台灣</option><option value="us" ${filterState.market==='us'?'selected':''}>美國</option></select>
      <select id="jf-type" class="j-filter-select"><option value="all">全部類型</option><option value="stock" ${filterState.type==='stock'?'selected':''}>股票</option><option value="futures" ${filterState.type==='futures'?'selected':''}>期貨</option><option value="options" ${filterState.type==='options'?'selected':''}>選擇權</option><option value="etf" ${filterState.type==='etf'?'selected':''}>ETF</option></select>
      ${allTags.length?`<select id="jf-tag" class="j-filter-select"><option value="all">全部標籤</option>${allTags.map(t=>`<option value="${esc(t)}" ${filterState.tag===t?'selected':''}>${esc(t)}</option>`).join('')}</select>`:''}
    </div>
    <div class="j-filter-group"><input type="date" id="jf-from" class="j-filter-date" value="${filterState.dateFrom}"><span class="j-filter-sep">~</span><input type="date" id="jf-to" class="j-filter-date" value="${filterState.dateTo}"></div>
    <div class="j-filter-search-wrap"><input type="text" id="jf-search" class="j-filter-search" placeholder="搜尋代號/名稱/備註..." value="${filterState.search}"></div>
  </div>`;
  const update = () => {
    filterState.market=$('#jf-market')?.value||'all'; filterState.type=$('#jf-type')?.value||'all'; filterState.tag=$('#jf-tag')?.value||'all';
    filterState.dateFrom=$('#jf-from')?.value||''; filterState.dateTo=$('#jf-to')?.value||''; filterState.search=$('#jf-search')?.value||'';
    viewMode==='list'?renderTradeList():renderStats();
  };
  $$('#j-filters select,#j-filters input').forEach(e=>e.addEventListener('change',update));
  $('#jf-search')?.addEventListener('input',update);
}

function getFilteredTrades() {
  let list=[...trades]; const f=filterState;
  if(f.market!=='all') list=list.filter(t=>t.market===f.market);
  if(f.type!=='all') list=list.filter(t=>t.type===f.type);
  if(f.tag!=='all') list=list.filter(t=>(t.tags||[]).includes(f.tag));
  if(f.dateFrom) list=list.filter(t=>t.date>=f.dateFrom);
  if(f.dateTo) list=list.filter(t=>t.date<=f.dateTo+'T23:59');
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
  const ML={tw:'台灣',us:'美國'},TL={stock:'股票',futures:'期貨',options:'選擇權',etf:'ETF'},DL={long:'做多',short:'做空'},DC={long:'j-dir-long',short:'j-dir-short'},SL={open:'持倉中',closed:'已平倉'};
  const si=f=>sortState.field!==f?'<span class="j-sort-icon"></span>':`<span class="j-sort-icon active">${sortState.asc?'&#9650;':'&#9660;'}</span>`;
  const cp=filtered.filter(t=>t.status==='closed').map(t=>calcPL(t)).filter(Boolean);
  const tn=cp.reduce((s,p)=>s+p.net,0),wins=cp.filter(p=>p.net>0).length,wr=cp.length?(wins/cp.length*100).toFixed(1):0;
  let h=`<div class="j-summary-bar"><span>共 <strong>${filtered.length}</strong> 筆</span>${cp.length?`<span>已平倉損益：<strong class="${tn>=0?'tg':'tr'}">${fmtNum(tn,0)}</strong></span><span>勝率：<strong>${wr}%</strong> (${wins}/${cp.length})</span>`:''}</div>
  <div class="j-table-wrap"><table class="j-table"><thead><tr><th class="j-th-sort" data-sort="date">日期 ${si('date')}</th><th>市場</th><th>類型</th><th class="j-th-sort" data-sort="symbol">代號 ${si('symbol')}</th><th>方向</th><th>進場</th><th>出場</th><th>數量</th><th class="j-th-sort" data-sort="pl">損益 ${si('pl')}</th><th>狀態</th><th>標籤</th><th></th></tr></thead><tbody>`;
  for(const t of filtered){const pl=calcPL(t),plStr=pl?fmtNum(pl.net,0):'—',plC=pl?(pl.net>0?'tg':pl.net<0?'tr':''):'tm';
  h+=`<tr class="j-row" data-id="${t.id}"><td class="j-td-date">${fmtDate(t.date)}</td><td><span class="j-badge j-badge-${t.market}">${ML[t.market]||t.market}</span></td><td><span class="j-badge j-badge-type">${TL[t.type]||t.type}</span></td><td class="j-td-sym"><strong>${t.symbol}</strong>${t.name?`<span class="j-sym-name">${t.name}</span>`:''}</td><td><span class="${DC[t.direction]}">${DL[t.direction]}</span></td><td class="j-td-num">${fmtNum(parseFloat(t.entryPrice),2)}</td><td class="j-td-num">${t.exitPrice?fmtNum(parseFloat(t.exitPrice),2):'—'}</td><td class="j-td-num">${t.quantity||'—'}</td><td class="j-td-num ${plC}">${plStr}</td><td><span class="j-status j-status-${t.status}">${SL[t.status]}</span></td><td class="j-td-tags">${(t.tags||[]).map(tag=>`<span class="j-tag">${tag}</span>`).join('')}</td><td class="j-td-actions"><button class="j-act-btn j-act-view" data-id="${t.id}" title="檢視"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button><button class="j-act-btn j-act-edit" data-id="${t.id}" title="編輯"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="j-act-btn j-act-del" data-id="${t.id}" title="刪除"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button></td></tr>`;}
  h+='</tbody></table></div>';body.innerHTML=h;
  $$('.j-th-sort').forEach(th=>th.addEventListener('click',()=>{const f=th.dataset.sort;if(sortState.field===f)sortState.asc=!sortState.asc;else{sortState.field=f;sortState.asc=false;}renderTradeList();}));
  $$('.j-act-view').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openTradeDetail(b.dataset.id);}));
  $$('.j-act-edit').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openTradeForm(b.dataset.id);}));
  $$('.j-act-del').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();deleteTrade(b.dataset.id);}));
  $$('.j-row').forEach(r=>r.addEventListener('click',()=>openTradeDetail(r.dataset.id)));
}

// ================================================================
//  Statistics
// ================================================================
function renderStats() {
  const body=$('#j-body');if(!body)return;
  const pls=getFilteredTrades().filter(t=>t.status==='closed').map(t=>({...t,pl:calcPL(t)})).filter(t=>t.pl);
  if(!pls.length){body.innerHTML='<div class="j-empty"><p>尚無已平倉交易可供統計</p></div>';return;}
  const tn=pls.reduce((s,t)=>s+t.pl.net,0),tf=pls.reduce((s,t)=>s+t.pl.fee,0),tt=pls.reduce((s,t)=>s+t.pl.tax,0);
  const w=pls.filter(t=>t.pl.net>0),l=pls.filter(t=>t.pl.net<=0),wr=(w.length/pls.length*100).toFixed(1);
  const aw=w.length?w.reduce((s,t)=>s+t.pl.net,0)/w.length:0,al=l.length?l.reduce((s,t)=>s+t.pl.net,0)/l.length:0;
  const pf=Math.abs(al)>0?Math.abs(aw/al):Infinity;
  const mw=pls.reduce((m,t)=>Math.max(m,t.pl.net),-Infinity),ml=pls.reduce((m,t)=>Math.min(m,t.pl.net),Infinity);
  let mcw=0,mcl=0,cw=0,cl=0;[...pls].sort((a,b)=>a.date>b.date?1:-1).forEach(t=>{if(t.pl.net>0){cw++;cl=0;mcw=Math.max(mcw,cw);}else{cl++;cw=0;mcl=Math.max(mcl,cl);}});
  const byT={},byM={},byTg={};const TL={stock:'股票',futures:'期貨',options:'選擇權',etf:'ETF'};
  pls.forEach(t=>{
    if(!byT[t.type])byT[t.type]={c:0,n:0,w:0};byT[t.type].c++;byT[t.type].n+=t.pl.net;if(t.pl.net>0)byT[t.type].w++;
    const m=t.date.slice(0,7);if(!byM[m])byM[m]={c:0,n:0,w:0};byM[m].c++;byM[m].n+=t.pl.net;if(t.pl.net>0)byM[m].w++;
    (t.tags||[]).forEach(tag=>{if(!byTg[tag])byTg[tag]={c:0,n:0,w:0};byTg[tag].c++;byTg[tag].n+=t.pl.net;if(t.pl.net>0)byTg[tag].w++;});
  });
  body.innerHTML=`<div class="j-stats"><div class="j-stats-grid">
    <div class="j-stat-card j-stat-main"><div class="j-stat-label">淨損益</div><div class="j-stat-value ${tn>=0?'tg':'tr'}">${fmtNum(tn,0)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">交易次數</div><div class="j-stat-value">${pls.length}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">勝率</div><div class="j-stat-value ${parseFloat(wr)>=50?'tg':'tr'}">${wr}%</div><div class="j-stat-sub">${w.length}勝/${l.length}負</div></div>
    <div class="j-stat-card"><div class="j-stat-label">獲利因子</div><div class="j-stat-value">${pf===Infinity?'∞':pf.toFixed(2)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">平均獲利</div><div class="j-stat-value tg">${fmtNum(aw,0)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">平均虧損</div><div class="j-stat-value tr">${fmtNum(al,0)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">最大單筆獲利</div><div class="j-stat-value tg">${fmtNum(mw,0)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">最大單筆虧損</div><div class="j-stat-value tr">${fmtNum(ml,0)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">最大連勝</div><div class="j-stat-value">${mcw}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">最大連敗</div><div class="j-stat-value">${mcl}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">總手續費</div><div class="j-stat-value ty">${fmtNum(tf,0)}</div></div>
    <div class="j-stat-card"><div class="j-stat-label">總交易稅</div><div class="j-stat-value ty">${fmtNum(tt,0)}</div></div>
  </div>
  ${Object.keys(byT).length>1?`<div class="j-stats-section"><h4>依商品類型</h4><table class="j-stats-table"><thead><tr><th>類型</th><th>筆數</th><th>淨損益</th><th>勝率</th></tr></thead><tbody>${Object.entries(byT).map(([k,v])=>`<tr><td>${TL[k]||k}</td><td>${v.c}</td><td class="${v.n>=0?'tg':'tr'}">${fmtNum(v.n,0)}</td><td>${(v.w/v.c*100).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>`:''}
  ${Object.keys(byM).length?`<div class="j-stats-section"><h4>月度績效</h4><table class="j-stats-table"><thead><tr><th>月份</th><th>筆數</th><th>淨損益</th><th>勝率</th></tr></thead><tbody>${Object.entries(byM).sort((a,b)=>b[0].localeCompare(a[0])).map(([m,v])=>`<tr><td>${m}</td><td>${v.c}</td><td class="${v.n>=0?'tg':'tr'}">${fmtNum(v.n,0)}</td><td>${(v.w/v.c*100).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>`:''}
  ${Object.keys(byTg).length?`<div class="j-stats-section"><h4>依標籤</h4><table class="j-stats-table"><thead><tr><th>標籤</th><th>筆數</th><th>淨損益</th><th>勝率</th></tr></thead><tbody>${Object.entries(byTg).sort((a,b)=>b[1].n-a[1].n).map(([tag,v])=>`<tr><td><span class="j-tag">${tag}</span></td><td>${v.c}</td><td class="${v.n>=0?'tg':'tr'}">${fmtNum(v.n,0)}</td><td>${(v.w/v.c*100).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>`:''}
  </div>`;
}

// ================================================================
//  Trade Form Modal
// ================================================================
function openTradeForm(id, prefill) {
  editingId = id;
  const t = id ? trades.find(x => x.id === id) : (prefill || newTrade());
  if (!t) return;

  // Use journal tab's modal if on journal, else global modal
  let overlay = $('#j-modal-overlay') || (() => { const o = document.createElement('div'); o.id='j-global-modal-overlay'; o.className='j-modal-overlay'; document.body.appendChild(o); return o; })();
  let modal = $('#j-modal') || (() => { const m = document.createElement('div'); m.id='j-global-modal'; m.className='j-modal'; document.body.appendChild(m); return m; })();

  modal.innerHTML = `
    <div class="j-modal-header"><h3>${id ? '編輯交易' : '新增交易'}</h3><button class="j-modal-close" id="jf-close">&times;</button></div>
    <div class="j-modal-body">
      <div class="j-form-grid">
        <div class="j-fg j-fg-wide"><label>日期時間</label><input type="datetime-local" id="jf-date" value="${t.date}"></div>
        <div class="j-fg"><label>市場</label><select id="jf-market2"><option value="tw" ${t.market==='tw'?'selected':''}>台灣</option><option value="us" ${t.market==='us'?'selected':''}>美國</option></select></div>
        <div class="j-fg"><label>商品類型</label><select id="jf-type2"><option value="stock" ${t.type==='stock'?'selected':''}>股票</option><option value="futures" ${t.type==='futures'?'selected':''}>期貨</option><option value="options" ${t.type==='options'?'selected':''}>選擇權</option><option value="etf" ${t.type==='etf'?'selected':''}>ETF</option></select></div>
        <div class="j-fg"><label>代號</label><input type="text" id="jf-symbol" value="${t.symbol}" placeholder="例：2330、AAPL"></div>
        <div class="j-fg"><label>名稱</label><input type="text" id="jf-name" value="${t.name}" placeholder="例：台積電"></div>
        <div class="j-fg"><label>方向</label><select id="jf-dir"><option value="long" ${t.direction==='long'?'selected':''}>做多 (Buy)</option><option value="short" ${t.direction==='short'?'selected':''}>做空 (Sell)</option></select></div>
        <div class="j-fg"><label>狀態</label><select id="jf-status"><option value="open" ${t.status==='open'?'selected':''}>持倉中</option><option value="closed" ${t.status==='closed'?'selected':''}>已平倉</option></select></div>
        <div class="j-fg"><label>進場價格</label><input type="number" id="jf-entry" step="any" value="${t.entryPrice||''}" placeholder="0"></div>
        <div class="j-fg"><label>出場價格</label><input type="number" id="jf-exit" step="any" value="${t.exitPrice||''}" placeholder="未平倉可留空"></div>
        <div class="j-fg"><label>數量 <span class="j-fg-hint">(股數/張數/口數)</span></label><input type="number" id="jf-qty" step="any" value="${t.quantity||''}" placeholder="0"></div>
        <div class="j-fg ${t.type==='futures'||t.type==='options'?'':'j-hidden'}" id="jf-mul-wrap"><label>合約乘數</label><input type="number" id="jf-mul" step="any" value="${t.contractMul||''}" placeholder="例：200 (大台)"></div>
        <div class="j-fg"><label>停損價</label><input type="number" id="jf-sl" step="any" value="${t.stopLoss||''}" placeholder="可選"></div>
        <div class="j-fg"><label>停利價</label><input type="number" id="jf-tp" step="any" value="${t.takeProfit||''}" placeholder="可選"></div>
        <div class="j-fg"><label>手續費</label><input type="number" id="jf-fee" step="any" value="${t.fee||''}" placeholder="0"></div>
        <div class="j-fg"><label>交易稅</label><input type="number" id="jf-tax" step="any" value="${t.tax||''}" placeholder="0"></div>
      </div>
      <div class="j-fg j-fg-wide" style="margin-top:10px"><label>標籤</label>
        <div class="j-tag-picker" id="jf-tags">${TAG_PRESETS.map(tag=>`<button type="button" class="j-tag-btn ${(t.tags||[]).includes(tag)?'active':''}" data-tag="${tag}">${tag}</button>`).join('')}${(t.tags||[]).filter(tag=>!TAG_PRESETS.includes(tag)).map(tag=>`<button type="button" class="j-tag-btn active" data-tag="${tag}">${tag}</button>`).join('')}</div>
        <input type="text" id="jf-custom-tag" placeholder="自訂標籤，按 Enter 新增" class="j-custom-tag-input">
      </div>
      <div class="j-fg j-fg-wide" style="margin-top:10px"><label>策略筆記</label><textarea id="jf-notes" rows="4" placeholder="進出場理由、觀察、檢討...">${t.notes||''}</textarea></div>
      <div class="j-form-pl" id="jf-pl-preview"></div>
    </div>
    <div class="j-modal-footer">
      <button class="j-btn-cancel" id="jf-cancel">取消</button>
      <button class="j-btn-save" id="jf-save">${id?'儲存修改':'新增紀錄'}</button>
    </div>
  `;

  overlay.classList.add('open'); modal.classList.add('open');

  $('#jf-type2').addEventListener('change',()=>{$('#jf-mul-wrap')?.classList.toggle('j-hidden',!['futures','options'].includes($('#jf-type2').value));});
  $$('.j-tag-btn',modal).forEach(b=>b.addEventListener('click',()=>b.classList.toggle('active')));
  $('#jf-custom-tag').addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();const v=e.target.value.trim();if(!v)return;const c=$('#jf-tags');const ex=$$('.j-tag-btn',c).find(b=>b.dataset.tag===v);if(ex){ex.classList.add('active');}else{const btn=document.createElement('button');btn.type='button';btn.className='j-tag-btn active';btn.dataset.tag=v;btn.textContent=v;btn.addEventListener('click',()=>btn.classList.toggle('active'));c.appendChild(btn);}e.target.value='';});

  const updatePV=()=>{const p=$('#jf-pl-preview');if(!p)return;const en=parseFloat($('#jf-entry')?.value),ex=parseFloat($('#jf-exit')?.value),q=parseFloat($('#jf-qty')?.value),fe=parseFloat($('#jf-fee')?.value)||0,ta=parseFloat($('#jf-tax')?.value)||0,di=$('#jf-dir')?.value==='long'?1:-1,mu=['futures','options'].includes($('#jf-type2')?.value)?(parseFloat($('#jf-mul')?.value)||1):1;if(isNaN(en)||isNaN(ex)||isNaN(q)){p.innerHTML='';return;}const g=di*(ex-en)*q*mu,n=g-fe-ta;p.innerHTML=`<div class="j-pl-box ${n>=0?'j-pl-profit':'j-pl-loss'}"><span>預估損益</span><strong>${fmtNum(n,0)}</strong><span class="j-pl-detail">毛利 ${fmtNum(g,0)} - 費用 ${fmtNum(fe+ta,0)}</span></div>`;};
  $$('#jf-entry,#jf-exit,#jf-qty,#jf-fee,#jf-tax,#jf-mul',modal).forEach(el=>{if(el)el.addEventListener('input',updatePV);});
  $('#jf-dir')?.addEventListener('change',updatePV);$('#jf-type2')?.addEventListener('change',updatePV);updatePV();

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
    loadTrades().then(() => {
      renderJournal();
      // Open the latest trade for editing notes
      if (trades.length) {
        setTimeout(() => openTradeForm(trades[0].id), 200);
      }
    });
  });
  setTimeout(() => { if (toast.parentNode) { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); } }, 6000);
}

async function saveTrade() {
  const data = {
    id: editingId || (Date.now().toString(36)+Math.random().toString(36).slice(2,7)),
    date:$('#jf-date')?.value||new Date().toISOString().slice(0,16),
    market:$('#jf-market2')?.value||'tw', type:$('#jf-type2')?.value||'stock',
    symbol:$('#jf-symbol')?.value.trim()||'', name:$('#jf-name')?.value.trim()||'',
    direction:$('#jf-dir')?.value||'long', status:$('#jf-status')?.value||'open',
    entryPrice:$('#jf-entry')?.value||'', exitPrice:$('#jf-exit')?.value||'',
    quantity:$('#jf-qty')?.value||'', contractMul:$('#jf-mul')?.value||'',
    stopLoss:$('#jf-sl')?.value||'', takeProfit:$('#jf-tp')?.value||'',
    fee:$('#jf-fee')?.value||'', tax:$('#jf-tax')?.value||'',
    tags:$$('.j-tag-btn.active',$('#jf-tags')).map(b=>b.dataset.tag),
    notes:$('#jf-notes')?.value||'',
  };
  try {
    if(editingId){await api(`/trades/${editingId}`,{method:'PUT',body:JSON.stringify(data)});const idx=trades.findIndex(t=>t.id===editingId);if(idx>=0)trades[idx]=data;}
    else{const res=await api('/trades',{method:'POST',body:JSON.stringify(data)});data.id=res.id;trades.unshift(data);}
    if($('#tab-journal')?.classList.contains('active'))renderJournal();
  }catch(e){throw e;}
}

// ================================================================
//  Trade Detail Modal
// ================================================================
function openTradeDetail(id) {
  const t=trades.find(x=>x.id===id);if(!t)return;
  const overlay=$('#j-modal-overlay'),modal=$('#j-modal');if(!overlay||!modal)return;
  const pl=calcPL(t),ML={tw:'台灣',us:'美國'},TL={stock:'股票',futures:'期貨',options:'選擇權',etf:'ETF'},DL={long:'做多',short:'做空'},SL={open:'持倉中',closed:'已平倉'};
  const en=parseFloat(t.entryPrice),sl=parseFloat(t.stopLoss),tp=parseFloat(t.takeProfit);
  const rp=(!isNaN(en)&&!isNaN(sl)&&en)?((Math.abs(en-sl)/en)*100).toFixed(2):null;
  const rwp=(!isNaN(en)&&!isNaN(tp)&&en)?((Math.abs(tp-en)/en)*100).toFixed(2):null;
  const rr=rp&&rwp&&parseFloat(rp)>0?(parseFloat(rwp)/parseFloat(rp)).toFixed(2):null;
  modal.innerHTML=`<div class="j-modal-header"><h3><span class="j-badge j-badge-${t.market}">${ML[t.market]}</span> <strong>${t.symbol}</strong> ${t.name}</h3><button class="j-modal-close" id="jd-close">&times;</button></div>
  <div class="j-modal-body"><div class="j-detail-grid">
    <div class="j-detail-item"><span class="j-dl">日期</span><span class="j-dv">${fmtDateTime(t.date)}</span></div>
    <div class="j-detail-item"><span class="j-dl">類型</span><span class="j-dv">${TL[t.type]}</span></div>
    <div class="j-detail-item"><span class="j-dl">方向</span><span class="j-dv j-dir-${t.direction}">${DL[t.direction]}</span></div>
    <div class="j-detail-item"><span class="j-dl">狀態</span><span class="j-dv"><span class="j-status j-status-${t.status}">${SL[t.status]}</span></span></div>
    <div class="j-detail-item"><span class="j-dl">進場價</span><span class="j-dv">${fmtNum(en,2)}</span></div>
    <div class="j-detail-item"><span class="j-dl">出場價</span><span class="j-dv">${t.exitPrice?fmtNum(parseFloat(t.exitPrice),2):'—'}</span></div>
    <div class="j-detail-item"><span class="j-dl">數量</span><span class="j-dv">${t.quantity||'—'}</span></div>
    ${t.type==='futures'&&t.contractMul?`<div class="j-detail-item"><span class="j-dl">合約乘數</span><span class="j-dv">${t.contractMul}</span></div>`:''}
    ${t.stopLoss?`<div class="j-detail-item"><span class="j-dl">停損</span><span class="j-dv">${fmtNum(sl,2)}${rp?` <span class="tr">(${rp}%)</span>`:''}</span></div>`:''}
    ${t.takeProfit?`<div class="j-detail-item"><span class="j-dl">停利</span><span class="j-dv">${fmtNum(tp,2)}${rwp?` <span class="tg">(${rwp}%)</span>`:''}</span></div>`:''}
    ${rr?`<div class="j-detail-item"><span class="j-dl">風報比</span><span class="j-dv ta">1:${rr}</span></div>`:''}
    ${t.fee?`<div class="j-detail-item"><span class="j-dl">手續費</span><span class="j-dv">${fmtNum(parseFloat(t.fee),0)}</span></div>`:''}
    ${t.tax?`<div class="j-detail-item"><span class="j-dl">交易稅</span><span class="j-dv">${fmtNum(parseFloat(t.tax),0)}</span></div>`:''}
  </div>
  ${pl?`<div class="j-pl-box ${pl.net>=0?'j-pl-profit':'j-pl-loss'} j-pl-detail-box"><div class="j-pl-row"><span>毛損益</span><strong>${fmtNum(pl.gross,0)}</strong></div><div class="j-pl-row"><span>手續費+稅</span><span>-${fmtNum(pl.fee+pl.tax,0)}</span></div><div class="j-pl-row j-pl-total"><span>淨損益</span><strong>${fmtNum(pl.net,0)}</strong></div></div>`:''}
  ${(t.tags||[]).length?`<div class="j-detail-tags">${t.tags.map(tag=>`<span class="j-tag">${esc(tag)}</span>`).join('')}</div>`:''}
  ${t.notes?`<div class="j-detail-notes"><h4>策略筆記</h4><div class="j-notes-content">${esc(t.notes).replace(/\n/g,'<br>')}</div></div>`:''}
  </div><div class="j-modal-footer"><button class="j-btn-cancel" id="jd-back">關閉</button><button class="j-btn-save" id="jd-edit">編輯</button></div>`;
  overlay.classList.add('open');modal.classList.add('open');
  const cl=()=>{overlay.classList.remove('open');modal.classList.remove('open');};
  $('#jd-close').addEventListener('click',cl);overlay.addEventListener('click',(e)=>{if(e.target===overlay)cl();});$('#jd-back').addEventListener('click',cl);
  $('#jd-edit').addEventListener('click',()=>{cl();setTimeout(()=>openTradeForm(id),100);});
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
}

document.addEventListener('DOMContentLoaded', initJournal);
})();
