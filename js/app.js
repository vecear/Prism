/* ================================================================
   Prism (v3 Live)
   ================================================================ */
// ── Global Error Handler ──
window.addEventListener('error', function(e) {
  console.error(`[Prism Error] ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener('unhandledrejection', function(e) {
  console.error('[Prism] Unhandled promise rejection:', e.reason);
});
// API base: local file / localhost → cloud; deployed → same origin
const CLOUD_ORIGIN = 'https://prism-7t8.pages.dev';
const API_BASE = (location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? CLOUD_ORIGIN : '';
const $ = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];
const fmt = (n, d = 0) => n == null || isNaN(n) || !isFinite(n) ? '—' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
const fP = (n, d = 2) => n == null || isNaN(n) || !isFinite(n) ? '—' : Number(n).toFixed(d) + '%';
const fM = (n, c = 'NT$', d = 0) => n == null || isNaN(n) || !isFinite(n) ? '—' : (n < 0 ? '-' : '') + c + ' ' + fmt(Math.abs(n), d);
const gV = id => { const e = document.getElementById(id); return e ? (parseFloat(e.value) || 0) : NaN; };
const gVraw = id => { const e = document.getElementById(id); return e ? e.value : ''; };
const riskLvl = (v, s, c, d) => v >= s ? 'safe' : v >= c ? 'caution' : v >= d ? 'danger' : 'critical';
const WARN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 3.5L19.5 19h-15L12 5.5zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg>';
const OK_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
const PLACEHOLDER = '<div class="results-placeholder"><p>輸入參數即可即時計算</p></div>';

// XSS escape helper
function _esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── Central index definitions ──
const INDEX_DEFS = {
  taiex:    { name: '加權指數',  placeholder: '22000', market: 'tw', region: '台灣', chart: 'TWSE:TAIEX' },
  txf:      { name: '台指期',    placeholder: '22000', market: 'tw', region: '台灣', chart: 'TXF1!' },
  es:       { name: 'S&P 期貨',  placeholder: '5800',  market: 'us', region: '美國', chart: 'CME_MINI:ES1!' },
  nq:       { name: '那指期貨',  placeholder: '20000', market: 'us', region: '美國', chart: 'CME_MINI:NQ1!' },
  ym:       { name: '道瓊期貨',  placeholder: '42000', market: 'us', region: '美國', chart: 'CBOT_MINI:YM1!' },
  sox:      { name: '費半',      placeholder: '5000',  market: 'us', region: '美國', chart: 'NASDAQ:SOX' },
  nkd:      { name: '日經期貨',  placeholder: '38000', market: 'jp', region: '亞洲', chart: 'CME:NKD1!' },
  kospi:    { name: 'KOSPI',     placeholder: '2500',  market: 'kr', region: '亞洲', chart: 'KRX:KOSPI' },
  shanghai: { name: '上證指數',  placeholder: '3200',  market: 'cn', region: '亞洲', chart: 'SSE:000001' },
  hsi:      { name: '恆生指數',  placeholder: '20000', market: 'hk', region: '亞洲', chart: 'TVC:HSI' },
  btc:      { name: 'BTC',       placeholder: '85000', market: 'crypto', region: '加密貨幣', chart: 'COINBASE:BTCUSD' },
};

// ================================================================
//  PRICE SERVICE — Multi-Provider Architecture
// ================================================================
const PriceService = {
  PROXIES: [
    url => `${API_BASE}/api/proxy?url=${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  ],

  async _fetchTimeout(url, ms = 8000, opts = {}) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), ms);
    try { const r = await fetch(url, { ...opts, signal: ctrl.signal }); clearTimeout(tid); return r; }
    catch (e) { clearTimeout(tid); throw e; }
  },

  async _proxyFetch(url, timeout = 8000) {
    try { const r = await this._fetchTimeout(url, Math.min(timeout, 4000)); if (r.ok) return r; } catch (e) { console.debug('[Prism] Direct fetch failed:', url, e.message); }
    for (const mk of this.PROXIES) {
      try { const r = await this._fetchTimeout(mk(url), timeout); if (r.ok) return r; } catch (e) { console.debug('[Prism] Proxy fetch failed:', e.message); }
    }
    throw new Error('無法連線');
  },

  // ────────── PROVIDERS ──────────
  PROVIDER_INFO: {
    yahoo:    { name: 'Yahoo Finance',     desc: '全球市場 (透過代理，免金鑰)',     markets: 'tw,us', needsKey: false },
    twse:     { name: 'TWSE 證交所',       desc: '台灣即時報價 (僅台灣市場)',       markets: 'tw',    needsKey: false },
    tpex:     { name: 'TPEX 櫃買中心',     desc: '台灣上櫃即時 (僅台灣上櫃)',       markets: 'tw',    needsKey: false },
    finnhub:  { name: 'Finnhub',           desc: '美國即時 (需免費 API Key)',       markets: 'us',    needsKey: true, keyHint: '至 finnhub.io 免費註冊取得' },
  },

  // ── CME 期貨合約月份解析 ──
  // 季月合約: H=3月, M=6月, U=9月, Z=12月
  // 到期日 = 合約月份第三個週五；距到期 ≤14 天自動換月至下一季
  // Yahoo 上 CBOT 交易所的期貨用 .CBT 後綴，其餘用 .CME
  _cmeExchange: { YM: 'CBT', MYM: 'CBT' },
  // 取得當季 + 下季合約代號
  _cmeContractPair(base) {
    const now = new Date();
    const quarters = [
      { month: 3, code: 'H' }, { month: 6, code: 'M' },
      { month: 9, code: 'U' }, { month: 12, code: 'Z' },
    ];
    function thirdFriday(year, month) {
      const d = new Date(year, month - 1, 1);
      const firstDay = d.getDay();
      const firstFri = firstDay <= 5 ? (5 - firstDay + 1) : (5 + 7 - firstDay + 1);
      return new Date(year, month - 1, firstFri + 14);
    }
    const exch = this._cmeExchange[base] || 'CME';
    const all = [];
    for (let yOff = 0; yOff <= 1; yOff++) {
      const y = now.getFullYear() + yOff;
      for (const q of quarters) {
        const expiry = thirdFriday(y, q.month);
        if ((expiry - now) / 864e5 > -1) {
          all.push({ symbol: `${base}${q.code}${String(y).slice(-2)}.${exch}`, expiry });
        }
        if (all.length >= 2) break;
      }
      if (all.length >= 2) break;
    }
    return all;
  },

  // ── Yahoo Finance ──
  yahoo: {
    INDEX_MAP: { taiex: '^TWII', es: 'ES=F', nq: 'NQ=F', ym: 'YM=F', sox: '^SOX', nkd: 'NKD=F', kospi: '^KS11', shanghai: '000001.SS', hsi: '^HSI', vix: '^VIX', btc: 'BTC-USD' },
    async fetchQuote(symbol) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
      const r = await PriceService._proxyFetch(url);
      const m = (await r.json())?.chart?.result?.[0]?.meta;
      if (!m?.regularMarketPrice) throw new Error('No data');
      const price = m.regularMarketPrice, prev = m.chartPreviousClose || m.previousClose || price;
      const sourceTime = m.regularMarketTime ? m.regularMarketTime * 1000 : null;
      return { price, prevClose: prev, change: price - prev, changePct: prev ? ((price - prev) / prev * 100) : 0, currency: m.currency || '', name: m.shortName || m.symbol || '', sourceTime };
    },
    formatSymbol(code, market) {
      code = code.trim();
      if (market === 'tw' && !code.includes('.') && /^\d+[A-Za-z]?$/.test(code)) code += '.TW';
      return code;
    }
  },

  // ── TWSE 台灣證交所 (上市) ──
  twse: {
    INDEX_MAP: { taiex: 'tse_t00.tw' },
    async fetchQuote(symbol) {
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(symbol)}&_=${Date.now()}`;
      const r = await PriceService._proxyFetch(url);
      const items = (await r.json())?.msgArray || [];
      const item = items.find(i => i.z && i.z !== '-') || items[0];
      if (!item) throw new Error('查無資料');
      const price = parseFloat(item.z !== '-' ? item.z : '') || parseFloat(item.y) || 0;
      const prev = parseFloat(item.y) || price;
      if (!price) throw new Error('尚無成交');
      const sourceTime = item.tlong ? parseInt(item.tlong, 10) : null;
      return { price, prevClose: prev, change: price - prev, changePct: prev ? ((price - prev) / prev * 100) : 0, currency: 'TWD', name: item.nf || item.n || symbol, sourceTime };
    },
    formatSymbol(code) {
      code = code.trim();
      if (/^\d{4,6}[A-Za-z]?$/.test(code)) return `tse_${code}.tw|otc_${code}.tw`;
      return code;
    }
  },

  // ── TPEX 台灣櫃買中心 (上櫃) — 共用 TWSE MIS API ──
  tpex: {
    INDEX_MAP: {},
    async fetchQuote(symbol) { return PriceService.twse.fetchQuote(symbol); },
    formatSymbol(code) {
      code = code.trim();
      if (/^\d{4,6}[A-Za-z]?$/.test(code)) return `otc_${code}.tw`;
      return code;
    }
  },

  // ── Finnhub ──
  finnhub: {
    INDEX_MAP: { es: 'ES=F', nq: 'NQ=F', ym: 'YM=F', sox: 'SOXX' },
    async fetchQuote(symbol) {
      const key = CFG.finnhubKey;
      if (!key) throw new Error('需要 Finnhub API Key (請至設定填入)');
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
      const r = await PriceService._fetchTimeout(url, 8000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!d.c || d.c === 0) throw new Error('No data');
      const sourceTime = d.t ? d.t * 1000 : null;
      return { price: d.c, prevClose: d.pc, change: d.d || 0, changePct: d.dp || 0, currency: 'USD', name: symbol, sourceTime };
    },
    formatSymbol(code) { return code.trim().toUpperCase(); }
  },

  // ────────── ROUTING ──────────
  _getProvider(market) {
    const src = market === 'tw' ? CFG.twSource : CFG.usSource;
    return this[src] || this.yahoo;
  },

  async fetchIndex(key) {
    // 台指期走專屬 TAIFEX MIS API
    if (key === 'txf') return await this.fetchTxfQuote();

    // CME/CBOT 期貨：查當季+下季合約，取成交量較高者（=主力合約）
    const cmeBases = { es: 'ES', nq: 'NQ', ym: 'YM', nkd: 'NKD' };
    if (cmeBases[key]) {
      try {
        const pair = this._cmeContractPair(cmeBases[key]);
        const results = await Promise.all(pair.map(async p => {
          try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(p.symbol)}?range=1d&interval=1d`;
            const r = await this._proxyFetch(url);
            const m = (await r.json())?.chart?.result?.[0]?.meta;
            if (!m?.regularMarketPrice) return null;
            const price = m.regularMarketPrice, prev = m.chartPreviousClose || m.previousClose || price;
            const sourceTime = m.regularMarketTime ? m.regularMarketTime * 1000 : null;
            return { price, prevClose: prev, change: price - prev, changePct: prev ? ((price - prev) / prev * 100) : 0, currency: m.currency || '', name: INDEX_DEFS[key]?.name || m.shortName || '', sourceTime, volume: m.regularMarketVolume || 0, symbol: p.symbol };
          } catch { return null; }
        }));
        const valid = results.filter(Boolean);
        if (valid.length) {
          // 取成交量最高的合約
          valid.sort((a, b) => b.volume - a.volume);
          return valid[0];
        }
      } catch {}
      // fallback 泛用符號
      return await this.yahoo.fetchQuote(cmeBases[key] + '=F');
    }

    const market = INDEX_DEFS[key]?.market || 'us';
    const provider = (market === 'tw' || market === 'us') ? this._getProvider(market) : this.yahoo;
    const symbol = provider.INDEX_MAP?.[key];
    if (symbol) {
      try { return await provider.fetchQuote(symbol); }
      catch (e) {
        if (provider !== this.yahoo && this.yahoo.INDEX_MAP[key]) return await this.yahoo.fetchQuote(this.yahoo.INDEX_MAP[key]);
        throw e;
      }
    }
    // Provider doesn't have this index → fallback Yahoo
    if (this.yahoo.INDEX_MAP[key]) return await this.yahoo.fetchQuote(this.yahoo.INDEX_MAP[key]);
    throw new Error(`不支援: ${key}`);
  },

  async fetchAllIndices() {
    const results = {};
    const keys = Object.keys(CFG.indices).filter(k => CFG.indices[k]);
    // Fetch VIX for sentiment strip (not in INDEX_DEFS / ticker)
    if (CFG.showVix) keys.push('vix');
    await Promise.all(keys.map(async key => {
      try { results[key] = await this.fetchIndex(key); }
      catch (e) { results[key] = { error: e.message }; }
    }));
    return results;
  },

  async fetchStockQuote(code, market) {
    const provider = this._getProvider(market);
    const symbol = provider.formatSymbol(code, market);
    try { return await provider.fetchQuote(symbol); }
    catch (e) {
      if (provider !== this.yahoo) {
        const yfSymbol = this.yahoo.formatSymbol(code, market);
        try { return await this.yahoo.fetchQuote(yfSymbol); } catch {}
      }
      throw e;
    }
  },

  fmtChg(q) {
    if (!q || q.error) return '';
    const s = q.change >= 0 ? '+' : '';
    return `${s}${q.change.toFixed(2)} (${s}${q.changePct.toFixed(2)}%)`;
  },

  // ── Fear & Greed Index (CNN) ──
  async fetchFearGreed() {
    const url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
    try {
      // CNN API 需要 Referer header 才能通過（瀏覽器自帶 UA 和 Accept）
      const r = await this._fetchTimeout(url, 8000, {
        headers: { 'Referer': 'https://edition.cnn.com/' }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const fg = d?.fear_and_greed;
      if (!fg) throw new Error('No F&G data');
      const score = Math.round(fg.score);
      const prev = fg.previous_close ? Math.round(fg.previous_close) : null;
      return { score, previousClose: prev, timestamp: fg.timestamp };
    } catch (e) {
      throw new Error('F&G 無法取得');
    }
  },

  // ── Yahoo Finance symbol search (autocomplete) ──
  async searchSymbol(query) {
    if (!query || query.length < 1) return [];
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&listsCount=0`;
    try {
      const r = await this._proxyFetch(url, 5000);
      const d = await r.json();
      return (d.quotes || []).filter(q => q.symbol && (q.typeDisp === 'Equity' || q.typeDisp === 'ETF')).map(q => ({
        symbol: q.symbol, name: q.shortname || q.longname || '', exchange: q.exchDisp || '', type: q.typeDisp || ''
      }));
    } catch { return []; }
  },

  // ── TAIFEX 期交所保證金 ──
  // API 回傳的 Contract 名稱 → FP.tw 合約代碼
  TAIFEX_CONTRACT_MAP: {
    '臺股期貨': 'TX',
    '小型臺指': 'MTX',
    '客製化小型臺指期貨': 'MTX', // 同 MTX
    '微型臺指期貨': 'MXF',
    '電子期貨': 'TE',
    '小型電子期貨': 'STE',
    '金融期貨': 'TF',
    '小型金融期貨': 'STF',
    '非金電期貨': 'XIF',
    '櫃買期貨': 'TGF',
    '富櫃200期貨': 'G2F',
    '臺灣永續期貨': 'E4F',
    '臺灣生技期貨': 'BTF',
    '半導體30期貨': 'SOF',
    '航運期貨': 'SHF',
    '臺灣中型100期貨': 'GTF',
    '東證期貨': 'NK225F',
    '美國道瓊期貨': 'UDF',
    '美國標普500期貨': 'SPF',
    '美國那斯達克100期貨': 'UNF',
    '美國費城半導體期貨': 'USF',
    '英國富時100期貨': 'UKF',
  },

  // ── 指數期貨保證金 (解析 https://www.taifex.com.tw/cht/5/indexMarging) ──
  async fetchTaifexMargins() {
    const url = 'https://www.taifex.com.tw/cht/5/indexMarging';
    const r = await this._proxyFetch(url, 12000);
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // 找到包含保證金資料的表格（含「結算保證金」標頭的那一個）
    const tables = doc.querySelectorAll('table');
    let tbl = null;
    for (const t of tables) {
      if (t.textContent.includes('結算保證金') && t.textContent.includes('原始保證金')) { tbl = t; break; }
    }
    if (!tbl) throw new Error('無法解析保證金表格');

    const margins = {};
    let dataDate = '';
    // 嘗試從頁面抓取日期 (格式如 "2026/02/26")
    const dateMatch = html.match(/(\d{4}\/\d{2}\/\d{2})/);
    if (dateMatch) dataDate = dateMatch[1].replace(/\//g, '');

    const rows = tbl.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 4) continue;
      const name = cells[0].textContent.trim();
      const code = this.TAIFEX_CONTRACT_MAP[name];
      if (!code) continue;
      // 欄位順序: 商品別 | 結算保證金 | 維持保證金 | 原始保證金
      const mm = parseInt(cells[2].textContent.replace(/[,\s]/g, '')) || 0;
      const im = parseInt(cells[3].textContent.replace(/[,\s]/g, '')) || 0;
      if (im > 0) margins[code] = { im, mm };
    }
    if (Object.keys(margins).length === 0) throw new Error('無法取得保證金資料');
    return { margins, date: dataDate };
  },

  // ── 股票期貨保證金比例 (解析 https://www.taifex.com.tw/cht/5/stockMargining) ──
  // 回傳 { [CID]: { imRate, mmRate } }，如 { CDF: { imRate: 0.135, mmRate: 0.1035 } }
  async fetchStockFuturesMargins() {
    const url = 'https://www.taifex.com.tw/cht/5/stockMargining';
    const r = await this._proxyFetch(url, 12000);
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tables = doc.querySelectorAll('table');
    let tbl = null;
    for (const t of tables) {
      if (t.textContent.includes('股票期貨英文代碼') && t.textContent.includes('原始保證金適用比例')) { tbl = t; break; }
    }
    if (!tbl) throw new Error('無法解析股期保證金表格');

    const margins = {};
    const rows = tbl.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 9) continue;
      // 欄位: 序號 | 英文代碼 | 標的證券代號 | 中文簡稱 | 標的證券 | 級距 | 結算% | 維持% | 原始%
      const cid = cells[1].textContent.trim().toUpperCase();
      if (!cid || /[^A-Z0-9]/.test(cid)) continue;
      const mmRate = parseFloat(cells[7].textContent.replace(/[%\s]/g, '')) / 100 || 0;
      const imRate = parseFloat(cells[8].textContent.replace(/[%\s]/g, '')) / 100 || 0;
      if (imRate > 0) margins[cid] = { imRate, mmRate };
    }
    if (Object.keys(margins).length === 0) throw new Error('無法取得股期保證金資料');
    return margins;
  },

  // ── 判斷目前是否為夜盤時段 (15:00~隔日05:00 台灣時間) ──
  _getTaifexMarketType() {
    const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).getHours();
    return (h >= 15 || h < 5) ? '1' : '0';
  },

  // 盤別標籤
  _sessionLabel(marketType) {
    return marketType === '1' ? '夜盤 (15:00-05:00)' : '日盤 (08:45-13:45)';
  },

  // ── TAIFEX 取得報價原始資料 ──
  async _taifexFetchRaw(kindID, cid, marketType) {
    const url = 'https://mis.taifex.com.tw/futures/api/getQuoteList';
    const payload = { MarketType: marketType, SymbolType: 'F', KindID: kindID, CID: cid, WithGreeks: 'N', ShowLimitPrices: 'N' };
    const postOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };

    let data;
    try { const r = await this._fetchTimeout(url, 4000, postOpts); if (r.ok) data = await r.json(); } catch {}
    if (!data) { try { const r = await this._fetchTimeout(`${API_BASE}/api/proxy?url=${encodeURIComponent(url)}`, 8000, postOpts); if (r.ok) data = await r.json(); } catch {} }
    if (!data) { try { const r = await this._fetchTimeout(`https://corsproxy.io/?url=${encodeURIComponent(url)}`, 10000, postOpts); if (r.ok) data = await r.json(); } catch {} }
    if (!data) { const getUrl = url + '?' + new URLSearchParams(payload).toString(); const r = await this._proxyFetch(getUrl, 10000); data = await r.json(); }
    return data;
  },

  // ── 從 API 回傳資料解析報價 ──
  _taifexParseQuote(data, marketType, cid) {
    const list = data?.RtData?.QuoteList;
    if (!Array.isArray(list) || list.length === 0) return null;
    const suffix = marketType === '1' ? '-M' : '-F';
    const item = list.find(i => i.SymbolID && i.SymbolID.endsWith(suffix))
              || list.find(i => i.SymbolID && i.SymbolID.endsWith('-F'))
              || list[1] || list[0];
    const price = parseFloat(item.CLastPrice) || 0;
    const prev = parseFloat(item.CRefPrice) || price;
    if (!price) return null;
    const change = parseFloat(item.CDiff) || (price - prev);
    const changePct = parseFloat(item.CDiffRate) || (prev ? (change / prev * 100) : 0);
    const contractName = item.DispCName || cid;
    let sourceTime = null;
    if (item.CTime && item.CTime.length >= 6) {
      const cd = item.CDate || new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const y = cd.slice(0, 4), mo = cd.slice(4, 6), d = cd.slice(6, 8);
      const hh = item.CTime.slice(0, 2), mm = item.CTime.slice(2, 4), ss = item.CTime.slice(4, 6);
      const parsed = new Date(`${y}/${mo}/${d} ${hh}:${mm}:${ss}`);
      // 夜盤 CTime 00:00~05:00 實際是隔天凌晨，CDate 仍為交易日 → +1 天
      if (!isNaN(parsed) && marketType === '1' && parseInt(hh) < 5) {
        parsed.setDate(parsed.getDate() + 1);
      }
      sourceTime = isNaN(parsed) ? null : parsed.getTime();
    }
    return { price, prevClose: prev, change, changePct, currency: 'TWD', name: contractName, sourceTime, session: this._sessionLabel(marketType) };
  },

  // ── TAIFEX 期貨即時報價 (通用，自動取最新盤別) ──
  async _taifexQuote(kindID, cid, forceMarketType) {
    if (forceMarketType) {
      // 指定盤別：直接查詢，不做雙盤比較
      const data = await this._taifexFetchRaw(kindID, cid, forceMarketType);
      const result = this._taifexParseQuote(data, forceMarketType, cid);
      if (!result) throw new Error('無資料');
      return result;
    }
    // 自動偵測：同時查日盤+夜盤，取最新報價（處理週末/颱風假/國定假日）
    const [dayData, nightData] = await Promise.all([
      this._taifexFetchRaw(kindID, cid, '0').catch(() => null),
      this._taifexFetchRaw(kindID, cid, '1').catch(() => null),
    ]);
    const dayResult = dayData ? this._taifexParseQuote(dayData, '0', cid) : null;
    const nightResult = nightData ? this._taifexParseQuote(nightData, '1', cid) : null;
    if (!dayResult && !nightResult) throw new Error('無資料');
    if (!dayResult) return nightResult;
    if (!nightResult) return dayResult;
    // 兩邊都有資料 → 比較 sourceTime 取較新的
    if (nightResult.sourceTime && dayResult.sourceTime) {
      return nightResult.sourceTime >= dayResult.sourceTime ? nightResult : dayResult;
    }
    // 無法比較時間 → 依當前時段偏好
    const preferred = this._getTaifexMarketType();
    return preferred === '1' ? nightResult : dayResult;
  },

  // ── TAIFEX 台指期即時報價 (支援日盤/夜盤自動切換) ──
  async fetchTxfQuote() {
    return await this._taifexQuote('1', 'TXF');
  },

  // ── TAIFEX 股票期貨即時報價 (一般=KindID 4, 小型=KindID 8，僅日盤) ──
  async fetchStockFuturesQuote(cid, kindID) {
    return await this._taifexQuote(kindID || '4', cid, '0');
  },

};

let _taifexMarginDate = '';
let _stkFutMargins = {}; // { CID: { imRate, mmRate } } — 股期保證金比例快取

// ── Price Cache (localStorage 持久化，重新整理不重抓) ──
const _quoteCache = {
  _KEY: 'tg-quote-cache',
  _VER: 3, // 升版清除舊資料（v3: 修正 sourceTime）
  _mem: null,
  _load() {
    if (this._mem) return this._mem;
    try { this._mem = JSON.parse(localStorage.getItem(this._KEY)) || {}; } catch { this._mem = {}; }
    // 版本不符 → 清快取
    if (this._mem._ver !== this._VER) { this._mem = { _ver: this._VER }; this._save(); }
    if (!this._mem.indices) this._mem.indices = {};
    if (!this._mem.stocks) this._mem.stocks = {};
    // 初次載入時清除過期項目（超過 TTL 2 倍）
    const pruneAge = this._ttl() * 2;
    const now = Date.now();
    for (const bucket of ['indices', 'stocks']) {
      const b = this._mem[bucket];
      for (const k of Object.keys(b)) { if (b[k]?.time && now - b[k].time > pruneAge) delete b[k]; }
    }
    this._save();
    return this._mem;
  },
  _save() { try { localStorage.setItem(this._KEY, JSON.stringify(this._mem)); } catch (e) { console.warn('[Prism] Cache save failed:', e.message); } },
  // TTL: 依設定的 refreshInterval；若為 0（關閉自動更新）則 30 分鐘
  _ttl() { return (CFG.refreshInterval > 0 ? CFG.refreshInterval * 1000 : 1800000); },
  getIndex(key) {
    const c = this._load().indices[key];
    return (c && Date.now() - c.time < this._ttl()) ? c.data : null;
  },
  setIndex(key, data) { this._load().indices[key] = { data, time: Date.now() }; this._save(); },
  getStock(market, code) {
    const k = `${market}:${code.trim().toUpperCase()}`;
    const c = this._load().stocks[k];
    return (c && Date.now() - c.time < this._ttl()) ? c.data : null;
  },
  setStock(market, code, data) { const d = this._load(); d.stocks[`${market}:${code.trim().toUpperCase()}`] = { data, time: Date.now() }; this._save(); },
  // 取得所有 index 快取的最後更新時間
  lastIndexTime() {
    const d = this._load().indices;
    let latest = 0;
    for (const k of Object.keys(d)) { if (d[k]?.time > latest) latest = d[k].time; }
    return latest;
  },
  // 取得所有已快取的 index 資料（不檢查 TTL，用於頁面載入恢復顯示）
  getAllIndices() {
    const d = this._load().indices;
    const out = {};
    for (const [k, v] of Object.entries(d)) { if (v?.data) out[k] = v.data; }
    return out;
  },
  // Fear & Greed cache (30 min TTL)
  getFearGreed() {
    const c = this._load().fearGreed;
    return (c && Date.now() - c.time < 1800000) ? c.data : null;
  },
  setFearGreed(data) { this._load().fearGreed = { data, time: Date.now() }; this._save(); },
};

// ── Smart TAIFEX session check (skip fetches outside trading hours) ──
function _isTaifexTradingDay() {
  // Use Taipei timezone for accurate session detection
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = now.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const h = now.getHours();
  // TAIFEX day session: 8:45-13:45, after-hours: 15:00-次日5:00
  // Margin data updates after 14:30; skip 5:00-8:00 (no session, no updates)
  return h < 5 || h >= 8;
}

// ── TAIFEX margin fetch handler (指數 + 股期保證金) ──
window.fetchTaifexMarginBtn = async function() {
  const dateEl = $('#f-margin-date');
  if (dateEl) dateEl.textContent = '查詢中…';
  try {
    // 同時抓指數保證金 + 股期保證金比例
    const [indexResult, stkResult] = await Promise.all([
      PriceService.fetchTaifexMargins().catch(() => null),
      PriceService.fetchStockFuturesMargins().catch(() => null),
    ]);

    // 指數期貨保證金
    if (indexResult) {
      const { margins, date } = indexResult;
      Object.entries(margins).forEach(([code, { im, mm }]) => {
        if (FP.tw[code]) { FP.tw[code].im = im; FP.tw[code].mm = mm; }
      });
      const fmtDate = date ? (date.includes('/') ? date : `${date.slice(0,4)}/${date.slice(4,6)}/${date.slice(6,8)}`) : '';
      _taifexMarginDate = fmtDate;
      // Update current form fields
      const contract = $('#f-contract')?.value;
      if (contract && margins[contract]) {
        $('#f-im').value = margins[contract].im;
        $('#f-mm').value = margins[contract].mm;
        const imD = $('#f-im-display'), mmD = $('#f-mm-display');
        if (imD) imD.textContent = fmt(margins[contract].im);
        if (mmD) mmD.textContent = fmt(margins[contract].mm);
        const activeM = $('.eq-multi-btn.active');
        const mulVal = activeM ? parseInt(activeM.dataset.mul) : 3;
        const qty = parseInt($('#f-qty')?.value) || 1;
        $('#f-equity').value = margins[contract].im * qty * mulVal;
        $('#f-im').dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    // 股票期貨保證金比例
    if (stkResult) {
      _stkFutMargins = stkResult;
    }

    if (dateEl) dateEl.textContent = _taifexMarginDate ? `期交所 ${_taifexMarginDate}` : '已更新';
  } catch (e) {
    if (dateEl) dateEl.textContent = '查詢失敗';
    setTimeout(() => { if (dateEl) dateEl.textContent = _taifexMarginDate ? `期交所 ${_taifexMarginDate}` : ''; }, 3000);
  }
};

// ── Quote time stamp: show fetch time next to a field ──
function stampTime(fieldId, source, sourceTime, fetchTime) {
  const el = document.getElementById(fieldId);
  if (!el) return;
  const fg = el.closest('.fg');
  if (!fg) return;
  let span = fg.querySelector('.quote-time');
  if (!span) { span = document.createElement('span'); span.className = 'quote-time'; fg.appendChild(span); }
  const tFmt = { hour: '2-digit', minute: '2-digit' };
  const fetchStr = new Date(fetchTime || Date.now()).toLocaleTimeString('zh-TW', tFmt);
  if (sourceTime) {
    const srcStr = new Date(sourceTime).toLocaleTimeString('zh-TW', tFmt);
    span.textContent = `${source || '報價'} 報價 ${srcStr} · 抓取 ${fetchStr}`;
  } else {
    span.textContent = `${source || '報價'} 抓取 ${fetchStr}`;
  }
}

// ── Symbol Autocomplete ──
function setupAutocomplete(inputId, listId, onSelect, market) {
  const input = $(`#${inputId}`);
  const list = $(`#${listId}`);
  if (!input || !list) return;
  let items = [], focusIdx = -1, skipBlur = false;

  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 1) { list.classList.remove('open'); items = []; return; }
    // Try local StockDB first
    const mk = market || (S.options?.market) || (S.futures?.market) || 'us';
    const local = StockDB.search(mk, q);
    if (local.length > 0) {
      items = local.map(r => ({ symbol: r.code, name: r.name, exchange: r.leverage ? `${r.leverage}x` : '', type: 'local' }));
    } else {
      // Fallback to Yahoo search
      items = await PriceService.searchSymbol(q);
    }
    focusIdx = -1;
    if (items.length === 0) { list.classList.remove('open'); return; }
    list.innerHTML = items.map((r, i) =>
      `<div class="sym-ac-item" data-i="${i}"><span class="sym-code">${_esc(r.symbol)}</span><span class="sym-name">${_esc(r.name)}</span><span class="sym-exch">${_esc(r.exchange)}</span></div>`
    ).join('');
    list.classList.add('open');
  }, 200);

  input.addEventListener('input', search);
  input.addEventListener('focus', () => { if (items.length > 0) list.classList.add('open'); });
  input.addEventListener('blur', () => { if (!skipBlur) setTimeout(() => list.classList.remove('open'), 150); skipBlur = false; });

  input.addEventListener('keydown', e => {
    if (!list.classList.contains('open') || items.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); focusIdx = Math.min(focusIdx + 1, items.length - 1); updateFocus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusIdx = Math.max(focusIdx - 1, 0); updateFocus(); }
    else if (e.key === 'Enter' && focusIdx >= 0) { e.preventDefault(); pick(focusIdx); }
    else if (e.key === 'Escape') { list.classList.remove('open'); }
  });

  list.addEventListener('mousedown', e => {
    skipBlur = true;
    const item = e.target.closest('.sym-ac-item');
    if (item) pick(parseInt(item.dataset.i));
  });

  function updateFocus() {
    $$('.sym-ac-item', list).forEach((el, i) => el.classList.toggle('focused', i === focusIdx));
    const focused = list.children[focusIdx];
    if (focused) focused.scrollIntoView({ block: 'nearest' });
  }
  function pick(i) {
    const r = items[i];
    if (!r) return;
    input.value = r.symbol.replace(/\.TW$/, '');
    list.classList.remove('open');
    items = [];
    if (onSelect) onSelect(r);
  }
}

// ── Debounce ──
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── Wrap number inputs with external +/− buttons ──
function wrapNumberInputs(container) {
  container.querySelectorAll('input[type="number"]').forEach(input => {
    if (input.closest('.num-wrap')) return;
    const isQty = /qty/i.test(input.id);
    // Non-qty fields: add inputmode for mobile numeric keyboard, hide native spinners
    if (!isQty) {
      input.setAttribute('inputmode', 'decimal');
      return;
    }
    // Qty fields: wrap with +/- buttons
    const isuf = input.closest('.isuf');
    const target = isuf || input;
    const parent = target.parentElement;

    const wrap = document.createElement('div');
    wrap.className = 'num-wrap';

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'num-btn';
    minus.textContent = '−';

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'num-btn';
    plus.textContent = '+';

    parent.insertBefore(wrap, target);
    wrap.appendChild(minus);
    wrap.appendChild(target);
    wrap.appendChild(plus);

    const getStep = () => {
      const s = parseFloat(input.step);
      if (!isNaN(s) && s > 0 && input.step !== 'any') return s;
      return 1;
    };

    const adjust = (dir) => {
      const step = getStep();
      const cur = parseFloat(input.value) || 0;
      const next = Math.max(parseFloat(input.min) || 0, cur + step * dir);
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    minus.addEventListener('click', () => adjust(-1));
    plus.addEventListener('click', () => adjust(1));

    let _holdTimer = null, _holdInterval = null;
    const startHold = (dir) => {
      _holdTimer = setTimeout(() => {
        _holdInterval = setInterval(() => adjust(dir), 80);
      }, 400);
    };
    const stopHold = () => { clearTimeout(_holdTimer); clearInterval(_holdInterval); };
    [minus, plus].forEach((btn, i) => {
      const dir = i === 0 ? -1 : 1;
      btn.addEventListener('pointerdown', () => startHold(dir));
      btn.addEventListener('pointerup', stopHold);
      btn.addEventListener('pointerleave', stopHold);
    });
  });
}

// ── Settings (persisted in localStorage) ──
const DEFAULT_SETTINGS = {
  theme: 'dark',               // 'dark' | 'light' | 'midnight' | 'emerald' | 'warm'
  autoFetch: true,
  refreshInterval: 10,
  indices: { taiex: true, txf: true, es: true, nq: true, ym: true, sox: true, nkd: true, kospi: true, shanghai: true, hsi: true, btc: true },
  showVix: true,
  showFearGreed: true,
  defaultMarket: 'tw',
  twSource: 'twse',        // 'yahoo' | 'twse' | 'tpex'
  usSource: 'yahoo',       // 'yahoo' | 'finnhub'
  finnhubKey: '',
  fontScale: 'm',          // 'xs' | 's' | 'm' | 'l' | 'xl'
  // 台灣股票
  twFeeDisc: '0.5',        // 手續費折扣
  twTaxRate: '0.003',      // 證交稅率
  // 美國股票
  usComm: '0',             // Commission per trade
  // 台灣期貨
  twFutComm: '60',         // 指數期貨手續費 (元/口)
  twStkFutComm: '40',      // 股票期貨手續費 (元/口)
  // 台灣選擇權
  twOptComm: '25',         // 選擇權手續費 (元/口)
  // 美國期貨
  usFutComm: '2.25',       // 期貨 Commission (USD/口)
  // 美國選擇權
  usOptComm: '0.65',       // 選擇權 Commission (USD/口)
  // 交易紀錄
  defaultFee: '',          // 預設手續費 (元)
  defaultTax: '',          // 預設交易稅 (元)
  // 交易前檢查清單
  checklist: [],           // string[] 自訂檢查項目
};
function mergeSettings(raw) {
  return { ...DEFAULT_SETTINGS, ...raw, indices: { ...DEFAULT_SETTINGS.indices, ...(raw.indices || {}) },
    fontScale: raw.fontScale || DEFAULT_SETTINGS.fontScale,
    checklist: Array.isArray(raw.checklist) ? raw.checklist : DEFAULT_SETTINGS.checklist };
}
function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('tg-settings')) || {};
    return mergeSettings(raw);
  } catch { return { ...DEFAULT_SETTINGS }; }
}
// Keys that stay local-only (not synced to cloud)
const LOCAL_ONLY_KEYS = ['fontScale'];
function saveSettings(s) {
  try { localStorage.setItem('tg-settings', JSON.stringify(s)); }
  catch (e) { console.warn('[Prism] localStorage save failed:', e.message); }
  // Sync to server if logged in (fire-and-forget)
  const token = localStorage.getItem('prism_token');
  if (token) {
    const cloud = Object.fromEntries(Object.entries(s).filter(([k]) => !LOCAL_ONLY_KEYS.includes(k)));
    fetch(`${API_BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ settings: cloud }),
    }).catch(e => console.debug('[Prism] Settings sync failed:', e.message));
  }
}
// Load settings from server (called after login)
async function loadSettingsFromServer() {
  const token = localStorage.getItem('prism_token');
  if (!token) return;
  try {
    const res = await fetch(`${API_BASE}/api/settings`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.settings && Object.keys(data.settings).length > 0) {
      const localOnly = {};
      LOCAL_ONLY_KEYS.forEach(k => { localOnly[k] = CFG[k]; });
      CFG = mergeSettings({ ...data.settings, ...localOnly });
      localStorage.setItem('tg-settings', JSON.stringify(CFG));
      applySettings();
    }
  } catch (e) { console.warn('[Prism] Cloud settings load failed:', e.message); }
}
window.loadSettingsFromServer = loadSettingsFromServer;
let CFG = loadSettings();
let _refreshTimer = null;

// ── State ──
const _savedS = (() => { try { return JSON.parse(localStorage.getItem('prism_state')); } catch { return null; } })();
const S = _savedS || {
  margin: { market: 'tw', direction: 'cash' },
  futures: { market: 'tw', direction: 'long', product: 'index' },
  options: { market: 'tw', side: 'buyer', product: 'index' },
  activeTab: 'margin'
};
if (!S.activeTab) S.activeTab = 'margin';
function _saveState() { localStorage.setItem('prism_state', JSON.stringify(S)); }

// ── Presets ──
const FP = {
  tw: {
    TX:   { name: '臺股期貨 (大台)',    mul: 200, im: 412000, mm: 316000, u: '點' },
    MTX:  { name: '小型臺指 (小台)',    mul: 50,  im: 103000, mm: 79000,  u: '點' },
    MXF:  { name: '微型臺指 (微台)',    mul: 10,  im: 20600,  mm: 15800,  u: '點' },
    TE:   { name: '電子期貨',          mul: 4000,im: 576000, mm: 441000, u: '點' },
    TF:   { name: '金融期貨',          mul: 1000,im: 122000, mm: 94000,  u: '點' },
    STK:  { name: '股票期貨',          mul: 2000,im: 0,      mm: 0,      u: '元' },
  },
  us: {
    ES:  { name: 'E-mini S&P 500',    mul: 50,  im: 12650,  mm: 11500,  u: 'pts' },
    NQ:  { name: 'E-mini Nasdaq 100', mul: 20,  im: 16500,  mm: 15000,  u: 'pts' },
    MES: { name: 'Micro E-mini S&P',  mul: 5,   im: 1265,   mm: 1150,   u: 'pts' },
    MNQ: { name: 'Micro E-mini NQ',   mul: 2,   im: 1650,   mm: 1500,   u: 'pts' },
    YM:  { name: 'E-mini Dow',        mul: 5,   im: 9000,   mm: 8200,   u: 'pts' },
    MYM: { name: 'Micro E-mini Dow',  mul: 0.5, im: 900,    mm: 820,    u: 'pts' },
  }
};

// ── 台灣股票期貨預設清單 (TAIFEX 商品代碼) ──
const STOCK_FUTURES = {
  CDF: { name: '台積電', stock: '2330', mul: 2000, kind: '4' },
  QFF: { name: '小台積電', stock: '2330', mul: 100, kind: '8' },
  DHF: { name: '鴻海', stock: '2317', mul: 2000, kind: '4' },
  DVF: { name: '聯發科', stock: '2454', mul: 2000, kind: '4' },
  PUF: { name: '小聯發科', stock: '2454', mul: 100, kind: '8' },
  FRF: { name: '台達電', stock: '2308', mul: 2000, kind: '4' },
  RVF: { name: '小台達電', stock: '2308', mul: 100, kind: '8' },
  DJF: { name: '華碩', stock: '2357', mul: 2000, kind: '4' },
  QRF: { name: '小華碩', stock: '2357', mul: 100, kind: '8' },
  OPF: { name: '智邦', stock: '2345', mul: 2000, kind: '4' },
  SEF: { name: '小智邦', stock: '2345', mul: 100, kind: '8' },
};

const ETF_PRESETS = {
  tw: [
    { code: '0050', name: '元大台灣50', leverage: 1, index: 'taiex' },
    { code: '006208', name: '富邦台50', leverage: 1, index: 'taiex' },
    { code: '00631L', name: '元大台灣50正2', leverage: 2, index: 'taiex' },
    { code: '00632R', name: '元大台灣50反1', leverage: -1, index: 'taiex' },
    { code: '00675L', name: 'S&P500正2', leverage: 2, index: 'es' },
    { code: '00670L', name: '美國道瓊正2', leverage: 2, index: 'ym' },
  ],
  us: [
    { code: 'SPY', name: 'SPDR S&P 500', leverage: 1, index: 'es' },
    { code: 'QQQ', name: 'Invesco Nasdaq', leverage: 1, index: 'nq' },
    { code: 'TQQQ', name: 'ProShares 3x QQQ', leverage: 3, index: 'nq' },
    { code: 'SQQQ', name: 'ProShares -3x QQQ', leverage: -3, index: 'nq' },
    { code: 'SPXL', name: 'Direxion 3x S&P', leverage: 3, index: 'es' },
    { code: 'UPRO', name: 'ProShares 3x S&P', leverage: 3, index: 'es' },
    { code: 'SOXL', name: 'Direxion 3x 費半', leverage: 3, index: 'sox' },
    { code: 'SOXS', name: 'Direxion -3x 費半', leverage: -3, index: 'sox' },
    { code: 'DIA', name: 'SPDR Dow Jones', leverage: 1, index: 'ym' },
    { code: 'UDOW', name: 'ProShares 3x Dow', leverage: 3, index: 'ym' },
  ]
};

// ── Stock Database (local autocomplete) ──
const StockDB = {
  _key: 'prism_stock_db',
  _get() { try { return JSON.parse(localStorage.getItem(this._key)) || {}; } catch { return {}; } },
  _set(data) { localStorage.setItem(this._key, JSON.stringify(data)); },
  getList(market) { return this._get()[market]?.list || []; },
  getTime(market) { return this._get()[market]?.time || 0; },

  async fetchTW() {
    // TWSE listed stocks (證交所上市)
    const url1 = 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L';
    // TPEX OTC stocks (櫃買中心上櫃)
    const url2 = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis';
    const list = [];
    try {
      const r1 = await PriceService._proxyFetch(url1, 10000);
      const d1 = await r1.json();
      for (const s of d1) {
        if (s['公司代號'] && s['公司簡稱']) list.push({ code: s['公司代號'].trim(), name: s['公司簡稱'].trim() });
      }
    } catch {}
    try {
      const r2 = await PriceService._proxyFetch(url2, 10000);
      const d2 = await r2.json();
      for (const s of d2) {
        if (s['SecuritiesCompanyCode'] && s['CompanyName']) list.push({ code: s['SecuritiesCompanyCode'].trim(), name: s['CompanyName'].trim() });
      }
    } catch {}
    // Add ETF presets that may not be in the API
    for (const p of (ETF_PRESETS.tw || [])) {
      if (!list.find(s => s.code === p.code)) list.push({ code: p.code, name: p.name });
    }
    // Add stock futures underlyings (from hardcoded presets)
    for (const [, v] of Object.entries(STOCK_FUTURES)) {
      if (!list.find(s => s.code === v.stock)) list.push({ code: v.stock, name: v.name });
    }
    const db = this._get();
    db.tw = { list, time: Date.now() };
    this._set(db);

    return list.length;
  },

  async fetchTaifexOnly() {
    const url = 'https://www.taifex.com.tw/cht/5/stockMargining';
    const r = await PriceService._proxyFetch(url, 15000);
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tables = doc.querySelectorAll('table');
    let tbl = null;
    for (const t of tables) {
      if (t.textContent.includes('股票期貨英文代碼') && t.textContent.includes('原始保證金適用比例')) { tbl = t; break; }
    }
    if (!tbl) throw new Error('無法解析股期表格');
    const futures = [];
    const rows = tbl.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 9) continue;
      const cid = cells[1].textContent.trim().toUpperCase();
      const stockCode = cells[2].textContent.trim();
      const name = cells[3].textContent.trim();
      if (!cid || /[^A-Z0-9]/.test(cid) || !stockCode) continue;
      const imRate = parseFloat(cells[8].textContent.replace(/[%\s]/g, '')) / 100 || 0;
      const mmRate = parseFloat(cells[7].textContent.replace(/[%\s]/g, '')) / 100 || 0;
      futures.push({ code: cid, stock: stockCode, name, imRate, mmRate, mul: STOCK_FUTURES[cid]?.mul || 2000, kind: STOCK_FUTURES[cid]?.kind || '4' });
    }
    if (futures.length === 0) throw new Error('無資料');
    const db = this._get();
    db.twFutures = { list: futures, time: Date.now() };
    this._set(db);
    return futures.length;
  },

  getTaifexFutures() {
    return this._get().twFutures?.list || [];
  },
  getTaifexFuturesTime() {
    return this._get().twFutures?.time || 0;
  },

  async fetchUS() {
    const list = [];
    // Try multiple sources for US stock list
    const sources = [
      // 1. SEC EDGAR
      async () => {
        const r = await PriceService._proxyFetch('https://www.sec.gov/files/company_tickers.json', 15000);
        const d = await r.json();
        for (const v of Object.values(d)) {
          if (v.ticker && v.title) list.push({ code: v.ticker.toUpperCase(), name: v.title });
        }
      },
      // 2. Nasdaq screener CSV (NYSE + NASDAQ)
      async () => {
        for (const ex of ['nasdaq', 'nyse']) {
          const r = await PriceService._proxyFetch(`https://api.nasdaq.com/api/screener/stocks?tableType=earnings&limit=5000&exchange=${ex}`, 15000);
          const d = await r.json();
          for (const row of (d?.data?.table?.rows || [])) {
            if (row.symbol && row.name) {
              const code = row.symbol.trim().toUpperCase();
              if (!list.find(s => s.code === code)) list.push({ code, name: row.name.trim() });
            }
          }
        }
      },
    ];
    for (const src of sources) {
      try { await src(); if (list.length > 100) break; } catch {}
    }
    // Add ETF presets
    for (const p of (ETF_PRESETS.us || [])) {
      if (!list.find(s => s.code === p.code)) list.push({ code: p.code, name: p.name });
    }
    const db = this._get();
    db.us = { list, time: Date.now() };
    this._set(db);
    return list.length;
  },

  search(market, query) {
    if (!query) return [];
    const q = query.toUpperCase();
    const list = this.getList(market);
    // ETF_PRESETS first (have leverage info)
    const presets = (ETF_PRESETS[market] || []).filter(p =>
      p.code.toUpperCase().includes(q) || p.name.toUpperCase().includes(q)
    ).map(p => ({ code: p.code, name: p.name, leverage: p.leverage, source: 'preset' }));
    // Then local DB — use Set for O(1) dedup
    const presetCodes = new Set(presets.map(p => p.code));
    const local = [];
    for (const s of list) {
      if (local.length >= 15) break;
      if (presetCodes.has(s.code)) continue;
      if (s.code.toUpperCase().includes(q) || s.name.toUpperCase().includes(q)) {
        local.push({ code: s.code, name: s.name, source: 'db' });
      }
    }
    return [...presets, ...local].slice(0, 12);
  },

  // Search stock futures by stock code or name (presets + TAIFEX DB)
  searchStockFutures(query) {
    if (!query) return [];
    const q = query.toUpperCase();
    // Start with hardcoded presets
    const results = Object.entries(STOCK_FUTURES).filter(([k, v]) =>
      k.toUpperCase().includes(q) || v.name.includes(query) || v.stock.includes(query)
    ).map(([k, v]) => ({ code: k, name: `${v.name} (${v.stock})`, mul: v.mul, stock: v.stock }));
    // Add from TAIFEX database (skip duplicates) — use Set for O(1) lookup
    const seen = new Set(results.map(r => r.code));
    const taifex = this.getTaifexFutures();
    for (const f of taifex) {
      if (seen.has(f.code)) continue;
      if (f.code.toUpperCase().includes(q) || f.name.includes(query) || f.stock.includes(query)) {
        results.push({ code: f.code, name: `${f.name} (${f.stock})`, mul: f.mul, stock: f.stock });
        seen.add(f.code);
      }
    }
    return results.slice(0, 12);
  },

  // Detect ETF leverage from presets
  detectLeverage(market, code) {
    const p = (ETF_PRESETS[market] || []).find(e => e.code.toUpperCase() === code.toUpperCase());
    return p ? p.leverage : null;
  }
};
window.StockDB = StockDB;

// ── Builders ──
function subTabs(prefix, tabs, contents) {
  let h = '<div class="sub-tabs">';
  tabs.forEach((t, i) => { h += `<button class="sub-tab${i === 0 ? ' active' : ''}" data-stab="${prefix}-${i}">${t}</button>`; });
  h += '</div>';
  contents.forEach((c, i) => { h += `<div class="sub-pane${i === 0 ? ' active' : ''}" id="${prefix}-${i}">${c}</div>`; });
  return h;
}

function riskBar(label, value, statusText, level, fillPct) {
  const colors = { safe: 'var(--green)', caution: 'var(--yellow)', danger: 'var(--orange)', critical: 'var(--red)' };
  const fp = Math.max(0, Math.min(100, fillPct));
  return `<div class="risk-bar-wrap"><div class="risk-bar-info risk-${level}"><div class="risk-bar-label">${label}</div><div class="risk-bar-value">${value}</div><div class="risk-bar-status">${statusText}</div></div><div class="risk-bar-col"><div class="risk-bar-track"><div class="risk-bar-fill" style="width:${fp}%;background:${colors[level]}"></div></div></div></div>`;
}

function alertBox(level, msg) {
  const cls = level === 'safe' ? 'alert-safe' : level === 'caution' || level === 'warning' ? 'alert-warn' : 'alert-danger';
  return `<div class="alert ${cls}">${level === 'safe' ? OK_SVG : WARN_SVG}<span>${msg}</span></div>`;
}

function mc(label, value, sub, hl) {
  return `<div class="mc${hl ? ' ' + hl : ''}"><div class="ml">${label}</div><div class="mv">${value}</div>${sub ? `<div class="ms">${sub}</div>` : ''}</div>`;
}
function mgLabel(text) { return `<div class="mg-label">${text}</div>`; }

/** Cost breakdown table
 *  items: [{ name, detail?, amt }]  — detail is optional calculation note
 *  total: formatted total string
 *  netPL: { label, value (formatted), positive (bool) } — optional net P&L row
 */
function costTable(items, total, netPL) {
  let rows = items.filter(i => i).map(i =>
    `<div class="cost-row"><div class="cost-left"><span class="cost-name">${i.name}</span>${i.detail ? `<span class="cost-detail">${i.detail}</span>` : ''}</div><span class="cost-amt">${i.amt}</span></div>`
  ).join('');
  rows += `<div class="cost-total"><span class="cost-name">合計</span><span class="cost-amt">${total}</span></div>`;
  if (netPL) rows += `<div class="cost-net ${netPL.positive ? 'profit' : 'loss'}"><span class="cost-name">${netPL.label}</span><span class="cost-amt">${netPL.value}</span></div>`;
  return `<div class="cost-box"><div class="cost-title"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 9h-2v2H9v-2H7v-2h2V7h2v2h2v2zm3 6H8v-2h8v2zm0-4h-1v-2h1v2zM13 9V3.5L18.5 9H13z"/></svg>交易成本明細</div>${rows}</div>`;
}

// ================================================================
//  BUILD TICKER BAR (dynamic from INDEX_DEFS)
// ================================================================
function _getTickerOrder() {
  return CFG.tickerOrder || null;
}
function _saveTickerOrder() {
  const chips = document.querySelectorAll('.ticker-chip[data-idx]');
  CFG.tickerOrder = [...chips].map(c => c.dataset.idx);
  saveSettings(CFG);
}

function buildTickerBar() {
  const container = $('#ticker-inputs');
  if (!container) return;
  const saved = _getTickerOrder();
  let keys = Object.keys(INDEX_DEFS);
  if (saved && saved.length) {
    const set = new Set(keys);
    const ordered = saved.filter(k => set.has(k));
    keys.forEach(k => { if (!ordered.includes(k)) ordered.push(k); });
    keys = ordered;
  }
  container.innerHTML = keys.map(key => {
    const def = INDEX_DEFS[key];
    const show = CFG.indices[key] !== false;
    const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(def.chart)}`;
    return `<a class="ticker-chip" data-idx="${key}" style="${show ? '' : 'display:none'}" href="${tvUrl}" target="_blank" rel="noopener" title="在 TradingView 開啟 ${def.name}" draggable="true">
      <span class="tc-name">${def.name}</span>
      <span class="tc-price stale" id="disp-${key}">—</span>
      <span class="tc-chg" id="chg-${key}"></span>
      ${key === 'txf' ? '<span class="ticker-basis" id="ticker-basis"></span>' : ''}
      <input type="hidden" id="idx-${key}">
    </a>`;
  }).join('');
  _initTickerDrag(container);
}

// 報價卡片拖曳排序（桌面 drag & 手機 touch）
let _tickerDragAC = null;
function _initTickerDrag(container) {
  if (_tickerDragAC) _tickerDragAC.abort();
  _tickerDragAC = new AbortController();
  const sig = { signal: _tickerDragAC.signal };
  let dragEl = null, placeholder = null, touchStartY = 0, touchStartX = 0, isDragging = false;

  // ── Desktop drag ──
  container.addEventListener('dragstart', e => {
    const chip = e.target.closest('.ticker-chip');
    if (!chip) return;
    dragEl = chip;
    chip.classList.add('ticker-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  }, sig);
  container.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.ticker-chip');
    if (!target || target === dragEl) return;
    const rect = target.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    if (e.clientX < mid) container.insertBefore(dragEl, target);
    else container.insertBefore(dragEl, target.nextSibling);
  }, sig);
  container.addEventListener('dragend', () => {
    if (dragEl) { dragEl.classList.remove('ticker-dragging'); dragEl = null; }
    _saveTickerOrder();
    _remeasureTickerRow();
  }, sig);

  // ── Mobile touch ──
  container.addEventListener('touchstart', e => {
    const chip = e.target.closest('.ticker-chip');
    if (!chip) return;
    const t = e.touches[0];
    touchStartX = t.clientX; touchStartY = t.clientY;
    isDragging = false;
    dragEl = chip;
  }, { passive: true, ...sig });

  container.addEventListener('touchmove', e => {
    if (!dragEl) return;
    const t = e.touches[0];
    if (!isDragging) {
      const dx = Math.abs(t.clientX - touchStartX), dy = Math.abs(t.clientY - touchStartY);
      if (dx < 8 && dy < 8) return; // threshold
      isDragging = true;
      dragEl.classList.add('ticker-dragging');
      e.preventDefault(); // prevent scroll once dragging
    }
    if (isDragging) {
      e.preventDefault();
      const el = document.elementFromPoint(t.clientX, t.clientY)?.closest('.ticker-chip');
      if (el && el !== dragEl) {
        const rect = el.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        if (t.clientX < mid) container.insertBefore(dragEl, el);
        else container.insertBefore(dragEl, el.nextSibling);
      }
    }
  }, { passive: false, ...sig });

  container.addEventListener('touchend', e => {
    if (dragEl) {
      if (isDragging) {
        e.preventDefault(); // prevent click/navigation after drag
        dragEl.classList.remove('ticker-dragging');
        _saveTickerOrder();
        _remeasureTickerRow();
      }
      dragEl = null;
      isDragging = false;
    }
  }, sig);
}

function _remeasureTickerRow() {
  requestAnimationFrame(() => {
    const chips = document.querySelectorAll('.ticker-chip');
    if (chips.length) {
      let maxH = 0;
      for (const c of chips) { const h = c.offsetHeight; if (h > maxH) maxH = h; }
      document.querySelector('.ticker-strip')?.style.setProperty('--ticker-row-h', (maxH + 4) + 'px');
    }
  });
}

// 手機版報價欄展開/收合
function _initTickerToggle() {
  const btn = $('#btn-ticker-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const bar = btn.closest('.ticker-bar');
    if (!bar) return;
    const expanded = bar.classList.toggle('expanded');
    btn.setAttribute('aria-label', expanded ? '收合報價' : '展開報價');
  });
  _remeasureTickerRow();
}

// 計算台指期 vs 加權指數的正逆價差
function _updateBasis(results) {
  const el = $('#ticker-basis');
  if (!el) return;
  const taiex = results?.taiex || _quoteCache.getIndex('taiex');
  const txf = results?.txf || _quoteCache.getIndex('txf');
  if (!taiex || taiex.error || !txf || txf.error) { el.textContent = ''; return; }
  const basis = txf.price - taiex.price;
  const label = basis >= 0 ? '正價差' : '逆價差';
  el.textContent = `${label} ${basis >= 0 ? '+' : ''}${basis.toFixed(0)}`;
  el.className = `ticker-basis ${basis >= 0 ? 'up' : 'down'}`;
  _remeasureTickerRow();
}

// 更新 ticker 時間顯示（抓取時間 + 來源最後報價時間）
function _updateTickerTime(results) {
  const timeEl = $('#ticker-time');
  if (!timeEl) return;
  const tFmt = { hour: '2-digit', minute: '2-digit' };
  // 來源端最後報價時間：取所有指數中最新的 sourceTime
  let latestSrc = 0;
  for (const [, q] of Object.entries(results || {})) {
    if (q && !q.error && q.sourceTime && q.sourceTime > latestSrc) latestSrc = q.sourceTime;
  }
  const now = new Date().toLocaleTimeString('zh-TW', tFmt);
  if (latestSrc) {
    const src = new Date(latestSrc).toLocaleTimeString('zh-TW', tFmt);
    timeEl.innerHTML = `<span>報價 ${src}</span><span>抓取 ${now}</span>`;
  } else {
    const lastT = _quoteCache.lastIndexTime();
    const fetchT = lastT ? new Date(lastT).toLocaleTimeString('zh-TW', tFmt) : now;
    timeEl.innerHTML = `<span>抓取 ${fetchT}</span>`;
  }
}

// ================================================================
//  SENTIMENT STRIP — VIX Gauge + Fear & Greed
// ================================================================
function _vixLevel(v) {
  if (v <= 12) return { label: '極低波動', cls: 'sent-low', color: 'var(--green)' };
  if (v <= 20) return { label: '正常', cls: 'sent-normal', color: 'var(--accent)' };
  if (v <= 30) return { label: '偏高', cls: 'sent-elevated', color: 'var(--yellow)' };
  if (v <= 40) return { label: '高波動', cls: 'sent-high', color: 'var(--orange)' };
  return { label: '極度恐慌', cls: 'sent-extreme', color: 'var(--red)' };
}

function _fgLevel(score) {
  if (score <= 25) return { label: '極度恐懼', cls: 'sent-extreme', color: 'var(--red)' };
  if (score <= 44) return { label: '恐懼', cls: 'sent-high', color: 'var(--orange)' };
  if (score <= 55) return { label: '中立', cls: 'sent-normal', color: 'var(--accent)' };
  if (score <= 74) return { label: '貪婪', cls: 'sent-elevated', color: 'var(--yellow)' };
  return { label: '極度貪婪', cls: 'sent-low', color: 'var(--green)' };
}

function _renderSentimentStrip() {
  const strip = $('#sentiment-strip');
  if (!strip) return;

  // VIX from cache or ticker
  const vixQ = _quoteCache.getIndex('vix');
  const vixVal = vixQ?.price;

  // Fear & Greed from cache
  const fgData = _quoteCache.getFearGreed();

  const showVix = vixVal && CFG.showVix !== false;
  const showFg = fgData && CFG.showFearGreed !== false;
  if (!showVix && !showFg) {
    strip.style.display = 'none';
    return;
  }
  strip.style.display = '';

  let html = '';

  const tFmt = { hour: '2-digit', minute: '2-digit', second: '2-digit' };

  // VIX gauge
  if (vixVal && CFG.showVix !== false) {
    const lv = _vixLevel(vixVal);
    const pct = Math.min(vixVal / 80 * 100, 100);
    const vixChg = vixQ.change != null ? vixQ.change : null;
    const vixChgHtml = vixChg != null ? `<span class="sent-chg ${vixChg <= 0 ? 'up' : 'down'}">${vixChg >= 0 ? '+' : ''}${vixChg.toFixed(2)}</span>` : '';
    const vixCache = _quoteCache._load().indices.vix;
    const vixFetchStr = vixCache?.time ? new Date(vixCache.time).toLocaleTimeString('zh-TW', tFmt) : '';
    const vixSrcStr = vixQ.sourceTime ? new Date(vixQ.sourceTime).toLocaleTimeString('zh-TW', tFmt) : '';
    const vixTip = vixSrcStr
      ? `來源報價時間：${vixSrcStr}\n本地抓取時間：${vixFetchStr}`
      : (vixFetchStr ? `本地抓取時間：${vixFetchStr}` : '');
    html += `<a class="sent-gauge" title="${vixTip}" href="https://www.tradingview.com/chart/?symbol=CBOE%3AVIX" target="_blank" rel="noopener">
      <div class="sent-label">VIX 恐慌指數</div>
      <div class="sent-value" style="color:${lv.color}">${vixVal.toFixed(2)} ${vixChgHtml}</div>
      <div class="sent-track sent-vix-track"><div class="sent-fill" style="width:${pct}%"></div></div>
      <div class="sent-tag" style="color:${lv.color}">${lv.label}</div>
    </a>`;
  }

  // Fear & Greed gauge
  if (fgData && CFG.showFearGreed !== false) {
    const lv = _fgLevel(fgData.score);
    const pct = fgData.score;
    const chg = fgData.previousClose != null ? fgData.score - fgData.previousClose : null;
    const chgHtml = chg != null ? `<span class="sent-chg ${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '+' : ''}${chg}</span>` : '';
    const fgCache = _quoteCache._load().fearGreed;
    const fgFetchStr = fgCache?.time ? new Date(fgCache.time).toLocaleTimeString('zh-TW', tFmt) : '';
    const fgSrcStr = fgData.timestamp ? new Date(fgData.timestamp).toLocaleTimeString('zh-TW', tFmt) : '';
    const fgTip = fgSrcStr
      ? `來源報價時間：${fgSrcStr}\n本地抓取時間：${fgFetchStr}`
      : (fgFetchStr ? `本地抓取時間：${fgFetchStr}` : '');
    html += `<a class="sent-gauge" title="${fgTip}" href="https://edition.cnn.com/markets/fear-and-greed" target="_blank" rel="noopener">
      <div class="sent-label">恐懼與貪婪指數</div>
      <div class="sent-value" style="color:${lv.color}">${fgData.score} ${chgHtml}</div>
      <div class="sent-track sent-fg-track"><div class="sent-fill" style="width:${pct}%;background:${lv.color}"></div></div>
      <div class="sent-tag" style="color:${lv.color}">${lv.label}</div>
    </a>`;
  }

  strip.innerHTML = html;
}

async function _fetchFearGreed() {
  if (CFG.showFearGreed === false) return;
  try {
    const fg = await PriceService.fetchFearGreed();
    _quoteCache.setFearGreed(fg);
    _renderSentimentStrip();
  } catch (e) { console.debug('[Prism] Fear & Greed fetch failed:', e.message); }
}

// ================================================================
//  GUIDE TAB — 交易新手說明
// ================================================================
function renderGuide() {
  const el = $('#guide-content');
  if (!el || el.innerHTML) return;

  const twStock = `<div class="guide-card">
<h4>交易時間</h4>
<table class="guide-table">
<tr><th>時段</th><th>時間</th><th>說明</th></tr>
<tr><td>盤前試撮</td><td>08:30 – 09:00</td><td>僅揭示模擬成交價，不實際成交</td></tr>
<tr><td>普通交易</td><td>09:00 – 13:30</td><td>主要交易時段，逐筆撮合（每 5 秒集合競價已改為逐筆）</td></tr>
<tr><td>盤後定價</td><td>13:40 – 14:30</td><td>以收盤價撮合，適合大額不想影響盤面的交易</td></tr>
<tr><td>零股交易</td><td>09:00 – 13:30</td><td>盤中零股，每 1~3 分鐘集合競價撮合一次</td></tr>
</table>
</div>
<div class="guide-card">
<h4>交割制度</h4>
<p><strong>T+2 交割</strong>：成交日後第 2 個營業日上午 10:00 前，銀行帳戶需備妥款項（買進）或股票（賣出）。</p>
<div class="guide-warn">違約交割是刑事責任，會被列為信用不良，且 3 年內不得申請信用交易。務必確認帳戶餘額充足再下單。</div>
</div>
<div class="guide-card">
<h4>漲跌幅限制</h4>
<p>每日漲跌幅 <em>±10%</em>（以前一交易日收盤價為基準）。</p>
<ul>
<li>漲停 / 跌停時仍可掛單，但不一定成交</li>
<li>ETF、權證等部分商品漲跌幅規則可能不同</li>
<li>初上市 / 上櫃前 5 日無漲跌幅限制</li>
</ul>
</div>
<div class="guide-card">
<h4>費用結構</h4>
<table class="guide-table">
<tr><th>費用</th><th>比率</th><th>說明</th></tr>
<tr><td>手續費</td><td>0.1425%</td><td>買賣各收一次；多數券商提供折扣（電子下單常見 2.8~6 折）</td></tr>
<tr><td>證交稅</td><td>0.3%</td><td>僅賣出時收取</td></tr>
<tr><td>ETF 證交稅</td><td>0.1%</td><td>ETF 優惠稅率（僅賣出）</td></tr>
</table>
<div class="guide-tip">以買進 100 張、每股 50 元為例：手續費 = 50 × 1000 × 100 × 0.1425% = 7,125 元（未折扣）。</div>
</div>
<div class="guide-card">
<h4>融資融券（信用交易）</h4>
<p>需開立信用帳戶，條件：開戶滿 3 個月、最近一年成交筆數達 10 筆、財力證明 25 萬以上。</p>
<table class="guide-table">
<tr><th></th><th>融資（做多）</th><th>融券（做空）</th></tr>
<tr><td>自備比例</td><td>40%（券商出 60%）</td><td>保證金 90%</td></tr>
<tr><td>維持率</td><td colspan="2">整戶維持率 130% 以下觸發追繳</td></tr>
<tr><td>追繳期限</td><td colspan="2">通知後 2 個營業日內補繳至 166%</td></tr>
<tr><td>斷頭</td><td colspan="2">維持率低於 120% 或未在期限內補繳，券商有權強制平倉</td></tr>
<tr><td>利息 / 費用</td><td>年利率約 6~7%</td><td>借券費 0.08%/天 + 手續費</td></tr>
<tr><td>期限</td><td colspan="2">最長 6 個月（可展延一次）</td></tr>
</table>
<div class="guide-warn">融資維持率公式 = (股票市值 + 融資自備款) ÷ 融資金額 × 100%。股價下跌時維持率會快速惡化。</div>
</div>`;

  const usStock = `<div class="guide-card">
<h4>交易時間（美東時間 ET）</h4>
<table class="guide-table">
<tr><th>時段</th><th>美東時間</th><th>台灣時間（冬令）</th><th>台灣時間（夏令）</th></tr>
<tr><td>盤前交易</td><td>04:00 – 09:30</td><td>17:00 – 22:30</td><td>16:00 – 21:30</td></tr>
<tr><td>正常交易</td><td>09:30 – 16:00</td><td>22:30 – 05:00+1</td><td>21:30 – 04:00+1</td></tr>
<tr><td>盤後交易</td><td>16:00 – 20:00</td><td>05:00 – 09:00+1</td><td>04:00 – 08:00+1</td></tr>
</table>
<p>夏令時間：3 月第 2 個週日 ~ 11 月第 1 個週日。</p>
</div>
<div class="guide-card">
<h4>交割制度</h4>
<p><strong>T+1 交割</strong>（2024 年 5 月起從 T+2 縮短為 T+1）。</p>
</div>
<div class="guide-card">
<h4>漲跌幅 & 熔斷機制</h4>
<p>美股 <strong>無每日漲跌幅限制</strong>，但有全市場熔斷機制（Circuit Breaker）：</p>
<table class="guide-table">
<tr><th>級別</th><th>S&P 500 跌幅</th><th>措施</th></tr>
<tr><td>Level 1</td><td>-7%</td><td>暫停交易 15 分鐘（14:25 後觸發不暫停）</td></tr>
<tr><td>Level 2</td><td>-13%</td><td>暫停交易 15 分鐘（14:25 後觸發不暫停）</td></tr>
<tr><td>Level 3</td><td>-20%</td><td>當日停止交易</td></tr>
</table>
<p>另有個股 LULD（Limit Up-Limit Down）機制，個股 5 分鐘內波動超過特定幅度會暫停交易。</p>
</div>
<div class="guide-card">
<h4>Margin Trading（保證金交易）</h4>
<table class="guide-table">
<tr><th></th><th>Reg T（隔夜）</th><th>Day Trade</th></tr>
<tr><td>Initial Margin</td><td>50%</td><td>25%（PDT 帳戶）</td></tr>
<tr><td>Maintenance Margin</td><td>25%</td><td>25%</td></tr>
</table>
<p><strong>PDT 規則</strong>：帳戶淨值低於 $25,000 時，5 個營業日內不得超過 3 次當沖交易（Day Trade），否則帳戶會被限制 90 天。</p>
<div class="guide-tip">美股券商通常不收固定手續費（如 Firstrade、Webull），但會有 SEC Fee（賣出時約 $8.00 / 百萬美元）。</div>
</div>`;

  const twFutures = `<div class="guide-card">
<h4>交易時間</h4>
<table class="guide-table">
<tr><th>時段</th><th>時間</th><th>說明</th></tr>
<tr><td>日盤</td><td>08:45 – 13:45</td><td>主要交易時段</td></tr>
<tr><td>夜盤（盤後）</td><td>15:00 – 05:00+1</td><td>與國際市場接軌；結算價以日盤為準</td></tr>
</table>
<div class="guide-tip">夜盤的保證金追繳以日盤結算時計算。夜盤虧損不會即時追繳，但會在隔日日盤反映。</div>
</div>
<div class="guide-card">
<h4>合約規格</h4>
<table class="guide-table">
<tr><th>商品</th><th>代碼</th><th>契約乘數</th><th>最小跳動</th><th>跳動值</th></tr>
<tr><td>臺股期貨（大台）</td><td>TX</td><td>指數 × 200</td><td>1 點</td><td>NT$200</td></tr>
<tr><td>小型臺指</td><td>MTX</td><td>指數 × 50</td><td>1 點</td><td>NT$50</td></tr>
<tr><td>微型臺指</td><td>MXF</td><td>指數 × 10</td><td>1 點</td><td>NT$10</td></tr>
<tr><td>電子期貨</td><td>TE</td><td>指數 × 4,000</td><td>0.05 點</td><td>NT$200</td></tr>
<tr><td>金融期貨</td><td>TF</td><td>指數 × 1,000</td><td>0.2 點</td><td>NT$200</td></tr>
</table>
</div>
<div class="guide-card">
<h4>保證金制度</h4>
<ul>
<li><strong>原始保證金</strong>：開倉時帳戶需有的最低金額</li>
<li><strong>維持保證金</strong>：帳戶權益低於此值時，會收到追繳通知（通常為原始保證金的 75%）</li>
<li>保證金由期交所（TAIFEX）每週公告調整，本工具會自動抓取最新資料</li>
</ul>
<div class="guide-warn">追繳通知後，需在次一營業日<strong>中午 12:00 前</strong>補繳至原始保證金，否則期貨商有權代為沖銷（砍倉）。</div>
</div>
<div class="guide-card">
<h4>結算</h4>
<ul>
<li><strong>到期日</strong>：每月第 3 個週三（若遇假日則提前）</li>
<li><strong>最後結算價</strong>：到期日當天台股收盤前 30 分鐘之指數算術平均價</li>
<li><strong>每日結算</strong>：每日依結算價計算盈虧，盈利可動用，虧損即扣</li>
</ul>
</div>
<div class="guide-card">
<h4>費用</h4>
<table class="guide-table">
<tr><th>費用</th><th>金額</th></tr>
<tr><td>期交稅</td><td>契約金額 × 十萬分之 2（買賣各收一次）</td></tr>
<tr><td>手續費</td><td>依期貨商公告，通常大台 $40~100/口、小台 $20~50/口</td></tr>
</table>
</div>`;

  const usFutures = `<div class="guide-card">
<h4>交易時間</h4>
<p>CME（芝加哥商品交易所）期貨幾乎 <strong>24 小時交易</strong>：</p>
<table class="guide-table">
<tr><th>時段</th><th>美東時間</th><th>台灣時間（冬令）</th></tr>
<tr><td>電子盤</td><td>週日 18:00 – 週五 17:00</td><td>週一 07:00 – 週六 06:00</td></tr>
<tr><td>每日維護</td><td>17:00 – 18:00</td><td>06:00 – 07:00</td></tr>
</table>
</div>
<div class="guide-card">
<h4>合約規格</h4>
<table class="guide-table">
<tr><th>商品</th><th>代碼</th><th>契約乘數</th><th>最小跳動</th><th>跳動值</th></tr>
<tr><td>E-mini S&P 500</td><td>ES</td><td>$50 × 指數</td><td>0.25 點</td><td>$12.50</td></tr>
<tr><td>Micro E-mini S&P</td><td>MES</td><td>$5 × 指數</td><td>0.25 點</td><td>$1.25</td></tr>
<tr><td>E-mini Nasdaq 100</td><td>NQ</td><td>$20 × 指數</td><td>0.25 點</td><td>$5.00</td></tr>
<tr><td>Micro E-mini Nasdaq</td><td>MNQ</td><td>$2 × 指數</td><td>0.25 點</td><td>$0.50</td></tr>
<tr><td>E-mini Dow</td><td>YM</td><td>$5 × 指數</td><td>1 點</td><td>$5.00</td></tr>
<tr><td>Micro E-mini Dow</td><td>MYM</td><td>$0.50 × 指數</td><td>1 點</td><td>$0.50</td></tr>
</table>
<div class="guide-tip">Micro 合約規模為 E-mini 的 1/10，適合小資金或新手練習。</div>
</div>
<div class="guide-card">
<h4>保證金 & 結算</h4>
<ul>
<li><strong>Initial Margin</strong>：開倉所需最低保證金（依 CME 公告，會隨波動調整）</li>
<li><strong>Maintenance Margin</strong>：帳戶低於此值會收到 Margin Call</li>
<li>Margin Call 後通常需在 <strong>T+1 營業日</strong> 前補足</li>
<li>美國期貨為 <strong>每日結算（Mark to Market）</strong>，盈虧每日入帳</li>
</ul>
</div>`;

  const options = `<div class="guide-card">
<h4>選擇權基本概念</h4>
<table class="guide-table">
<tr><th></th><th>買權 (Call)</th><th>賣權 (Put)</th></tr>
<tr><td>買方 (Buyer)</td><td>看漲：有權在到期日以履約價<strong>買進</strong>標的</td><td>看跌：有權在到期日以履約價<strong>賣出</strong>標的</td></tr>
<tr><td>賣方 (Seller)</td><td>收取權利金，承擔被買方履約的義務</td><td>收取權利金，承擔被買方履約的義務</td></tr>
</table>
<ul>
<li><strong>買方</strong>：付出權利金，最大損失 = 權利金，獲利理論上無限（Call）或有限（Put）</li>
<li><strong>賣方</strong>：收取權利金，最大獲利 = 權利金，虧損理論上無限（需繳保證金）</li>
</ul>
<div class="guide-warn">賣方風險遠大於買方。新手建議先從買方開始，且嚴控部位大小。</div>
</div>
<div class="guide-card">
<h4>台指選擇權 (TXO)</h4>
<table class="guide-table">
<tr><th>項目</th><th>規格</th></tr>
<tr><td>標的</td><td>臺灣加權股價指數</td></tr>
<tr><td>契約乘數</td><td>每點 NT$50</td></tr>
<tr><td>到期日</td><td>每月第 3 個週三（另有週選擇權）</td></tr>
<tr><td>履約方式</td><td>歐式（僅到期日可履約），現金結算</td></tr>
<tr><td>交易時間</td><td>日盤 08:45–13:45 / 夜盤 15:00–05:00</td></tr>
<tr><td>交易稅</td><td>權利金 × 千分之 1（買賣各一次）</td></tr>
</table>
</div>
<div class="guide-card">
<h4>美國選擇權 (SPX / SPY)</h4>
<table class="guide-table">
<tr><th></th><th>SPX Options</th><th>SPY Options</th></tr>
<tr><td>標的</td><td>S&P 500 指數</td><td>SPY ETF</td></tr>
<tr><td>契約乘數</td><td>$100</td><td>$100</td></tr>
<tr><td>結算方式</td><td>現金結算</td><td>實物交割</td></tr>
<tr><td>履約方式</td><td>歐式</td><td>美式</td></tr>
<tr><td>到期頻率</td><td>每週一、三、五到期（0DTE）</td><td>每日到期（0DTE）</td></tr>
</table>
<div class="guide-tip">SPX 選擇權有稅務優勢（美國稅制 60/40 rule），且為現金結算不會被指派股票。SPY 流動性佳，價格較低適合小資金。</div>
</div>
<div class="guide-card">
<h4>Greeks 簡介</h4>
<table class="guide-table">
<tr><th>Greek</th><th>衡量</th><th>白話</th></tr>
<tr><td><strong>Delta (Δ)</strong></td><td>標的價格變動 1 點，權利金變動多少</td><td>方向性敏感度。Call Δ 為正，Put Δ 為負</td></tr>
<tr><td><strong>Gamma (Γ)</strong></td><td>標的價格變動 1 點，Delta 變動多少</td><td>Delta 的加速度。越接近價平、越接近到期，Gamma 越大</td></tr>
<tr><td><strong>Theta (Θ)</strong></td><td>每過一天，權利金減少多少</td><td>時間價值衰減。買方的敵人，賣方的朋友</td></tr>
<tr><td><strong>Vega (ν)</strong></td><td>隱含波動率變動 1%，權利金變動多少</td><td>波動率敏感度。買方喜歡高波動，賣方喜歡低波動</td></tr>
</table>
</div>`;

  const risk = `<div class="guide-card">
<h4>維持率的意義</h4>
<p>維持率（Maintenance Ratio）是衡量你帳戶安全程度的核心指標：</p>
<ul>
<li><strong>融資維持率</strong> = (股票市值 + 自備款) ÷ 融資金額 × 100%</li>
<li><strong>期貨風險指標</strong> = 帳戶權益 ÷ 所需保證金 × 100%</li>
<li>數字越高越安全，低於門檻就會被追繳或強制平倉</li>
</ul>
</div>
<div class="guide-card">
<h4>追繳 & 斷頭流程</h4>
<table class="guide-table">
<tr><th>階段</th><th>台灣融資融券</th><th>台灣期貨</th></tr>
<tr><td>安全</td><td>維持率 ≥ 166%</td><td>風險指標 ≥ 100%</td></tr>
<tr><td>追繳通知</td><td>維持率 < 130%</td><td>權益 < 維持保證金</td></tr>
<tr><td>補繳期限</td><td>2 個營業日內補至 166%</td><td>次營業日中午 12:00 前補至原始保證金</td></tr>
<tr><td>強制平倉</td><td>未補繳或維持率 < 120%</td><td>未補繳或權益 < 25% 原始保證金</td></tr>
</table>
<div class="guide-warn">強制平倉（斷頭）由券商/期貨商決定平倉順序和時機，通常在開盤前市價掛單，損失可能超出預期。</div>
</div>
<div class="guide-card">
<h4>部位大小控制</h4>
<p>常見的風險管理原則：</p>
<ul>
<li><strong>單筆風險 ≤ 總資金 1~2%</strong>：例如 100 萬帳戶，單筆最大虧損控制在 1~2 萬</li>
<li><strong>不要 All-in</strong>：即使再有信心，也保留足夠的備用資金應對追繳</li>
<li><strong>設定停損</strong>：進場前就決定停損價位，嚴格執行</li>
<li><strong>注意相關性</strong>：同時持有多檔相關標的等於放大曝險</li>
<li><strong>槓桿倍數</strong>：融資 = 2.5 倍槓桿、期貨通常 10~20 倍。槓桿越高，同樣的價格波動造成的盈虧比例越大</li>
</ul>
<div class="guide-tip">本工具的壓力測試功能可以模擬不同價格下的維持率變化，建議每次開倉前都跑一次。</div>
</div>
<div class="guide-card">
<h4>常見新手錯誤</h4>
<ul>
<li><span class="warn">忽略交易成本</span>：頻繁交易下，手續費和稅金會大幅侵蝕獲利</li>
<li><span class="warn">不設停損</span>：「再等一下就會回來」是最危險的心態</li>
<li><span class="warn">過度槓桿</span>：保證金只放最低限度，稍有波動就被追繳斷頭</li>
<li><span class="warn">忽略夜盤風險</span>：期貨夜盤流動性較差，遇到國際事件可能跳空</li>
<li><span class="warn">融券軋空</span>：融券做空遇到軋空行情，理論上虧損無上限</li>
<li><span class="warn">賣方裸賣選擇權</span>：看似穩定收租，但一次黑天鵝可能賠掉多年獲利</li>
</ul>
</div>`;

  el.innerHTML = `<div class="guide-wrap">${subTabs('guide', [
    '台灣股票', '美國股票', '台灣期貨', '美國期貨', '選擇權', '風險管理'
  ], [twStock, usStock, twFutures, usFutures, options, risk])}</div>`;
}

// 從 localStorage 快取恢復 ticker 顯示（頁面載入時）
function _restoreIndicesFromCache() {
  const cached = _quoteCache.getAllIndices();
  if (Object.keys(cached).length === 0) return false;
  let ok = 0;
  for (const [key, q] of Object.entries(cached)) {
    if (!q || q.error) continue;
    ok++;
    _renderTickerChip(key, q);
  }
  if (ok > 0) {
    _updateBasis(cached);
    _updateTickerTime(cached);
    _renderSentimentStrip();
    if ($('#f-entry')) fillFromTicker('f-entry');
    if ($('#f-live-price')) fillFromTicker('f-live-price');
    if ($('#o-ul')) fillOptFromTicker();
    autoFillMarginPrice();
  }
  return ok > 0;
}

// ================================================================
//  INIT
// ================================================================
function init() {
  buildTickerBar();
  _initTickerToggle();

  // Main tabs
  $$('.main-tab').forEach(b => b.addEventListener('click', () => {
    $$('.main-tab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    $$('.tab-content').forEach(x => x.classList.remove('active'));
    $(`#tab-${b.dataset.tab}`).classList.add('active');
    window.scrollTo(0, 0);
    S.activeTab = b.dataset.tab; _saveState();
    if (b.dataset.tab === 'guide') renderGuide();
    if (b.dataset.tab === 'settings') { if (!window._stgRendered) { renderSettings(); window._stgRendered = true; } }
  }));

  // Toggle groups
  $$('.toggle-group').forEach(g => {
    $$('.toggle-btn', g).forEach(b => b.addEventListener('click', () => {
      $$('.toggle-btn', g).forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const gn = g.dataset.group, v = b.dataset.value;
      if (gn === 'margin-market')    { S.margin.market = v;    renderMarginForm(); }
      if (gn === 'margin-direction') { S.margin.direction = v; renderMarginForm(); }
      if (gn === 'futures-market')   { S.futures.market = v;   renderFuturesForm(); }
      if (gn === 'futures-direction'){ S.futures.direction = v; renderFuturesForm(); }
      if (gn === 'futures-product')  { S.futures.product = v;  renderFuturesForm(); }
      if (gn === 'options-market')   { S.options.market = v;   renderOptionsForm(); }
      if (gn === 'options-side')     { S.options.side = v;     renderOptionsForm(); }
      if (gn === 'options-product')  { S.options.product = v;  renderOptionsForm(); }
      _saveState();
    }));
  });

  // Sub-tab delegation
  document.addEventListener('click', e => {
    const st = e.target.closest('.sub-tab');
    if (!st) return;
    const p = st.parentElement;
    $$('.sub-tab', p).forEach(x => x.classList.remove('active'));
    st.classList.add('active');
    const container = p.parentElement;
    $$('.sub-pane', container).forEach(x => x.classList.remove('active'));
    const pane = $(`#${st.dataset.stab}`, container);
    if (pane) pane.classList.add('active');
  });

  // ── Fetch indices button ──
  const fetchBtn = $('#btn-fetch-indices');
  if (fetchBtn) fetchBtn.addEventListener('click', () => handleFetchIndices(true));

  // ── Settings panel ──
  initSettings();

  // ── Restore saved state or apply default market ──
  if (!_savedS && CFG.defaultMarket) {
    const m = CFG.defaultMarket;
    S.margin.market = m; S.futures.market = m; S.options.market = m;
  }
  // Sync all toggle buttons to match S state
  const _syncToggles = () => {
    const map = {
      'margin-market': S.margin.market, 'margin-direction': S.margin.direction,
      'futures-market': S.futures.market, 'futures-direction': S.futures.direction, 'futures-product': S.futures.product,
      'options-market': S.options.market, 'options-side': S.options.side, 'options-product': S.options.product,
    };
    Object.entries(map).forEach(([gn, val]) => {
      const g = $(`.toggle-group[data-group="${gn}"]`);
      if (!g) return;
      $$('.toggle-btn', g).forEach(b => b.classList.toggle('active', b.dataset.value === val));
    });
  };
  _syncToggles();

  // Restore active tab
  if (S.activeTab && S.activeTab !== 'margin') {
    const tabBtn = $(`.main-tab[data-tab="${S.activeTab}"]`);
    if (tabBtn) {
      $$('.main-tab').forEach(x => x.classList.remove('active'));
      tabBtn.classList.add('active');
      $$('.tab-content').forEach(x => x.classList.remove('active'));
      $(`#tab-${S.activeTab}`)?.classList.add('active');
      if (S.activeTab === 'guide') renderGuide();
      if (S.activeTab === 'settings') { if (!window._stgRendered) { renderSettings(); window._stgRendered = true; } }
    }
  }

  // Render forms
  renderMarginForm();
  renderFuturesForm();
  renderOptionsForm();

  // ── LIVE CALCULATION: event delegation on each tab ──
  const liveMargin = debounce(calcMargin, 100);
  const liveFutures = debounce(calcFutures, 100);
  const liveOptions = debounce(calcOptions, 100);

  $('#tab-margin').addEventListener('input', liveMargin);
  $('#tab-margin').addEventListener('change', liveMargin);
  $('#tab-futures').addEventListener('input', liveFutures);
  $('#tab-futures').addEventListener('change', liveFutures);
  $('#tab-options').addEventListener('input', liveOptions);
  $('#tab-options').addEventListener('change', liveOptions);

  // ── 初始計算（讓預設值立刻顯示結果）──
  calcMargin();
  calcFutures();
  calcOptions();

  // ── 根據設定決定是否自動取報價 ──
  applySettings();

  // ── 登入狀態下從雲端載入設定 ──
  if (localStorage.getItem('prism_token')) {
    loadSettingsFromServer().then(() => {
      renderMarginForm(); renderFuturesForm(); renderOptionsForm();
    });
  }
}
document.addEventListener('DOMContentLoaded', init);

// Pause refresh timer when tab is hidden (saves bandwidth)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  } else {
    if (CFG.refreshInterval > 0) {
      // 回到頁面時，若快取過期則立刻刷新一次
      const lastT = _quoteCache.lastIndexTime();
      if (!lastT || Date.now() - lastT >= _quoteCache._ttl()) handleFetchIndices();
      if (!_refreshTimer) _refreshTimer = setInterval(handleFetchIndices, CFG.refreshInterval * 1000);
    }
  }
});

// ================================================================
//  SETTINGS PANEL
// ================================================================
function initSettings() {
  window._stgRendered = false;
}

function renderSettings() {
  const body = $('#settings-body');
  if (!body) return;
  const P = PriceService.PROVIDER_INFO;
  // Group indices by region
  const regionOrder = ['台灣', '美國', '亞洲', '加密貨幣'];
  const grouped = {};
  Object.entries(INDEX_DEFS).forEach(([k, def]) => {
    if (!grouped[def.region]) grouped[def.region] = [];
    grouped[def.region].push({ key: k, name: def.name });
  });
  const cbHtml = regionOrder.filter(r => grouped[r]).map(region =>
    `<div class="stg-cb-region"><span class="stg-cb-region-label">${region}</span>${
      grouped[region].map(({ key, name }) =>
        `<label class="stg-cb"><input type="checkbox" data-idx="${key}" ${CFG.indices[key] ? 'checked' : ''}>${name}</label>`
      ).join('')
    }</div>`
  ).join('');

  // Build provider options for each market
  const twOpts = Object.entries(P).filter(([,v]) => v.markets.includes('tw')).map(([id, v]) =>
    `<option value="${id}" ${CFG.twSource === id ? 'selected' : ''}>${v.name}</option>`).join('');
  const usOpts = Object.entries(P).filter(([,v]) => v.markets.includes('us')).map(([id, v]) =>
    `<option value="${id}" ${CFG.usSource === id ? 'selected' : ''}>${v.name}</option>`).join('');

  // Account section
  const loggedIn = !!(window.PrismJournal && PrismJournal.isLoggedIn());
  const userInfo = loggedIn ? JSON.parse(localStorage.getItem('prism_user_info') || '{}') : null;
  const accountHTML = loggedIn
    ? `<div class="stg-account-info">
        <div class="stg-avatar"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
        <div><div class="stg-username">${userInfo?.username || '使用者'}</div><div class="stg-uid">已登入 · 資料同步中</div></div>
      </div>
      <div class="stg-account-actions">
        <button id="stg-reload"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg> 重新整理</button>
        <button class="stg-logout-btn" id="stg-logout">登出</button>
      </div>`
    : `<div class="stg-login-prompt">
        <p>登入後可在不同裝置同步設定與交易紀錄</p>
        <button class="stg-save-btn" id="stg-login">登入 / 註冊</button>
      </div>`;

  const curTheme = CFG.theme || 'dark';
  const _chevron = `<svg class="stg-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  const _twDBInfo = (() => { const t = StockDB.getTime('tw'); const n = StockDB.getList('tw').length; return n ? `${n} 檔 · ${new Date(t).toLocaleDateString('zh-TW')}` : '尚未下載'; })();
  const _futDBInfo = (() => { const t = StockDB.getTaifexFuturesTime(); const n = StockDB.getTaifexFutures().length; return n ? `${n} 檔 · ${new Date(t).toLocaleDateString('zh-TW')}` : '尚未下載'; })();
  const _usDBInfo = (() => { const t = StockDB.getTime('us'); const n = StockDB.getList('us').length; return n ? `${n} 檔 · ${new Date(t).toLocaleDateString('zh-TW')}` : '尚未下載'; })();

  body.innerHTML = `
    <!-- ① 外觀與帳號 -->
    <div class="stg-section">
      <h4><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>外觀與偏好</h4>
      <div class="stg-s-body">
        <div class="stg-theme-grid">
          <button type="button" class="stg-theme-btn ${curTheme==='dark'?'active':''}" data-theme="dark"><div class="stg-theme-swatch" data-sw="dark"></div><span class="stg-theme-label">深色</span></button>
          <button type="button" class="stg-theme-btn ${curTheme==='light'?'active':''}" data-theme="light"><div class="stg-theme-swatch" data-sw="light"></div><span class="stg-theme-label">淺色</span></button>
          <button type="button" class="stg-theme-btn ${curTheme==='midnight'?'active':''}" data-theme="midnight"><div class="stg-theme-swatch" data-sw="midnight"></div><span class="stg-theme-label">午夜藍</span></button>
          <button type="button" class="stg-theme-btn ${curTheme==='emerald'?'active':''}" data-theme="emerald"><div class="stg-theme-swatch" data-sw="emerald"></div><span class="stg-theme-label">翡翠綠</span></button>
          <button type="button" class="stg-theme-btn ${curTheme==='warm'?'active':''}" data-theme="warm"><div class="stg-theme-swatch" data-sw="warm"></div><span class="stg-theme-label">琥珀</span></button>
        </div>
        <div class="stg-row" style="margin-top:10px">
          <label>預設市場</label>
          <select class="stg-select" id="stg-default-market">
            <option value="tw" ${CFG.defaultMarket === 'tw' ? 'selected' : ''}>台灣</option>
            <option value="us" ${CFG.defaultMarket === 'us' ? 'selected' : ''}>美國</option>
          </select>
        </div>
        <div class="stg-row">
          <label>字體大小</label>
          <select class="stg-select" id="stg-font-scale">
            <option value="xs" ${CFG.fontScale === 'xs' ? 'selected' : ''}>小</option>
            <option value="s" ${CFG.fontScale === 's' ? 'selected' : ''}>適中</option>
            <option value="m" ${CFG.fontScale === 'm' ? 'selected' : ''}>標準</option>
            <option value="l" ${CFG.fontScale === 'l' ? 'selected' : ''}>大</option>
            <option value="xl" ${CFG.fontScale === 'xl' ? 'selected' : ''}>特大</option>
          </select>
        </div>
      </div>
      <div class="stg-group open">
        <div class="stg-group-title"><span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>帳號</span>${_chevron}</div>
        <div class="stg-group-body">${accountHTML}</div>
      </div>
    </div>

    <!-- ② 報價與行情 -->
    <div class="stg-section">
      <h4><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>報價與行情</h4>
      <div class="stg-s-body">
        <div class="stg-row">
          <label>台灣報價來源<span class="stg-hint" id="stg-tw-desc">${P[CFG.twSource]?.desc || ''}</span></label>
          <select class="stg-select" id="stg-tw-source">${twOpts}</select>
        </div>
        <div class="stg-row">
          <label>美國報價來源<span class="stg-hint" id="stg-us-desc">${P[CFG.usSource]?.desc || ''}</span></label>
          <select class="stg-select" id="stg-us-source">${usOpts}</select>
        </div>
        <div class="stg-row" id="stg-finnhub-row" style="display:${CFG.usSource === 'finnhub' ? '' : 'none'}">
          <label>Finnhub API Key<span class="stg-hint">至 finnhub.io 免費註冊取得</span></label>
          <input type="text" class="stg-input" id="stg-finnhub-key" value="${CFG.finnhubKey}" placeholder="輸入 API Key" spellcheck="false">
        </div>
        <div class="stg-row">
          <label>自動取得報價<span class="stg-hint">進入頁面時自動查詢</span></label>
          <label class="stg-toggle"><input type="checkbox" id="stg-auto-fetch" ${CFG.autoFetch ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="stg-row">
          <label>報價刷新頻率<span class="stg-hint">指數列即時刷新間隔</span></label>
          <select class="stg-select" id="stg-refresh">
            <option value="0" ${CFG.refreshInterval === 0 ? 'selected' : ''}>關閉</option>
            <option value="5" ${CFG.refreshInterval === 5 ? 'selected' : ''}>5 秒</option>
            <option value="10" ${CFG.refreshInterval === 10 ? 'selected' : ''}>10 秒</option>
            <option value="15" ${CFG.refreshInterval === 15 ? 'selected' : ''}>15 秒</option>
            <option value="30" ${CFG.refreshInterval === 30 ? 'selected' : ''}>30 秒</option>
            <option value="60" ${CFG.refreshInterval === 60 ? 'selected' : ''}>1 分鐘</option>
            <option value="300" ${CFG.refreshInterval === 300 ? 'selected' : ''}>5 分鐘</option>
          </select>
        </div>
      </div>
      <div class="stg-group">
        <div class="stg-group-title"><span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>顯示指數與指標</span>${_chevron}</div>
        <div class="stg-group-body">
          <div class="stg-cb-group">
            ${cbHtml}
            <div class="stg-cb-region" style="margin-top:4px;padding-top:6px;border-top:1px dashed var(--bdr)">
              <span class="stg-cb-region-label">指標</span>
              <label class="stg-cb"><input type="checkbox" id="stg-show-vix" ${CFG.showVix !== false ? 'checked' : ''}>VIX</label>
              <label class="stg-cb"><input type="checkbox" id="stg-show-fg" ${CFG.showFearGreed !== false ? 'checked' : ''}>恐懼與貪婪</label>
            </div>
          </div>
        </div>
      </div>
      <div class="stg-group">
        <div class="stg-group-title"><span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>股票資料庫</span>${_chevron}</div>
        <div class="stg-group-body">
          <div class="stg-db-row">
            <div class="stg-db-name">台灣股票 <small>證交所 + 櫃買</small></div>
            <span class="stg-db-info" id="stg-stockdb-tw-info">${_twDBInfo}</span>
            <button class="stg-db-btn" id="stg-stockdb-tw-fetch">更新</button>
          </div>
          <div class="stg-db-row">
            <div class="stg-db-name">台灣股期 <small>TAIFEX</small></div>
            <span class="stg-db-info" id="stg-stockdb-fut-info">${_futDBInfo}</span>
            <button class="stg-db-btn" id="stg-stockdb-fut-fetch">更新</button>
          </div>
          <div class="stg-db-row">
            <div class="stg-db-name">美國股票 <small>SEC / NASDAQ</small></div>
            <span class="stg-db-info" id="stg-stockdb-us-info">${_usDBInfo}</span>
            <button class="stg-db-btn" id="stg-stockdb-us-fetch">更新</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ③ 交易費用 -->
    <div class="stg-section">
      <h4><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>交易費用</h4>
      <div class="stg-s-body">
        <div class="stg-fee-cols">
          <div class="stg-fee-col">
            <div class="stg-sub-label">台灣股票</div>
            <div class="stg-row">
              <label>手續費折扣</label>
              <select class="stg-select" id="stg-tw-fee-disc">
                <option value="1" ${CFG.twFeeDisc === '1' ? 'selected' : ''}>全額 0.1425%</option>
                <option value="0.6" ${CFG.twFeeDisc === '0.6' ? 'selected' : ''}>6折</option>
                <option value="0.5" ${CFG.twFeeDisc === '0.5' ? 'selected' : ''}>5折</option>
                <option value="0.38" ${CFG.twFeeDisc === '0.38' ? 'selected' : ''}>3.8折</option>
                <option value="0.28" ${CFG.twFeeDisc === '0.28' ? 'selected' : ''}>2.8折</option>
                <option value="0" ${CFG.twFeeDisc === '0' ? 'selected' : ''}>免手續費</option>
              </select>
            </div>
            <div class="stg-row">
              <label>證交稅率</label>
              <select class="stg-select" id="stg-tw-tax-rate">
                <option value="0.003" ${CFG.twTaxRate === '0.003' ? 'selected' : ''}>0.3% 股票</option>
                <option value="0.001" ${CFG.twTaxRate === '0.001' ? 'selected' : ''}>0.1% ETF</option>
                <option value="0.0015" ${CFG.twTaxRate === '0.0015' ? 'selected' : ''}>0.15% 當沖</option>
              </select>
            </div>
            <div class="stg-sub-label">台灣期貨 / 選擇權</div>
            <div class="stg-row">
              <label>指數期貨<span class="stg-hint">NT$/口</span></label>
              <input type="number" class="stg-input" id="stg-tw-fut-comm" value="${CFG.twFutComm}" step="any" min="0" placeholder="60">
            </div>
            <div class="stg-row">
              <label>股票期貨<span class="stg-hint">NT$/口</span></label>
              <input type="number" class="stg-input" id="stg-tw-stk-fut-comm" value="${CFG.twStkFutComm}" step="any" min="0" placeholder="40">
            </div>
            <div class="stg-row">
              <label>選擇權<span class="stg-hint">NT$/口</span></label>
              <input type="number" class="stg-input" id="stg-tw-opt-comm" value="${CFG.twOptComm}" step="any" min="0" placeholder="25">
            </div>
          </div>
          <div class="stg-fee-col">
            <div class="stg-sub-label">美國股票</div>
            <div class="stg-row">
              <label>Commission<span class="stg-hint">USD/筆</span></label>
              <input type="number" class="stg-input" id="stg-us-comm" value="${CFG.usComm}" step="any" min="0" placeholder="0">
            </div>
            <div class="stg-sub-label">美國期貨 / 選擇權</div>
            <div class="stg-row">
              <label>期貨<span class="stg-hint">USD/口</span></label>
              <input type="number" class="stg-input" id="stg-us-fut-comm" value="${CFG.usFutComm}" step="any" min="0" placeholder="2.25">
            </div>
            <div class="stg-row">
              <label>選擇權<span class="stg-hint">USD/口</span></label>
              <input type="number" class="stg-input" id="stg-us-opt-comm" value="${CFG.usOptComm}" step="any" min="0" placeholder="0.65">
            </div>
            <div class="stg-sub-label">交易紀錄預設</div>
            <div class="stg-row">
              <label>預設手續費</label>
              <input type="number" class="stg-input" id="stg-default-fee" value="${CFG.defaultFee}" step="any" min="0" placeholder="不設定">
            </div>
            <div class="stg-row">
              <label>預設交易稅</label>
              <input type="number" class="stg-input" id="stg-default-tax" value="${CFG.defaultTax}" step="any" min="0" placeholder="不設定">
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="stg-section">
      <h4><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>交易前檢查清單</h4>
      <div class="stg-s-body">
        <p style="color:var(--t3);font-size:.78rem;margin:0 0 8px">新增交易時會顯示的提醒檢查項目</p>
        <div id="stg-checklist-items">${(CFG.checklist||[]).map((item,i)=>`<div class="stg-cl-item" data-idx="${i}"><span>${item}</span><button class="stg-cl-del" data-idx="${i}" title="刪除">&times;</button></div>`).join('')}</div>
        <div class="stg-cl-add"><input type="text" id="stg-cl-input" placeholder="輸入檢查項目，按 Enter 新增" maxlength="50"><button id="stg-cl-add-btn" class="stg-save-btn" style="padding:5px 12px;font-size:.78rem">新增</button></div>
      </div>
    </div>
    <div class="stg-section stg-reset-section">
      <h4><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>重設</h4>
      <div class="stg-s-body">
        <p style="color:var(--t3);font-size:.78rem;margin:0 0 8px">將所有設定恢復為預設值（主題、報價源、手續費等）</p>
        <button class="stg-save-btn stg-reset-btn" id="stg-reset-defaults" style="background:var(--red);border-color:var(--red)">恢復預設值</button>
      </div>
    </div>
    <div class="stg-section stg-shortcuts-section">
      <h4><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h8M6 16h.01M18 16h.01"/></svg>鍵盤快捷鍵</h4>
      <div class="stg-s-body">
        <div style="font-size:.8rem;color:var(--t2);line-height:1.8">
          <div><kbd>1</kbd>~<kbd>6</kbd> 切換分頁（股票/期貨/選擇權/紀錄/說明/設定）</div>
          <div><kbd>R</kbd> 重新整理報價</div>
        </div>
      </div>
    </div>`;

  // Collapsible group toggle
  $$('.stg-group-title', body).forEach(t => t.addEventListener('click', () => t.parentElement.classList.toggle('open')));

  // Account actions
  $('#stg-login')?.addEventListener('click', () => {
    if (window.PrismJournal) { PrismJournal.showLogin(); }
  });
  $('#stg-logout')?.addEventListener('click', () => {
    if (window.PrismJournal) { PrismJournal.doLogout(); window._stgRendered = false; renderSettings(); window._stgRendered = true; }
  });
  $('#stg-reload')?.addEventListener('click', () => {
    if (confirm('確定要重新載入頁面嗎？未儲存的輸入內容將會消失。')) location.reload();
  });

  // Theme picker
  $$('.stg-theme-btn', body).forEach(btn => btn.addEventListener('click', () => {
    $$('.stg-theme-btn', body).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    CFG.theme = btn.dataset.theme;
    applyTheme(CFG.theme);
    saveSettings(CFG);
  }));

  // Update descriptions & show/hide Finnhub key row on source change
  const syncUI = () => {
    const tw = $('#stg-tw-source')?.value || 'twse';
    const us = $('#stg-us-source')?.value || 'yahoo';
    const tdesc = $('#stg-tw-desc'), udesc = $('#stg-us-desc'), frow = $('#stg-finnhub-row');
    if (tdesc) tdesc.textContent = P[tw]?.desc || '';
    if (udesc) udesc.textContent = P[us]?.desc || '';
    if (frow) frow.style.display = us === 'finnhub' ? '' : 'none';
  };
  $('#stg-tw-source')?.addEventListener('change', syncUI);
  $('#stg-us-source')?.addEventListener('change', syncUI);

  // Bind events — save on every change
  const save = () => {
    CFG.twSource = $('#stg-tw-source')?.value || 'twse';
    CFG.usSource = $('#stg-us-source')?.value || 'yahoo';
    CFG.finnhubKey = $('#stg-finnhub-key')?.value?.trim() || '';
    CFG.autoFetch = $('#stg-auto-fetch')?.checked ?? true;
    CFG.refreshInterval = parseInt($('#stg-refresh')?.value || '0', 10);
    CFG.defaultMarket = $('#stg-default-market')?.value || 'tw';
    CFG.fontScale = $('#stg-font-scale')?.value || 'm';
    CFG.twFeeDisc = $('#stg-tw-fee-disc')?.value || '0.5';
    CFG.twTaxRate = $('#stg-tw-tax-rate')?.value || '0.003';
    CFG.twFutComm = $('#stg-tw-fut-comm')?.value || '60';
    CFG.twStkFutComm = $('#stg-tw-stk-fut-comm')?.value || '40';
    CFG.twOptComm = $('#stg-tw-opt-comm')?.value || '25';
    CFG.usComm = $('#stg-us-comm')?.value || '0';
    CFG.usFutComm = $('#stg-us-fut-comm')?.value || '2.25';
    CFG.usOptComm = $('#stg-us-opt-comm')?.value || '0.65';
    CFG.defaultFee = $('#stg-default-fee')?.value || '';
    CFG.defaultTax = $('#stg-default-tax')?.value || '';
    $$('[data-idx]', body).forEach(cb => { CFG.indices[cb.dataset.idx] = cb.checked; });
    CFG.showVix = $('#stg-show-vix')?.checked ?? true;
    CFG.showFearGreed = $('#stg-show-fg')?.checked ?? true;
    saveSettings(CFG);
    applySettings();
    _renderSentimentStrip();
  };
  body.addEventListener('change', save);
  $('#stg-finnhub-key')?.addEventListener('input', debounce(save, 500));
  $$('input[type="number"].stg-input', body).forEach(el => el.addEventListener('input', debounce(save, 500)));

  // Stock DB fetch helpers
  const _stockDBFetch = async (btnId, infoId, fetchFn) => {
    const btn = $(`#${btnId}`);
    const info = $(`#${infoId}`);
    btn.disabled = true; btn.textContent = '下載中…';
    try {
      const count = await fetchFn();
      if (info) info.textContent = `${count} 檔 · ${new Date().toLocaleDateString('zh-TW')}`;
      btn.textContent = '完成';
      setTimeout(() => { btn.textContent = '更新'; btn.disabled = false; }, 1500);
    } catch {
      btn.textContent = '失敗';
      setTimeout(() => { btn.textContent = '更新'; btn.disabled = false; }, 1500);
    }
  };
  $('#stg-stockdb-tw-fetch')?.addEventListener('click', () => _stockDBFetch('stg-stockdb-tw-fetch', 'stg-stockdb-tw-info', () => StockDB.fetchTW()));
  $('#stg-stockdb-fut-fetch')?.addEventListener('click', () => _stockDBFetch('stg-stockdb-fut-fetch', 'stg-stockdb-fut-info', () => StockDB.fetchTaifexOnly()));
  $('#stg-stockdb-us-fetch')?.addEventListener('click', () => _stockDBFetch('stg-stockdb-us-fetch', 'stg-stockdb-us-info', () => StockDB.fetchUS()));

  // Checklist management
  const refreshChecklist = () => {
    const container = $('#stg-checklist-items');
    if (!container) return;
    container.innerHTML = (CFG.checklist||[]).map((item,i)=>`<div class="stg-cl-item" data-idx="${i}"><span>${item}</span><button class="stg-cl-del" data-idx="${i}" title="刪除">&times;</button></div>`).join('');
    $$('.stg-cl-del', container).forEach(btn => btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      CFG.checklist.splice(idx, 1);
      saveSettings(CFG);
      refreshChecklist();
    }));
  };
  const addChecklistItem = () => {
    const input = $('#stg-cl-input');
    const val = input?.value?.trim();
    if (!val) return;
    if (!CFG.checklist) CFG.checklist = [];
    if (CFG.checklist.length >= 20) { if (window._showToast) window._showToast('最多 20 個檢查項目'); return; }
    CFG.checklist.push(val);
    input.value = '';
    saveSettings(CFG);
    refreshChecklist();
  };
  $('#stg-cl-add-btn')?.addEventListener('click', addChecklistItem);
  $('#stg-cl-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addChecklistItem(); } });
  refreshChecklist();

  // Reset to defaults button
  $('#stg-reset-defaults')?.addEventListener('click', () => window._resetSettingsToDefaults());
}

function applyTheme(theme) {
  if (!theme || theme === 'dark') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  // Update meta theme-color to match current theme
  const themeColors = { dark: '#0e1117', light: '#f0f2f5', midnight: '#0a0f1e', emerald: '#071210', warm: '#141008' };
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = themeColors[theme || 'dark'] || '#0e1117';
}

function applySettings() {
  // Apply theme
  applyTheme(CFG.theme);
  // Apply font scale
  document.documentElement.setAttribute('data-font-scale', CFG.fontScale || 'm');

  // Rebuild ticker bar if order changed (e.g. synced from server)
  if (CFG.tickerOrder) {
    const container = $('#ticker-inputs');
    if (container) {
      const current = [...container.querySelectorAll('.ticker-chip[data-idx]')].map(c => c.dataset.idx);
      if (JSON.stringify(current) !== JSON.stringify(CFG.tickerOrder)) {
        buildTickerBar();
        _restoreIndicesFromCache();
      }
    }
  }

  // Show/hide ticker items based on settings
  Object.entries(CFG.indices).forEach(([k, show]) => {
    const item = $(`.ticker-chip[data-idx="${k}"]`);
    if (item) item.style.display = show ? '' : 'none';
  });

  // First load: restore from cache, only fetch if cache is stale or empty
  if (!applySettings._fetched) {
    applySettings._fetched = true;

    // 1) Restore indices from localStorage cache
    const hasCache = _restoreIndicesFromCache();
    const lastT = _quoteCache.lastIndexTime();
    const ttl = _quoteCache._ttl();
    const stale = !lastT || (Date.now() - lastT >= ttl);

    // 2) Stock data: try cache first, else fetch
    handleFetchStock();

    // 3) Only fetch indices if no cache or cache expired
    if (CFG.autoFetch && (!hasCache || stale)) {
      handleFetchIndices(true);  // 初次載入帶入表單（也會觸發 F&G fetch）
      fetchTaifexMarginBtn();
    } else if (hasCache && !stale) {
      // Cache is fresh — also auto-fetch TAIFEX margins from cache/API
      fetchTaifexMarginBtn();
      // Restore F&G from cache, or fetch if stale
      if (!_quoteCache.getFearGreed()) _fetchFearGreed();
    }
  }

  // Refresh timer (based on settings interval)
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  if (CFG.refreshInterval > 0) {
    _refreshTimer = setInterval(handleFetchIndices, CFG.refreshInterval * 1000);
  }
}
applySettings._fetched = false;

// ================================================================
//  FETCH INDEX PRICES
// ================================================================
// updateForms: true = 同時帶入下方分頁欄位（使用者手動按鈕才帶入）
async function handleFetchIndices(updateForms) {
  const btn = $('#btn-fetch-indices');
  if (!btn || btn.classList.contains('loading')) return;
  btn.classList.add('loading');

  try {
    const results = await PriceService.fetchAllIndices();
    let ok = 0, fail = 0;
    for (const [key, q] of Object.entries(results)) {
      if (q.error) { fail++; continue; }
      ok++;
      _quoteCache.setIndex(key, q);
      _renderTickerChip(key, q);
    }
    if (updateForms && ok > 0) {
      if ($('#f-entry')) fillFromTicker('f-entry');
      if ($('#f-live-price')) fillFromTicker('f-live-price');
      if ($('#o-ul')) fillOptFromTicker();
      autoFillMarginPrice();
    }
    _updateBasis(results);
    _updateTickerTime(results);
    _renderSentimentStrip();
    _fetchFearGreed();
  } catch (e) { console.warn('[Prism] Index fetch error:', e.message); }
  btn.classList.remove('loading');
}

// 更新單一 ticker chip 的顯示（含價格變動閃爍）
function _renderTickerChip(key, q) {
  const input = $(`#idx-${key}`);
  const dispEl = $(`#disp-${key}`);
  const chgEl = $(`#chg-${key}`);
  const oldPrice = input ? parseFloat(input.value) : NaN;
  if (input) { input.value = q.price.toFixed(2); input.dispatchEvent(new Event('input', { bubbles: true })); }
  if (dispEl) {
    dispEl.textContent = fmt(q.price, q.price % 1 !== 0 ? 2 : 0);
    dispEl.classList.remove('stale');
    // 價格變動閃爍 (use rAF to batch DOM reads/writes)
    if (!isNaN(oldPrice) && oldPrice !== q.price) {
      const cls = q.price > oldPrice ? 'flash-up' : 'flash-down';
      dispEl.classList.remove('flash-up', 'flash-down');
      requestAnimationFrame(() => { dispEl.classList.add(cls); });
    }
  }
  if (chgEl) {
    chgEl.textContent = PriceService.fmtChg(q);
    // VIX 漲=恐慌加劇(red), 跌=恐慌減少(green) — 反向配色
    const chgDir = key === 'vix' ? (q.change >= 0 ? 'down' : 'up') : (q.change >= 0 ? 'up' : 'down');
    chgEl.className = `tc-chg ${chgDir}`;
  }
  // 台指期顯示盤別標示
  if (key === 'txf' && q.session) {
    const nameEl = $(`.ticker-chip[data-idx="txf"] .tc-name`);
    if (nameEl) nameEl.textContent = `台指期 ${q.session}`;
  }
  // VIX 依波動程度上色
  if (key === 'vix' && dispEl) {
    const lv = _vixLevel(q.price);
    dispEl.style.color = lv.color;
  }
  // 設定 tooltip：來源報價時間 + 本地抓取時間
  const chip = $(`.ticker-chip[data-idx="${key}"]`);
  if (chip) {
    const tFmt = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
    const fetchStr = new Date().toLocaleTimeString('zh-TW', tFmt);
    const srcStr = q.sourceTime ? new Date(q.sourceTime).toLocaleTimeString('zh-TW', tFmt) : null;
    chip.title = srcStr
      ? `來源報價時間：${srcStr}\n本地抓取時間：${fetchStr}`
      : `本地抓取時間：${fetchStr}`;
  }
}

// ================================================================
//  FETCH INDIVIDUAL STOCK PRICE
// ================================================================
async function handleFetchStock() {
  const symbolInput = $('#m-symbol');
  const infoEl = $('#m-stock-info');
  const fetchBtn = $('#m-fetch-stock');
  if (!symbolInput || !symbolInput.value.trim()) return;

  const market = S.margin.market;
  if (fetchBtn) { fetchBtn.disabled = true; fetchBtn.textContent = '查詢中…'; }
  if (infoEl) infoEl.innerHTML = '<span class="tm">查詢中…</span>';

  try {
    const code = symbolInput.value.trim();
    // Check cache first
    let q = _quoteCache.getStock(market, code);
    if (!q) {
      q = await PriceService.fetchStockQuote(code, market);
      _quoteCache.setStock(market, code, q);
    }
    _displayStockInfo(q, code, market, infoEl);
    _fillStockPrice(q, true);
  } catch (e) {
    if (infoEl) infoEl.innerHTML = `<span class="tr">${e.message}</span>`;
  }
  if (fetchBtn) { fetchBtn.disabled = false; fetchBtn.textContent = '查詢'; }
}

// ── Stock display & fill helpers ──
function _displayStockInfo(q, code, market, infoEl) {
  if (!infoEl) return;
  const chgCls = q.change >= 0 ? 'price-up' : 'price-down';
  const chgStr = PriceService.fmtChg(q);
  const tvSym = market === 'tw' && /^\d{4,6}[A-Za-z]?$/.test(code) ? `TWSE:${code}` : code.toUpperCase();
  const provName = market === 'tw' ? PriceService.PROVIDER_INFO[CFG.twSource]?.name : PriceService.PROVIDER_INFO[CFG.usSource]?.name;
  const tFmt = { hour: '2-digit', minute: '2-digit' };
  const fetchStr = new Date().toLocaleTimeString('zh-TW', tFmt);
  const srcStr = q.sourceTime ? new Date(q.sourceTime).toLocaleTimeString('zh-TW', tFmt) : '';
  const timeLabel = srcStr ? `報價 ${srcStr} · 抓取 ${fetchStr}` : fetchStr;
  const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym)}`;
  infoEl.innerHTML = `<span class="si-row"><strong>${_esc(q.name || code)}</strong> <span class="${chgCls}">${q.price.toFixed(2)} ${chgStr}</span></span><span class="si-row"><span class="tm" style="font-size:.6rem">${_esc(provName)} ${timeLabel}</span> <a href="${tvUrl}" target="_blank" rel="noopener" style="color:var(--accent);font-size:.66rem;margin-left:4px">TradingView</a></span>`;
}

function _fillStockPrice(q, force) {
  const isCashOrLong = S.margin.direction !== 'short';
  const priceField = $(isCashOrLong ? '#m-buy-price' : '#m-sell-price');
  if (priceField) {
    priceField.value = q.price.toFixed(2);
    priceField.dataset.fetched = '1';
    priceField.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const curField = $('#m-current-price');
  if (curField && (!curField.value || force)) {
    curField.value = q.price.toFixed(2);
    curField.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Restore stock info from cache after form rebuild (tab/mode switch)
function _restoreStockFromCache() {
  const symEl = $('#m-symbol');
  if (!symEl || !symEl.value.trim()) return;
  const code = symEl.value.trim();
  const market = S.margin.market;
  const q = _quoteCache.getStock(market, code);
  if (!q) return;
  const infoEl = $('#m-stock-info');
  _displayStockInfo(q, code, market, infoEl);
  _fillStockPrice(q);
  // Restore ETF leverage detection
  _autoDetectETF(code, market);
}

// ── Stock Autocomplete ──
function _setupMarginAutocomplete(input, market) {
  const list = $('#m-sym-ac');
  if (!input || !list) return;
  let focusIdx = -1;
  let items = [];

  const close = () => { list.classList.remove('open'); list.innerHTML = ''; items = []; focusIdx = -1; };

  const selectItem = (code, name) => {
    input.value = code;
    close();
    _autoDetectETF(code, market);
    handleFetchStock();
  };

  const render = (results) => {
    if (!results.length) { close(); return; }
    items = results;
    focusIdx = -1;
    list.innerHTML = results.map((r, i) =>
      `<div class="sym-ac-item" data-i="${i}"><span class="sym-code">${_esc(r.code)}</span><span class="sym-name">${_esc(r.name)}</span>${r.leverage ? `<span class="sym-exch">${r.leverage > 0 ? '' : ''}${Math.abs(r.leverage)}x</span>` : ''}</div>`
    ).join('');
    list.classList.add('open');
  };

  const doSearch = debounce(() => {
    const q = input.value.trim();
    if (!q || q.length < 1) { close(); return; }
    const results = StockDB.search(market, q);
    render(results);
  }, 150);

  input.addEventListener('input', doSearch);

  input.addEventListener('keydown', e => {
    if (!list.classList.contains('open') || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); focusIdx = Math.min(focusIdx + 1, items.length - 1); _highlightAC(list, focusIdx); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusIdx = Math.max(focusIdx - 1, 0); _highlightAC(list, focusIdx); }
    else if (e.key === 'Enter' && focusIdx >= 0) { e.preventDefault(); e.stopPropagation(); selectItem(items[focusIdx].code, items[focusIdx].name); }
    else if (e.key === 'Escape') { close(); }
  });

  list.addEventListener('click', e => {
    const el = e.target.closest('.sym-ac-item');
    if (!el) return;
    const i = parseInt(el.dataset.i);
    if (items[i]) selectItem(items[i].code, items[i].name);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.sym-ac-wrap')) close();
  });
}

function _highlightAC(list, idx) {
  $$('.sym-ac-item', list).forEach((el, i) => el.classList.toggle('focused', i === idx));
}

function _autoDetectETF(code, market) {
  const lev = StockDB.detectLeverage(market, code);
  const wrap = $('#m-etf-lev-wrap');
  const levInput = $('#m-etf-lev');
  const taxSel = $('#m-tax-rate');
  if (lev !== null && Math.abs(lev) !== 1) {
    // It's a leveraged ETF
    if (wrap) wrap.style.display = '';
    if (levInput) levInput.value = lev;
    if (taxSel && market === 'tw') taxSel.value = '0.001';
  } else if (lev !== null) {
    // Regular ETF (1x)
    if (wrap) wrap.style.display = 'none';
    if (levInput) levInput.value = 1;
    if (taxSel && market === 'tw') taxSel.value = '0.001';
  } else {
    // Regular stock
    if (wrap) wrap.style.display = 'none';
    if (levInput) levInput.value = 1;
    if (taxSel && market === 'tw') taxSel.value = '0.003';
  }
}

// ── Stock Futures Autocomplete (TW) ──
function _setupFuturesAC(input) {
  const list = $('#f-stk-ac');
  if (!input || !list) return;
  let focusIdx = -1, items = [];

  const close = () => { list.classList.remove('open'); list.innerHTML = ''; items = []; focusIdx = -1; };

  const selectItem = (code) => {
    input.value = code;
    close();
    // Update mul
    const sf = STOCK_FUTURES[code] || StockDB.getTaifexFutures().find(f => f.code === code);
    if (sf) { $('#f-mul').value = sf.mul; const d = $('#f-mul-display'); if (d) d.textContent = 'NT$ ' + fmt(sf.mul); }
    // Clear stale data and fetch
    const _clr = id => { const e = $(`#${id}`); if (e) e.value = ''; };
    ['f-entry', 'f-current', 'f-live-price', 'f-im-input', 'f-mm-input'].forEach(_clr);
    _fetchTaifexStockFutures(code);
  };

  const doSearch = debounce(() => {
    const q = input.value.trim();
    if (!q) { close(); return; }
    items = StockDB.searchStockFutures(q);
    if (!items.length) { close(); return; }
    focusIdx = -1;
    list.innerHTML = items.map((r, i) =>
      `<div class="sym-ac-item" data-i="${i}"><span class="sym-code">${_esc(r.code)}</span><span class="sym-name">${_esc(r.name)}</span></div>`
    ).join('');
    list.classList.add('open');
  }, 150);

  input.addEventListener('input', doSearch);
  input.addEventListener('keydown', e => {
    if (!list.classList.contains('open') || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); focusIdx = Math.min(focusIdx + 1, items.length - 1); _highlightAC(list, focusIdx); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusIdx = Math.max(focusIdx - 1, 0); _highlightAC(list, focusIdx); }
    else if (e.key === 'Enter' && focusIdx >= 0) { e.preventDefault(); e.stopPropagation(); selectItem(items[focusIdx].code); }
    else if (e.key === 'Escape') { close(); }
  });
  list.addEventListener('click', e => {
    const el = e.target.closest('.sym-ac-item');
    if (el && items[el.dataset.i]) selectItem(items[el.dataset.i].code);
  });
  document.addEventListener('click', e => { if (!e.target.closest('.sym-ac-wrap')) close(); });
}

// ================================================================
//  MARGIN FORM
// ================================================================
function renderMarginForm() {
  const { market, direction } = S.margin;
  const tw = market === 'tw', long = direction === 'long', cash = direction === 'cash';
  const cur = tw ? 'NT$' : 'USD';
  const su = tw ? '張 (1張=1000股)' : '股';
  const symbolHint = tw ? '例: 2330、0050' : '例: AAPL、MSFT';

  // ── 共用區塊：股票代號(含autocomplete) + 價格 + 數量 ──
  let h = `
    <div class="fg"><label>股票代號 <span class="hint">${symbolHint}</span></label>
      <div class="stock-search-row">
        <div class="sym-ac-wrap" style="flex:1;position:relative">
          <input type="text" id="m-symbol" placeholder="${tw ? '輸入代號或名稱' : 'Symbol or name'}" autocomplete="off">
          <div class="sym-ac-list" id="m-sym-ac"></div>
        </div>
        <button type="button" class="mini-fetch-btn" id="m-fetch-stock">查詢</button>
      </div>
      <div class="stock-info" id="m-stock-info"></div>
    </div>
    <div class="fg" id="m-etf-lev-wrap" style="display:none"><label>ETF 槓桿倍數 <span class="hint">(自動偵測)</span></label><input type="number" id="m-etf-lev" value="1" step="any"></div>
    <div class="fr">
      <div class="fg"><label>買進價格 <span class="hint">(${cur})</span></label><input type="number" id="m-buy-price" placeholder="${tw ? '市價' : 'Market'}" step="any"></div>
      <div class="fg"><label>${cash ? '賣出價格' : '目前價格'} <span class="hint">(留空=同買進)</span></label><input type="number" id="m-current-price" placeholder="即時價格" step="any"></div>
    </div>`;

  if (cash) {
    // ── 現股模式：只需數量 + 費用 ──
    h += `
    <div class="fg"><label>數量 <span class="hint">${su}</span></label><input type="number" id="m-qty" value="1" min="1" step="1"></div>
    ${tw ? (() => { const t = CFG.twTaxRate || '0.003'; return `<div class="fr">
      <div class="fg"><label>手續費折扣</label><select id="m-fee-disc">
        <option value="1" ${CFG.twFeeDisc==='1'?'selected':''}>全額 0.1425%</option><option value="0.6" ${CFG.twFeeDisc==='0.6'?'selected':''}>6折 0.0855%</option>
        <option value="0.5" ${CFG.twFeeDisc==='0.5'?'selected':''}>5折 0.07125%</option><option value="0.38" ${CFG.twFeeDisc==='0.38'?'selected':''}>3.8折</option>
        <option value="0.28" ${CFG.twFeeDisc==='0.28'?'selected':''}>2.8折 0.0399%</option><option value="0" ${CFG.twFeeDisc==='0'?'selected':''}>免手續費</option>
      </select></div>
      <div class="fg"><label>證交稅(賣出)</label><select id="m-tax-rate">
        <option value="0.003" ${t==='0.003'?'selected':''}>0.3% 股票</option>
        <option value="0.001" ${t==='0.001'?'selected':''}>0.1% ETF</option>
        <option value="0.0015" ${t==='0.0015'?'selected':''}>0.15% 當沖減半</option>
      </select></div>
    </div>`; })() : `<div class="fg"><label>Commission <span class="hint">(per trade)</span></label><input type="number" id="m-comm" value="${CFG.usComm||'0'}" step="any"></div>`}`;
  } else {
    // ── 融資/融券模式 ──
    const priceLabel = long ? '買進價格' : '賣出價格';
    const priceId = long ? 'm-buy-price' : 'm-sell-price';
    const marginId = long ? 'm-margin-rate' : 'm-short-margin-rate';
    const marginOpts = long
      ? (tw ? '<option value="0.6">60%</option><option value="0.5">50%</option><option value="0.4">40%</option>'
           : '<option value="0.5">50% Reg T</option><option value="0.7">70%</option><option value="0.6">60%</option>')
      : (tw ? '<option value="0.9">90%</option><option value="1.0">100%</option><option value="1.2">120%</option>'
           : '<option value="0.5">50% Reg T</option><option value="0.6">60%</option>');
    const defCall = long ? (tw ? 130 : 25) : (tw ? 130 : 30);
    const defForced = long ? (tw ? 120 : 20) : (tw ? 120 : 25);

    // Replace buy price row with correct label for short
    if (!long) {
      h = `
    <div class="fg"><label>股票代號 <span class="hint">${symbolHint}</span></label>
      <div class="stock-search-row">
        <div class="sym-ac-wrap" style="flex:1;position:relative">
          <input type="text" id="m-symbol" placeholder="${tw ? '輸入代號或名稱' : 'Symbol or name'}" autocomplete="off">
          <div class="sym-ac-list" id="m-sym-ac"></div>
        </div>
        <button type="button" class="mini-fetch-btn" id="m-fetch-stock">查詢</button>
      </div>
      <div class="stock-info" id="m-stock-info"></div>
    </div>
    <div class="fg" id="m-etf-lev-wrap" style="display:none"><label>ETF 槓桿倍數 <span class="hint">(自動偵測)</span></label><input type="number" id="m-etf-lev" value="1" step="any"></div>
    <div class="fr">
      <div class="fg"><label>${priceLabel} <span class="hint">(${cur})</span></label><input type="number" id="${priceId}" placeholder="${tw ? '市價' : 'Market'}" step="any"></div>
      <div class="fg"><label>目前價格 <span class="hint">(留空=以進場價計算)</span></label><input type="number" id="m-current-price" placeholder="即時價格" step="any"></div>
    </div>`;
    }

    h += `
    <div class="fr">
      <div class="fg"><label>數量 <span class="hint">${su}</span></label><input type="number" id="m-qty" value="1" min="1" step="1"></div>
      <div class="fg"><label>${long ? (tw ? '融資成數' : 'Margin') : (tw ? '券保證金成數' : 'Short Margin')}</label><select id="${marginId}">${marginOpts}</select></div>
    </div>
    <div class="fr">
      <div class="fg"><label>追繳線</label><div class="isuf"><input type="number" id="m-call-rate" value="${defCall}" step="any"><span class="suf">%</span></div></div>
      <div class="fg"><label>斷頭線</label><div class="isuf"><input type="number" id="m-forced-rate" value="${defForced}" step="any"><span class="suf">%</span></div></div>
    </div>
    ${tw ? (() => { const t = CFG.twTaxRate || '0.003'; return `<div class="fr">
      <div class="fg"><label>手續費折扣</label><select id="m-fee-disc">
        <option value="1" ${CFG.twFeeDisc==='1'?'selected':''}>全額 0.1425%</option><option value="0.6" ${CFG.twFeeDisc==='0.6'?'selected':''}>6折 0.0855%</option>
        <option value="0.5" ${CFG.twFeeDisc==='0.5'?'selected':''}>5折 0.07125%</option><option value="0.38" ${CFG.twFeeDisc==='0.38'?'selected':''}>3.8折</option>
        <option value="0.28" ${CFG.twFeeDisc==='0.28'?'selected':''}>2.8折 0.0399%</option><option value="0" ${CFG.twFeeDisc==='0'?'selected':''}>免手續費</option>
      </select></div>
      <div class="fg"><label>證交稅(賣出)</label><select id="m-tax-rate">
        <option value="0.003" ${t==='0.003'?'selected':''}>0.3% 股票</option>
        <option value="0.001" ${t==='0.001'?'selected':''}>0.1% ETF</option>
        <option value="0.0015" ${t==='0.0015'?'selected':''}>0.15% 當沖減半</option>
      </select></div>
    </div>`; })() + `
    <div class="fr">
      <div class="fg"><label>${long ? '融資年利率' : '借券費率(年)'}</label><div class="isuf"><input type="number" id="m-int-rate" value="${long ? '6.25' : '0.5'}" step="any"><span class="suf">%</span></div></div>
      <div class="fg"><label>持有天數</label><input type="number" id="m-hold-days" value="30" min="0" step="1"></div>
    </div>` : `<div class="fr">
      <div class="fg"><label>Commission <span class="hint">(per trade)</span></label><input type="number" id="m-comm" value="${CFG.usComm||'0'}" step="any"></div>
      <div class="fg"><label>Holding Days</label><input type="number" id="m-hold-days" value="30" min="0" step="1"></div>
    </div>
    <div class="fg"><label>Margin Interest Rate</label><div class="isuf"><input type="number" id="m-int-rate" value="${long ? '8' : '3'}" step="any"><span class="suf">%/yr</span></div></div>`}`;
  }

  $('#margin-inputs').innerHTML = h;
  $('#margin-results').innerHTML = PLACEHOLDER;

  // Sync fee settings back to CFG when changed in calc form
  const feeDisc = $('#m-fee-disc');
  if (feeDisc) feeDisc.addEventListener('change', () => { CFG.twFeeDisc = feeDisc.value; saveSettings(CFG); });
  const taxRate = $('#m-tax-rate');
  if (taxRate) taxRate.addEventListener('change', () => { CFG.twTaxRate = taxRate.value; saveSettings(CFG); });
  const usCommEl = $('#m-comm');
  if (usCommEl) usCommEl.addEventListener('change', () => { CFG.usComm = usCommEl.value; saveSettings(CFG); });

  // Wire stock search + autocomplete
  const fetchStockBtn = $('#m-fetch-stock');
  if (fetchStockBtn) fetchStockBtn.addEventListener('click', handleFetchStock);
  const symbolInput = $('#m-symbol');
  if (symbolInput) {
    symbolInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); handleFetchStock(); } });
    _setupMarginAutocomplete(symbolInput, market);
  }

  // Pre-fill default stock code
  const defStock = tw ? '2330' : 'NVDA';
  const symEl = $('#m-symbol');
  if (symEl && !symEl.value) symEl.value = defStock;

  wrapNumberInputs($('#margin-inputs'));

  // Restore cached stock data (so mode switch doesn't lose info)
  _restoreStockFromCache();

  calcMargin();
}

// Auto-fill margin price from default stock (called after ticker fetch)
async function autoFillMarginPrice() {
  const symEl = $('#m-symbol');
  const priceId = S.margin.direction !== 'short' ? '#m-buy-price' : '#m-sell-price';
  const priceEl = $(priceId);
  if (!symEl || !symEl.value.trim() || !priceEl) return;
  // 若已查詢過或使用者已手動輸入價格，則不覆蓋
  if (priceEl.dataset.fetched || priceEl.value) return;
  try {
    const code = symEl.value.trim();
    const mk = S.margin.market;
    let q = _quoteCache.getStock(mk, code);
    if (!q) {
      q = await PriceService.fetchStockQuote(code, mk);
      _quoteCache.setStock(mk, code, q);
    }
    _fillStockPrice(q);
    _displayStockInfo(q, code, mk, $('#m-stock-info'));
  } catch {}
}

// ================================================================
//  MARGIN CALC
// ================================================================
function calcMargin() {
  const { market, direction } = S.margin;
  const tw = market === 'tw', long = direction === 'long', cash = direction === 'cash';
  const cur = tw ? 'NT$' : 'USD';
  const spu = tw ? 1000 : 1;
  const qty = gV('m-qty'), ts = qty * spu;
  const etfLev = gV('m-etf-lev') || 1;
  const isETF = Math.abs(etfLev) !== 1;

  // ── CASH MODE (現股) ──
  if (cash) {
    const bp = gV('m-buy-price');
    let cp = gV('m-current-price'); if (!cp) cp = bp;
    if (!bp || !qty) { $('#margin-results').innerHTML = PLACEHOLDER; return; }
    const tc = bp * ts, cv = cp * ts, upl = (cp - bp) * ts;
    let buyFee, sellFee, sellTax, totalFees;
    if (tw) {
      const disc = parseFloat($('#m-fee-disc')?.value || '0.5');
      const feeRate = 0.001425 * disc;
      const taxRate = parseFloat($('#m-tax-rate')?.value || '0.003');
      buyFee = Math.round(Math.max(20, tc * feeRate)); sellFee = Math.round(Math.max(20, cv * feeRate)); sellTax = Math.round(cv * taxRate);
    } else {
      const comm = gV('m-comm') || 0;
      buyFee = comm; sellFee = comm; sellTax = Math.round(cv * 0.0000278 * 100) / 100;
    }
    totalFees = buyFee + sellFee + sellTax;
    const netPL = upl - totalFees;
    const roi = tc > 0 ? (netPL / tc * 100) : 0;
    const plH = upl >= 0 ? 'h-green' : 'h-red', plS = upl >= 0 ? '+' : '';
    const effectiveLev = Math.abs(etfLev);

    const overview = `
      ${alertBox('safe', '現股交易，無融資融券風險')}
      <div class="mg">
        ${mgLabel('部位資訊')}
        ${mc('投入金額', fM(tc, cur), `${fM(bp, cur, 2)} × ${fmt(ts)}股`)}
        ${mc('目前市值', fM(cv, cur), `${fM(cp, cur, 2)} × ${fmt(ts)}股`)}
        ${isETF ? mc('ETF槓桿', effectiveLev.toFixed(1) + 'x', `指數±1% → ETF±${effectiveLev.toFixed(1)}%`, 'h-accent') : ''}
        ${mgLabel('損益')}
        ${mc('未實現損益(税前)', plS + fM(upl, cur), `每股 ${plS}${fM(cp - bp, cur, 2)}`, plH)}
        ${mc('投資報酬率', (netPL >= 0 ? '+' : '') + roi.toFixed(2) + '%', `淨損益 ${(netPL >= 0 ? '+' : '')}${fM(netPL, cur)}`, netPL >= 0 ? 'h-green' : 'h-red')}
      </div>
      ${totalFees > 0 ? costTable(
        tw ? [
          { name: '買進手續費', detail: `${fM(tc,cur)} × 0.1425% × ${parseFloat($('#m-fee-disc')?.value||'0.5')*10}折`, amt: fM(buyFee, cur) },
          { name: '賣出手續費', detail: `${fM(cv,cur)} × 0.1425% × ${parseFloat($('#m-fee-disc')?.value||'0.5')*10}折`, amt: fM(sellFee, cur) },
          { name: '證交稅(賣出)', detail: `${fM(cv,cur)} × ${(parseFloat($('#m-tax-rate')?.value||'0.003')*100).toFixed(2)}%`, amt: fM(sellTax, cur) },
        ] : [
          { name: 'Commission (Buy)', amt: fM(buyFee, cur) },
          { name: 'Commission (Sell)', amt: fM(sellFee, cur) },
          { name: 'SEC Fee (Sell)', detail: `${fM(cv,cur)} × 0.00278%`, amt: fM(sellTax, cur) },
        ],
        fM(totalFees, cur),
        { label: '淨損益(税後)', value: (netPL >= 0 ? '+' : '') + fM(netPL, cur) + ` (報酬率 ${roi.toFixed(2)}%)`, positive: netPL >= 0 }
      ) : ''}`;

    const steps = [30, 25, 20, 15, 10, 5, 0, -5, -10, -15, -20, -25, -30, -35, -40, -45, -50];
    let sRows = '';
    for (const p of steps) {
      const pr = bp * (1 + p / 100), diff = pr - bp, v = pr * ts, u = (pr - bp) * ts;
      let sf;
      if (tw) { const d2 = parseFloat($('#m-fee-disc')?.value||'0.5'), r2 = 0.001425*d2, t2 = parseFloat($('#m-tax-rate')?.value||'0.003'); sf = Math.max(20,tc*r2)+Math.max(20,v*r2)+v*t2; }
      else { sf = (gV('m-comm')||0)*2+v*0.0000278; }
      const net = u - sf, r = tc > 0 ? (net / tc * 100) : 0;
      const rc2 = p === 0 ? 'rc' : '';
      const diffStr = (diff >= 0 ? '+' : '') + fM(diff, cur, 2);
      sRows += `<tr class="${rc2}"><td>${p > 0 ? '+' : ''}${p}%<br><span class="tm">${diffStr}</span></td><td>${fM(pr, cur, 2)}</td><td class="${u >= 0 ? 'tg' : 'tr'}">${u >= 0 ? '+' : ''}${fM(u, cur)}</td><td class="${net >= 0 ? 'tg' : 'tr'}">${net >= 0 ? '+' : ''}${fM(net, cur)}</td><td class="${r >= 0 ? 'tg' : 'tr'}">${r >= 0 ? '+' : ''}${r.toFixed(1)}%</td></tr>`;
    }
    const stress = `<div class="st-wrap"><table class="st"><thead><tr><th>漲跌</th><th>股價</th><th>損益</th><th>淨損益</th><th>報酬率</th></tr></thead><tbody>${sRows}</tbody></table></div>`;

    const formula = tw ? `<div class="fc">
      <div class="fb"><h4>1. 投入金額</h4>
        <span class="fl"><span class="v">投入金額</span> <span class="o">=</span> 買進價格(<span class="n">${fM(bp,cur,2)}</span>) <span class="o">×</span> 股數(<span class="n">${fmt(ts)}</span>) <span class="o">=</span> <span class="r">${fM(tc,cur)}</span></span>
      </div>
      <div class="fb"><h4>2. 未實現損益</h4>
        <span class="fl"><span class="v">損益</span> <span class="o">=</span> (目前價格(<span class="n">${fM(cp,cur,2)}</span>) <span class="o">−</span> 買進價格(<span class="n">${fM(bp,cur,2)}</span>)) <span class="o">×</span> 股數(<span class="n">${fmt(ts)}</span>) <span class="o">=</span> <span class="r">${plS}${fM(upl,cur)}</span></span>
      </div>
      <div class="fb"><h4>3. 交易成本</h4>
        <span class="fl"><span class="v">買進手續費</span> <span class="o">=</span> max(20, ${fM(tc,cur)} × 0.1425% × ${parseFloat($('#m-fee-disc')?.value||'0.5')*10}折) <span class="o">=</span> <span class="r">${fM(buyFee,cur)}</span></span>
        <span class="fl"><span class="v">賣出手續費</span> <span class="o">=</span> max(20, ${fM(cv,cur)} × 0.1425% × ${parseFloat($('#m-fee-disc')?.value||'0.5')*10}折) <span class="o">=</span> <span class="r">${fM(sellFee,cur)}</span></span>
        <span class="fl"><span class="v">證交稅</span> <span class="o">=</span> ${fM(cv,cur)} × ${(parseFloat($('#m-tax-rate')?.value||'0.003')*100).toFixed(2)}% <span class="o">=</span> <span class="r">${fM(sellTax,cur)}</span></span>
      </div>
      <div class="fb"><h4>4. 淨損益 & 報酬率</h4>
        <span class="fl"><span class="v">淨損益</span> <span class="o">=</span> 損益(<span class="n">${plS}${fM(upl,cur)}</span>) <span class="o">−</span> 成本(<span class="n">${fM(totalFees,cur)}</span>) <span class="o">=</span> <span class="r">${(netPL>=0?'+':'')}${fM(netPL,cur)}</span></span>
        <span class="fl"><span class="v">報酬率</span> <span class="o">=</span> 淨損益 <span class="o">÷</span> 投入金額(<span class="n">${fM(tc,cur)}</span>) <span class="o">=</span> <span class="r">${roi.toFixed(2)}%</span></span>
      </div>
    </div>` : `<div class="fc">
      <div class="fb"><h4>1. Total Cost</h4>
        <span class="fl"><span class="v">Cost</span> <span class="o">=</span> Price(<span class="n">${fM(bp,cur,2)}</span>) <span class="o">×</span> Shares(<span class="n">${fmt(ts)}</span>) <span class="o">=</span> <span class="r">${fM(tc,cur)}</span></span>
      </div>
      <div class="fb"><h4>2. P&L</h4>
        <span class="fl"><span class="v">P&L</span> <span class="o">=</span> (Current(<span class="n">${fM(cp,cur,2)}</span>) <span class="o">−</span> Buy(<span class="n">${fM(bp,cur,2)}</span>)) <span class="o">×</span> Shares(<span class="n">${fmt(ts)}</span>) <span class="o">=</span> <span class="r">${plS}${fM(upl,cur)}</span></span>
      </div>
      <div class="fb"><h4>3. Fees</h4>
        <span class="fl"><span class="v">Commission</span> <span class="o">=</span> <span class="r">${fM(buyFee+sellFee,cur)}</span></span>
        <span class="fl"><span class="v">SEC Fee</span> <span class="o">=</span> ${fM(cv,cur)} × 0.00278% <span class="o">=</span> <span class="r">${fM(sellTax,cur)}</span></span>
      </div>
      <div class="fb"><h4>4. Net P&L & ROI</h4>
        <span class="fl"><span class="v">Net</span> <span class="o">=</span> P&L(<span class="n">${plS}${fM(upl,cur)}</span>) <span class="o">−</span> Fees(<span class="n">${fM(totalFees,cur)}</span>) <span class="o">=</span> <span class="r">${(netPL>=0?'+':'')}${fM(netPL,cur)}</span></span>
        <span class="fl"><span class="v">ROI</span> <span class="o">=</span> Net <span class="o">÷</span> Cost(<span class="n">${fM(tc,cur)}</span>) <span class="o">=</span> <span class="r">${roi.toFixed(2)}%</span></span>
      </div>
    </div>`;

    $('#margin-results').innerHTML = subTabs('mr', ['風險概覽', '壓力測試', '計算公式'], [overview, stress, formula]) + (window.PrismJournal ? PrismJournal.recordBtnHTML('margin') : '');
    return;
  }

  // ── MARGIN (Long / Short) ──
  const cr = gV('m-call-rate') / 100, fr = gV('m-forced-rate') / 100;
  const holdDays = gV('m-hold-days') || 0;
  const intRate = (gV('m-int-rate') || 0) / 100;

  if (long) {
    const bp = gV('m-buy-price'), mr = parseFloat($('#m-margin-rate')?.value || '0.5');
    let cp = gV('m-current-price'); if (!cp) cp = bp;
    if (!bp || !qty) { $('#margin-results').innerHTML = PLACEHOLDER; return; }

    const lps = bp * mr, eps = bp * (1 - mr), tl = lps * ts, te = eps * ts;
    const tc = bp * ts, cv = cp * ts, upl = (cp - bp) * ts, ce = cv - tl;

    // Fee calculation
    let buyFee, sellFee, sellTax, interest, totalFees;
    if (tw) {
      const disc = parseFloat($('#m-fee-disc')?.value || '0.5');
      const feeRate = 0.001425 * disc;
      const taxRate = parseFloat($('#m-tax-rate')?.value || '0.003');
      buyFee = Math.round(Math.max(20, tc * feeRate));
      sellFee = Math.round(Math.max(20, cv * feeRate));
      sellTax = Math.round(cv * taxRate);
      interest = Math.round(tl * intRate * holdDays / 365);
    } else {
      const comm = gV('m-comm') || 0;
      buyFee = comm; sellFee = comm;
      sellTax = Math.round(cv * 0.0000278 * 100) / 100; // SEC fee
      interest = Math.round(tl * intRate * holdDays / 365 * 100) / 100;
    }
    totalFees = buyFee + sellFee + sellTax + interest;
    const netPL = upl - totalFees;
    const lev = te > 0 ? tc / te : 0, effectiveLev = lev * Math.abs(etfLev);
    let maint, callP, forcedP;
    if (tw) { maint = tl > 0 ? cv / tl : 0; callP = lps * cr; forcedP = lps * fr; }
    else { maint = cv > 0 ? ce / cv : 0; callP = (1 - cr) > 0 ? lps / (1 - cr) : 0; forcedP = (1 - fr) > 0 ? lps / (1 - fr) : 0; }

    const rl = tw ? riskLvl(maint * 100, 166, 140, cr * 100) : riskLvl(maint * 100, 40, 30, cr * 100);
    const mp = maint * 100, fillPct = tw ? Math.min(100, (mp - 100) / 100 * 100) : Math.min(100, mp);
    const dC = bp - callP, dCP = bp > 0 ? dC / bp * 100 : 0, dF = bp - forcedP, dFP = bp > 0 ? dF / bp * 100 : 0;
    const dCur = cp - callP, dCurP = cp > 0 ? dCur / cp * 100 : 0;
    const statusMap = { safe: '安全', caution: '注意', danger: '追繳', critical: '斷頭' };
    const alertMsg = { safe: '維持率充足，風險可控。', caution: '接近追繳邊緣！', danger: tw ? '已觸發追繳！T+2 日內需補繳。' : 'Margin call!', critical: tw ? '已達斷頭標準！' : 'Forced liquidation!' };
    const plH = upl >= 0 ? 'h-green' : 'h-red', plS = upl >= 0 ? '+' : '', eqRet = te > 0 ? ((ce - te) / te * 100).toFixed(1) : '0.0';

    const overview = `
      ${alertBox(rl === 'safe' ? 'safe' : rl === 'caution' ? 'warning' : 'danger', alertMsg[rl])}
      ${riskBar(tw ? '擔保維持率' : 'Margin Ratio', fP(mp), statusMap[rl], rl, fillPct)}
      <div class="mg">
        ${mgLabel('部位資訊')}
        ${mc(tw ? '融資金額' : 'Loan', fM(tl, cur), `每股 ${fM(lps, cur, 2)}`)}
        ${mc(tw ? '自備款' : 'Equity', fM(te, cur), `每股 ${fM(eps, cur, 2)}`)}
        ${mc('槓桿倍數', effectiveLev.toFixed(2) + 'x', isETF ? `融資${lev.toFixed(1)}x × ETF${etfLev}x` : `±1% → 權益±${lev.toFixed(1)}%`, 'h-accent')}
        ${mc('目前市值', fM(cv, cur), `成本 ${fM(tc, cur)}`)}
        ${mgLabel('損益')}
        ${mc('未實現損益(税前)', plS + fM(upl, cur), `權益 ${fM(ce, cur)} (${eqRet}%)`, plH)}
        ${mgLabel('風險警示')}
        ${mc('追繳價格', fM(callP, cur, 2), `從買價跌 ${fM(dC, cur, 2)} (${fP(dCP)})`, rl !== 'safe' ? 'h-yellow' : '')}
        ${mc('斷頭價格', fM(forcedP, cur, 2), `從買價跌 ${fM(dF, cur, 2)} (${fP(dFP)})`, rl === 'critical' ? 'h-red' : '')}
        ${mc('距追繳可跌(從目前)', dCur > 0 ? fM(dCur, cur, 2) : '已追繳!', dCur > 0 ? fP(dCurP) : '')}
      </div>
      ${totalFees > 0 ? costTable(
        tw ? [
          { name: '買進手續費', detail: `${fM(tc,cur)} × 0.1425% × ${parseFloat($('#m-fee-disc')?.value||'0.5')*10}折`, amt: fM(buyFee, cur) },
          { name: '賣出手續費', detail: `${fM(cv,cur)} × 0.1425% × ${parseFloat($('#m-fee-disc')?.value||'0.5')*10}折`, amt: fM(sellFee, cur) },
          { name: '證交稅(賣出)', detail: `${fM(cv,cur)} × ${(parseFloat($('#m-tax-rate')?.value||'0.003')*100).toFixed(2)}%`, amt: fM(sellTax, cur) },
          interest > 0 ? { name: '融資利息', detail: `${fM(tl,cur)} × ${(intRate*100).toFixed(2)}% × ${holdDays}天`, amt: fM(interest, cur) } : null,
        ] : [
          { name: 'Commission (Buy)', amt: fM(buyFee, cur) },
          { name: 'Commission (Sell)', amt: fM(sellFee, cur) },
          { name: 'SEC Fee (Sell)', detail: `${fM(cv,cur)} × 0.00278%`, amt: fM(sellTax, cur) },
          interest > 0 ? { name: 'Margin Interest', detail: `${fM(tl,cur)} × ${(intRate*100).toFixed(1)}% × ${holdDays}d`, amt: fM(interest, cur) } : null,
        ],
        fM(totalFees, cur),
        { label: '淨損益(税後)', value: (netPL >= 0 ? '+' : '') + fM(netPL, cur) + ` (報酬率 ${(netPL / te * 100).toFixed(1)}%)`, positive: netPL >= 0 }
      ) : ''}`;

    const steps = [30, 25, 20, 15, 10, 5, 0, -5, -10, -15, -20, -25, -30, -35, -40, -45, -50];
    let sRows = '';
    for (const p of steps) {
      const pr = bp * (1 + p / 100), diff = pr - bp, v = pr * ts, eq = v - tl;
      let mr2 = tw ? v / tl : eq / v;
      const u = (pr - bp) * ts;
      const lvl = tw ? riskLvl(mr2 * 100, 166, cr * 100 + 10, cr * 100) : riskLvl(mr2 * 100, 40, cr * 100 + 5, cr * 100);
      let st2 = '', rc2 = '';
      if (tw) { if (mr2 < fr) { st2 = '斷頭'; rc2 = 'rf'; } else if (mr2 < cr) { st2 = '追繳'; rc2 = 'rmc'; } else st2 = '安全'; }
      else { if (mr2 < fr) { st2 = 'Liq'; rc2 = 'rf'; } else if (mr2 < cr) { st2 = 'Call'; rc2 = 'rmc'; } else st2 = 'OK'; }
      if (p === 0) rc2 = 'rc';
      const sc = lvl === 'safe' ? 'sb-s' : lvl === 'caution' ? 'sb-c' : lvl === 'danger' ? 'sb-d' : 'sb-x';
      const diffStr = (diff >= 0 ? '+' : '') + fM(diff, cur, 2);
      sRows += `<tr class="${rc2}"><td>${p > 0 ? '+' : ''}${p}%<br><span class="tm">${diffStr}</span></td><td>${fM(pr, cur, 2)}</td><td class="${u >= 0 ? 'tg' : 'tr'}">${u >= 0 ? '+' : ''}${fM(u, cur)}</td><td>${fM(eq, cur)}</td><td class="${mr2 < cr ? 'tr' : ''}">${fP(mr2 * 100)}</td><td><span class="sb ${sc}">${st2}</span></td></tr>`;
    }
    const stress = `<div class="st-wrap"><table class="st"><thead><tr><th>漲跌</th><th>股價</th><th>損益</th><th>權益</th><th>${tw ? '維持率' : 'Margin%'}</th><th>狀態</th></tr></thead><tbody>${sRows}</tbody></table></div>`;

    const formula = tw ? `<div class="fc">
      <div class="fb"><h4>1. 融資金額與自備款</h4>
        <span class="fl"><span class="v">融資金額/股</span> <span class="o">=</span> 買進價格(<span class="n">${fM(bp,cur,2)}</span>) <span class="o">×</span> 融資成數(<span class="n">${(mr*100).toFixed(0)}%</span>) <span class="o">=</span> <span class="r">${fM(lps,cur,2)}</span></span>
        <span class="fl"><span class="v">自備款/股</span> <span class="o">=</span> 買進價格(<span class="n">${fM(bp,cur,2)}</span>) <span class="o">×</span> (1−融資成數)(<span class="n">${((1-mr)*100).toFixed(0)}%</span>) <span class="o">=</span> <span class="r">${fM(eps,cur,2)}</span></span>
        <span class="fl"><span class="v">融資總額</span> <span class="o">=</span> 融資金額/股(<span class="n">${fM(lps,cur,2)}</span>) <span class="o">×</span> 股數(<span class="n">${fmt(ts)}</span>) <span class="o">=</span> <span class="r">${fM(tl,cur)}</span></span>
        <span class="fl"><span class="v">自備款總額</span> <span class="o">=</span> 自備款/股(<span class="n">${fM(eps,cur,2)}</span>) <span class="o">×</span> 股數(<span class="n">${fmt(ts)}</span>) <span class="o">=</span> <span class="r">${fM(te,cur)}</span></span>
        <span class="fl"><span class="v">總成本</span> <span class="o">=</span> 融資(<span class="n">${fM(tl,cur)}</span>) <span class="o">+</span> 自備(<span class="n">${fM(te,cur)}</span>) <span class="o">=</span> <span class="r">${fM(tc,cur)}</span></span>
      </div>
      <div class="fb"><h4>2. 槓桿倍數</h4>
        <span class="fl"><span class="v">槓桿</span> <span class="o">=</span> 總成本(<span class="n">${fM(tc,cur)}</span>) <span class="o">÷</span> 自備款(<span class="n">${fM(te,cur)}</span>) <span class="o">=</span> <span class="r">${lev.toFixed(2)}x</span></span>
        ${isETF ? `<span class="fl"><span class="v">有效槓桿</span> <span class="o">=</span> 融資槓桿(<span class="n">${lev.toFixed(2)}x</span>) <span class="o">×</span> ETF槓桿(<span class="n">${etfLev}x</span>) <span class="o">=</span> <span class="r">${effectiveLev.toFixed(2)}x</span></span>
        <div class="fn">指數跌1% → ETF跌${Math.abs(etfLev)}% → 權益跌${effectiveLev.toFixed(1)}%</div>` : `<div class="fn">每漲跌1%，權益變動${lev.toFixed(1)}%</div>`}
      </div>
      <div class="fb"><h4>3. 擔保維持率</h4>
        <span class="fl"><span class="v">目前市值</span> <span class="o">=</span> 目前價格(<span class="n">${fM(cp,cur,2)}</span>) <span class="o">×</span> 股數(<span class="n">${fmt(ts)}</span>) <span class="o">=</span> <span class="r">${fM(cv,cur)}</span></span>
        <span class="fl"><span class="v">維持率</span> <span class="o">=</span> 市值(<span class="n">${fM(cv,cur)}</span>) <span class="o">÷</span> 融資金額(<span class="n">${fM(tl,cur)}</span>) <span class="o">=</span> <span class="r">${fP(mp)}</span></span>
        <div class="fn">< ${(cr*100).toFixed(0)}% → 追繳 (須於 T+2 日補繳)　< ${(fr*100).toFixed(0)}% → 斷頭 (券商強制賣出)</div>
      </div>
      <div class="fb"><h4>4. 未實現損益</h4>
        <span class="fl"><span class="v">損益</span> <span class="o">=</span> (目前價格(<span class="n">${fM(cp,cur,2)}</span>) <span class="o">−</span> 買進價格(<span class="n">${fM(bp,cur,2)}</span>)) <span class="o">×</span> 股數(<span class="n">${fmt(ts)}</span>) <span class="o">=</span> <span class="r">${plS}${fM(upl,cur)}</span></span>
        <span class="fl"><span class="v">權益</span> <span class="o">=</span> 市值(<span class="n">${fM(cv,cur)}</span>) <span class="o">−</span> 融資金額(<span class="n">${fM(tl,cur)}</span>) <span class="o">=</span> <span class="r">${fM(ce,cur)}</span></span>
        <span class="fl"><span class="v">權益報酬率</span> <span class="o">=</span> (權益(<span class="n">${fM(ce,cur)}</span>) <span class="o">−</span> 自備(<span class="n">${fM(te,cur)}</span>)) <span class="o">÷</span> 自備(<span class="n">${fM(te,cur)}</span>) <span class="o">=</span> <span class="r">${eqRet}%</span></span>
      </div>
      <div class="fb"><h4>5. 追繳 & 斷頭價格</h4>
        <span class="fl"><span class="v">追繳價</span> <span class="o">=</span> 融資金額/股(<span class="n">${fM(lps,cur,2)}</span>) <span class="o">×</span> 追繳線(<span class="n">${cr}</span>) <span class="o">=</span> <span class="r">${fM(callP,cur,2)}</span></span>
        <span class="fl">　從買進價跌 <span class="r">${fM(dC,cur,2)}</span> (<span class="r">${fP(dCP)}</span>)，距目前價可跌 <span class="r">${dCur > 0 ? fM(dCur,cur,2) : '已追繳!'}</span></span>
        <span class="fl"><span class="v">斷頭價</span> <span class="o">=</span> 融資金額/股(<span class="n">${fM(lps,cur,2)}</span>) <span class="o">×</span> 斷頭線(<span class="n">${fr}</span>) <span class="o">=</span> <span class="r">${fM(forcedP,cur,2)}</span></span>
        <span class="fl">　從買進價跌 <span class="r">${fM(dF,cur,2)}</span> (<span class="r">${fP(dFP)}</span>)</span>
      </div>
      <div class="fb"><h4>6. 券商處置流程</h4>
        <span class="fl">① <span class="v">維持率 < ${(cr*100).toFixed(0)}% (追繳線)</span>：券商發出<strong>追繳通知</strong>，投資人須在 <strong>T+2 日</strong> 收盤前補繳差額，使維持率回到 166% 以上。</span>
        <span class="fl">② <span class="v">逾期未補繳 或 維持率 < ${(fr*100).toFixed(0)}% (斷頭線)</span>：券商有權在次一營業日以市價<strong>強制賣出</strong>全部融資股票（俗稱「斷頭」），賣出後之餘額（扣除融資本息及手續費等）退還投資人；若不足，投資人仍需補繳差額。</span>
        <span class="fl">③ <span class="v">盤中急跌</span>：若盤中維持率急跌至斷頭線以下，部分券商可能在<strong>盤中即時</strong>執行斷頭，不待 T+2 補繳期限。</span>
        <div class="fn">實際追繳時程與斷頭規則以各券商信用交易契約為準，上述為一般慣例。</div>
      </div>
    </div>` : `<div class="fc">
      <div class="fb"><h4>1. Loan & Equity</h4>
        <span class="fl"><span class="v">Loan/share</span> <span class="o">=</span> Buy Price(<span class="n">${fM(bp,cur,2)}</span>) <span class="o">×</span> Margin Rate(<span class="n">${(mr*100).toFixed(0)}%</span>) <span class="o">=</span> <span class="r">${fM(lps,cur,2)}</span></span>
        <span class="fl"><span class="v">Equity/share</span> <span class="o">=</span> Buy Price(<span class="n">${fM(bp,cur,2)}</span>) <span class="o">×</span> (1−Rate)(<span class="n">${((1-mr)*100).toFixed(0)}%</span>) <span class="o">=</span> <span class="r">${fM(eps,cur,2)}</span></span>
        <span class="fl"><span class="v">Total Loan</span> <span class="o">=</span> <span class="n">${fM(lps,cur,2)}</span> <span class="o">×</span> <span class="n">${fmt(ts)}</span> shares <span class="o">=</span> <span class="r">${fM(tl,cur)}</span></span>
      </div>
      <div class="fb"><h4>2. Margin Ratio</h4>
        <span class="fl"><span class="v">Market Value</span> <span class="o">=</span> Current Price(<span class="n">${fM(cp,cur,2)}</span>) <span class="o">×</span> Shares(<span class="n">${fmt(ts)}</span>) <span class="o">=</span> <span class="r">${fM(cv,cur)}</span></span>
        <span class="fl"><span class="v">Equity</span> <span class="o">=</span> Value(<span class="n">${fM(cv,cur)}</span>) <span class="o">−</span> Loan(<span class="n">${fM(tl,cur)}</span>) <span class="o">=</span> <span class="r">${fM(ce,cur)}</span></span>
        <span class="fl"><span class="v">Margin%</span> <span class="o">=</span> Equity(<span class="n">${fM(ce,cur)}</span>) <span class="o">÷</span> Value(<span class="n">${fM(cv,cur)}</span>) <span class="o">=</span> <span class="r">${fP(mp)}</span></span>
        <div class="fn">FINRA minimum: 25%. Most brokers require 30-40%.</div>
      </div>
      <div class="fb"><h4>3. Margin Call & Liquidation</h4>
        <span class="fl"><span class="v">Call Price</span> <span class="o">=</span> Loan(<span class="n">${fM(lps,cur,2)}</span>) <span class="o">÷</span> (1 − Maint%)(<span class="n">${(1-cr).toFixed(2)}</span>) <span class="o">=</span> <span class="r">${fM(callP,cur,2)}</span></span>
        <span class="fl"><span class="v">Forced Liq</span> <span class="o">=</span> Loan(<span class="n">${fM(lps,cur,2)}</span>) <span class="o">÷</span> (1 − Liq%)(<span class="n">${(1-fr).toFixed(2)}</span>) <span class="o">=</span> <span class="r">${fM(forcedP,cur,2)}</span></span>
      </div>
      <div class="fb"><h4>4. Broker Actions</h4>
        <span class="fl">① <span class="v">Equity% < ${(cr*100).toFixed(0)}% (Maintenance)</span>: Broker issues a <strong>margin call</strong>. You must deposit cash or securities within <strong>2-5 business days</strong> (varies by broker) to bring equity back above the maintenance requirement.</span>
        <span class="fl">② <span class="v">Failure to meet call / Equity% < ${(fr*100).toFixed(0)}%</span>: Broker may <strong>force-sell</strong> some or all positions <strong>without prior notice</strong> to cover the shortfall. Any remaining deficit is still owed.</span>
        <span class="fl">③ <span class="v">Rapid decline</span>: Under FINRA rules, brokers can liquidate <strong>immediately</strong> during extreme market conditions without waiting for the call period to expire.</span>
        <div class="fn">FINRA minimum maintenance: 25%. Most brokers set 30-40%. Actual rules per your broker agreement.</div>
      </div>
    </div>`;

    $('#margin-results').innerHTML = subTabs('mr', ['風險概覽', '壓力測試', '計算公式'], [overview, stress, formula]) + (window.PrismJournal ? PrismJournal.recordBtnHTML('margin') : '');

  } else {
    // ── SHORT ──
    const sp = gV('m-sell-price'), smr = parseFloat($('#m-short-margin-rate')?.value || '0.9');
    let cp = gV('m-current-price'); if (!cp) cp = sp;
    if (!sp || !qty) { $('#margin-results').innerHTML = PLACEHOLDER; return; }

    const dep = sp * smr, col = sp, tg2 = (dep + col) * ts, cv = cp * ts, upl = (sp - cp) * ts;

    // Fee calculation (short)
    let openFee, closeFee, openTax, borrowFee, totalFees;
    if (tw) {
      const disc = parseFloat($('#m-fee-disc')?.value || '0.5');
      const feeRate = 0.001425 * disc;
      const taxRate = parseFloat($('#m-tax-rate')?.value || '0.003');
      openFee = Math.max(20, sp * ts * feeRate);   // 融券賣出手續費
      closeFee = Math.max(20, cp * ts * feeRate);   // 回補買進手續費
      openTax = sp * ts * taxRate;                   // 賣出證交稅
      borrowFee = sp * ts * intRate * holdDays / 365; // 借券費
    } else {
      const comm = gV('m-comm') || 0;
      openFee = comm; closeFee = comm;
      openTax = sp * ts * 0.0000278; // SEC fee on sell
      borrowFee = sp * ts * intRate * holdDays / 365; // borrow fee
    }
    totalFees = openFee + closeFee + openTax + borrowFee;
    const netPL = upl - totalFees;
    let maint, callP, forcedP;
    if (tw) { maint = cp > 0 ? (dep + col) / cp : 0; callP = cr > 0 ? (dep + col) / cr : 0; forcedP = fr > 0 ? (dep + col) / fr : 0; }
    else { maint = cp > 0 ? (col + dep - cp) / cp : 0; callP = (col + dep) / (1 + cr); forcedP = (col + dep) / (1 + fr); }
    const ce = (dep + col - cp) * ts;
    const rl = tw ? riskLvl(maint * 100, 166, 140, cr * 100) : riskLvl(maint * 100, 50, 35, cr * 100);
    const mp = maint * 100, fillPct = tw ? Math.min(100, (mp - 100) / 100 * 100) : Math.min(100, mp);
    const rC = callP - sp, rCP = sp > 0 ? rC / sp * 100 : 0;
    const statusMap = { safe: '安全', caution: '注意', danger: '追繳', critical: '斷頭' };
    const plH = upl >= 0 ? 'h-green' : 'h-red', plS = upl >= 0 ? '+' : '';

    const overview = `
      ${alertBox(rl === 'safe' ? 'safe' : rl === 'caution' ? 'warning' : 'danger', rl === 'safe' ? '做空部位安全' : rl === 'caution' ? '接近追繳邊緣' : '已觸發追繳/斷頭！')}
      ${riskBar(tw ? '擔保維持率' : 'Margin Ratio', fP(mp), statusMap[rl], rl, fillPct)}
      <div class="mg">
        ${mgLabel('部位資訊')}
        ${mc(tw ? '融券保證金' : 'Margin Deposit', fM(dep * ts, cur), `${(smr * 100).toFixed(0)}% × 賣出價`)}
        ${mc(tw ? '融券擔保品' : 'Short Proceeds', fM(sp * ts, cur))}
        ${mc('總擔保', fM(tg2, cur), '保證金 + 擔保品')}
        ${mgLabel('損益')}
        ${mc('做空損益(税前)', plS + fM(upl, cur), `權益 ${fM(ce, cur)}`, plH)}
        ${mgLabel('風險警示')}
        ${mc('追繳價(股價漲到)', fM(callP, cur, 2), `上漲 ${fP(rCP)}`, 'h-yellow')}
        ${mc('斷頭價', fM(forcedP, cur, 2), '', 'h-red')}
      </div>
      ${totalFees > 0 ? costTable(
        tw ? [
          { name: '融券賣出手續費', detail: `${fM(sp*ts,cur)} × 0.1425% × ${parseFloat($('#m-fee-disc')?.value||'0.5')*10}折`, amt: fM(openFee, cur) },
          { name: '回補買進手續費', detail: `${fM(cp*ts,cur)} × 0.1425% × ${parseFloat($('#m-fee-disc')?.value||'0.5')*10}折`, amt: fM(closeFee, cur) },
          { name: '證交稅(賣出)', detail: `${fM(sp*ts,cur)} × ${(parseFloat($('#m-tax-rate')?.value||'0.003')*100).toFixed(2)}%`, amt: fM(openTax, cur) },
          borrowFee > 0 ? { name: '借券費', detail: `${fM(sp*ts,cur)} × ${(intRate*100).toFixed(2)}% × ${holdDays}天`, amt: fM(borrowFee, cur) } : null,
        ] : [
          { name: 'Commission (Sell)', amt: fM(openFee, cur) },
          { name: 'Commission (Buy-to-cover)', amt: fM(closeFee, cur) },
          { name: 'SEC Fee', detail: `${fM(sp*ts,cur)} × 0.00278%`, amt: fM(openTax, cur) },
          borrowFee > 0 ? { name: 'Borrow Fee', detail: `${fM(sp*ts,cur)} × ${(intRate*100).toFixed(1)}% × ${holdDays}d`, amt: fM(borrowFee, cur) } : null,
        ],
        fM(totalFees, cur),
        { label: '淨損益(税後)', value: (netPL >= 0 ? '+' : '') + fM(netPL, cur), positive: netPL >= 0 }
      ) : ''}`;

    const steps = [-30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 50, 60];
    let sRows = '';
    for (const p of steps) {
      const pr = sp * (1 + p / 100), diff = pr - sp;
      let mr2 = tw ? (dep + col) / pr : (col + dep - pr) / pr;
      const u = (sp - pr) * ts;
      let st2 = '', rc2 = '';
      if (mr2 < fr) { st2 = tw ? '斷頭' : 'Liq'; rc2 = 'rf'; } else if (mr2 < cr) { st2 = tw ? '追繳' : 'Call'; rc2 = 'rmc'; } else st2 = tw ? '安全' : 'OK';
      if (p === 0) rc2 = 'rc';
      const lvl = tw ? riskLvl(mr2 * 100, 166, 140, cr * 100) : riskLvl(mr2 * 100, 50, 35, cr * 100);
      const sc = lvl === 'safe' ? 'sb-s' : lvl === 'caution' ? 'sb-c' : lvl === 'danger' ? 'sb-d' : 'sb-x';
      const diffStr = (diff >= 0 ? '+' : '') + fM(diff, cur, 2);
      sRows += `<tr class="${rc2}"><td>${p > 0 ? '+' : ''}${p}%<br><span class="tm">${diffStr}</span></td><td>${fM(pr, cur, 2)}</td><td class="${u >= 0 ? 'tg' : 'tr'}">${u >= 0 ? '+' : ''}${fM(u, cur)}</td><td class="${mr2 < cr ? 'tr' : ''}">${fP(mr2 * 100)}</td><td><span class="sb ${sc}">${st2}</span></td></tr>`;
    }
    const stress = `<div class="st-wrap"><table class="st"><thead><tr><th>漲跌</th><th>股價</th><th>做空損益</th><th>維持率</th><th>狀態</th></tr></thead><tbody>${sRows}</tbody></table></div>`;

    const formula = tw ? `<div class="fc">
      <div class="fb"><h4>1. 保證金與擔保品</h4>
        <span class="fl"><span class="v">融券保證金/股</span> <span class="o">=</span> 賣出價格(<span class="n">${fM(sp,cur,2)}</span>) <span class="o">×</span> 保證金成數(<span class="n">${(smr*100).toFixed(0)}%</span>) <span class="o">=</span> <span class="r">${fM(dep,cur,2)}</span></span>
        <span class="fl"><span class="v">融券擔保品/股</span> <span class="o">=</span> 賣出價格(<span class="n">${fM(sp,cur,2)}</span>) <span class="o">=</span> <span class="r">${fM(col,cur,2)}</span></span>
        <span class="fl"><span class="v">每股合計</span> <span class="o">=</span> 保證金(<span class="n">${fM(dep,cur,2)}</span>) <span class="o">+</span> 擔保品(<span class="n">${fM(col,cur,2)}</span>) <span class="o">=</span> <span class="r">${fM(dep+col,cur,2)}</span></span>
        <span class="fl"><span class="v">總擔保</span> <span class="o">=</span> 每股合計(<span class="n">${fM(dep+col,cur,2)}</span>) <span class="o">×</span> 股數(<span class="n">${fmt(ts)}</span>) <span class="o">=</span> <span class="r">${fM(tg2,cur)}</span></span>
      </div>
      <div class="fb"><h4>2. 擔保維持率</h4>
        <span class="fl"><span class="v">維持率</span> <span class="o">=</span> (保證金+擔保品)(<span class="n">${fM(dep+col,cur,2)}</span>) <span class="o">÷</span> 目前價格(<span class="n">${fM(cp,cur,2)}</span>) <span class="o">=</span> <span class="r">${fP(mp)}</span></span>
        <div class="fn">< ${(cr*100).toFixed(0)}% → 追繳 (須於 T+2 日補繳)　< ${(fr*100).toFixed(0)}% → 斷頭 (券商強制回補)</div>
      </div>
      <div class="fb"><h4>3. 做空損益</h4>
        <span class="fl"><span class="v">損益</span> <span class="o">=</span> (賣出價(<span class="n">${fM(sp,cur,2)}</span>) <span class="o">−</span> 目前價(<span class="n">${fM(cp,cur,2)}</span>)) <span class="o">×</span> 股數(<span class="n">${fmt(ts)}</span>) <span class="o">=</span> <span class="r">${plS}${fM(upl,cur)}</span></span>
        <span class="fl"><span class="v">權益</span> <span class="o">=</span> 總擔保(<span class="n">${fM(tg2,cur)}</span>) <span class="o">−</span> 目前市值(<span class="n">${fM(cv,cur)}</span>) <span class="o">=</span> <span class="r">${fM(ce,cur)}</span></span>
      </div>
      <div class="fb"><h4>4. 追繳 & 斷頭價格</h4>
        <span class="fl"><span class="v">追繳價(股價漲到)</span> <span class="o">=</span> 每股合計(<span class="n">${fM(dep+col,cur,2)}</span>) <span class="o">÷</span> 追繳線(<span class="n">${(cr*100).toFixed(0)}%</span>) <span class="o">=</span> <span class="r">${fM(callP,cur,2)}</span></span>
        <span class="fl">　從賣出價上漲 <span class="r">${fM(rC,cur,2)}</span> (<span class="r">${fP(rCP)}</span>)</span>
        <span class="fl"><span class="v">斷頭價</span> <span class="o">=</span> 每股合計(<span class="n">${fM(dep+col,cur,2)}</span>) <span class="o">÷</span> 斷頭線(<span class="n">${(fr*100).toFixed(0)}%</span>) <span class="o">=</span> <span class="r">${fM(forcedP,cur,2)}</span></span>
      </div>
      <div class="fb"><h4>5. 券商處置流程</h4>
        <span class="fl">① <span class="v">維持率 < ${(cr*100).toFixed(0)}% (追繳線)</span>：券商發出<strong>追繳通知</strong>，投資人須在 <strong>T+2 日</strong> 收盤前補繳保證金差額，使維持率回到 166% 以上。</span>
        <span class="fl">② <span class="v">逾期未補繳 或 維持率 < ${(fr*100).toFixed(0)}% (斷頭線)</span>：券商有權在次一營業日以市價<strong>強制回補</strong>（買進股票歸還借券），即「軋空斷頭」。回補後若有虧損，投資人仍需補繳差額。</span>
        <span class="fl">③ <span class="v">強制回補日</span>：除追繳斷頭外，融券亦有<strong>強制回補日</strong>（如股東會前 6 個營業日），屆時無論盈虧均須回補。</span>
        <div class="fn">實際規則以各券商信用交易契約為準。融券做空須注意借券費、強制回補日等額外成本與風險。</div>
      </div>
    </div>` : `<div class="fc">
      <div class="fb"><h4>1. Short Margin & Collateral</h4>
        <span class="fl"><span class="v">Margin Deposit</span> <span class="o">=</span> Sell Price(<span class="n">${fM(sp,cur,2)}</span>) <span class="o">×</span> Rate(<span class="n">${(smr*100).toFixed(0)}%</span>) <span class="o">=</span> <span class="r">${fM(dep,cur,2)}</span></span>
        <span class="fl"><span class="v">Sale Proceeds</span> <span class="o">=</span> <span class="r">${fM(col,cur,2)}</span></span>
        <span class="fl"><span class="v">Total Collateral</span> <span class="o">=</span> Deposit(<span class="n">${fM(dep,cur,2)}</span>) <span class="o">+</span> Proceeds(<span class="n">${fM(col,cur,2)}</span>) <span class="o">=</span> <span class="r">${fM(dep+col,cur,2)}</span></span>
      </div>
      <div class="fb"><h4>2. Margin Ratio</h4>
        <span class="fl"><span class="v">Margin%</span> <span class="o">=</span> (Proceeds+Deposit−Price)(<span class="n">${fM(col+dep-cp,cur,2)}</span>) <span class="o">÷</span> Price(<span class="n">${fM(cp,cur,2)}</span>) <span class="o">=</span> <span class="r">${fP(mp)}</span></span>
        <div class="fn">FINRA minimum: 30%. Most brokers require 30-40%.</div>
      </div>
      <div class="fb"><h4>3. Margin Call & Liquidation</h4>
        <span class="fl"><span class="v">Call Price</span> <span class="o">=</span> (Proceeds+Deposit)(<span class="n">${fM(col+dep,cur,2)}</span>) <span class="o">÷</span> (1+Maint%)(<span class="n">${(1+cr).toFixed(2)}</span>) <span class="o">=</span> <span class="r">${fM(callP,cur,2)}</span></span>
        <span class="fl"><span class="v">Forced Liq</span> <span class="o">=</span> (Proceeds+Deposit)(<span class="n">${fM(col+dep,cur,2)}</span>) <span class="o">÷</span> (1+Liq%)(<span class="n">${(1+fr).toFixed(2)}</span>) <span class="o">=</span> <span class="r">${fM(forcedP,cur,2)}</span></span>
      </div>
      <div class="fb"><h4>4. Broker Actions</h4>
        <span class="fl">① <span class="v">Equity% < ${(cr*100).toFixed(0)}%</span>: Broker issues a <strong>margin call</strong>. Deposit additional cash/securities within <strong>2-5 business days</strong>.</span>
        <span class="fl">② <span class="v">Failure to meet call</span>: Broker may <strong>buy-to-cover</strong> (force close) your short position <strong>without notice</strong>.</span>
        <span class="fl">③ <span class="v">Hard-to-borrow / Recall</span>: The lender may <strong>recall shares at any time</strong>, forcing a buy-to-cover regardless of P&L. Short interest and borrow cost can spike without warning.</span>
        <div class="fn">FINRA minimum for short: 30%. Actual rules per your broker agreement.</div>
      </div>
    </div>`;

    $('#margin-results').innerHTML = subTabs('mr', ['風險概覽', '壓力測試', '計算公式'], [overview, stress, formula]) + (window.PrismJournal ? PrismJournal.recordBtnHTML('margin') : '');
  }
}

// ================================================================
//  FUTURES FORM
// ================================================================
function renderFuturesForm() {
  const { market, product } = S.futures;
  const tw = market === 'tw', cur = tw ? 'NT$' : 'USD';
  const isStock = product === 'stock';

  // 指數期貨：合約下拉；股票期貨：代號搜尋
  let contractRow;
  if (isStock && tw) {
    // 台灣股票期貨：輸入框 + autocomplete
    const defSF = STOCK_FUTURES.CDF;
    contractRow = `
      <div class="fg"><label>股期代號 <span class="hint">輸入代號或股票名稱</span></label>
        <div class="sym-ac-wrap">
          <div class="stock-search-row"><input type="text" id="f-stk-input" value="CDF" placeholder="如 CDF、2330、台積電" autocomplete="off"><button type="button" class="mini-fetch-btn" id="f-sym-fetch">查詢</button></div>
          <div class="sym-ac-list" id="f-stk-ac"></div>
        </div>
        <div class="stock-info" id="f-stock-info"></div>
      </div>
      <input type="hidden" id="f-contract" value="STK">
      <input type="hidden" id="f-im" value="0"><input type="hidden" id="f-mm" value="0"><input type="hidden" id="f-mul" value="${defSF.mul}">`;
  } else if (isStock) {
    // 美國股票期貨：代號搜尋 (Yahoo)
    contractRow = `
      <div class="fg"><label>Stock Symbol</label>
        <div class="sym-ac-wrap">
          <div class="stock-search-row"><input type="text" id="f-sym" placeholder="e.g. AAPL" autocomplete="off"><button type="button" class="mini-fetch-btn" id="f-sym-fetch">查詢</button></div>
          <div class="sym-ac-list" id="f-sym-ac"></div>
        </div>
        <div class="stock-info" id="f-stock-info"></div>
      </div>
      <input type="hidden" id="f-contract" value="STK">
      <input type="hidden" id="f-im" value="0"><input type="hidden" id="f-mm" value="0"><input type="hidden" id="f-mul" value="100">`;
  } else {
    const presets = FP[market];
    const savedContract = S.futures.contract;
    const opts = Object.entries(presets).filter(([k]) => k !== 'STK').map(([k, v]) => `<option value="${k}" ${k === savedContract ? 'selected' : ''}>${v.name}</option>`).join('');
    const fk = (savedContract && presets[savedContract]) ? savedContract : Object.keys(presets).filter(k => k !== 'STK')[0];
    const f = presets[fk];
    contractRow = `
      <div class="fr">
        <div class="fg"><label>合約類型</label><select id="f-contract">${opts}</select></div>
        <div class="fg"><label>口數</label><input type="number" id="f-qty" value="1" min="1" step="1"></div>
      </div>
      <input type="hidden" id="f-im" value="${f.im}"><input type="hidden" id="f-mm" value="${f.mm}"><input type="hidden" id="f-mul" value="${f.mul}">`;
  }

  // 指數期貨的預設值
  const presets = FP[market];
  const idxKeys = Object.keys(presets).filter(k => k !== 'STK');
  const f = isStock ? { im: 0, mm: 0, mul: tw ? 2000 : 100 } : presets[idxKeys[0]];

  const priceLabel = isStock ? (tw ? '價格' : 'Price') : (tw ? '點數' : 'Price');
  const pricePH = isStock ? (tw ? '期貨價格' : 'Price') : (tw ? '20000' : '5000');
  // 股票期貨(US)不顯示帶入按鈕，股票期貨(TW)和指數期貨都顯示
  const showPriceBtn = !isStock || tw;

  const h = `${contractRow}
    ${isStock ? `<div class="fg"><label>口數</label><input type="number" id="f-qty" value="1" min="1" step="1"></div>` : ''}
    <div class="fr">
      <div class="fg"><label>進場${priceLabel}</label><input type="number" id="f-entry" placeholder="${pricePH}" step="any"></div>
      <div class="fg"><label>賣出${priceLabel} <span class="hint">(留空=目前點數)</span></label><input type="number" id="f-current" placeholder="賣出價格" step="any"></div>
    </div>
    <div class="fg"><label>目前${priceLabel} <span class="hint">(API 即時報價)</span></label>
      <div style="display:flex;align-items:center;gap:6px">
        <input type="text" id="f-live-price" class="fg-readonly" readonly placeholder="尚未取得" style="flex:1">
        ${isStock && tw ? `<button type="button" class="ticker-fill-btn" id="f-stk-price-btn">更新報價</button>` : ''}
        ${!isStock ? `<button type="button" class="ticker-fill-btn" onclick="refreshFuturesPrice()">更新報價</button>` : ''}
      </div>
    </div>
    <div class="margin-info">
      <span class="mi-item"><span class="mi-label">原始保證金</span><span class="mi-val" id="f-im-display">${f.im ? fmt(f.im) : '—'}</span></span>
      <span class="mi-sep">|</span>
      <span class="mi-item"><span class="mi-label">維持保證金</span><span class="mi-val" id="f-mm-display">${f.mm ? fmt(f.mm) : '—'}</span></span>
      <span class="mi-sep">|</span>
      <span class="mi-item"><span class="mi-label">${isStock ? '契約乘數' : '每點價值'}</span><span class="mi-val" id="f-mul-display">${f.mul ? cur + ' ' + fmt(f.mul) : '—'}</span></span>
      ${!isStock && tw ? `<button type="button" class="ticker-fill-btn" onclick="fetchTaifexMarginBtn()" style="margin-left:auto">期交所</button>
      <span id="f-margin-date" style="font-size:.62rem;color:var(--t3)">${_taifexMarginDate ? _taifexMarginDate : ''}</span>` : ''}
    </div>
    ${isStock ? `<div class="fr">
      <div class="fg"><label>原始保證金 <span class="hint">(${tw ? '約契約價值13.5%' : 'per contract'})</span></label><input type="number" id="f-im-input" placeholder="${tw ? '自行輸入' : 'Manual'}" step="any"></div>
      <div class="fg"><label>維持保證金 <span class="hint">(${tw ? '約契約價值10.35%' : 'per contract'})</span></label><input type="number" id="f-mm-input" placeholder="${tw ? '自行輸入' : 'Manual'}" step="any"></div>
    </div>` : ''}
    <div class="fr">
      <div class="fg"><label>手續費 <span class="hint">(${cur}/口·單邊)</span></label><input type="number" id="f-comm" value="${tw ? (isStock ? CFG.twStkFutComm : CFG.twFutComm) : CFG.usFutComm}" step="any"></div>
      <div class="fg"><label>期交稅率</label><select id="f-tax-rate">
        ${tw ? (isStock ? `<option value="0.00004" selected>十萬分之四(股票)</option><option value="0.00002">十萬分之二(指數)</option>` : `<option value="0.00002" selected>十萬分之二(指數)</option><option value="0.00004">十萬分之四(股票)</option>`) : `<option value="0" selected>無</option>`}
      </select></div>
    </div>
    <div class="fg"><label>初始權益數 <span class="hint">(預設=3倍保證金)</span></label><input type="number" id="f-equity" value="${f.im ? f.im * 3 : ''}" step="any" placeholder="${isStock ? '查詢股票後自動計算' : ''}">
      <div class="eq-multi-row">
        <button type="button" class="eq-multi-btn" data-mul="1">1x</button>
        <button type="button" class="eq-multi-btn" data-mul="2">2x</button>
        <button type="button" class="eq-multi-btn active" data-mul="3">3x</button>
        <button type="button" class="eq-multi-btn" data-mul="4">4x</button>
        <button type="button" class="eq-multi-btn" data-mul="5">5x</button>
      </div>
    </div>`;

  $('#futures-inputs').innerHTML = h;
  $('#futures-results').innerHTML = PLACEHOLDER;

  if (isStock && tw) {
    // 台灣股票期貨：autocomplete + 查詢
    const stkInput = $('#f-stk-input');
    const fetchStk = () => {
      const cid = stkInput?.value?.trim().toUpperCase();
      if (cid) _fetchTaifexStockFutures(cid);
    };
    // Autocomplete for stock futures
    _setupFuturesAC(stkInput);
    stkInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fetchStk(); } });
    $('#f-sym-fetch')?.addEventListener('click', fetchStk);
    $('#f-stk-price-btn')?.addEventListener('click', () => {
      const _clr = id => { const e = $(`#${id}`); if (e) e.value = ''; };
      ['f-entry', 'f-current', 'f-live-price', 'f-im-input', 'f-mm-input'].forEach(_clr);
      fetchStk();
    });
    // Manual margin inputs sync to hidden fields
    $('#f-im-input')?.addEventListener('input', () => {
      const v = parseFloat($('#f-im-input').value) || 0;
      $('#f-im').value = v;
      $('#f-im-display').textContent = v ? fmt(v) : '—';
      const activeM = $('.eq-multi-btn.active');
      const mulVal = activeM ? parseInt(activeM.dataset.mul) : 3;
      const qty = parseInt($('#f-qty')?.value) || 1;
      $('#f-equity').value = v * qty * mulVal;
      calcFutures();
    });
    $('#f-mm-input')?.addEventListener('input', () => {
      const v = parseFloat($('#f-mm-input').value) || 0;
      $('#f-mm').value = v;
      $('#f-mm-display').textContent = v ? fmt(v) : '—';
      calcFutures();
    });
    // 預設帶入台積電期貨
    fetchStk();
  } else if (isStock) {
    // 美國股票期貨：Yahoo autocomplete + fetch
    setupAutocomplete('f-sym', 'f-sym-ac', async (r) => {
      _fetchFuturesStockPrice(r.symbol);
    }, S.futures.market);
    $('#f-sym-fetch')?.addEventListener('click', () => {
      const code = $('#f-sym')?.value?.trim();
      if (code) _fetchFuturesStockPrice(code);
    });
    $('#f-im-input')?.addEventListener('input', () => {
      const v = parseFloat($('#f-im-input').value) || 0;
      $('#f-im').value = v;
      $('#f-im-display').textContent = v ? fmt(v) : '—';
      const activeM = $('.eq-multi-btn.active');
      const mulVal = activeM ? parseInt(activeM.dataset.mul) : 3;
      const qty = parseInt($('#f-qty')?.value) || 1;
      $('#f-equity').value = v * qty * mulVal;
      calcFutures();
    });
    $('#f-mm-input')?.addEventListener('input', () => {
      const v = parseFloat($('#f-mm-input').value) || 0;
      $('#f-mm').value = v;
      $('#f-mm-display').textContent = v ? fmt(v) : '—';
      calcFutures();
    });
  } else {
    // Index futures: contract change handler
    $('#f-contract')?.addEventListener('change', () => {
      const mk = S.futures.market, c = mk === 'tw' ? 'NT$' : 'USD';
      S.futures.contract = $('#f-contract').value; _saveState();
      const p = FP[mk][$('#f-contract').value];
      if (p) {
        $('#f-im').value = p.im; $('#f-mm').value = p.mm; $('#f-mul').value = p.mul;
        const imD = $('#f-im-display'), mmD = $('#f-mm-display'), mulD = $('#f-mul-display');
        if (imD) imD.textContent = fmt(p.im);
        if (mmD) mmD.textContent = fmt(p.mm);
        if (mulD) mulD.textContent = c + ' ' + fmt(p.mul);
        const activeM = $('.eq-multi-btn.active');
        const mulVal = activeM ? parseInt(activeM.dataset.mul) : 3;
        const qty = parseInt($('#f-qty')?.value) || 1;
        $('#f-equity').value = p.im * qty * mulVal;
        $('#f-im').dispatchEvent(new Event('input', { bubbles: true }));
      }
      const dateEl = $('#f-margin-date');
      if (dateEl && _taifexMarginDate) dateEl.textContent = '期交所 ' + _taifexMarginDate;
    });
    fillFromTicker('f-entry');
    fillFromTicker('f-live-price');
  }

  // Equity multiplier buttons
  const updateEquity = (mulVal) => {
    const im = parseFloat($('#f-im')?.value) || 0;
    const qty = parseInt($('#f-qty')?.value) || 1;
    if (im > 0) {
      $('#f-equity').value = im * qty * mulVal;
      $('#f-equity').dispatchEvent(new Event('input', { bubbles: true }));
    }
    $$('.eq-multi-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.mul) === mulVal));
  };
  $$('.eq-multi-btn').forEach(btn => {
    btn.addEventListener('click', () => updateEquity(parseInt(btn.dataset.mul)));
  });

  wrapNumberInputs($('#futures-inputs'));
  calcFutures();
}

// 台灣股票期貨：從 TAIFEX 查詢即時報價 + 現股價差
async function _fetchTaifexStockFutures(cid) {
  const infoEl = $('#f-stock-info');
  if (infoEl) infoEl.innerHTML = '<span class="tm">查詢中…</span>';
  // 若股期保證金比例尚未載入，等待抓取
  if (Object.keys(_stkFutMargins).length === 0) {
    try { _stkFutMargins = await PriceService.fetchStockFuturesMargins(); } catch {}
  }
  try {
    // 查期貨報價 (一般股期 KindID=4, 小型股期 KindID=8)
    const sf = STOCK_FUTURES[cid] || StockDB.getTaifexFutures().find(f => f.code === cid);
    let q;
    if (sf?.kind) {
      q = await PriceService.fetchStockFuturesQuote(cid, sf.kind);
    } else {
      // 自訂代碼：先試 KindID=4，失敗再試 KindID=8
      try { q = await PriceService.fetchStockFuturesQuote(cid, '4'); } catch {}
      if (!q) q = await PriceService.fetchStockFuturesQuote(cid, '8');
    }

    // 嘗試查現股價格算正逆價差
    let basisHtml = '';
    if (sf?.stock) {
      try {
        let spot = _quoteCache.getStock('tw', sf.stock);
        if (!spot) {
          spot = await PriceService.fetchStockQuote(sf.stock, 'tw');
          _quoteCache.setStock('tw', sf.stock, spot);
        }
        const basis = q.price - spot.price;
        const basisLabel = basis >= 0 ? '正價差' : '逆價差';
        const basisCls = basis >= 0 ? 'price-up' : 'price-down';
        basisHtml = ` · <span class="${basisCls}">${basisLabel} ${basis >= 0 ? '+' : ''}${basis.toFixed(2)}</span> <span class="tm">(現股 ${spot.price.toFixed(2)})</span>`;
      } catch {}
    }

    // Display info
    if (infoEl) {
      const chgCls = q.change >= 0 ? 'price-up' : 'price-down';
      const chgStr = PriceService.fmtChg(q);
      const tFmt = { hour: '2-digit', minute: '2-digit' };
      const fetchStr = new Date().toLocaleTimeString('zh-TW', tFmt);
      const srcStr = q.sourceTime ? new Date(q.sourceTime).toLocaleTimeString('zh-TW', tFmt) : '';
      const timeLabel = srcStr ? `報價 ${srcStr} · 抓取 ${fetchStr}` : `抓取 ${fetchStr}`;
      infoEl.innerHTML = `<span class="si-row"><strong>${_esc(q.name || cid)}</strong> <span class="${chgCls}">${q.price.toFixed(2)} ${chgStr}</span>${basisHtml}</span><span class="si-row"><span class="tm" style="font-size:.6rem">期交所 ${q.session || '日盤 (08:45-13:45)'} · ${timeLabel}</span></span>`;
    }
    // Fill entry & live price
    const entryEl = $('#f-entry');
    if (entryEl && !entryEl.value) { entryEl.value = q.price.toFixed(2); entryEl.dispatchEvent(new Event('input', { bubbles: true })); }
    const liveEl = $('#f-live-price');
    if (liveEl) { liveEl.value = q.price.toFixed(2); }
    // 用期交所實際比例計算保證金，無資料時 fallback 預設級距1 (13.5%/10.35%)
    const marginInfo = _stkFutMargins[cid];
    const imRate = marginInfo?.imRate || 0.135;
    const mmRate = marginInfo?.mmRate || 0.1035;
    const mul = parseFloat($('#f-mul')?.value) || 2000;
    const contractVal = q.price * mul;
    const estIm = Math.round(contractVal * imRate);
    const estMm = Math.round(contractVal * mmRate);
    const imInput = $('#f-im-input'), mmInput = $('#f-mm-input');
    if (imInput && !imInput.value) { imInput.value = estIm; imInput.dispatchEvent(new Event('input', { bubbles: true })); }
    if (mmInput && !mmInput.value) { mmInput.value = estMm; mmInput.dispatchEvent(new Event('input', { bubbles: true })); }
    calcFutures();
  } catch (e) {
    if (infoEl) infoEl.innerHTML = `<span class="tr">${e.message}</span>`;
  }
}

// 美國股票期貨：查詢股價並自動估算保證金
async function _fetchFuturesStockPrice(code) {
  const market = S.futures.market;
  const tw = market === 'tw', cur = tw ? 'NT$' : 'USD';
  const infoEl = $('#f-stock-info');
  if (infoEl) infoEl.innerHTML = '<span class="tm">查詢中…</span>';
  try {
    const q = await PriceService.fetchStockQuote(code, market);
    _quoteCache.setStock(market, code, q);
    // Display stock info
    if (infoEl) {
      const chgCls = q.change >= 0 ? 'price-up' : 'price-down';
      const chgStr = PriceService.fmtChg(q);
      const tFmt = { hour: '2-digit', minute: '2-digit' };
      const fetchStr = new Date().toLocaleTimeString('zh-TW', tFmt);
      const srcStr = q.sourceTime ? new Date(q.sourceTime).toLocaleTimeString('zh-TW', tFmt) : '';
      const provName = market === 'tw' ? PriceService.PROVIDER_INFO[CFG.twSource]?.name : PriceService.PROVIDER_INFO[CFG.usSource]?.name;
      const timeLabel = srcStr ? `報價 ${srcStr} · 抓取 ${fetchStr}` : `抓取 ${fetchStr}`;
      infoEl.innerHTML = `<span class="si-row"><strong>${_esc(q.name || code)}</strong> <span class="${chgCls}">${q.price.toFixed(2)} ${chgStr}</span></span><span class="si-row"><span class="tm" style="font-size:.6rem">${_esc(provName || 'API')} ${timeLabel}</span></span>`;
    }
    // Fill entry & live price
    const entryEl = $('#f-entry');
    if (entryEl && !entryEl.value) { entryEl.value = q.price.toFixed(2); entryEl.dispatchEvent(new Event('input', { bubbles: true })); }
    const liveEl = $('#f-live-price');
    if (liveEl) { liveEl.value = q.price.toFixed(2); }
    // Auto-estimate margins for TW stock futures (用期交所實際比例)
    if (tw) {
      const stkCode = ($('#f-sym')?.value || '').trim().toUpperCase();
      const stkMI = _stkFutMargins[stkCode];
      const _imR = stkMI?.imRate || 0.135, _mmR = stkMI?.mmRate || 0.1035;
      const mul = parseFloat($('#f-mul')?.value) || 2000;
      const contractVal = q.price * mul;
      const estIm = Math.round(contractVal * _imR);
      const estMm = Math.round(contractVal * _mmR);
      const imInput = $('#f-im-input'), mmInput = $('#f-mm-input');
      if (imInput && !imInput.value) { imInput.value = estIm; imInput.dispatchEvent(new Event('input', { bubbles: true })); }
      if (mmInput && !mmInput.value) { mmInput.value = estMm; mmInput.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    calcFutures();
  } catch (e) {
    if (infoEl) infoEl.innerHTML = `<span class="tr">${e.message}</span>`;
  }
}

// 更新報價：先嘗試 ticker 快取，沒有或過期則發 API
window.refreshFuturesPrice = async function() {
  const mk = S.futures.market;
  const contract = $('#f-contract')?.value || '';
  const indexKeyMap = {
    tw: { TX: 'txf', MTX: 'txf', MXF: 'txf', TE: 'taiex', TF: 'taiex', STK: '' },
    us: { ES: 'es', MES: 'es', NQ: 'nq', MNQ: 'nq', YM: 'ym', MYM: 'ym' }
  };
  const idxKey = indexKeyMap[mk]?.[contract];
  if (!idxKey) return;

  // 先試 ticker bar 快取
  const cached = _quoteCache.getIndex(idxKey);
  if (cached) {
    _applyFuturesQuote(idxKey, cached, _quoteCache._load().indices[idxKey]?.time);
    return;
  }
  // 快取過期或沒有 → 發 API
  const el = document.getElementById('f-live-price');
  if (el) el.value = '查詢中…';
  try {
    const q = await PriceService.fetchIndex(idxKey);
    _quoteCache.setIndex(idxKey, q);
    _renderTickerChip(idxKey, q);
    _applyFuturesQuote(idxKey, q);
  } catch {
    if (el) { el.value = '查詢失敗'; setTimeout(() => { el.value = ''; el.placeholder = '尚未取得'; }, 2000); }
  }
};

// 將報價填入期貨欄位（目前價格 + 進場價格若為空）
function _applyFuturesQuote(idxKey, q, fetchTime) {
  const mk = S.futures.market;
  const isTxf = idxKey === 'txf';
  const sessionStr = isTxf && q.session ? ` ${q.session}` : '';
  const provName = isTxf ? `期交所${sessionStr}` : (mk === 'tw' ? PriceService.PROVIDER_INFO[CFG.twSource]?.name : PriceService.PROVIDER_INFO[CFG.usSource]?.name);

  // 填入唯讀的「目前價格」顯示
  const liveEl = document.getElementById('f-live-price');
  if (liveEl) {
    liveEl.value = q.price.toFixed(2);
    stampTime('f-live-price', provName || 'API', q.sourceTime, fetchTime);
  }
  // 進場價格預設帶入（若為空）
  const entryEl = document.getElementById('f-entry');
  if (entryEl && !entryEl.value) {
    entryEl.value = q.price.toFixed(2);
    entryEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

window.fillFromTicker = function(targetId, force) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (!force && el.value) return;
  const mk = S.futures.market;
  const contract = $('#f-contract')?.value || '';
  let idxId = 'idx-taiex';
  let srcLabel = mk === 'tw' ? (PriceService.PROVIDER_INFO[CFG.twSource]?.name || '加權指數') : '';
  if (mk === 'tw') {
    const txfVal = gV('idx-txf');
    if (txfVal && ['TX', 'MTX', 'MXF'].includes(contract)) {
      idxId = 'idx-txf';
      const session = PriceService._sessionLabel(PriceService._getTaifexMarketType());
      srcLabel = `期交所 ${session}`;
    }
  } else {
    const prov = PriceService.PROVIDER_INFO[CFG.usSource]?.name || '';
    if (['ES', 'MES'].includes(contract)) { idxId = 'idx-es'; srcLabel = prov || 'S&P 期貨'; }
    else if (['NQ', 'MNQ'].includes(contract)) { idxId = 'idx-nq'; srcLabel = prov || '那指期貨'; }
    else if (['YM', 'MYM'].includes(contract)) { idxId = 'idx-ym'; srcLabel = prov || '道瓊期貨'; }
    else { idxId = 'idx-es'; srcLabel = prov || 'S&P 期貨'; }
  }
  const v = gV(idxId);
  if (v) {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (targetId !== 'f-entry') {
      const cacheKey = idxId.replace('idx-', '');
      const cacheEntry = _quoteCache._load().indices[cacheKey];
      stampTime(targetId, srcLabel, cacheEntry?.data?.sourceTime, cacheEntry?.time);
    }
  }
};

// ================================================================
//  FUTURES CALC (with custom initial equity)
// ================================================================
function calcFutures() {
  const { market, direction } = S.futures;
  const tw = market === 'tw', long = direction === 'long';
  const cur = tw ? 'NT$' : 'USD';
  const entry = gV('f-entry'), qty = gV('f-qty'), im = gV('f-im'), mm = gV('f-mm'), mul = gV('f-mul');
  let curr = gV('f-current');
  if (!curr) {
    const liveVal = parseFloat($('#f-live-price')?.value);
    curr = liveVal || entry;
  }
  if (!entry || !qty || !im || !mul) { $('#futures-results').innerHTML = PLACEHOLDER; return; }

  // Fee calculation
  const fComm = gV('f-comm') || 0;
  const fTaxRate = parseFloat($('#f-tax-rate')?.value || '0');
  const commTotal = fComm * qty * 2; // round trip
  const entryTax = Math.round(entry * mul * qty * fTaxRate);
  const exitTax = Math.round(curr * mul * qty * fTaxRate);
  const taxTotal = entryTax + exitTax;
  const futFees = commTotal + taxTotal;

  const tIM = im * qty;   // 所需原始保證金
  const tMM = mm * qty;   // 所需維持保證金

  // ★ 初始權益數: 使用者輸入 or 預設=3倍原始保證金
  const rawEq = gVraw('f-equity');
  const initEq = rawEq !== '' ? parseFloat(rawEq) : tIM * 3;
  const excessMargin = initEq - tIM;  // 超額保證金

  const pd = long ? (curr - entry) : (entry - curr);
  const upl = pd * mul * qty;
  const eq = initEq + upl;           // ★ 權益數 = 初始權益 + 損益
  const ri = tIM > 0 ? (eq / tIM * 100) : 0;  // 風險指標 (分母仍是所需原始保證金)
  const ppm = mul * qty;              // 每點損益

  // ★ 追繳: 權益數 < 維持保證金
  // initEq + (callLevel - entry) * mul * qty * dir = tMM
  const maxLossToCall = initEq - tMM;
  const ptToCall = ppm > 0 ? maxLossToCall / ppm : 0;
  const callLvl = long ? entry - ptToCall : entry + ptToCall;

  // ★ 砍倉: 風險指標 ≤ 25%  → eq = 0.25 * tIM
  const maxLossToForced = initEq - 0.25 * tIM;
  const ptToForced = ppm > 0 ? maxLossToForced / ppm : 0;
  const forcedLvl = long ? entry - ptToForced : entry + ptToForced;

  const dC = long ? curr - callLvl : callLvl - curr;
  const dF = long ? curr - forcedLvl : forcedLvl - curr;

  let rl;
  if (ri <= 25) rl = 'critical';
  else if (eq <= tMM) rl = 'danger';
  else if (ri <= 50) rl = 'caution';
  else rl = 'safe';

  const u = FP[market][$('#f-contract')?.value]?.u || '點';
  const cn = FP[market][$('#f-contract')?.value]?.name || '';
  const statusMap = { safe: '安全', caution: '注意', danger: '追繳', critical: '砍倉' };
  const fillPct = Math.min(100, Math.max(0, ri));
  const plH = upl >= 0 ? 'h-green' : 'h-red', plS = upl >= 0 ? '+' : '';

  const overview = `
    ${alertBox(rl === 'safe' ? 'safe' : rl === 'caution' ? 'warning' : 'danger',
      rl === 'safe' ? '風險指標充足' : rl === 'caution' ? '風險指標偏低，接近追繳' : rl === 'danger' ? '權益數 < 維持保證金！需補繳至原始保證金水位' : '風險指標 ≤ 25%，可強制砍倉！')}
    ${riskBar('風險指標', fP(ri), statusMap[rl], rl, fillPct)}
    <div class="mg">
      ${mgLabel('合約資訊')}
      ${mc('合約', cn, `${long ? '做多' : '做空'} ${qty}口 @ ${fmt(entry)} ${u}`)}
      ${mc('所需原始保證金', fM(tIM, cur), `每口 ${fM(im, cur)}`)}
      ${mc('所需維持保證金', fM(tMM, cur), `每口 ${fM(mm, cur)}`)}
      ${mc('初始權益數', fM(initEq, cur), excessMargin > 0 ? `超額 ${fM(excessMargin, cur)}` : excessMargin < 0 ? `不足 ${fM(-excessMargin, cur)}` : '= 原始保證金', excessMargin > 0 ? 'h-accent' : excessMargin < 0 ? 'h-red' : '')}
      ${mc('每點損益', fM(ppm, cur), `${mul} × ${qty}口`)}
      ${mgLabel('損益')}
      ${mc('未實現損益(税前)', plS + fM(upl, cur), `${pd >= 0 ? '+' : ''}${fmt(pd, 2)} ${u}`, plH)}
      ${mc('目前權益數', fM(eq, cur), '初始權益 + 損益', eq <= tMM ? 'h-red' : 'h-accent')}
      ${mc('可承受虧損(至追繳)', fM(maxLossToCall, cur), `${fmt(ptToCall, 2)} ${u}`)}
      ${mgLabel('風險警示')}
      ${mc('追繳點位', fmt(callLvl, 2) + ' ' + u, dC > 0 ? `距目前 ${fmt(dC, 2)} ${u} (${fP(dC / curr * 100)})` : '已追繳!', 'h-yellow')}
      ${mc('砍倉點位(RI≤25%)', fmt(forcedLvl, 2) + ' ' + u, dF > 0 ? `距目前 ${fmt(dF, 2)} ${u} (${fP(dF / curr * 100)})` : '已砍倉!', 'h-red')}
    </div>
    ${futFees > 0 ? costTable(
      tw ? [
        { name: '手續費(進場)', detail: `${fM(fComm,cur)}/口 × ${qty}口`, amt: fM(fComm * qty, cur) },
        { name: '手續費(出場)', detail: `${fM(fComm,cur)}/口 × ${qty}口`, amt: fM(fComm * qty, cur) },
        { name: '期交稅(進場)', detail: `${fmt(entry)} × ${fmt(mul)} × ${qty}口 × ${fTaxRate}`, amt: fM(entryTax, cur) },
        { name: '期交稅(出場)', detail: `${fmt(curr)} × ${fmt(mul)} × ${qty}口 × ${fTaxRate}`, amt: fM(exitTax, cur) },
      ] : [
        { name: 'Commission (Entry)', detail: `${fM(fComm,cur)} × ${qty}`, amt: fM(fComm * qty, cur) },
        { name: 'Commission (Exit)', detail: `${fM(fComm,cur)} × ${qty}`, amt: fM(fComm * qty, cur) },
      ],
      fM(futFees, cur),
      { label: '淨損益(税後)', value: (upl - futFees >= 0 ? '+' : '') + fM(upl - futFees, cur), positive: (upl - futFees) >= 0 }
    ) : ''}`;

  // Stress test: now using initEq instead of tIM
  const steps = [10, 8, 6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6, -8, -10, -12, -15, -20];
  let sRows = '';
  for (const p of steps) {
    const lv = entry * (1 + p / 100), diff = lv - entry;
    const d2 = long ? lv - entry : entry - lv;
    const pl = d2 * mul * qty;
    const e2 = initEq + pl;            // ★ using initEq
    const r2 = tIM > 0 ? (e2 / tIM * 100) : 0;
    let st = '', rc = '', sc = 'sb-s';
    if (r2 <= 25) { st = '砍倉'; rc = 'rf'; sc = 'sb-x'; }
    else if (e2 <= tMM) { st = '追繳'; rc = 'rmc'; sc = 'sb-d'; }
    else if (r2 <= 50) { st = '注意'; sc = 'sb-c'; }
    else st = '安全';
    if (p === 0) rc = 'rc';
    const diffStr = (diff >= 0 ? '+' : '') + fmt(diff, 2) + ' ' + u;
    sRows += `<tr class="${rc}"><td>${p > 0 ? '+' : ''}${p}%<br><span class="tm">${diffStr}</span></td><td>${fmt(lv, 2)}</td><td class="${pl >= 0 ? 'tg' : 'tr'}">${pl >= 0 ? '+' : ''}${fM(pl, cur)}</td><td>${fM(e2, cur)}</td><td class="${r2 <= 25 ? 'tr' : r2 <= 50 ? 'ty' : ''}">${fP(r2)}</td><td><span class="sb ${sc}">${st}</span></td></tr>`;
  }
  const stress = `<div class="st-wrap"><table class="st"><thead><tr><th>漲跌</th><th>${u}</th><th>損益</th><th>權益數</th><th>風險指標</th><th>狀態</th></tr></thead><tbody>${sRows}</tbody></table></div>`;

  const formula = `<div class="fc">
    <div class="fb"><h4>1. 保證金 vs 初始權益</h4>
      <span class="fl"><span class="v">所需原始保證金</span> <span class="o">=</span> 每口原始保證金(<span class="n">${fM(im,cur)}</span>) <span class="o">×</span> 口數(<span class="n">${qty}</span>) <span class="o">=</span> <span class="r">${fM(tIM,cur)}</span></span>
      <span class="fl"><span class="v">所需維持保證金</span> <span class="o">=</span> 每口維持保證金(<span class="n">${fM(mm,cur)}</span>) <span class="o">×</span> 口數(<span class="n">${qty}</span>) <span class="o">=</span> <span class="r">${fM(tMM,cur)}</span></span>
      <span class="fl"><span class="v">初始權益數(帳戶餘額)</span> <span class="o">=</span> <span class="r">${fM(initEq,cur)}</span></span>
      <span class="fl"><span class="v">超額保證金</span> <span class="o">=</span> 初始權益(<span class="n">${fM(initEq,cur)}</span>) <span class="o">−</span> 原始保證金(<span class="n">${fM(tIM,cur)}</span>) <span class="o">=</span> <span class="${excessMargin >= 0 ? 'r' : 'n'}">${fM(excessMargin,cur)}</span></span>
      <div class="fn">入金 > 原始保證金 → 有額外緩衝空間，追繳/砍倉距離更遠<br>入金 = 原始保證金 → 剛好達最低要求，無額外緩衝</div>
    </div>
    <div class="fb"><h4>2. 每點損益</h4>
      <span class="fl"><span class="v">每點損益</span> <span class="o">=</span> 每點價值(<span class="n">${fM(mul,cur)}</span>) <span class="o">×</span> 口數(<span class="n">${qty}</span>) <span class="o">=</span> <span class="r">${fM(ppm,cur)}</span></span>
      <div class="fn">${long ? '做多' : '做空'}：指數每${long ? '漲' : '跌'}1點，獲利 ${fM(ppm,cur)}；每${long ? '跌' : '漲'}1點，虧損 ${fM(ppm,cur)}</div>
    </div>
    <div class="fb"><h4>3. 未實現損益 & 權益數</h4>
      <span class="fl"><span class="v">點數差</span> <span class="o">=</span> ${long ? '目前點數' : '進場點數'}(<span class="n">${long ? fmt(curr,2) : fmt(entry,2)}</span>) <span class="o">−</span> ${long ? '進場點數' : '目前點數'}(<span class="n">${long ? fmt(entry,2) : fmt(curr,2)}</span>) <span class="o">=</span> <span class="r">${fmt(pd,2)} ${u}</span></span>
      <span class="fl"><span class="v">未實現損益</span> <span class="o">=</span> 點數差(<span class="n">${fmt(pd,2)}</span>) <span class="o">×</span> 每點損益(<span class="n">${fM(ppm,cur)}</span>) <span class="o">=</span> <span class="r">${plS}${fM(upl,cur)}</span></span>
      <span class="fl"><span class="v">目前權益數</span> <span class="o">=</span> 初始權益(<span class="n">${fM(initEq,cur)}</span>) <span class="o">+</span> 損益(<span class="n">${plS}${fM(upl,cur)}</span>) <span class="o">=</span> <span class="r">${fM(eq,cur)}</span></span>
    </div>
    <div class="fb"><h4>4. 風險指標</h4>
      <span class="fl"><span class="v">風險指標</span> <span class="o">=</span> 權益數(<span class="n">${fM(eq,cur)}</span>) <span class="o">÷</span> 原始保證金(<span class="n">${fM(tIM,cur)}</span>) <span class="o">=</span> <span class="r">${fP(ri)}</span></span>
      <div class="fn">權益數(<span>${fM(eq,cur)}</span>) < 維持保證金(<span>${fM(tMM,cur)}</span>) → 追繳 (需補繳至原始保證金 ${fM(tIM,cur)})<br>風險指標 ≤ 25% → 期貨商可強制砍倉</div>
    </div>
    <div class="fb"><h4>5. 追繳 & 砍倉點位</h4>
      <span class="fl"><span class="v">可承受虧損(至追繳)</span> <span class="o">=</span> 初始權益(<span class="n">${fM(initEq,cur)}</span>) <span class="o">−</span> 維持保證金(<span class="n">${fM(tMM,cur)}</span>) <span class="o">=</span> <span class="r">${fM(maxLossToCall,cur)}</span></span>
      <span class="fl"><span class="v">追繳點數</span> <span class="o">=</span> 可承受虧損(<span class="n">${fM(maxLossToCall,cur)}</span>) <span class="o">÷</span> 每點損益(<span class="n">${fM(ppm,cur)}</span>) <span class="o">=</span> <span class="r">${fmt(ptToCall,2)} ${u}</span></span>
      <span class="fl"><span class="v">追繳點位</span> <span class="o">=</span> 進場(<span class="n">${fmt(entry,2)}</span>) ${long ? '−' : '+'} 追繳點數(<span class="n">${fmt(ptToCall,2)}</span>) <span class="o">=</span> <span class="r">${fmt(callLvl,2)} ${u}</span>　距目前 <span class="r">${fmt(dC,2)} ${u}</span></span>
      <span class="fl"><span class="v">可承受虧損(至砍倉)</span> <span class="o">=</span> 初始權益(<span class="n">${fM(initEq,cur)}</span>) <span class="o">−</span> 25%×原始保證金(<span class="n">${fM(0.25*tIM,cur)}</span>) <span class="o">=</span> <span class="r">${fM(maxLossToForced,cur)}</span></span>
      <span class="fl"><span class="v">砍倉點位</span> <span class="o">=</span> <span class="r">${fmt(forcedLvl,2)} ${u}</span>　距目前 <span class="r">${fmt(dF,2)} ${u}</span></span>
    </div>
    <div class="fb"><h4>6. 期貨商處置流程</h4>
      <span class="fl">① <span class="v">權益數 < 維持保證金 (${fM(tMM,cur)})</span>：期貨商於盤後發出<strong>追繳通知</strong>，交易人須在<strong>次一營業日中午 12:00 前</strong>補繳至原始保證金水位 (${fM(tIM,cur)})。</span>
      <span class="fl">② <span class="v">逾期未補繳</span>：期貨商有權自<strong>次一營業日起</strong>，以市價<strong>代為沖銷</strong>（強制平倉）部分或全部部位，直至權益數回到原始保證金以上。</span>
      <span class="fl">③ <span class="v">風險指標 ≤ 25%</span>：期貨商可<strong>不另通知</strong>，立即執行代為沖銷（俗稱「砍倉」）。盤中若指標急跌至此水位，可能<strong>盤中即時砍倉</strong>。</span>
      <span class="fl">④ <span class="v">結算日</span>：到期月份合約會在<strong>最後結算日</strong>以結算價強制平倉（現金結算）或進行實物交割。</span>
      <div class="fn">實際追繳時限與砍倉門檻以各期貨商風控規則為準。上述為台灣期交所一般慣例；海外期貨規則類似但時限可能不同。</div>
    </div>
  </div>`;

  $('#futures-results').innerHTML = subTabs('fr', ['風險概覽', '壓力測試', '計算公式'], [overview, stress, formula]) + (window.PrismJournal ? PrismJournal.recordBtnHTML('futures') : '');
}

// ================================================================
//  OPTIONS FORM
// ================================================================
function renderOptionsForm() {
  const { market, side, product } = S.options;
  const tw = market === 'tw', buyer = side === 'buyer';
  const cur = tw ? 'NT$' : 'USD';
  const isStock = product === 'stock';
  const defMul = isStock ? 100 : (tw ? 50 : 100);

  // 標的物欄位
  let ulRow;
  if (isStock) {
    ulRow = `<div class="fg"><label>股票代號</label>
      <div class="sym-ac-wrap">
        <div class="stock-search-row"><input type="text" id="o-sym" placeholder="${tw ? '輸入代號 如 2330' : 'e.g. AAPL'}" autocomplete="off"><button type="button" class="mini-fetch-btn" id="o-sym-fetch">查詢</button></div>
        <div class="sym-ac-list" id="o-sym-ac"></div>
      </div>
      <div class="stock-info" id="o-stock-info"></div>
    </div>
    <div class="fr">
      <div class="fg"><label>標的物股價</label><input type="number" id="o-ul" placeholder="查詢後自動帶入" step="any"></div>
      <div class="fg"><label>履約價 Strike</label><input type="number" id="o-strike" placeholder="履約價" step="any"></div>
    </div>`;
  } else {
    ulRow = `<div class="fr">
      <div class="fg"><label>標的物${tw ? '指數' : '價格'}</label><input type="number" id="o-ul" placeholder="${tw ? '20000' : '500'}" step="any">
        <div style="display:flex;gap:3px;margin-top:2px;flex-wrap:wrap"><button type="button" class="ticker-fill-btn" onclick="refreshOptPrice()">更新報價</button></div>
      </div>
      <div class="fg"><label>履約價 Strike</label><input type="number" id="o-strike" placeholder="${tw ? '20000' : '500'}" step="any"></div>
    </div>`;
  }

  let h = `
    <div class="fg"><label>類型</label><select id="o-type"><option value="call">Call 買權</option><option value="put">Put 賣權</option></select></div>
    ${ulRow}
    <div class="fr">
      <div class="fg"><label>權利金 <span class="hint">(${isStock ? '每股' : '每點'})</span></label><input type="number" id="o-premium" placeholder="${tw ? (isStock ? '5' : '300') : '5'}" step="any"></div>
      <div class="fg"><label>到期結算價 <span class="hint">(選填)</span></label><input type="number" id="o-exp" placeholder="結算價" step="any"></div>
    </div>
    <div class="fr">
      <div class="fg"><label>口數</label><input type="number" id="o-qty" value="1" min="1" step="1"></div>
      <div class="fg"><label>乘數 <span class="hint">(${cur}/${isStock ? '股' : '點'})</span></label><input type="number" id="o-mul" value="${defMul}" step="any"></div>
    </div>`;

  if (!buyer) {
    h += `<div class="fr">
      <div class="fg"><label>風險保證金比率</label><div class="isuf"><input type="number" id="o-rr" value="15" step="any"><span class="suf">%</span></div></div>
      <div class="fg"><label>最低保證金比率</label><div class="isuf"><input type="number" id="o-mr" value="10" step="any"><span class="suf">%</span></div></div>
    </div>`;
  }

  h += `<div class="fr">
    <div class="fg"><label>手續費 <span class="hint">(${cur}/口·單邊)</span></label><input type="number" id="o-comm" value="${tw ? CFG.twOptComm : CFG.usOptComm}" step="any"></div>
    <div class="fg"><label>交易稅率</label><select id="o-tax-rate">
      ${tw ? `<option value="0.001" selected>千分之一</option><option value="0">免稅</option>` : `<option value="0" selected>無</option>`}
    </select></div>
  </div>`;

  $('#options-inputs').innerHTML = h;
  $('#options-results').innerHTML = PLACEHOLDER;

  if (isStock) {
    setupAutocomplete('o-sym', 'o-sym-ac', async (r) => {
      _fetchOptionsStockPrice(r.symbol);
    }, S.options.market);
    $('#o-sym-fetch')?.addEventListener('click', () => {
      const code = $('#o-sym')?.value?.trim();
      if (code) _fetchOptionsStockPrice(code);
    });
  }

  wrapNumberInputs($('#options-inputs'));
  calcOptions();
}

// 個股選擇權：查詢股價
async function _fetchOptionsStockPrice(code) {
  const market = S.options.market;
  const infoEl = $('#o-stock-info');
  if (infoEl) infoEl.innerHTML = '<span class="tm">查詢中…</span>';
  try {
    const q = await PriceService.fetchStockQuote(code, market);
    _quoteCache.setStock(market, code, q);
    if (infoEl) {
      const chgCls = q.change >= 0 ? 'price-up' : 'price-down';
      const chgStr = PriceService.fmtChg(q);
      const tFmt = { hour: '2-digit', minute: '2-digit' };
      const fetchStr = new Date().toLocaleTimeString('zh-TW', tFmt);
      const srcStr = q.sourceTime ? new Date(q.sourceTime).toLocaleTimeString('zh-TW', tFmt) : '';
      const timeLabel = srcStr ? `報價 ${srcStr} · 抓取 ${fetchStr}` : fetchStr;
      infoEl.innerHTML = `<span class="si-row"><strong>${q.name || code}</strong> <span class="${chgCls}">${q.price.toFixed(2)} ${chgStr}</span></span><span class="si-row"><span class="tm" style="font-size:.6rem">${timeLabel}</span></span>`;
    }
    const ulEl = $('#o-ul');
    if (ulEl) { ulEl.value = q.price.toFixed(2); ulEl.dispatchEvent(new Event('input', { bubbles: true })); }
    calcOptions();
  } catch (e) {
    if (infoEl) infoEl.innerHTML = `<span class="tr">${e.message}</span>`;
  }
}

window.fetchOptPrice = async function() {
  const mk = S.options.market;
  const idxKey = mk === 'tw' ? 'taiex' : 'es';
  const el = document.getElementById('o-ul');
  if (!el) return;
  el.placeholder = '查詢中…';
  try {
    const q = await PriceService.fetchIndex(idxKey);
    _quoteCache.setIndex(idxKey, q);
    _renderTickerChip(idxKey, q);
    el.value = q.price.toFixed(2);
    el.placeholder = mk === 'tw' ? '20000' : '500';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const provName = mk === 'tw' ? PriceService.PROVIDER_INFO[CFG.twSource]?.name : PriceService.PROVIDER_INFO[CFG.usSource]?.name;
    stampTime('o-ul', provName || 'API', q.sourceTime);
  } catch {
    el.placeholder = '查詢失敗';
    setTimeout(() => { el.placeholder = mk === 'tw' ? '20000' : '500'; }, 2000);
  }
};

// 更新報價：先嘗試快取，沒有則發 API
window.refreshOptPrice = function() {
  const tw = S.options.market === 'tw';
  const cacheKey = tw ? 'taiex' : 'es';
  const cached = _quoteCache.getIndex(cacheKey);
  if (cached) {
    const el = document.getElementById('o-ul');
    if (el) {
      el.value = cached.price.toFixed(2);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const cacheEntry = _quoteCache._load().indices[cacheKey];
      const provName = tw ? PriceService.PROVIDER_INFO[CFG.twSource]?.name : PriceService.PROVIDER_INFO[CFG.usSource]?.name;
      stampTime('o-ul', provName || (tw ? '加權指數' : 'S&P 期貨'), cacheEntry?.data?.sourceTime, cacheEntry?.time);
    }
    calcOptions();
    return;
  }
  fetchOptPrice();
};

window.fillOptFromTicker = function(force) {
  const ulEl = document.getElementById('o-ul');
  if (!ulEl) return;
  // 非手動觸發時，若欄位已有值則不覆蓋
  if (!force && ulEl.value) return;
  const tw = S.options.market === 'tw';
  const id = tw ? 'idx-taiex' : 'idx-es';
  const v = gV(id);
  if (v) {
    ulEl.value = v;
    ulEl.dispatchEvent(new Event('input', { bubbles: true }));
    const cacheKey = tw ? 'taiex' : 'es';
    const cacheEntry = _quoteCache._load().indices[cacheKey];
    const provName = tw ? PriceService.PROVIDER_INFO[CFG.twSource]?.name : PriceService.PROVIDER_INFO[CFG.usSource]?.name;
    stampTime('o-ul', provName || (tw ? '加權指數' : 'S&P 期貨'), cacheEntry?.data?.sourceTime, cacheEntry?.time);
  }
};

// ================================================================
//  OPTIONS CALC
// ================================================================
function calcOptions() {
  const { market, side } = S.options;
  const tw = market === 'tw', buyer = side === 'buyer', cur = tw ? 'NT$' : 'USD';
  const isCall = $('#o-type')?.value === 'call';
  const ul = gV('o-ul'), strike = gV('o-strike'), prem = gV('o-premium');
  const qty = gV('o-qty'), mul = gV('o-mul');
  if (!ul || !strike || !prem || !qty || !mul) { $('#options-results').innerHTML = PLACEHOLDER; return; }

  // Fee calculation
  const oComm = gV('o-comm') || 0;
  const oTaxRate = parseFloat($('#o-tax-rate')?.value || '0');
  const oCommTotal = oComm * qty * 2; // open + close
  const oOpenTax = Math.round(prem * mul * qty * oTaxRate); // tax on premium at open
  const oCloseTax = Math.round(prem * mul * qty * oTaxRate); // approximate (close at same premium)
  const oFees = oCommTotal + oOpenTax + oCloseTax;

  const totalPrem = prem * mul * qty;
  const iv = isCall ? Math.max(0, ul - strike) : Math.max(0, strike - ul);
  const tv = Math.max(0, prem - iv);
  const oom = isCall ? Math.max(0, strike - ul) : Math.max(0, ul - strike);
  const money = isCall ? (ul > strike ? '價內 ITM' : ul === strike ? '價平 ATM' : '價外 OTM')
    : (ul < strike ? '價內 ITM' : ul === strike ? '價平 ATM' : '價外 OTM');
  const be = isCall ? strike + prem : strike - prem;

  let expPL = null;
  const expP = gV('o-exp');
  if (expP) {
    const eIv = isCall ? Math.max(0, expP - strike) : Math.max(0, strike - expP);
    expPL = buyer ? (eIv - prem) * mul * qty : (prem - eIv) * mul * qty;
  }

  if (buyer) {
    const overview = `
      ${alertBox('safe', '買方風險有限，最大虧損 = 權利金。不會追繳或斷頭。')}
      <div class="mg">
        ${mgLabel('合約資訊')}
        ${mc(`${isCall ? 'Call' : 'Put'} 買方`, money, `履約價 ${fmt(strike)} | ${qty}口`, 'h-accent')}
        ${mc('內含價值 / 時間價值', fmt(iv, 2) + ' / ' + fmt(tv, 2))}
        ${mc('損益平衡', fmt(be, 2), isCall ? '履約價 + 權利金' : '履約價 - 權利金')}
        ${mgLabel('損益')}
        ${mc('最大虧損 = 權利金+費用', fM(totalPrem + oFees, cur), `權利金 ${fM(totalPrem, cur)} + 費用 ${fM(oFees, cur)}`, 'h-red')}
        ${mc('最大獲利', isCall ? '無上限' : fM((strike - prem) * mul * qty, cur))}
        ${expPL !== null ? mc('到期損益(税前)', (expPL >= 0 ? '+' : '') + fM(expPL, cur), `結算價 ${fmt(expP)} | 報酬率 ${(expPL / totalPrem * 100).toFixed(1)}%`, expPL >= 0 ? 'h-green' : 'h-red') : ''}
      </div>
      ${oFees > 0 ? costTable(
        tw ? [
          { name: '手續費(開倉)', detail: `${fM(oComm,cur)}/口 × ${qty}口`, amt: fM(oComm * qty, cur) },
          { name: '手續費(平倉)', detail: `${fM(oComm,cur)}/口 × ${qty}口`, amt: fM(oComm * qty, cur) },
          { name: '交易稅(開倉)', detail: `${fM(totalPrem,cur)} × ${(oTaxRate*100).toFixed(2)}%`, amt: fM(oOpenTax, cur) },
          { name: '交易稅(平倉)', detail: `${fM(totalPrem,cur)} × ${(oTaxRate*100).toFixed(2)}%`, amt: fM(oCloseTax, cur) },
        ] : [
          { name: 'Commission (Open)', detail: `${fM(oComm,cur)} × ${qty}`, amt: fM(oComm * qty, cur) },
          { name: 'Commission (Close)', detail: `${fM(oComm,cur)} × ${qty}`, amt: fM(oComm * qty, cur) },
        ],
        fM(oFees, cur),
        expPL !== null ? { label: '到期淨損益(税後)', value: ((expPL - oFees) >= 0 ? '+' : '') + fM(expPL - oFees, cur), positive: (expPL - oFees) >= 0 } : null
      ) : ''}`;
    const stress = buildOptionsStress(isCall, buyer, prem, strike, mul, qty, ul, cur);
    const formula = `<div class="fc">
      <div class="fb"><h4>1. 權利金成本</h4>
        <span class="fl"><span class="v">總成本</span> <span class="o">=</span> 權利金(<span class="n">${fmt(prem,2)}</span>) <span class="o">×</span> 乘數(<span class="n">${fmt(mul)}</span>) <span class="o">×</span> 口數(<span class="n">${qty}</span>) <span class="o">=</span> <span class="r">${fM(totalPrem,cur)}</span></span>
        <div class="fn">買方最大虧損 = 全部權利金 ${fM(totalPrem,cur)}，不需保證金，不會追繳。</div>
      </div>
      <div class="fb"><h4>2. 價值分析</h4>
        <span class="fl"><span class="v">內含價值</span> <span class="o">=</span> ${isCall ? `Max(0, 標的(${fmt(ul,2)}) − 履約價(${fmt(strike,2)}))` : `Max(0, 履約價(${fmt(strike,2)}) − 標的(${fmt(ul,2)}))`} <span class="o">=</span> <span class="r">${fmt(iv,2)}</span></span>
        <span class="fl"><span class="v">時間價值</span> <span class="o">=</span> 權利金(<span class="n">${fmt(prem,2)}</span>) <span class="o">−</span> 內含價值(<span class="n">${fmt(iv,2)}</span>) <span class="o">=</span> <span class="r">${fmt(tv,2)}</span></span>
        <span class="fl"><span class="v">價內外狀態</span> <span class="o">=</span> <span class="r">${money}</span>${oom > 0 ? `　價外值 = <span class="n">${fmt(oom,2)}</span>` : ''}</span>
      </div>
      <div class="fb"><h4>3. 損益平衡</h4>
        <span class="fl"><span class="v">損益平衡點</span> <span class="o">=</span> ${isCall ? `履約價(${fmt(strike,2)}) + 權利金(${fmt(prem,2)})` : `履約價(${fmt(strike,2)}) − 權利金(${fmt(prem,2)})`} <span class="o">=</span> <span class="r">${fmt(be,2)}</span></span>
        <div class="fn">${isCall ? '標的高於' : '標的低於'} ${fmt(be,2)} 才開始獲利</div>
      </div>
      ${expPL !== null ? `<div class="fb"><h4>4. 到期損益試算</h4>
        <span class="fl"><span class="v">到期內含價值</span> <span class="o">=</span> ${isCall ? `Max(0, 結算價(${fmt(expP,2)}) − 履約價(${fmt(strike,2)}))` : `Max(0, 履約價(${fmt(strike,2)}) − 結算價(${fmt(expP,2)}))`} <span class="o">=</span> <span class="r">${fmt(isCall ? Math.max(0,expP-strike) : Math.max(0,strike-expP),2)}</span></span>
        <span class="fl"><span class="v">到期損益</span> <span class="o">=</span> (到期內含值(<span class="n">${fmt(isCall ? Math.max(0,expP-strike) : Math.max(0,strike-expP),2)}</span>) <span class="o">−</span> 權利金(<span class="n">${fmt(prem,2)}</span>)) <span class="o">×</span> 乘數(<span class="n">${fmt(mul)}</span>) <span class="o">×</span> 口數(<span class="n">${qty}</span>) <span class="o">=</span> <span class="r">${(expPL>=0?'+':'')}${fM(expPL,cur)}</span></span>
        <span class="fl"><span class="v">報酬率</span> <span class="o">=</span> 損益(<span class="n">${(expPL>=0?'+':'')}${fM(expPL,cur)}</span>) <span class="o">÷</span> 成本(<span class="n">${fM(totalPrem,cur)}</span>) <span class="o">=</span> <span class="r">${(expPL/totalPrem*100).toFixed(1)}%</span></span>
      </div>` : ''}
      <div class="fb"><h4>${expPL !== null ? '5' : '4'}. 買方風險說明</h4>
        <span class="fl">① <span class="v">不需保證金、不會追繳</span>：買方已在進場時支付全部權利金 ${fM(totalPrem,cur)}，此即為<strong>最大虧損上限</strong>，無論市場如何波動都不會被追繳。</span>
        <span class="fl">② <span class="v">到期處理</span>：到期時若為<strong>價內</strong>（有內含價值），台灣期交所會<strong>自動現金結算</strong>；若為<strong>價外</strong>，權利金歸零、合約自動消滅。</span>
        <span class="fl">③ <span class="v">時間價值衰減</span>：距到期越近，時間價值(${fmt(tv,2)})衰減越快（Theta 效應），即使標的不動，權利金也會下降。</span>
        <div class="fn">買方風險有限但獲利機率較低，統計上大多數選擇權到期時為價外（歸零）。</div>
      </div>
    </div>`;
    $('#options-results').innerHTML = subTabs('or', ['風險概覽', '到期情境', '計算公式'], [overview, stress, formula]) + (window.PrismJournal ? PrismJournal.recordBtnHTML('options') : '');
  } else {
    const rr = gV('o-rr') / 100, mr = gV('o-mr') / 100;
    const pmv = prem * mul, uv = ul * mul;
    const A = uv * rr - oom * mul, B = uv * mr;
    const mpc = Math.max(A, B) + pmv, totalMargin = mpc * qty;

    const overview = `
      ${alertBox('danger', `賣方風險${isCall ? '無上限' : '極大'}！需繳交保證金，可能被追繳。`)}
      <div class="mg">
        ${mgLabel('合約資訊')}
        ${mc(`${isCall ? 'Call' : 'Put'} 賣方`, money, `履約價 ${fmt(strike)} | ${qty}口`, 'h-red')}
        ${mc('價外值', fmt(oom, 2), `A=${fM(A, cur)} B=${fM(B, cur)}`)}
        ${mc('損益平衡', fmt(be, 2))}
        ${mgLabel('保證金')}
        ${mc('所需保證金', fM(totalMargin, cur), `每口 ${fM(mpc, cur)}`, 'h-yellow')}
        ${mgLabel('損益')}
        ${mc('最大獲利(税前)', fM(totalPrem, cur), '', 'h-green')}
        ${oFees > 0 ? mc('最大淨獲利(税後)', fM(totalPrem - oFees, cur), `扣除費用 ${fM(oFees, cur)}`, 'h-green') : ''}
        ${mc('最大虧損', isCall ? '無上限' : fM((strike - prem) * mul * qty, cur), '', 'h-red')}
        ${expPL !== null ? mc('到期損益(税前)', (expPL >= 0 ? '+' : '') + fM(expPL, cur), `結算價 ${fmt(expP)}`, expPL >= 0 ? 'h-green' : 'h-red') : ''}
      </div>
      ${oFees > 0 ? costTable(
        tw ? [
          { name: '手續費(開倉)', detail: `${fM(oComm,cur)}/口 × ${qty}口`, amt: fM(oComm * qty, cur) },
          { name: '手續費(平倉)', detail: `${fM(oComm,cur)}/口 × ${qty}口`, amt: fM(oComm * qty, cur) },
          { name: '交易稅(開倉)', detail: `${fM(totalPrem,cur)} × ${(oTaxRate*100).toFixed(2)}%`, amt: fM(oOpenTax, cur) },
          { name: '交易稅(平倉)', detail: `${fM(totalPrem,cur)} × ${(oTaxRate*100).toFixed(2)}%`, amt: fM(oCloseTax, cur) },
        ] : [
          { name: 'Commission (Open)', detail: `${fM(oComm,cur)} × ${qty}`, amt: fM(oComm * qty, cur) },
          { name: 'Commission (Close)', detail: `${fM(oComm,cur)} × ${qty}`, amt: fM(oComm * qty, cur) },
        ],
        fM(oFees, cur),
        expPL !== null ? { label: '到期淨損益(税後)', value: ((expPL - oFees) >= 0 ? '+' : '') + fM(expPL - oFees, cur), positive: (expPL - oFees) >= 0 } : null
      ) : ''}`;
    const stress = buildOptionsStress(isCall, buyer, prem, strike, mul, qty, ul, cur);
    const maxLoss = isCall ? '無上限' : fM((strike - prem) * mul * qty, cur);
    const formula = `<div class="fc">
      <div class="fb"><h4>1. 權利金收入</h4>
        <span class="fl"><span class="v">每口收入</span> <span class="o">=</span> 權利金(<span class="n">${fmt(prem,2)}</span>) <span class="o">×</span> 乘數(<span class="n">${fmt(mul)}</span>) <span class="o">=</span> <span class="r">${fM(pmv,cur)}</span></span>
        <span class="fl"><span class="v">總收入</span> <span class="o">=</span> 每口收入(<span class="n">${fM(pmv,cur)}</span>) <span class="o">×</span> 口數(<span class="n">${qty}</span>) <span class="o">=</span> <span class="r">${fM(totalPrem,cur)}</span></span>
        <div class="fn">賣方最大獲利 = 全部權利金 ${fM(totalPrem,cur)}（買方不履約時）</div>
      </div>
      <div class="fb"><h4>2. 保證金計算</h4>
        <span class="fl"><span class="v">標的價值</span> <span class="o">=</span> 標的物(<span class="n">${fmt(ul,2)}</span>) <span class="o">×</span> 乘數(<span class="n">${fmt(mul)}</span>) <span class="o">=</span> <span class="r">${fM(uv,cur)}</span></span>
        <span class="fl"><span class="v">價外值</span> <span class="o">=</span> ${isCall ? `Max(0, 履約價(${fmt(strike,2)}) − 標的(${fmt(ul,2)}))` : `Max(0, 標的(${fmt(ul,2)}) − 履約價(${fmt(strike,2)}))`} <span class="o">=</span> <span class="r">${fmt(oom,2)}</span></span>
        <span class="fl"><span class="v">A</span> <span class="o">=</span> 標的價值(<span class="n">${fM(uv,cur)}</span>) <span class="o">×</span> 風險比率(<span class="n">${(rr*100).toFixed(0)}%</span>) <span class="o">−</span> 價外值(<span class="n">${fmt(oom,2)}</span>) <span class="o">×</span> 乘數(<span class="n">${fmt(mul)}</span>) <span class="o">=</span> <span class="r">${fM(A,cur)}</span></span>
        <span class="fl"><span class="v">B</span> <span class="o">=</span> 標的價值(<span class="n">${fM(uv,cur)}</span>) <span class="o">×</span> 最低比率(<span class="n">${(mr*100).toFixed(0)}%</span>) <span class="o">=</span> <span class="r">${fM(B,cur)}</span></span>
        <span class="fl"><span class="v">每口保證金</span> <span class="o">=</span> Max(A(<span class="n">${fM(A,cur)}</span>), B(<span class="n">${fM(B,cur)}</span>)) <span class="o">+</span> 權利金市值(<span class="n">${fM(pmv,cur)}</span>) <span class="o">=</span> <span class="r">${fM(mpc,cur)}</span></span>
        <span class="fl"><span class="v">總保證金</span> <span class="o">=</span> 每口(<span class="n">${fM(mpc,cur)}</span>) <span class="o">×</span> 口數(<span class="n">${qty}</span>) <span class="o">=</span> <span class="r">${fM(totalMargin,cur)}</span></span>
        <div class="fn">實際保證金可能使用 SPAN 模型，以上為簡化公式。</div>
      </div>
      <div class="fb"><h4>3. 價值分析</h4>
        <span class="fl"><span class="v">內含價值</span> <span class="o">=</span> ${isCall ? `Max(0, 標的(${fmt(ul,2)}) − 履約價(${fmt(strike,2)}))` : `Max(0, 履約價(${fmt(strike,2)}) − 標的(${fmt(ul,2)}))`} <span class="o">=</span> <span class="r">${fmt(iv,2)}</span></span>
        <span class="fl"><span class="v">時間價值</span> <span class="o">=</span> 權利金(<span class="n">${fmt(prem,2)}</span>) <span class="o">−</span> 內含價值(<span class="n">${fmt(iv,2)}</span>) <span class="o">=</span> <span class="r">${fmt(tv,2)}</span></span>
        <span class="fl"><span class="v">價內外狀態</span> <span class="o">=</span> <span class="r">${money}</span>${oom > 0 ? `　價外值 = <span class="n">${fmt(oom,2)}</span>（賣方有利）` : ''}</span>
      </div>
      <div class="fb"><h4>4. 損益平衡與風險</h4>
        <span class="fl"><span class="v">損益平衡點</span> <span class="o">=</span> ${isCall ? `履約價(${fmt(strike,2)}) + 權利金(${fmt(prem,2)})` : `履約價(${fmt(strike,2)}) − 權利金(${fmt(prem,2)})`} <span class="o">=</span> <span class="r">${fmt(be,2)}</span></span>
        <span class="fl"><span class="v">最大獲利</span> <span class="o">=</span> 全部權利金 <span class="o">=</span> <span class="r">${fM(totalPrem,cur)}</span></span>
        <span class="fl"><span class="v">最大虧損</span> <span class="o">=</span> <span class="r">${maxLoss}</span></span>
        <div class="fn">${isCall ? '標的超過' : '標的低於'} ${fmt(be,2)} 時開始虧損，賣方風險${isCall ? '無上限' : '極大'}！</div>
      </div>
      ${expPL !== null ? `<div class="fb"><h4>5. 到期損益試算</h4>
        <span class="fl"><span class="v">到期內含價值</span> <span class="o">=</span> ${isCall ? `Max(0, 結算價(${fmt(expP,2)}) − 履約價(${fmt(strike,2)}))` : `Max(0, 履約價(${fmt(strike,2)}) − 結算價(${fmt(expP,2)}))`} <span class="o">=</span> <span class="r">${fmt(isCall ? Math.max(0,expP-strike) : Math.max(0,strike-expP),2)}</span></span>
        <span class="fl"><span class="v">到期損益</span> <span class="o">=</span> (權利金(<span class="n">${fmt(prem,2)}</span>) <span class="o">−</span> 到期內含值(<span class="n">${fmt(isCall ? Math.max(0,expP-strike) : Math.max(0,strike-expP),2)}</span>)) <span class="o">×</span> 乘數(<span class="n">${fmt(mul)}</span>) <span class="o">×</span> 口數(<span class="n">${qty}</span>) <span class="o">=</span> <span class="r">${(expPL>=0?'+':'')}${fM(expPL,cur)}</span></span>
        <span class="fl"><span class="v">報酬率(對保證金)</span> <span class="o">=</span> 損益(<span class="n">${(expPL>=0?'+':'')}${fM(expPL,cur)}</span>) <span class="o">÷</span> 保證金(<span class="n">${fM(totalMargin,cur)}</span>) <span class="o">=</span> <span class="r">${(expPL/totalMargin*100).toFixed(1)}%</span></span>
      </div>` : ''}
      <div class="fb"><h4>${expPL !== null ? '6' : '5'}. 期貨商處置流程（賣方）</h4>
        <span class="fl">① <span class="v">保證金不足</span>：當市場不利變動導致帳戶權益低於<strong>維持保證金</strong>時，期貨商盤後發出<strong>追繳通知</strong>，須在<strong>次一營業日中午 12:00 前</strong>補繳至原始保證金水位。</span>
        <span class="fl">② <span class="v">逾期未補繳</span>：期貨商可<strong>代為沖銷</strong>（強制平倉）賣方部位。</span>
        <span class="fl">③ <span class="v">風險指標 ≤ 25%</span>：期貨商可<strong>不另通知、立即砍倉</strong>，盤中即時執行。</span>
        <span class="fl">④ <span class="v">到期結算</span>：到期時若為<strong>價內</strong>，賣方需支付內含價值差額（自動現金結算）；若為<strong>價外</strong>，賣方保留全部權利金。</span>
        <span class="fl">⑤ <span class="v">賣方特有風險</span>：${isCall ? 'Call 賣方虧損理論上<strong>無上限</strong>（標的可無限上漲）' : 'Put 賣方虧損可達 ' + fM((strike-prem)*mul*qty, cur) + '（標的跌至0）'}，且保證金會隨市場波動而<strong>動態調整</strong>（SPAN 模型），可能需要額外補繳。</span>
        <div class="fn">實際追繳時限與砍倉門檻以各期貨商風控規則為準。賣方風險極大，請務必做好資金管理。</div>
      </div>
    </div>`;
    $('#options-results').innerHTML = subTabs('or', ['風險概覽', '到期情境', '計算公式'], [overview, stress, formula]) + (window.PrismJournal ? PrismJournal.recordBtnHTML('options') : '');
  }
}

function buildOptionsStress(isCall, buyer, prem, strike, mul, qty, ul, cur) {
  const range = ul * 0.15, step = Math.max(1, Math.round(range / 10));
  const levels = [];
  for (let p = ul - range; p <= ul + range; p += step) levels.push(Math.round(p));
  if (!levels.includes(Math.round(strike))) levels.push(Math.round(strike));
  if (!levels.includes(Math.round(ul))) levels.push(Math.round(ul));
  levels.sort((a, b) => a - b);
  let rows = '';
  for (const lv of levels) {
    const iv2 = isCall ? Math.max(0, lv - strike) : Math.max(0, strike - lv);
    const pl = buyer ? (iv2 - prem) * mul * qty : (prem - iv2) * mul * qty;
    const rc = lv === Math.round(ul) ? 'rc' : '', isSt = lv === Math.round(strike);
    const sc = pl >= 0 ? 'sb-s' : 'sb-x';
    rows += `<tr class="${rc}"><td>${fmt(lv)}${isSt ? ' (履約)' : ''}${lv === Math.round(ul) ? ' (目前)' : ''}</td><td>${fmt(iv2, 2)}</td><td class="${pl >= 0 ? 'tg' : 'tr'}">${pl >= 0 ? '+' : ''}${fM(pl, cur)}</td><td><span class="sb ${sc}">${pl >= 0 ? '獲利' : '虧損'}</span></td></tr>`;
  }
  return `<div class="st-wrap"><table class="st"><thead><tr><th>結算價</th><th>內含價值</th><th>損益</th><th>狀態</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ================================================================
//  KEYBOARD SHORTCUTS
// ================================================================
document.addEventListener('keydown', e => {
  // Don't fire when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.target.isContentEditable) return;

  const tabs = ['margin', 'futures', 'options', 'journal', 'guide', 'settings'];
  const key = parseInt(e.key);
  if (key >= 1 && key <= 6) {
    const tab = tabs[key - 1];
    const tabBtn = $(`.main-tab[data-tab="${tab}"]`);
    if (tabBtn) { tabBtn.click(); e.preventDefault(); }
  }
  // R to refresh quotes
  if (e.key === 'r' || e.key === 'R') {
    const btn = $('#btn-fetch-indices');
    if (btn && !btn.classList.contains('loading')) { btn.click(); e.preventDefault(); }
  }
});

// ================================================================
//  NETWORK STATUS TOAST
// ================================================================
(function() {
  let _toastEl = null;
  function _getToast() {
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.className = 'network-toast';
      _toastEl.setAttribute('role', 'status');
      _toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(_toastEl);
    }
    return _toastEl;
  }
  function showToast(msg, type) {
    const t = _getToast();
    t.textContent = msg;
    t.className = 'network-toast ' + (type || '');
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 3500);
  }
  window._showToast = showToast;
  window.addEventListener('online', () => showToast('網路已恢復連線', 'online'));
  window.addEventListener('offline', () => showToast('網路連線已中斷，部分功能可能無法使用', 'offline'));
})();

// ================================================================
//  PULL-TO-REFRESH (Mobile)
// ================================================================
(function() {
  let _startY = 0, _pulling = false, _indicator = null;
  function _getIndicator() {
    if (!_indicator) {
      _indicator = document.createElement('div');
      _indicator.className = 'pull-refresh-indicator';
      _indicator.textContent = '下拉更新報價';
      const app = document.getElementById('app');
      if (app) app.prepend(_indicator);
    }
    return _indicator;
  }
  document.addEventListener('touchstart', e => {
    if (window.scrollY === 0 && e.touches.length === 1) {
      _startY = e.touches[0].clientY;
      _pulling = true;
    }
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!_pulling) return;
    const dy = e.touches[0].clientY - _startY;
    const ind = _getIndicator();
    if (dy > 10 && dy < 120 && window.scrollY === 0) {
      ind.style.transform = `translateY(${Math.min(dy * 0.5, 50)}px)`;
      ind.style.opacity = Math.min(dy / 80, 1);
      ind.textContent = dy > 60 ? '放開更新報價' : '下拉更新報價';
    } else {
      ind.style.transform = '';
      ind.style.opacity = 0;
    }
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (!_pulling) return;
    _pulling = false;
    const ind = _getIndicator();
    const released = parseFloat(ind.style.opacity) >= 0.75;
    ind.style.transform = '';
    ind.style.opacity = 0;
    if (released) {
      const btn = document.getElementById('btn-fetch-indices');
      if (btn && !btn.classList.contains('loading')) btn.click();
    }
  }, { passive: true });
})();

// ================================================================
//  HAPTIC FEEDBACK (Mobile bottom nav)
// ================================================================
document.addEventListener('click', e => {
  const tab = e.target.closest('.main-tab');
  if (tab && navigator.vibrate) navigator.vibrate(10);
});

// ================================================================
//  COLLAPSIBLE FORMULA SECTIONS
// ================================================================
document.addEventListener('click', e => {
  const h4 = e.target.closest('.fb > h4');
  if (!h4) return;
  const fb = h4.parentElement;
  if (fb && fb.classList.contains('fb')) {
    fb.classList.toggle('collapsed');
  }
});

// ================================================================
//  SCROLL INDICATOR for horizontal stress tables
// ================================================================
(function() {
  let _stDebounce = null;
  const bindScrollIndicators = () => {
    document.querySelectorAll('.st-wrap').forEach(wrap => {
      if (wrap._scrollBound) return;
      wrap._scrollBound = true;
      wrap.addEventListener('scroll', function() {
        const atEnd = this.scrollLeft + this.clientWidth >= this.scrollWidth - 4;
        this.classList.toggle('scrolled-end', atEnd);
      }, { passive: true });
    });
  };
  const observer = new MutationObserver(() => {
    clearTimeout(_stDebounce);
    _stDebounce = setTimeout(bindScrollIndicators, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();

// ================================================================
//  RESET SETTINGS TO DEFAULTS
// ================================================================
window._resetSettingsToDefaults = function() {
  if (!confirm('確定要將所有設定恢復為預設值嗎？此操作無法還原。')) return;
  Object.assign(CFG, { ...DEFAULT_SETTINGS });
  saveSettings(CFG);
  applySettings();
  window._stgRendered = false;
  renderSettings();
  window._stgRendered = true;
};

// ================================================================
//  AUTO-FILL TRADE RECORD FROM CALCULATOR
// ================================================================
window._getCalcParamsForRecord = function(tab) {
  const params = {};
  if (tab === 'margin') {
    params.market = S.margin.market;
    params.type = 'stock';
    const price = gV('m-price');
    const qty = gV('m-shares');
    if (price) params.entry_price = price;
    if (qty) params.quantity = qty;
    const symbol = gVraw('m-symbol');
    if (symbol) params.symbol = symbol;
  } else if (tab === 'futures') {
    params.market = S.futures.market;
    params.type = 'futures';
    const entry = gV('f-entry');
    const qty = gV('f-qty');
    if (entry) params.entry_price = entry;
    if (qty) params.quantity = qty;
  } else if (tab === 'options') {
    params.market = S.options.market;
    params.type = 'options';
    const premium = gV('o-prem');
    const qty = gV('o-qty');
    if (premium) params.entry_price = premium;
    if (qty) params.quantity = qty;
  }
  params.direction = (tab === 'margin') ? S.margin.direction :
                     (tab === 'futures') ? S.futures.direction :
                     S.options.side;
  return params;
};
