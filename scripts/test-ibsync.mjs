// js/ibsync.js 解析邏輯單元測試（node scripts/test-ibsync.mjs）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'ibsync.js'), 'utf8');
const win = {};
const docStub = { createElement: () => ({}), querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {}, body: { appendChild: () => {} } };
new Function('window', 'document', 'localStorage', src)(win, docStub, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const { _parseFlexTrades, _parseFlexError } = win.PrismIBSync;

// ── 測試 1：典型 Activity Flex（股票 + 期貨 + 選擇權 + 取消單 + ORDER 彙總列） ──
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="prism" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U1234567" fromDate="20260511" toDate="20260610">
<Trades>
<Trade accountId="U1234567" assetCategory="STK" symbol="NVDA" description="NVIDIA CORP" conid="4815747" currency="USD" tradeDate="20260601" tradeTime="093015" buySell="BUY" quantity="100" tradePrice="185.5" ibCommission="-1" taxes="0" multiplier="1" levelOfDetail="EXECUTION" tradeID="111" />
<Trade accountId="U1234567" assetCategory="STK" symbol="NVDA" description="NVIDIA CORP" conid="4815747" currency="USD" dateTime="20260605;103000" buySell="SELL" quantity="-100" tradePrice="192.25" ibCommission="-1.02" taxes="0.05" multiplier="1" levelOfDetail="EXECUTION" tradeID="112" />
<Trade accountId="U1234567" assetCategory="FUT" symbol="MESM6" description="MICRO E-MINI S&amp;P 500" underlyingSymbol="MES" currency="USD" tradeDate="2026-06-08" tradeTime="22:15:00" buySell="BUY" quantity="2" tradePrice="6850.25" ibCommission="-1.24" multiplier="5" expiry="20260619" levelOfDetail="EXECUTION" tradeID="113" />
<Trade accountId="U1234567" assetCategory="FUT" symbol="CLN6" description="CRUDE OIL" underlyingSymbol="CL" currency="USD" tradeDate="20260609" tradeTime="030000" buySell="SELL" quantity="-1" tradePrice="71.3" ibCommission="-2.4" multiplier="1000" expiry="20260620" levelOfDetail="EXECUTION" tradeID="114" />
<Trade accountId="U1234567" assetCategory="OPT" symbol="NVDA 260620C00200000" description="NVDA 20JUN26 200 C" currency="USD" tradeDate="20260603" tradeTime="100001" buySell="BUY" quantity="1" tradePrice="5.2" ibCommission="-0.65" multiplier="100" expiry="20260620" strike="200" putCall="C" levelOfDetail="EXECUTION" tradeID="115" />
<Trade accountId="U1234567" assetCategory="STK" symbol="AAPL" buySell="BUY (Ca.)" quantity="10" tradePrice="200" tradeDate="20260601" levelOfDetail="EXECUTION" tradeID="116" />
<Trade accountId="U1234567" assetCategory="STK" symbol="NVDA" buySell="BUY" quantity="100" tradePrice="185.5" tradeDate="20260601" levelOfDetail="ORDER" tradeID="117" />
<Trade accountId="U1234567" assetCategory="CASH" symbol="USD.TWD" buySell="BUY" quantity="10000" tradePrice="31.2" tradeDate="20260601" levelOfDetail="EXECUTION" tradeID="118" />
</Trades>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>`;

const { legs, skipped } = _parseFlexTrades(FIXTURE);
assert.equal(legs.length, 5, `應有 5 筆合法成交，實得 ${legs.length}`);
assert.equal(skipped, 2, `應略過 2 筆（取消單+CASH），實得 ${skipped}`); // ORDER 列為 continue 不計 skipped

const [nvdaBuy, nvdaSell, mes, cl, opt] = legs;
assert.equal(nvdaBuy.symbol, 'NVDA');
assert.equal(nvdaBuy.date, '2026-06-01');
assert.equal(nvdaBuy.direction, 'long');
assert.equal(nvdaBuy.quantity, 100);
assert.equal(nvdaBuy.entryPrice, 185.5);
assert.equal(nvdaBuy.fee, 1);
assert.equal(nvdaBuy.type, 'stock');
assert.equal(nvdaBuy.market, 'us');
assert.equal(nvdaBuy.account, 'IB');
assert.match(nvdaBuy.notes, /時間 09:30:15/);

assert.equal(nvdaSell.date, '2026-06-05');       // dateTime 分號格式
assert.equal(nvdaSell.direction, 'short');
assert.equal(nvdaSell.quantity, 100);             // 負數取絕對值
assert.match(nvdaSell.notes, /時間 10:30:00/);
assert.equal(nvdaSell.tax, 0.05);

assert.equal(mes.type, 'index_futures');          // MES → 指數期貨
assert.equal(mes.contractMul, 5);
assert.equal(mes.date, '2026-06-08');             // 含 dash 的日期
assert.match(mes.notes, /到期 20260619/);

assert.equal(cl.type, 'commodity_futures');       // CL → 原物料期貨
assert.equal(cl.contractMul, 1000);
assert.equal(cl.direction, 'short');

assert.equal(opt.type, 'options');
assert.equal(opt.contractMul, 100);
assert.match(opt.notes, /履約價 200/);
assert.match(opt.notes, /到期 20260620/);

// ── 測試 2：錯誤回應解析 ──
const ERR = `<FlexStatementResponse timestamp="11 June, 2026 04:10 PM EDT"><Status>Fail</Status><ErrorCode>1012</ErrorCode><ErrorMessage>Token has expired.</ErrorMessage></FlexStatementResponse>`;
const err = _parseFlexError(ERR);
assert.equal(err.code, '1012');
assert.match(err.msg, /expired/);
assert.equal(_parseFlexError(FIXTURE), null);

// ── 測試 3：產生中回應（1019） ──
const PENDING = `<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress. Please try again shortly.</ErrorMessage></FlexStatementResponse>`;
assert.equal(_parseFlexError(PENDING).code, '1019');

console.log('✓ ibsync 解析測試全數通過（5 legs、錯誤碼、輪詢碼）');
