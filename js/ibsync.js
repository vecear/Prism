// ================================================================
//  Prism — IB（Interactive Brokers）Flex Web Service 交易同步
//  流程：SendRequest（token+queryId）→ ReferenceCode → 輪詢 GetStatement
//        → 解析 Flex XML <Trade> 成交 → 轉成單腿列 → 交給 journal.js
//        既有匯入管線（_showImportPreview：FIFO 配對 + 去重 + 批次建立）
//  設定存 localStorage `prism_ib_flex`（token 僅存於本機瀏覽器，唯讀權限）
//  依賴：journal.js（PrismJournal.showImportPreview / isLoggedIn / showLogin）
// ================================================================
(function () {
  'use strict';

  const LS_KEY = 'prism_ib_flex';
  const FLEX_BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
  const POLL_MAX = 12;          // GetStatement 最多輪詢次數
  const POLL_INTERVAL = 3000;   // 輪詢間隔 ms
  // 常見指數期貨根代號（其餘 FUT 視為原物料期貨）
  const INDEX_FUT = new Set(['ES', 'NQ', 'YM', 'RTY', 'MES', 'MNQ', 'MYM', 'M2K', 'NKD', 'EMD', 'VX', 'VXM']);

  const $ = (s, el) => (el || document).querySelector(s);
  const _e = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
  }
  function saveCfg(cfg) { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }

  // ────────── Flex XML 解析（regex 版：瀏覽器與 node 測試皆可用） ──────────
  function _parseAttrs(tagBody) {
    const out = {};
    const re = /([\w.]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(tagBody))) out[m[1]] = m[2];
    return out;
  }

  // 'YYYYMMDD' / 'YYYY-MM-DD' → 'YYYY-MM-DD'
  function _normDate(s) {
    if (!s) return '';
    const t = s.replace(/-/g, '');
    if (!/^\d{8}$/.test(t)) return '';
    return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  }
  // 'HHMMSS' / 'HH:MM:SS' → 'HH:MM:SS'
  function _normTime(s) {
    if (!s) return '';
    const t = s.replace(/:/g, '');
    if (!/^\d{6}$/.test(t)) return '';
    return `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
  }

  function _futType(a) {
    const root = (a.underlyingSymbol || a.symbol || '').replace(/[A-Z]\d+$/i, '').trim().toUpperCase();
    return INDEX_FUT.has(root) ? 'index_futures' : 'commodity_futures';
  }

  // 解析 Flex 回應中的錯誤（FlexStatementResponse 階段）
  function parseFlexError(xml) {
    const code = /<ErrorCode>(\d+)<\/ErrorCode>/.exec(xml)?.[1];
    const msg = /<ErrorMessage>([^<]*)<\/ErrorMessage>/.exec(xml)?.[1];
    return code ? { code, msg: msg || '' } : null;
  }

  // 解析成交：回傳 journal 匯入管線的單腿列陣列
  function parseFlexTrades(xml) {
    const legs = [];
    let skipped = 0;
    const re = /<Trade\s+([^>]*?)\/?>/g;
    let m;
    while ((m = re.exec(xml))) {
      const a = _parseAttrs(m[1]);
      // 僅收成交執行層級（排除 ORDER/CLOSED_LOT 彙總列與取消單）
      if (a.levelOfDetail && a.levelOfDetail !== 'EXECUTION') continue;
      if (/Ca\.?/.test(a.buySell || '')) { skipped++; continue; }
      const cat = (a.assetCategory || '').toUpperCase();
      if (!['STK', 'FUT', 'OPT', 'FOP', 'ETF'].includes(cat)) { skipped++; continue; }

      // 日期時間：dateTime="YYYYMMDD;HHMMSS" 或 tradeDate + tradeTime
      let date = '', time = '';
      if (a.dateTime) {
        const parts = a.dateTime.split(/[;, ]/);
        date = _normDate(parts[0]); time = _normTime(parts[1] || '');
      }
      if (!date) date = _normDate(a.tradeDate || '');
      if (!time) time = _normTime(a.tradeTime || '');
      if (!date) { skipped++; continue; }

      const qty = Math.abs(parseFloat(a.quantity) || 0);
      const price = parseFloat(a.tradePrice) || 0;
      if (!qty || !price) { skipped++; continue; }

      const buySell = (a.buySell || '').toUpperCase();
      const direction = buySell === 'SELL' ? 'short' : 'long';
      const mult = parseFloat(a.multiplier) || 0;
      const expiry = a.expiry || a.lastTradeDateOrContractMonth || '';
      const isDeriv = cat !== 'STK' && cat !== 'ETF';
      const type = cat === 'STK' ? 'stock' : cat === 'ETF' ? 'etf'
        : (cat === 'OPT' || cat === 'FOP') ? 'options' : _futType(a);

      const notePieces = ['IB 同步'];
      if (isDeriv && expiry) notePieces.push(`到期 ${expiry.replace(/-/g, '')}`);
      if (a.strike && parseFloat(a.strike)) notePieces.push(`履約價 ${a.strike}`);
      if (time) notePieces.push(`時間 ${time}`);

      legs.push({
        date,
        market: 'us',
        type,
        symbol: (a.symbol || '').replace(/\s+/g, ''),
        name: a.description || a.symbol || '',
        direction, status: 'closed',
        entryPrice: price, exitPrice: '',
        quantity: qty,
        contractMul: isDeriv && mult > 0 ? mult : '',
        stopLoss: '', takeProfit: '',
        fee: Math.abs(parseFloat(a.ibCommission) || 0) || '',
        tax: Math.abs(parseFloat(a.taxes) || 0) || '',
        account: 'IB', rating: 0,
        tags: ['IB'],
        notes: notePieces.join(' | '), pricingStage: '',
      });
    }
    return { legs, skipped };
  }

  // ────────── Flex Web Service 抓取 ──────────
  async function _proxyGet(url) {
    const r = await fetch(`/api/proxy?url=${encodeURIComponent(url)}`);
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}：${text.slice(0, 120)}`);
    return text;
  }

  async function fetchFlexStatement(token, queryId, onProgress) {
    onProgress('向 IB 發出報表請求…');
    const sendXml = await _proxyGet(`${FLEX_BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`);
    const sendErr = parseFlexError(sendXml);
    if (sendErr) throw new Error(`IB 錯誤 ${sendErr.code}：${sendErr.msg}`);
    const ref = /<ReferenceCode>(\w+)<\/ReferenceCode>/.exec(sendXml)?.[1];
    if (!ref) throw new Error('IB 回應中找不到 ReferenceCode（請確認 Token 與 Query ID）');

    for (let i = 0; i < POLL_MAX; i++) {
      onProgress(`等待 IB 產生報表… (${i + 1}/${POLL_MAX})`);
      await new Promise(res => setTimeout(res, POLL_INTERVAL));
      const xml = await _proxyGet(`${FLEX_BASE}/GetStatement?t=${encodeURIComponent(token)}&q=${ref}&v=3`);
      const err = parseFlexError(xml);
      if (!err) return xml;
      // 1019 = 報表產生中，繼續輪詢；其他錯誤直接拋出
      if (err.code !== '1019') throw new Error(`IB 錯誤 ${err.code}：${err.msg}`);
    }
    throw new Error('IB 報表產生逾時，請稍後再試');
  }

  async function sync() {
    const cfg = loadCfg();
    if (!cfg.token || !cfg.queryId) { open(); return; }
    const J = window.PrismJournal;
    if (!J?.isLoggedIn?.()) { J?.showLogin?.(); return; }
    const toast = (m) => window._showToast && window._showToast(m);
    try {
      const xml = await fetchFlexStatement(cfg.token, cfg.queryId, toast);
      const { legs, skipped } = parseFlexTrades(xml);
      if (!legs.length) { toast(`IB 報表中沒有可匯入的成交${skipped ? `（略過 ${skipped} 筆非交易列）` : ''}`); return; }
      toast(`取得 ${legs.length} 筆 IB 成交，開啟匯入預覽`);
      J.showImportPreview(legs);
    } catch (e) {
      console.error('[IBSync]', e);
      toast(`IB 同步失敗：${e.message}`);
    }
  }

  // ────────── 設定 Modal ──────────
  function open() {
    const cfg = loadCfg();
    let overlay = $('#ib-sync-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ib-sync-overlay';
      overlay.className = 'j-modal-overlay';
      overlay.innerHTML = `<div class="j-modal ib-sync-modal" role="dialog" aria-modal="true" aria-label="IB 同步設定"></div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    }
    const modal = $('.ib-sync-modal', overlay);
    modal.innerHTML = `
      <div class="j-modal-header"><h3>IB 交易同步（Flex Web Service）</h3><button class="j-modal-close" type="button" aria-label="關閉" id="ib-close">&times;</button></div>
      <div class="j-modal-body">
        <div class="j-form-grid">
          <div class="j-fg j-fg-wide"><label for="ib-token">Flex Web Service Token</label>
            <input type="password" id="ib-token" value="${_e(cfg.token || '')}" placeholder="於 IBKR 後台產生" autocomplete="off"></div>
          <div class="j-fg j-fg-wide"><label for="ib-qid">Flex Query ID</label>
            <input type="text" id="ib-qid" value="${_e(cfg.queryId || '')}" placeholder="例：123456" inputmode="numeric"></div>
        </div>
        <details class="ib-help"${cfg.token ? '' : ' open'}>
          <summary>如何設定（首次使用必看）</summary>
          <ol>
            <li>登入 IBKR Client Portal → <b>Performance &amp; Reports → Flex Queries</b></li>
            <li>建立 <b>Activity Flex Query</b>：Sections 勾選 <b>Trades</b>（Options: Executions），欄位至少勾選
              Symbol、Description、Asset Class、Buy/Sell、Quantity、Trade Price、Trade Date、Trade Time（或 Date/Time）、
              IB Commission、Multiplier、Expiry、Strike、Level of Detail</li>
            <li>Period 建議 <b>Last 30 Calendar Days</b>（每次同步取近期，重複者匯入時自動跳過）；Format 選 <b>XML</b></li>
            <li>於 <b>Flex Web Service Configuration</b> 啟用服務並產生 Token（效期建議 1 年）</li>
            <li>把 Token 與 Query ID 貼到上方欄位</li>
          </ol>
          <p class="ib-note">Token 僅儲存在這台裝置的瀏覽器（localStorage），不會上傳伺服器；其權限為唯讀報表，無法下單。</p>
        </details>
        <div class="ind-card-actions">
          <button class="ind-act-btn ind-act-primary" id="ib-save-sync">儲存並同步</button>
          <button class="ind-act-btn" id="ib-save">僅儲存</button>
          ${cfg.token ? '<button class="ind-act-btn" id="ib-clear">清除設定</button>' : ''}
        </div>
      </div>`;

    overlay.classList.add('open');
    modal.classList.add('open');

    const close = () => { overlay.classList.remove('open'); modal.classList.remove('open'); document.removeEventListener('keydown', escH); };
    const escH = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escH);
    $('#ib-close', modal).addEventListener('click', close);
    const grab = () => ({ token: $('#ib-token').value.trim(), queryId: $('#ib-qid').value.trim() });
    $('#ib-save', modal).addEventListener('click', () => {
      saveCfg(grab());
      if (window._showToast) window._showToast('IB 設定已儲存');
      close();
    });
    $('#ib-save-sync', modal).addEventListener('click', () => {
      const c = grab();
      if (!c.token || !c.queryId) { if (window._showToast) window._showToast('請填入 Token 與 Query ID'); return; }
      saveCfg(c); close(); sync();
    });
    $('#ib-clear', modal)?.addEventListener('click', () => {
      localStorage.removeItem(LS_KEY);
      if (window._showToast) window._showToast('IB 設定已清除');
      close();
    });
  }

  window.PrismIBSync = { open, sync, hasConfig: () => { const c = loadCfg(); return !!(c.token && c.queryId); }, _parseFlexTrades: parseFlexTrades, _parseFlexError: parseFlexError };
})();
