# 台股產業地圖專區 — 設計文件

日期：2026-06-11
狀態：已核准（使用者於對話中核准「核准，開始實作」）

## 目標

在 Prism 新增「產業地圖」主 tab，提供專業投資人等級的台股產業鏈視覺化：
1. **熱力圖總覽**（Finviz 式 squarified treemap，市值加權、漲跌著色）
2. **單一產業鏈視圖**（上游→中游→下游，細分環節 + 代表個股 + 即時報價）
3. **個股資訊卡**（即時價、產業鏈位置、同環節競爭對手、帶入日誌/計算機、外部連結）

## 決策紀錄

| 決策 | 選擇 |
|------|------|
| 呈現形式 | 產業鏈圖 + 熱力圖 |
| 資料來源 | 內建靜態產業鏈資料庫 + TWSE MIS 即時報價疊加 |
| 涵蓋範圍 | 深度重點產業 14 條鏈 |
| 個股互動 | 資訊卡 modal + 帶入交易日誌 + 帶入股票計算機 |

## 架構

### 新檔案
- `js/industry-data.js` — 純靜態資料：`window.PrismIndustryData`。14 條產業鏈 × 上中下游 stages × 細分環節 groups × 個股（代號/名稱/上市櫃別/約當流通股數億股）。
- `js/industry.js` — IIFE 模組 `window.PrismIndustry`：tab 啟用 hook、報價批次抓取（TWSE MIS `ex_ch=tse_xxxx.tw|otc_xxxx.tw` 每批 50 檔、60s 記憶體快取）、treemap 演算法（自寫 squarified）、產業鏈渲染、個股資訊卡。

### 修改檔案
- `index.html`：sidebar +「產業地圖」、`#tab-industry` section、手機 more-sheet 項目、script 標籤、`?v=` bump。
- `js/app.js`：`TAB_META` 加 industry 項；tab click 與 restore 各加一行 activation hook。
- `js/journal.js`：加一行 `window.openTradeFormPrefill`（newTrade() + 覆寫欄位後開表單）。
- `css/style.css`：`.ind-` 前綴樣式，全 design tokens；新按鈕 class 納入統一按鈕基底群組；`@supports not (backdrop-filter)` fallback 同步。
- `sw.js`：CACHE_NAME +1、STATIC_ASSETS 加入新檔。

### 不變
- 後端零變更（報價走現有 `/api/proxy`，`mis.twse.com.tw` 已在白名單）；雲端/本機雙模式同時生效。

## 資料結構

```js
window.PrismIndustryData = {
  updated: '2026-06',
  industries: [{
    id: 'semi', name: '半導體', icon: '<svg…>', desc: '一句話產業簡介',
    stages: [{
      name: '上游', groups: [{
        name: 'IP / 設計服務', note: '矽智財與 ASIC 委託設計',
        stocks: [{ s:'3661', n:'世芯-KY', ex:'tse', sh:0.75 }, …]
      }, …]
    }, { name:'中游', … }, { name:'下游', … }]
  }, …]
}
```

- `sh` = 約當流通股數（億股，估算值，用於 treemap 市值加權 = sh × 即時價）。UI 註明「市值為估算」。
- 14 條鏈：半導體、AI 伺服器、被動元件、光通訊/CPO、PCB/載板、網通、散熱、電動車/車用電子、機器人/自動化、重電/綠能、生技醫療、金融、航運、軍工/航太。

## 報價策略

- 只在切入 industry tab 時抓取；`Map` 快取 TTL 60 秒。
- 批次：所有產業個股代號去重 → 每批 50 檔 MIS 查詢，依序送出避免 rate limit。
- 失敗降級：顯示產業鏈結構但無漲跌（chip 灰色「—」），頂部顯示重試按鈕。

## UI 規範遵循

- 面板級玻璃表面（`--glass-bg` + blur），treemap 方塊與個股 chip 禁用 backdrop-filter。
- 漲跌色用 `.tg`/`.tr`（隨紅漲綠跌設定翻轉）；treemap 著色用 `--green/--red` CSS 變數混色（同樣會被 colorMode 對調）。
- 數值 monospace + tabular-nums。
- RWD：>1024 三欄供應鏈；≤768 垂直堆疊、treemap 高度縮減；≤420 字級再降。
- 6 主題不需逐一新增 token —— 全部使用既有 tokens。

## 測試計畫

1. `node --check` 全部 JS。
2. Playwright（本機 `npm start`）：
   - 切入產業地圖 tab → treemap 渲染（方塊數 > 0）
   - 切換產業 pill → 供應鏈三欄渲染
   - 點個股 → 資訊卡開啟 → 「帶入交易日誌」開啟交易表單且代號正確
   - 「帶入股票計算機」→ margin tab `#m-symbol` 填入
   - paper / dark / midnight 三主題截圖
   - 768px / 420px 斷點截圖（無水平溢出）
