// 驗證 js/industry-data.js 內所有股票代號與簡稱是否與官方資料一致
// 用法：node scripts/validate-industry-data.mjs
// 資料來源：TWSE openapi（上市）+ TPEx openapi（上櫃）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 載入 industry-data.js（IIFE 寫入 window）
const src = readFileSync(join(root, 'js', 'industry-data.js'), 'utf8');
const sandbox = { window: {} };
new Function('window', src)(sandbox.window);
const data = sandbox.window.PrismIndustryData;
if (!data) { console.error('無法載入 PrismIndustryData'); process.exit(1); }

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

const official = new Map(); // code -> { name, board }
try {
  const twse = await fetchJson('https://openapi.twse.com.tw/v1/opendata/t187ap03_L');
  for (const row of twse) official.set(row['公司代號'], { name: row['公司簡稱'], board: '上市' });
  console.log(`TWSE 上市 ${twse.length} 筆`);
} catch (e) { console.error('TWSE 抓取失敗:', e.message); }
try {
  const tpex = await fetchJson('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O');
  for (const row of tpex) official.set(row['SecuritiesCompanyCode'] || row['公司代號'], { name: row['CompanyAbbreviation'] || row['公司簡稱'], board: '上櫃' });
  console.log(`TPEx 上櫃 ${tpex.length} 筆`);
} catch (e) { console.error('TPEx 抓取失敗:', e.message); }

if (!official.size) { console.error('官方清單為空，中止'); process.exit(1); }

let total = 0, bad = 0, dup = new Map(), noDesc = 0;
function checkList(indName, path, stocks) {
  for (const stock of stocks || []) {
    total++;
    dup.set(stock.s, (dup.get(stock.s) || 0) + 1);
    if (!stock.d) { noDesc++; console.log(`… [${indName}/${path}] ${stock.s} ${stock.n} — 缺 d 說明`); }
    const off = official.get(stock.s);
    if (!off) {
      bad++;
      console.log(`✗ [${indName}/${path}] ${stock.s} ${stock.n} — 官方清單查無此代號`);
    } else if (off.name.replace(/[\s*]/g, '').replace(/-創$/, '') !== stock.n.replace(/[\s*]/g, '').replace(/-創$/, '')) {
      bad++;
      console.log(`△ [${indName}/${path}] ${stock.s} 名稱不符：資料=${stock.n} 官方=${off.name}（${off.board}）`);
    }
  }
}
for (const ind of data.industries) {
  // 產業可為直接 stages，或含 tabs（分頁，各自有 stages）
  const stageSets = ind.tabs ? ind.tabs.map(t => ({ prefix: t.name, stages: t.stages })) : [{ prefix: '', stages: ind.stages }];
  for (const set of stageSets) {
    for (const st of set.stages) {
      for (const g of st.groups) {
        const path = set.prefix ? `${set.prefix}/${g.name}` : g.name;
        checkList(ind.name, path, g.stocks);
        for (const sub of g.subs || []) checkList(ind.name, `${path}/${sub.name}`, sub.stocks);
      }
    }
  }
}
if (noDesc) console.log(`（${noDesc} 筆缺 d 說明）`);
const uniq = dup.size;
console.log(`\n共 ${total} 筆（去重 ${uniq} 檔），問題 ${bad} 筆`);
process.exit(bad ? 2 : 0);
