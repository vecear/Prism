# Prism

一站式交易風險管理 PWA — 支援台股、美股、加密貨幣的股票融資融券、期貨、選擇權、合約風險計算，搭配即時行情、交易日誌、跨裝置同步。

🌐 **Live**: [prism-7t8.pages.dev](https://prism-7t8.pages.dev)

## 功能特色

### 風險計算

- **股票融資融券** — 台灣（現股/融資/融券）+ 美國（Cash/Margin Long/Short）；維持率、追繳線、斷頭線；含完整費用（手續費、證交稅、融資利息、借券費）
- **期貨** — 台灣（大台/小台/微台/電子/金融/股票期貨）+ 美國（E-mini / Micro E-mini S&P/Nasdaq/Dow）；即時抓 TAIFEX 保證金；風險指標 RI%、追繳/砍倉價位
- **選擇權** — 買方/賣方雙向；台指選擇權 + SPX/SPY Options；最大損失、保證金壓力分析
- **加密貨幣** — Spot 現貨 + Perpetual 合約；做多/做空雙向；強平價、保證金率

### 即時行情

- 12 個指數/幣種：加權指數、台指期、S&P 期貨、那指期貨、道瓊期貨、費半、日經期貨、KOSPI、上證、恆生、BTC、ETH、SOL
- 多資料來源：TWSE、Yahoo Finance、Finnhub、Binance
- 內建 CORS Proxy 解決跨域問題
- 一鍵帶入行情到計算表單

### 台股產業地圖

- **熱力圖總覽** — Finviz 式 squarified treemap：14 個產業分區、市值加權（平方根縮放）、漲跌幅著色，一眼看出資金流向
- **14 條產業鏈（四層樹狀 + 主題分頁）** — AI 伺服器、半導體、被動元件、光通訊/CPO、PCB/載板、網通、散熱、電動車、機器人、重電/綠能、生技醫療、金融、航運、軍工/航太；上中下游 → 環節 → 細分子環節 → 個股（252 檔，代號經 TWSE/TPEx 官方清單驗證），每層附產業說明、每檔個股附該環節角色說明。AI 伺服器鏈再分 9 個主題分頁深入：晶片記憶體、先進封裝測試、電源電力、散熱、機構連接線纜、PCB 板材、整機組裝、網路光通訊、資料中心雲服務
- **即時報價疊加** — TWSE MIS 批次查詢，產業加權漲跌、領漲領跌即時計算；離線仍可瀏覽產業鏈結構
- **個股資訊卡** — 開高低收量、估算市值、產業鏈位置、同環節競爭對手；一鍵帶入交易日誌/股票計算機，外連 Goodinfo/TradingView

### 交易日誌

- 完整 CRUD + 5 種視圖：列表、日曆、統計、庫存、日記
- 統計面板：權益曲線、勝率、獲利因子、期望值、最大回撤、R-Multiple 分佈、虧損後行為分析、星期/時段熱圖
- 每日交易日記：心情評分、紀律/時機/部位三軸覆盤
- 標籤、帳戶、星級評價、截圖 URL
- **CSV 匯出**：含已實現損益與 R 倍數欄位，可直接在 Excel 做系統分析
- **券商檔案匯入**：支援元大台股 CSV、元富 HTML-XLS、群益期貨 XLSX 自動 FIFO 配對
- **IB 自動同步**：接入 Interactive Brokers Flex Web Service，一鍵拉回美股/期貨/選擇權成交（自動 FIFO 配對、重複跳過；token 唯讀且僅存本機瀏覽器）

### 風險管理系統（Van Tharp）

依《交易·創造自己的聖盃》、Qullamaggie 動能策略、KP FOMOSoc 出場框架打造的紀律工具組：

- **系統品質 SQN** — `√(min(N,100)) × 平均R ÷ R標準差` + 期望實現報酬（expectunity）+ 系統評級（平均/良好/優秀/超級/聖盃）
- **部位規模計算機** — 固定風險百分比模型（部位 = 帳戶 × 風險% ÷ 每單位風險）+ 破產風險表，可一鍵套用到新交易
- **投組風險預算監控** — 持倉初始風險 vs 帳戶資金、風險預算使用率、裸部位（無停損）警示
- **連敗熔斷提醒** — 連續虧損達門檻時警示縮小部位或暫停
- **戰情 Cockpit** — 系統品質 / 開倉風險 / 紀律狀態三支柱跨視圖常駐列
- **交易論點 + 出場決策 4 問** — 論點式停損；出場前依序自問論點/邊際/結構/現金測試
- **風險/品質語意色**採固定色（藍/琥珀/橘），不隨「紅漲綠跌」模式翻轉

### 設計系統

- **Liquid Glass 液態玻璃**：全站玻璃面板（半透明 + backdrop blur + 漸層 mesh 背景），可於設定**開關**並以滑桿調整**透明度 0~90%**（調高時 blur/飽和度自動加重，近似 iPhone 全透流動玻璃）；關閉時退回實底，適合省電與低階裝置
- **6 種主題**：暖米白 (paper)、奶油象牙 (ivory)、緊湊紙感 (paperDense)、經典深色 (dark)、午夜藍 (midnight)、翡翠綠 (emerald) — 各主題有專屬玻璃色溫與 mesh 配色
- **統一按鈕系統**：40+ 按鈕 class 共用玻璃基底與五種變體（Primary / Danger / Pill chip / Segmented / Ghost），hover、focus ring、disabled 行為一致
- **紅綠雙模式**：綠漲紅跌 / 紅漲綠跌（台股慣例）即時切換
- **完整 Design Tokens**：spacing/text/radius/duration/control-height scale，theme-aware shadows + glass tokens
- **PWA**：可安裝至主畫面、離線可用 (Service Worker)
- **RWD**：桌面/平板/手機全裝置優化

## 架構

Prism 同時支援兩種部署模式：

| 模式 | 用途 | Backend | DB |
|------|------|---------|-----|
| **本機單機 (local-only)** | 個人離線使用、無需登入 | `node server.js` (Node.js + node:sqlite) | `prism.db` 本機檔案 |
| **雲端多使用者 (cloud)** | Cloudflare Pages + 跨裝置同步 | `_worker.js` (Cloudflare Workers) | Cloudflare D1 |

### 檔案結構

```
Prism/
├── index.html                       # 主頁面結構，所有 tab 的 HTML 骨架
├── css/style.css                    # 全域樣式 + design tokens + 6 主題 + Liquid Glass (~4,800 行)
├── js/
│   ├── ml.js                        # ML 工具：K-Means、Spectral Clustering、Z-score
│   ├── app.js                       # 計算引擎、即時報價、設定、Guide、Regime 偵測 (~7,600 行)
│   └── journal.js                   # 交易日誌、Van Tharp 風險工具、modal、CSV 匯入 UI (~5,100 行)
├── server.js                        # Local-only Node 伺服器 (使用 node:sqlite)
├── _worker.js                       # Cloudflare Pages Worker (API 路由、認證、CORS proxy、DB 遷移)
├── sw.js                            # Service Worker (stale-while-revalidate)
├── schema.sql                       # D1 schema 參考文件
├── manifest.json                    # PWA manifest
├── favicon.svg                      # 三稜鏡 SVG icon
├── wrangler.toml                    # Cloudflare 設定 (D1 binding + 選用 RATE_LIMIT_KV)
├── _headers                         # Cloudflare Pages 安全標頭 (HTML 頁面 CSP/HSTS 等)
├── scripts/
│   └── prism-parse-import.mjs       # 券商交易檔解析器 (元大/元富/群益)
└── start.bat                        # Windows 一鍵啟動 local-only 模式
```

### 前端

- **純 Vanilla**：HTML + CSS + Vanilla JavaScript，無框架、無建置工具
- **即時計算**：表單輸入即時觸發計算，無送出按鈕
- **Design Token 系統**：所有 spacing / typography / radius / shadows 透過 CSS variables 統一管理，6 種主題自動切換

### 後端

雲端模式（`_worker.js`）：
- Cloudflare Pages Advanced Mode 處理 API 路由 + 靜態資源
- D1 SQLite 自動遷移（v1 ~ v13；v12 = 平倉日歸期、v13 = 交易論點欄位）
- JWT (HMAC-SHA256, 7d) + PBKDF2 (600,000 iterations，版本化格式、舊雜湊向後相容) 雜湊
- Rate Limiting（選用 KV 跨實例）、CORS 白名單、輸入驗證
- 安全標頭與 CSP：API 回應由 `_worker.js` 套用，HTML 頁面由 `_headers` 套用（含 `frame-ancestors`/`base-uri`/`form-action` 與 Permissions-Policy）

本機模式（`server.js`）：
- Node.js 24+ 內建 `node:sqlite`，無需 npm install 額外 deps
- 單一使用者、無認證、所有資料留在本機
- HTML 與 sw.js 強制 `Cache-Control: no-cache`，確保更新立刻生效

### 資料來源

| 來源 | 用途 | 金鑰 |
|------|------|------|
| TWSE 證交所 | 台灣上市即時報價 | 免費 |
| TPEX 櫃買中心 | 台灣上櫃即時報價 | 免費 |
| Yahoo Finance | 全球指數與個股（透過代理） | 免費 |
| Finnhub | 美股即時報價 | 免費 API Key |
| Binance | 加密貨幣即時報價 | 免費 |
| TAIFEX 期交所 | 期貨保證金即時查詢 | 免費 |
| FRED 聯準會 | 信用利差 / 通膨預期（Regime 偵測） | 免費 API Key |

## 開發

### 環境需求

- Node.js 18+（local-only 模式需 24+ 因要 `node:sqlite`）
- Wrangler CLI（透過 devDependency 自動安裝）

### 安裝

```bash
git clone https://github.com/vecear/Prism.git
cd Prism
npm install
```

### 執行模式

```bash
# 本機單機模式（推薦個人使用，無需登入、資料留本機）
npm start
# → http://localhost:3000，自動開瀏覽器，按 Ctrl+C 結束

# 雲端模式本地模擬（含 D1 + Workers）
npm run dev
# → http://localhost:3000，綁定 D1 本地資料庫

# 部署到 Cloudflare Pages
npm run deploy
```

### 環境變數（雲端模式才需要）

| 變數 | 說明 | 設定位置 |
|------|------|---------|
| `JWT_SECRET` | JWT 簽名密鑰 | Cloudflare Pages → Settings → Environment Variables |
| `FRED_API_KEY` | FRED 經濟數據金鑰（信用利差/通膨預期；缺則該來源回 503） | Cloudflare Pages 環境變數 / 本機 `.env` |
| `RATE_LIMIT_KV`（選用） | KV namespace 綁定，啟用跨實例認證限流；未綁定自動退回 in-memory | `wrangler.toml` `[[kv_namespaces]]` |

### 券商檔案匯入

把券商交易報表放到 `import/` 資料夾後，在 Claude Code 內執行 `/imp` slash command。支援：

- 元大證券台股 CSV (Big5 編碼)
- 元富證券 HTML 偽裝為 .xls 的投資明細
- 群益期貨 XLSX 沖銷報表
- 其他使用相似欄位名稱的券商報表

腳本：`scripts/prism-parse-import.mjs <files...>` — FIFO 自動配對 buy/sell legs，輸出可匯入 API 的 trades JSON。

## API 路由（雲端模式）

| 方法 | 路徑 | 用途 |
|------|------|------|
| POST | `/api/auth/register` | 註冊 |
| POST | `/api/auth/login` | 登入 |
| GET | `/api/auth/me` | 驗證 token |
| GET / POST / PUT / DELETE | `/api/trades[/:id]` | 交易紀錄 CRUD |
| GET / PUT | `/api/settings` | 使用者設定 |
| GET / PUT | `/api/presets` | 商品預設值 |
| GET / PUT | `/api/templates` | 交易範本 |
| GET / PUT | `/api/app-state` | 計算器狀態 |
| GET / PUT | `/api/daily-journal` | 每日日記 |
| GET | `/api/proxy?url=` | CORS 代理（白名單） |
| GET | `/api/fred?series=` | FRED 經濟數據代理（信用利差/通膨預期） |

## 資料庫 Schema

| 資料表 | 用途 |
|--------|------|
| `users` | 使用者帳號（username + PBKDF2 hash）|
| `trades` | 交易紀錄（含停損/停利、評分、覆盤三軸、定價階段、平倉日、交易論點 thesis、標籤、帳戶、截圖 URL）|
| `daily_journal` | 每日交易日記 |
| `user_settings` | 使用者設定 |
| `presets` | 商品預設值（乘數、保證金）|
| `templates` | 交易範本 |
| `app_state` | 計算器狀態 |

## 免責聲明

本工具僅供學習與參考，實際交易規則、保證金、費率以各券商及期貨商公告為準。投資有風險，使用者應自行評估並承擔交易決策之責任。

## License

MIT
