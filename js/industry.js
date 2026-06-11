// ================================================================
//  Prism — 台股產業地圖模組
//  視圖：heat（熱力圖總覽）/ 各產業鏈（上中下游）
//  報價：TWSE MIS 批次查詢（tse_|otc_ 雙形式），60s 快取
//  依賴：js/industry-data.js（PrismIndustryData）、app.js（PriceService）
// ================================================================
(function () {
  'use strict';

  const $ = (s, el) => (el || document).querySelector(s);
  const _e = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const DATA = () => window.PrismIndustryData || { industries: [] };
  const QUOTE_TTL = 60 * 1000;     // 報價快取 60 秒
  const BATCH_SIZE = 25;           // 每批 25 檔（×2 形式 = 50 個 ex_ch）
  const COLOR_FULL_PCT = 3;        // 漲跌幅 ±3% 時 treemap 色彩飽和

  const state = {
    view: 'heat',                  // 'heat' | industry id
    chainTab: {},                  // industry id -> 啟用的主題分頁 id（產業含 tabs 時）
    quotes: new Map(),             // code -> {price, prev, changePct, open, high, low, volume, time}
    fetchedAt: 0,
    loading: false,
    progress: '',
    rendered: false,
  };

  // ────────── 資料輔助 ──────────
  // group 可含直屬 stocks 與細分 subs（樹狀第四層）
  function groupLists(g) {
    const out = [];
    if (g.stocks && g.stocks.length) out.push({ sub: null, stocks: g.stocks });
    for (const sub of g.subs || []) out.push({ sub, stocks: sub.stocks || [] });
    return out;
  }

  // 產業可為直接 stages，或含 tabs（主題分頁，各自有 stages）
  function stagesOf(ind) {
    return ind.tabs ? ind.tabs.flatMap(t => t.stages) : (ind.stages || []);
  }

  function stocksOfStages(stages) {
    const seen = new Map();
    for (const st of stages || [])
      for (const g of st.groups)
        for (const list of groupLists(g))
          for (const s of list.stocks)
            if (!seen.has(s.s)) seen.set(s.s, s);
    return [...seen.values()];
  }

  function allStocks() {
    // 去重：同一檔股票回傳第一次出現的定義
    const seen = new Map();
    for (const ind of DATA().industries)
      for (const s of stocksOfStages(stagesOf(ind)))
        if (!seen.has(s.s)) seen.set(s.s, s);
    return seen;
  }

  function industryStocks(ind) {
    return stocksOfStages(stagesOf(ind));
  }

  function stockPositions(code) {
    // 該股票出現在哪些 產業/分頁/環節/子環節（含該環節的角色說明 d）
    const out = [];
    for (const ind of DATA().industries) {
      const sets = ind.tabs ? ind.tabs.map(t => ({ tab: t, stages: t.stages })) : [{ tab: null, stages: ind.stages || [] }];
      for (const set of sets)
        for (const st of set.stages)
          for (const g of st.groups)
            for (const list of groupLists(g)) {
              const hit = list.stocks.find(s => s.s === code);
              if (hit) out.push({ ind, tab: set.tab, stage: st.name, group: g, sub: list.sub, peers: list.stocks, d: hit.d || '' });
            }
    }
    return out;
  }

  function cap(stock) {
    const q = state.quotes.get(stock.s);
    return (q?.price || 0) * (stock.sh || 0);
  }

  // ────────── 報價 ──────────
  async function fetchQuotes(force) {
    if (state.loading) return;
    if (!force && Date.now() - state.fetchedAt < QUOTE_TTL && state.quotes.size) return;
    if (typeof PriceService === 'undefined') return;
    state.loading = true;
    const codes = [...allStocks().keys()];
    const batches = [];
    for (let i = 0; i < codes.length; i += BATCH_SIZE) batches.push(codes.slice(i, i + BATCH_SIZE));
    let done = 0, ok = 0;
    for (const batch of batches) {
      const exch = batch.map(c => `tse_${c}.tw|otc_${c}.tw`).join('|');
      try {
        const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exch)}&_=${Date.now()}`;
        const r = await PriceService._proxyFetch(url, 10000);
        const items = (await r.json())?.msgArray || [];
        for (const it of items) {
          if (!it.c) continue;
          const prev = parseFloat(it.y) || 0;
          const price = (it.z && it.z !== '-') ? parseFloat(it.z) : prev;
          if (!price) continue;
          state.quotes.set(it.c, {
            price, prev,
            changePct: prev ? ((price - prev) / prev * 100) : 0,
            open: parseFloat(it.o) || 0, high: parseFloat(it.h) || 0, low: parseFloat(it.l) || 0,
            volume: parseFloat(it.v) || 0,
            time: it.tlong ? parseInt(it.tlong, 10) : null,
          });
          ok++;
        }
      } catch (e) { console.debug('[Industry] 批次報價失敗:', e.message); }
      done++;
      state.progress = `${done}/${batches.length}`;
      updateProgressUI();
      if (state.view !== 'heat') updateChainQuotes();
      // 批次間隔，避免對 MIS 過度頻繁
      if (done < batches.length) await new Promise(res => setTimeout(res, 150));
    }
    state.loading = false;
    state.progress = '';
    if (ok) state.fetchedAt = Date.now();
    render();
  }

  // ────────── 格式化 ──────────
  function fmtP(n) {
    if (!n && n !== 0) return '—';
    if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
    if (n >= 100) return n.toFixed(1);
    return n.toFixed(2);
  }
  function fmtPct(p) { return (p > 0 ? '+' : '') + p.toFixed(2) + '%'; }
  function pctClass(p) { return p > 0.001 ? 'tg' : p < -0.001 ? 'tr' : ''; }
  function fmtVol(v) {
    if (!v) return '—';
    if (v >= 10000) return (v / 10000).toFixed(1) + ' 萬張';
    return Math.round(v).toLocaleString('en-US') + ' 張';
  }
  function fmtCapE(stock) {
    const c = cap(stock);
    if (!c) return '';
    if (c >= 10000) return (c / 10000).toFixed(1) + ' 兆';
    return Math.round(c).toLocaleString('en-US') + ' 億';
  }
  function tileColor(pct) {
    const t = Math.max(-1, Math.min(1, pct / COLOR_FULL_PCT));
    if (Math.abs(t) < 0.02) return 'var(--bg2)';
    const v = t > 0 ? 'var(--green)' : 'var(--red)';
    const p = Math.round(18 + Math.abs(t) * 60); // 18% ~ 78% 混色
    return `color-mix(in srgb, ${v} ${p}%, var(--bg2))`;
  }
  function tileText(pct) {
    const t = Math.abs(pct / COLOR_FULL_PCT);
    if (t < 0.45) return 'var(--t1)';
    return pct > 0 ? 'var(--on-green)' : 'var(--on-red)';
  }

  // ────────── 產業統計 ──────────
  function industrySummary(ind) { return summaryOf(industryStocks(ind)); }
  function summaryOf(stocks) {
    let wSum = 0, wPct = 0, top = null, bottom = null, quoted = 0;
    for (const s of stocks) {
      const q = state.quotes.get(s.s);
      if (!q) continue;
      quoted++;
      const w = cap(s) || 0.01;
      wSum += w; wPct += q.changePct * w;
      if (!top || q.changePct > state.quotes.get(top.s).changePct) top = s;
      if (!bottom || q.changePct < state.quotes.get(bottom.s).changePct) bottom = s;
    }
    return { count: stocks.length, quoted, avgPct: wSum ? wPct / wSum : 0, top, bottom };
  }

  // ────────── Squarified Treemap ──────────
  function squarify(items, x, y, w, h, out) {
    // items: [{area, ...}] 由大到小；out 收集 {x,y,w,h,item}
    items = items.filter(i => i.area > 0);
    while (items.length) {
      const horiz = w >= h;            // 沿短邊鋪 row
      const side = horiz ? h : w;
      const row = [items.shift()];
      let best = worstRatio(row, side);
      while (items.length) {
        const r = worstRatio(row.concat(items[0]), side);
        if (r <= best) { row.push(items.shift()); best = r; }
        else break;
      }
      const rowArea = row.reduce((s, i) => s + i.area, 0);
      const thick = rowArea / side;
      let off = 0;
      for (const it of row) {
        const len = it.area / thick;
        if (horiz) out.push({ x, y: y + off, w: thick, h: len, item: it });
        else out.push({ x: x + off, y, w: len, h: thick, item: it });
        off += len;
      }
      if (horiz) { x += thick; w -= thick; }
      else { y += thick; h -= thick; }
    }
  }
  function worstRatio(row, side) {
    const sum = row.reduce((s, i) => s + i.area, 0);
    const thick = sum / side;
    let worst = 0;
    for (const it of row) {
      const len = it.area / thick;
      worst = Math.max(worst, thick / len, len / thick);
    }
    return worst;
  }

  // ────────── 渲染：root ──────────
  function ensureRoot() {
    const root = $('#industry-root');
    if (!root) return null;
    if (!state.rendered) {
      root.innerHTML = `
        <div class="ind-nav" id="ind-nav" role="tablist" aria-label="產業選擇"></div>
        <div class="ind-body" id="ind-body"></div>`;
      $('#ind-nav').addEventListener('click', e => {
        const b = e.target.closest('.ind-pill');
        if (!b) return;
        state.view = b.dataset.view;
        render();
      });
      $('#ind-body').addEventListener('click', e => {
        const ct = e.target.closest('[data-chaintab]');
        if (ct) { state.chainTab[state.view] = ct.dataset.chaintab; render(); return; }
        const tile = e.target.closest('[data-ind-stock]');
        if (tile) { openStockCard(tile.dataset.indStock); return; }
        const retry = e.target.closest('#ind-retry');
        if (retry) { fetchQuotes(true); return; }
      });
      window.addEventListener('resize', debounceResize);
      state.rendered = true;
    }
    return root;
  }

  let _resizeTimer;
  function debounceResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (state.view === 'heat' && $('#tab-industry')?.classList.contains('active')) render();
    }, 200);
  }

  function renderNav() {
    const nav = $('#ind-nav');
    if (!nav) return;
    const pills = [`<button class="ind-pill${state.view === 'heat' ? ' active' : ''}" data-view="heat" role="tab" aria-selected="${state.view === 'heat'}">熱力圖總覽</button>`]
      .concat(DATA().industries.map(ind =>
        `<button class="ind-pill${state.view === ind.id ? ' active' : ''}" data-view="${_e(ind.id)}" role="tab" aria-selected="${state.view === ind.id}">${_e(ind.name)}</button>`));
    nav.innerHTML = pills.join('');
  }

  function render() {
    if (!ensureRoot()) return;
    renderNav();
    if (state.view === 'heat') renderHeatmap();
    else renderChain(state.view);
  }

  function metaBar(extra) {
    const t = state.fetchedAt ? new Date(state.fetchedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : null;
    const status = state.loading
      ? `<span class="ind-meta-loading">載入報價 <span id="ind-progress">${_e(state.progress)}</span></span>`
      : t ? `報價時間 ${t}` : `<button class="ind-act-btn" id="ind-retry">重新載入報價</button>`;
    return `<div class="ind-meta">${extra || ''}<span class="ind-meta-status">${status}</span><span class="ind-meta-note">市值為估算值（約當股數 × 即時價）</span></div>`;
  }

  function updateProgressUI() {
    const el = $('#ind-progress');
    if (el) el.textContent = state.progress;
  }

  // ────────── 渲染：熱力圖 ──────────
  function renderHeatmap() {
    const body = $('#ind-body');
    if (!body) return;
    const inds = DATA().industries;

    // 全域去重：股票只歸入第一個包含它的產業
    // 歸屬優先序：半導體優先（台積電等權值股依市場慣例歸半導體區），其餘依資料順序
    const ordered = [...inds.filter(i => i.id === 'semi'), ...inds.filter(i => i.id !== 'semi')];
    const assigned = new Set();
    const groupsData = ordered.map(ind => {
      const stocks = industryStocks(ind).filter(s => !assigned.has(s.s));
      stocks.forEach(s => assigned.add(s.s));
      return { ind, stocks };
    }).filter(g => g.stocks.length);

    if (!state.quotes.size) {
      body.innerHTML = metaBar() + `<div class="ind-empty">${state.loading ? '載入報價中，熱力圖需要市值資料…' : '尚無報價資料，無法繪製熱力圖'}</div>`;
      return;
    }

    const W = Math.max(320, body.clientWidth || 800);
    const isMobile = window.innerWidth <= 768;
    const H = isMobile ? 520 : Math.max(420, Math.round(W * 0.56));
    const HEADER = 20;

    // 第一層：產業
    // 面積採市值平方根縮放：保留大小排序、壓縮極端差距（台積電獨大時其餘仍可讀）
    const wgt = (st) => Math.sqrt(cap(st) || 0);
    const indItems = groupsData.map(g => ({
      area: g.stocks.reduce((s, st) => s + wgt(st), 0), g,
    })).filter(i => i.area > 0).sort((a, b) => b.area - a.area);
    const totalCap = indItems.reduce((s, i) => s + i.area, 0);
    if (!totalCap) {
      body.innerHTML = metaBar() + `<div class="ind-empty">報價資料不足</div>`;
      return;
    }
    const scale1 = (W * H) / totalCap;
    indItems.forEach(i => { i.area *= scale1; });
    const indRects = [];
    squarify(indItems, 0, 0, W, H, indRects);

    let html = '';
    for (const ir of indRects) {
      const { ind, stocks } = ir.item.g;
      const sum = industrySummary(ind);
      const showHeader = ir.w > 70 && ir.h > 50;
      const innerY = showHeader ? HEADER : 0;
      const innerH = ir.h - innerY;
      // 第二層：個股
      const stItems = stocks.map(s => ({ area: wgt(s), s }))
        .filter(i => i.area > 0).sort((a, b) => b.area - a.area);
      const stTotal = stItems.reduce((s, i) => s + i.area, 0);
      const scale2 = (ir.w * innerH) / stTotal;
      stItems.forEach(i => { i.area *= scale2; });
      const stRects = [];
      squarify(stItems, 0, 0, ir.w, innerH, stRects);

      let tiles = '';
      for (const sr of stRects) {
        const st = sr.item.s;
        const q = state.quotes.get(st.s);
        const pct = q ? q.changePct : 0;
        const showCode = sr.w >= 42 && sr.h >= 17;
        const showPct = sr.w >= 46 && sr.h >= 31;
        tiles += `<div class="ind-tile" data-ind-stock="${_e(st.s)}" role="button" tabindex="0"
          style="left:${sr.x.toFixed(1)}px;top:${sr.y.toFixed(1)}px;width:${sr.w.toFixed(1)}px;height:${sr.h.toFixed(1)}px;background:${tileColor(pct)};color:${tileText(pct)}"
          title="${_e(st.s + ' ' + st.n)} ${q ? fmtPct(pct) : ''}${st.d ? _e('｜' + st.d) : ''}">
          ${showCode ? `<span class="ind-tile-code">${_e(st.n)}</span>` : ''}
          ${showPct ? `<span class="ind-tile-pct">${q ? fmtPct(pct) : '—'}</span>` : ''}
        </div>`;
      }
      html += `<div class="ind-sector" style="left:${ir.x.toFixed(1)}px;top:${ir.y.toFixed(1)}px;width:${ir.w.toFixed(1)}px;height:${ir.h.toFixed(1)}px">
        ${showHeader ? `<div class="ind-sector-head" data-view="${_e(ind.id)}"><span class="ind-sector-name">${_e(ind.name)}</span><span class="ind-sector-pct ${pctClass(sum.avgPct)}">${fmtPct(sum.avgPct)}</span></div>` : ''}
        <div class="ind-sector-tiles" style="top:${innerY}px">${tiles}</div>
      </div>`;
    }

    const legend = `<div class="ind-legend" aria-hidden="true">
      <span class="ind-legend-label">-${COLOR_FULL_PCT}%</span>
      ${[-1, -0.6, -0.25, 0, 0.25, 0.6, 1].map(t => `<span class="ind-legend-cell" style="background:${tileColor(t * COLOR_FULL_PCT)}"></span>`).join('')}
      <span class="ind-legend-label">+${COLOR_FULL_PCT}%</span>
    </div>`;

    body.innerHTML = metaBar(legend) + `<div class="ind-heatmap" style="height:${H}px">${html}</div>`;

    // 產業標題 → 切換到該產業鏈
    body.querySelectorAll('.ind-sector-head').forEach(h => h.addEventListener('click', e => {
      e.stopPropagation();
      state.view = h.dataset.view; render();
    }));
  }

  // ────────── 渲染：產業鏈 ──────────
  function renderChain(id) {
    const body = $('#ind-body');
    const ind = DATA().industries.find(i => i.id === id);
    if (!body || !ind) { state.view = 'heat'; renderHeatmap(); return; }
    // 主題分頁：產業含 tabs 時渲染啟用分頁的 stages
    const tabs = ind.tabs || null;
    let act = null;
    if (tabs) {
      act = tabs.find(t => t.id === state.chainTab[id]) || tabs[0];
      state.chainTab[id] = act.id;
    }
    const stageList = act ? act.stages : (ind.stages || []);
    const sum = summaryOf(stocksOfStages(stageList));
    const topQ = sum.top ? state.quotes.get(sum.top.s) : null;
    const botQ = sum.bottom ? state.quotes.get(sum.bottom.s) : null;

    const strip = `<div class="ind-strip">
      <span class="ind-strip-item"><span class="ind-strip-label">成分股</span><b>${sum.count}</b></span>
      <span class="ind-strip-item"><span class="ind-strip-label">加權漲跌</span><b class="${pctClass(sum.avgPct)}">${sum.quoted ? fmtPct(sum.avgPct) : '—'}</b></span>
      ${sum.top && topQ ? `<span class="ind-strip-item" data-ind-stock="${_e(sum.top.s)}" role="button" tabindex="0"><span class="ind-strip-label">領漲</span><b class="tg">${_e(sum.top.n)} ${fmtPct(topQ.changePct)}</b></span>` : ''}
      ${sum.bottom && botQ ? `<span class="ind-strip-item" data-ind-stock="${_e(sum.bottom.s)}" role="button" tabindex="0"><span class="ind-strip-label">領跌</span><b class="tr">${_e(sum.bottom.n)} ${fmtPct(botQ.changePct)}</b></span>` : ''}
    </div>`;

    const renderRows = (stocks) => stocks.slice().sort((a, b) => cap(b) - cap(a)).map(s => {
      const q = state.quotes.get(s.s);
      return `<div class="ind-row" data-ind-stock="${_e(s.s)}" role="button" tabindex="0"${s.d ? ` title="${_e(s.d)}"` : ''}>
        <span class="ind-row-id"><span class="ind-row-code">${_e(s.s)}</span><span class="ind-row-name">${_e(s.n)}</span></span>
        <span class="ind-row-quote" data-ind-q="${_e(s.s)}">${q
          ? `<span class="ind-row-price">${fmtP(q.price)}</span><span class="ind-row-pct ${pctClass(q.changePct)}">${fmtPct(q.changePct)}</span>`
          : `<span class="ind-row-price ind-dim">—</span>`}</span>
      </div>`;
    }).join('');

    const stages = stageList.map((st, i) => {
      const groups = st.groups.map(g => {
        const direct = (g.stocks && g.stocks.length) ? renderRows(g.stocks) : '';
        const subs = (g.subs || []).map(sub => `
          <div class="ind-sub">
            <div class="ind-sub-head"><span class="ind-sub-name">${_e(sub.name)}</span>${sub.note ? `<span class="ind-sub-note">${_e(sub.note)}</span>` : ''}</div>
            ${renderRows(sub.stocks || [])}
          </div>`).join('');
        return `<div class="ind-group">
          <div class="ind-group-head"><span class="ind-group-name">${_e(g.name)}</span>${g.note ? `<span class="ind-group-note">${_e(g.note)}</span>` : ''}</div>
          ${direct}${subs}
        </div>`;
      }).join('');
      return `<div class="ind-stage">
        <div class="ind-stage-head"><span class="ind-stage-name">${_e(st.name)}</span>${i < stageList.length - 1 ? '<span class="ind-stage-arrow" aria-hidden="true">→</span>' : ''}</div>
        ${st.note ? `<div class="ind-stage-note">${_e(st.note)}</div>` : ''}
        ${groups}
      </div>`;
    }).join('');

    const subnav = tabs ? `<div class="ind-subnav" role="tablist" aria-label="${_e(ind.name)}主題分頁">${tabs.map(t =>
        `<button class="ind-subpill${t.id === act.id ? ' active' : ''}" data-chaintab="${_e(t.id)}" role="tab" aria-selected="${t.id === act.id}">${_e(t.name)}</button>`).join('')}</div>` +
      (act.note ? `<div class="ind-subnav-note">${_e(act.note)}</div>` : '') : '';

    body.innerHTML = metaBar() +
      `<div class="ind-chain-head"><h2>${_e(ind.name)}產業鏈</h2><p class="ind-chain-desc">${_e(ind.desc)}</p></div>` +
      subnav +
      strip +
      `<div class="ind-stages" data-n="${stageList.length}">${stages}</div>`;
  }

  function updateChainQuotes() {
    // 批次載入過程中就地更新報價（不重建 DOM）
    document.querySelectorAll('[data-ind-q]').forEach(el => {
      const q = state.quotes.get(el.dataset.indQ);
      if (!q) return;
      el.innerHTML = `<span class="ind-row-price">${fmtP(q.price)}</span><span class="ind-row-pct ${pctClass(q.changePct)}">${fmtPct(q.changePct)}</span>`;
    });
  }

  // ────────── 個股資訊卡 ──────────
  function openStockCard(code) {
    const def = allStocks().get(code);
    if (!def) return;
    const q = state.quotes.get(code);
    const positions = stockPositions(code);

    let overlay = $('#ind-modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ind-modal-overlay';
      overlay.className = 'j-modal-overlay';
      overlay.innerHTML = `<div class="j-modal ind-modal" role="dialog" aria-modal="true" aria-label="個股資訊"></div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', e => { if (e.target === overlay) closeStockCard(); });
    }
    const modal = $('.ind-modal', overlay);

    const quoteHtml = q ? `
      <div class="ind-card-quote">
        <span class="ind-card-price ${pctClass(q.changePct)}">${fmtP(q.price)}</span>
        <span class="ind-card-pct ${pctClass(q.changePct)}">${fmtPct(q.changePct)}</span>
      </div>
      <div class="ind-card-ohlc">
        <span><i>開</i>${fmtP(q.open)}</span><span><i>高</i>${fmtP(q.high)}</span>
        <span><i>低</i>${fmtP(q.low)}</span><span><i>昨收</i>${fmtP(q.prev)}</span>
        <span><i>量</i>${fmtVol(q.volume)}</span>${cap(def) ? `<span><i>市值≈</i>${fmtCapE(def)}</span>` : ''}
      </div>` : `<div class="ind-card-quote"><span class="ind-card-price ind-dim">無報價</span></div>`;

    const posHtml = positions.map(p => {
      const path = [p.ind.name, p.tab?.name, p.stage, p.group.name, p.sub?.name].filter(Boolean).join(' · ');
      return `<div class="ind-pos-item">
        <button class="ind-pos-link" data-goto="${_e(p.ind.id)}"${p.tab ? ` data-goto-tab="${_e(p.tab.id)}"` : ''}>${_e(path)}</button>
        ${p.d ? `<div class="ind-pos-desc">${_e(p.d)}</div>` : ''}
      </div>`;
    }).join('');

    // 同環節競爭對手（第一個 position 的最細層級同儕）
    const peers = positions.length
      ? positions[0].peers.filter(s => s.s !== code).slice(0, 6)
      : [];
    const peersHtml = peers.length ? `<div class="ind-card-sec-title">同環節個股</div><div class="ind-card-peers">${
      peers.map(p => {
        const pq = state.quotes.get(p.s);
        return `<button class="ind-peer" data-peer="${_e(p.s)}"><span>${_e(p.n)}</span>${pq ? `<b class="${pctClass(pq.changePct)}">${fmtPct(pq.changePct)}</b>` : ''}</button>`;
      }).join('')}</div>` : '';

    modal.innerHTML = `
      <div class="j-modal-header">
        <h3><span class="ind-card-code">${_e(code)}</span> ${_e(def.n)}</h3>
        <button class="j-modal-close" type="button" aria-label="關閉" id="ind-card-close">&times;</button>
      </div>
      <div class="j-modal-body ind-card-body">
        ${quoteHtml}
        <div class="ind-card-sec-title">產業鏈位置</div>
        <div class="ind-card-pos">${posHtml}</div>
        ${peersHtml}
        <div class="ind-card-actions">
          <button class="ind-act-btn ind-act-primary" id="ind-act-journal">帶入交易日誌</button>
          <button class="ind-act-btn" id="ind-act-calc">帶入股票計算機</button>
          <a class="ind-act-btn ind-act-link" href="https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=${encodeURIComponent(code)}" target="_blank" rel="noopener noreferrer">Goodinfo ↗</a>
          <a class="ind-act-btn ind-act-link" href="https://tw.tradingview.com/chart/?symbol=${encodeURIComponent(code)}" target="_blank" rel="noopener noreferrer">TradingView ↗</a>
        </div>
      </div>`;

    overlay.classList.add('open');
    modal.classList.add('open');

    $('#ind-card-close', modal).addEventListener('click', closeStockCard);
    $('#ind-act-journal', modal).addEventListener('click', () => {
      closeStockCard();
      if (window.openTradeFormPrefill) {
        document.querySelector('.sidebar-item[data-tab="journal"], .mtab[data-tab="journal"]')?.click();
        window.openTradeFormPrefill({ symbol: code, name: def.n, market: 'tw', type: 'stock', entryPrice: q ? String(q.price) : '' });
      } else if (window.PrismJournal && !window.PrismJournal.isLoggedIn?.()) {
        window.PrismJournal.showLogin?.();
      }
    });
    $('#ind-act-calc', modal).addEventListener('click', () => {
      closeStockCard();
      document.querySelector('.sidebar-item[data-tab="margin"], .mtab[data-tab="margin"]')?.click();
      const sym = $('#m-symbol');
      if (sym) { sym.value = code; sym.dispatchEvent(new Event('input', { bubbles: true })); sym.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    modal.querySelectorAll('.ind-pos-link').forEach(b => b.addEventListener('click', () => {
      closeStockCard(); state.view = b.dataset.goto;
      if (b.dataset.gotoTab) state.chainTab[b.dataset.goto] = b.dataset.gotoTab;
      render();
      document.querySelector('.sidebar-item[data-tab="industry"], .sheet-item[data-tab="industry"]')?.click();
    }));
    modal.querySelectorAll('.ind-peer').forEach(b => b.addEventListener('click', () => openStockCard(b.dataset.peer)));
    document.addEventListener('keydown', _cardEsc);
  }

  function _cardEsc(e) { if (e.key === 'Escape') closeStockCard(); }
  function closeStockCard() {
    const overlay = $('#ind-modal-overlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    $('.ind-modal', overlay)?.classList.remove('open');
    document.removeEventListener('keydown', _cardEsc);
  }

  // ────────── 鍵盤可達性：Enter/Space 觸發 data-ind-stock ──────────
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest?.('[data-ind-stock]');
    if (t) { e.preventDefault(); openStockCard(t.dataset.indStock); }
  });

  // ────────── 對外 API ──────────
  window.PrismIndustry = {
    onActivate() {
      render();
      fetchQuotes(false);
    },
    refresh() { fetchQuotes(true); },
  };
})();
