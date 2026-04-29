#!/usr/bin/env node
/**
 * Prism 券商交易紀錄解析器
 *
 * Usage:
 *   node scripts/prism-parse-import.mjs <file1> [file2] ...
 *
 * 支援：
 *   - 元大 台股 CSV（Big5，含小計列）
 *   - 元大 美股 CSV（Big5）
 *   - 群益 期貨 xlsx（沖銷報表）
 *   - 其他使用類似欄位名稱的券商報表
 *
 * 輸出：JSON array 到 stdout，每筆交易經 FIFO 配對
 */
import fs from 'fs';
import path from 'path';
import { inflateRawSync } from 'zlib';

// ── 欄位 alias（精確匹配）─────────────────────────────────
const BROKER_COL_ALIASES = {
  date: ['date','成交日期','成交日','交易日期','日期','買賣日期','Date'],
  symbol: ['symbol','股票代號','證券代號','代號','商品代號','商品','代碼','股票代碼','股號','Symbol','Stock','Ticker'],
  name: ['name','股票名稱','證券名稱','商品名稱','名稱','股名','Name'],
  direction: ['direction','買賣別','買賣','交易別','買/賣','買賣區分','Side'],
  currency: ['幣別','Currency'],
  exchange: ['交易所','Exchange','市場別','市場'],
  quantity: ['quantity','成交股數','成交數量','股數','數量','成交量','口數','Qty','Quantity','Shares'],
  entryPrice: ['entryPrice','成交價格','成交均價','價格','均價','成交價','Price','Avg Price'],
  fee: ['fee','手續費','Fee','Commission'],
  tax: ['tax','交易稅','證交稅','稅額','Tax'],
  market: ['market','Market'],
  type: ['type','商品類別','Type'],
  account: ['account','帳號','券商','Account'],
  notes: ['notes','備註','Notes'],
  _amount: ['淨收付金額','淨額','成交金額','金額','Amount','Net'],
  expiry: ['到期年月','契約月份','月份'],
  strike: ['履約價','Strike'],
  tradeTime: ['成交時間'],
};

function resolveColMap(headerCells) {
  const map = {};
  for (let i = 0; i < headerCells.length; i++) {
    const h = (headerCells[i] ?? '').toString().trim().replace(/^["']|["']$/g, '');
    if (!h) continue;
    for (const [field, aliases] of Object.entries(BROKER_COL_ALIASES)) {
      if (map[field] != null) continue;
      if (aliases.includes(h)) { map[field] = i; break; }
    }
  }
  return map;
}

function parseCSVLine(line) {
  const r = []; let c = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i+1] === '"') { c += '"'; i++; }
      else if (ch === '"') q = false;
      else c += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ',') { r.push(c); c = ''; }
      else c += ch;
    }
  }
  r.push(c);
  return r;
}

function parseDate(raw) {
  if (!raw) return '';
  let s = raw.trim().replace(/\s+/g, ' ');
  const m1 = s.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (m1) return `${+m1[1]+1911}-${m1[2].padStart(2,'0')}-${m1[3].padStart(2,'0')}`;
  const m2 = s.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (m2) return `${+m2[1]+1911}-${m2[2]}-${m2[3]}`;
  const m3 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m3) return `${m3[1]}-${m3[2]}-${m3[3]}`;
  const m4 = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m4) return `${m4[1]}-${m4[2].padStart(2,'0')}-${m4[3].padStart(2,'0')}`;
  return s;
}

const parseDir = (r) => !r ? 'long' : (/^(賣|賣出|融券賣出|sell|short|S)$/i.test(r.trim()) ? 'short' : 'long');
const parseQty = (r) => !r ? '' : (n => isNaN(n) ? '' : Math.abs(n))(parseFloat(r.toString().replace(/,/g,'')));
const parseNum = (r) => !r ? '' : (n => isNaN(n) ? '' : n)(parseFloat(r.toString().replace(/,/g,'')));

// ── 根據商品代號自動套 contractMul ──────────────────────
const FUTURES_MUL = {
  'TXF': 200, 'TX': 200,   // 大台指
  'MXF': 50, 'MTX': 50,    // 小台指
  'FITM': 10, 'TMF': 10,   // 微台指
  'EXF': 200,              // 電子期
  'FXF': 4000,             // 金融期
};
const lookupContractMul = (symbol) => FUTURES_MUL[(symbol || '').toUpperCase().replace(/\s/g, '')] || '';

function parseRowToTrade(vals, colMap, opts = {}) {
  const g = f => { const i = colMap[f]; return i != null ? (vals[i] ?? '').toString().trim() : ''; };
  const dir = parseDir(g('direction'));
  const qty = parseQty(g('quantity'));
  const price = parseNum(g('entryPrice'));
  let dp = price;
  if (!price && g('_amount') && qty) {
    const a = Math.abs(parseNum(g('_amount')));
    if (a && qty) dp = Math.round(a/qty*100)/100;
  }
  const expiry = g('expiry'), strike = g('strike'), tradeTime = g('tradeTime');
  const notePieces = [];
  const baseNotes = g('notes');
  if (baseNotes) notePieces.push(baseNotes);
  if (expiry) notePieces.push(`到期 ${expiry}`);
  if (strike && strike !== '0' && strike !== '0.0') notePieces.push(`履約價 ${strike}`);
  if (tradeTime) notePieces.push(`時間 ${tradeTime}`);
  const isFutures = !!opts.futures;
  const sym = g('symbol').replace(/\s/g,'');
  const cur = g('currency').toUpperCase();
  const exch = g('exchange');
  let market = g('market') || '';
  if (!market) {
    if (/USD/.test(cur) || /美國|NYSE|NASDAQ|美股/i.test(exch)) market = 'us';
    else if (/HKD/.test(cur) || /香港|HKEX|港股/i.test(exch)) market = 'hk';
    else if (/JPY/.test(cur) || /日本|TSE|日股/i.test(exch)) market = 'jp';
    else market = 'tw';
  }
  const contractMul = isFutures ? lookupContractMul(sym) : '';
  return {
    date: parseDate(g('date')) || new Date().toISOString().slice(0, 10),
    market,
    type: isFutures ? 'index_futures' : (g('type') || 'stock'),
    symbol: sym, name: g('name'),
    direction: dir, status: 'closed',
    entryPrice: dp, exitPrice: '', quantity: qty,
    contractMul,
    stopLoss: '', takeProfit: '',
    fee: parseNum(g('fee')) || '',
    tax: parseNum(g('tax')) || '',
    account: g('account'),
    rating: 0, tags: [],
    notes: notePieces.join(' | '),
    pricingStage: '',
  };
}

// ── FIFO 配對 ────────────────────────────────────────────
function pairFIFO(raw) {
  const byKey = {};
  for (const t of raw) {
    const exp = (t.notes || '').match(/到期 (\S+)/);
    const key = `${t.market}|${t.type}|${t.symbol}|${exp ? exp[1] : ''}`;
    (byKey[key] = byKey[key] || []).push(t);
  }
  const _time = t => { const m = (t.notes || '').match(/時間 ([\d:.]+)/); return m ? m[1] : ''; };
  const round2 = n => Math.round(n * 100) / 100;
  const results = [];
  for (const key of Object.keys(byKey)) {
    const list = byKey[key].slice().sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return _time(a).localeCompare(_time(b));
    });
    const queue = [];
    for (const t of list) {
      const qty = Number(t.quantity) || 0, price = Number(t.entryPrice) || 0;
      const fee = Number(t.fee) || 0, tax = Number(t.tax) || 0;
      if (!qty || !price) continue;
      let rem = qty;
      while (rem > 0 && queue.length && queue[0].direction !== t.direction) {
        const lot = queue[0];
        const cq = Math.min(lot.qty, rem);
        const lotFee = lot.fee * (cq/lot.qty), lotTax = lot.tax * (cq/lot.qty);
        const exitFee = fee * (cq/qty), exitTax = tax * (cq/qty);
        const et = _time(t);
        const exitLabel = et ? `出場 ${t.date} ${et}` : `出場 ${t.date}`;
        results.push({
          date: lot.date, market: lot.market, type: lot.type,
          symbol: lot.symbol, name: lot.name || t.name,
          direction: lot.direction, status: 'closed',
          entryPrice: lot.price, exitPrice: price, quantity: cq,
          contractMul: lot.contractMul || t.contractMul || '',
          stopLoss: '', takeProfit: '',
          fee: round2(lotFee + exitFee),
          tax: round2(lotTax + exitTax),
          account: lot.account || t.account,
          rating: 0, tags: [],
          notes: [lot.notes, exitLabel].filter(Boolean).join(' | '),
          pricingStage: '',
        });
        lot.qty -= cq; lot.fee -= lotFee; lot.tax -= lotTax;
        rem -= cq;
        if (lot.qty <= 1e-9) queue.shift();
      }
      if (rem > 0) {
        const r = rem / qty;
        queue.push({
          direction: t.direction, date: t.date,
          qty: rem, price,
          fee: fee * r, tax: tax * r,
          market: t.market, type: t.type,
          symbol: t.symbol, name: t.name,
          account: t.account, notes: t.notes,
          contractMul: t.contractMul || '',
        });
      }
    }
    for (const lot of queue) {
      results.push({
        date: lot.date, market: lot.market, type: lot.type,
        symbol: lot.symbol, name: lot.name,
        direction: lot.direction, status: 'open',
        entryPrice: lot.price, exitPrice: '', quantity: lot.qty,
        contractMul: lot.contractMul || '',
        stopLoss: '', takeProfit: '',
        fee: round2(lot.fee), tax: round2(lot.tax),
        account: lot.account, rating: 0, tags: [],
        notes: lot.notes, pricingStage: '',
      });
    }
  }
  results.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return results;
}

// ── HTML-as-XLS 解析（元富/MasterLink 等券商 HTML 偽裝格式）──────────
function isHtmlXls(buf) {
  const head = buf.slice(0, 300).toString('utf8');
  return head.includes('<html') || head.includes('ExcelWorkbook');
}

function parseHtmlXlsRows(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trM;
  while ((trM = trRe.exec(html))) {
    const cells = [];
    const tdRe = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
    let tdM;
    while ((tdM = tdRe.exec(trM[1]))) {
      const text = tdM[1]
        .replace(/<br\b[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
        .replace(/\s+/g, ' ').trim();
      cells.push(text);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

// 元富/MasterLink 投資明細格式：row0=20欄主標題，row1=4欄子標題，data從row2起22欄
function isMasterlinkFormat(rows) {
  const h0 = (rows[0] || []).map(c => (c || '').trim());
  const h1 = (rows[1] || []).map(c => (c || '').trim());
  return h0[0] === '成交日期' && h0.includes('損益') &&
         h1.includes('代號') && h1.includes('名稱');
}

function masterlinkRowsToRaw(rows, srcLabel) {
  // 固定欄位位置：成交日期(0) 代號(1) 名稱(2) 交易種類(3) 買賣(4) 交易類別(5) 數量(6) 單價(7) 價金(8) 手續費(9) 交易稅(10) ... 幣別(21)
  const cm = { date: 0, symbol: 1, name: 2, direction: 4, quantity: 6, entryPrice: 7, fee: 9, tax: 10, currency: 21 };
  const raw = [];
  for (let i = 2; i < rows.length; i++) {
    const v = (rows[i] || []).map(c => (c || '').toString());
    if (v.length < 8) continue;
    const first = v[0].trim();
    if (!first || !/^\d{4}\/\d{2}\/\d{2}/.test(first)) continue;
    const sym = (v[1] || '').trim();
    if (!sym) continue;
    raw.push(parseRowToTrade(v, cm, {}));
  }
  if (!raw.length) throw new Error(`${srcLabel}：元富格式解析後無有效資料列`);
  return raw;
}

// ── xlsx 解析（原生 ZIP + 正則 XML）──────────────────────
async function unzipXlsx(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(ab);
  const size = ab.byteLength;
  let eocd = -1;
  for (let i = size - 22; i >= Math.max(0, size - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('非有效的 xlsx 檔');
  const cdCount = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const out = {};
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    const method = dv.getUint16(p+10, true);
    const compSize = dv.getUint32(p+20, true);
    const nameLen = dv.getUint16(p+28, true);
    const extraLen = dv.getUint16(p+30, true);
    const commentLen = dv.getUint16(p+32, true);
    const localOffset = dv.getUint32(p+42, true);
    const name = new TextDecoder('utf-8').decode(new Uint8Array(ab, p+46, nameLen));
    const lN = dv.getUint16(localOffset+26, true);
    const lE = dv.getUint16(localOffset+28, true);
    const ds = localOffset + 30 + lN + lE;
    const raw = Buffer.from(ab, ds, compSize);
    if (method === 0) out[name] = raw.toString('utf-8');
    else if (method === 8) out[name] = inflateRawSync(raw).toString('utf-8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
const colToIdx = l => { let n = 0; for (const c of l) n = n*26 + (c.charCodeAt(0) - 64); return n - 1; };

async function parseXlsxFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const files = await unzipXlsx(buf);
  const ss = [];
  const ssXml = files['xl/sharedStrings.xml'];
  if (ssXml) {
    const re = /<si[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(ssXml))) {
      let s = '';
      const t = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let x;
      while ((x = t.exec(m[1]))) s += x[1];
      ss.push(s);
    }
  }
  const sk = Object.keys(files).find(k => /^xl\/worksheets\/sheet[^/]*\.xml$/i.test(k));
  if (!sk) throw new Error('xlsx 中找不到 worksheet');
  const sheet = files[sk];
  const rows = [];
  const rr = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rr.exec(sheet))) {
    const cR = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    const cells = []; let mc = -1, cm, ci = 0;
    while ((cm = cR.exec(rm[1]))) {
      const a = cm[1], b = cm[2] || '';
      const rM = a.match(/r="([A-Z]+)\d+"/);
      const ix = rM ? colToIdx(rM[1]) : ci;
      const tM = a.match(/t="([^"]+)"/);
      const t = tM ? tM[1] : null;
      let v = '';
      const vM = b.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      const iM = b.match(/<is[^>]*>([\s\S]*?)<\/is>/);
      if (iM) {
        const tr = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let tm;
        while ((tm = tr.exec(iM[1]))) v += tm[1];
      } else if (vM) {
        v = vM[1];
        if (t === 's') v = ss[+v] || '';
      }
      cells[ix] = v;
      if (ix > mc) mc = ix;
      ci++;
    }
    for (let i = 0; i <= mc; i++) if (cells[i] == null) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

function parseCsvFile(filePath) {
  const buf = fs.readFileSync(filePath);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('big5').decode(buf); }
  return text.split(/\r?\n/).filter(l => l.trim()).map(parseCSVLine);
}

function rowsToRaw(rows, srcLabel) {
  let hi = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (resolveColMap(rows[i].map(c => c ?? '')).symbol != null) { hi = i; break; }
  }
  const header = rows[hi].map(c => c ?? '');
  const cm = resolveColMap(header);
  if (cm.symbol == null) throw new Error(`${srcLabel}：無法辨識欄位（找不到代號/商品欄）`);
  const hasExp = cm.expiry != null;
  const raw = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const v = rows[i].map(c => c ?? '');
    if (v.every(x => !x.trim())) continue;
    const sv = cm.symbol != null ? (v[cm.symbol] || '').trim() : '';
    const dv = cm.date != null ? (v[cm.date] || '') : '';
    if (!sv || /小計|合計|總計/.test(sv) || /小計|合計|總計/.test(dv)) continue;
    raw.push(parseRowToTrade(v, cm, { futures: hasExp }));
  }
  return raw;
}

// ── Main ───────────────────────────────────────────────
async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Usage: node prism-parse-import.mjs <file1> [file2] ...');
    process.exit(1);
  }
  const allRaw = [];
  const perFile = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const label = path.basename(f);
    try {
      let rows, raw;
      if (ext === '.xlsx') {
        rows = await parseXlsxFile(f);
        raw = rowsToRaw(rows, label);
      } else if (ext === '.xls') {
        const buf = fs.readFileSync(f);
        if (!isHtmlXls(buf)) throw new Error(`${label}：.xls 非 HTML 格式，無法解析`);
        rows = parseHtmlXlsRows(buf.toString('utf8'));
        raw = isMasterlinkFormat(rows) ? masterlinkRowsToRaw(rows, label) : rowsToRaw(rows, label);
      } else {
        rows = parseCsvFile(f);
        raw = rowsToRaw(rows, label);
      }
      allRaw.push(...raw);
      perFile.push({ file: label, legs: raw.length });
    } catch (e) {
      console.error(`[${label}] 解析失敗：${e.message}`);
      process.exit(2);
    }
  }
  const paired = pairFIFO(allRaw);
  // 序列化時把空字串轉 null（API 比較友善）
  for (const t of paired) for (const k of Object.keys(t)) if (t[k] === '') t[k] = null;
  const summary = {
    files: perFile,
    rawLegs: allRaw.length,
    paired: paired.length,
    closed: paired.filter(t => t.status === 'closed').length,
    open: paired.filter(t => t.status === 'open').length,
    byMarket: paired.reduce((a, t) => (a[t.market] = (a[t.market]||0)+1, a), {}),
    byType: paired.reduce((a, t) => (a[t.type] = (a[t.type]||0)+1, a), {}),
  };
  process.stdout.write(JSON.stringify({ summary, trades: paired }, null, 2));
}

main().catch(e => { console.error(e); process.exit(99); });
