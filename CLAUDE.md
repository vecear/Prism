# Prism Project Instructions

## Project Overview

Prism 是一站式交易風險管理 PWA，**同時支援雲端與本機單機兩種部署模式**。前端為純 Vanilla JS（無框架），雲端模式後端為 Cloudflare Pages Advanced Mode Worker + D1 資料庫，本機模式為 Node.js + node:sqlite。

## Tech Stack

- **Frontend**: HTML + CSS + Vanilla JavaScript (no framework, no build tool)
- **雲端 Backend**: Cloudflare Pages Advanced Mode (`_worker.js`) + D1 (SQLite)
- **本機 Backend**: Node.js 24+ with built-in `node:sqlite` (`server.js`)
- **Auth**: JWT (HMAC-SHA256) + PBKDF2 password hashing（雲端模式）/ 無認證（本機模式）
- **Deployment**: Cloudflare Pages (`prism-7t8.pages.dev`)
- **PWA**: Service Worker with stale-while-revalidate caching

## File Structure & Responsibilities

```
Prism/
├── index.html                        # 頁面結構，所有 tab 的 HTML 骨架
├── css/style.css                     # 全域樣式 + design tokens + 6 種主題
├── js/
│   ├── app.js                        # 主模組：計算引擎、PriceService、UI 渲染、設定面板、Guide
│   └── journal.js                    # 交易日誌：CRUD、5 視圖（list/calendar/stats/holdings/diary）、Auth UI
├── server.js                         # 本機單機 Node 伺服器（使用 node:sqlite）
├── _worker.js                        # Cloudflare Worker：API 路由、CORS proxy、DB 遷移
├── sw.js                             # Service Worker：離線快取策略
├── schema.sql                        # D1 Schema 參考文件（實際遷移在 _worker.js 中）
├── manifest.json                     # PWA manifest
├── favicon.svg                       # SVG favicon
├── wrangler.toml                     # Cloudflare 設定（D1 binding）
├── scripts/
│   └── prism-parse-import.mjs        # 券商交易檔解析器（元大/元富/群益）
└── start.bat                         # Windows 一鍵啟動 local-only 模式
```

### Key Code Locations

| 功能 | 檔案 | 說明 |
|------|------|------|
| 計算引擎（股票/期貨/選擇權/加密貨幣） | `js/app.js` | 各 tab 的 `renderXxxInputs()` + `calcXxx()` |
| 即時報價服務 | `js/app.js` → `PriceService` | 多來源架構，含 CORS proxy fallback |
| 指數定義 | `js/app.js` → `INDEX_DEFS` | 12 個指數/幣種的定義 |
| 設定面板 | `js/app.js` → `renderSettings()` | 報價來源、主題、字體、小數位等 |
| 交易日誌 UI | `js/journal.js` | IIFE 模組，獨立的 state 管理 |
| Modal 系統 | `js/journal.js` → `openTradeForm()` / `openTradeDetail()` | 共用 `#j-global-modal` + `#j-global-modal-overlay` |
| Auth（雲端） | `js/journal.js` → header auth UI | JWT token 存 localStorage |
| 雲端 API 路由 | `_worker.js` → `export default { fetch }` | 路由分發在底部 Router 區段 |
| 本機 API + 靜態服務 | `server.js` → `routeXxx()` + 靜態檔案 fallback | HTML/sw.js 強制 no-cache |
| DB 自動遷移（雲端） | `_worker.js` → `ensureDB()` | v1~v11 累積遷移 |
| 密碼雜湊/JWT | `_worker.js` | 內建實作 |
| 券商交易檔解析 | `scripts/prism-parse-import.mjs` | 元大 CSV / 元富 HTML-XLS / 群益 XLSX → FIFO 配對 |

## Development Commands

```bash
npm start        # 本機單機模式 (node server.js, port 3000)
npm run dev      # 雲端模式本地模擬 (wrangler pages dev . --port 3000 --d1 DB)
npm run deploy   # 部署到 Cloudflare Pages
```

## Architecture Rules

### No Build System
此專案刻意不使用打包工具（Webpack/Vite/Sass/PostCSS）。所有 JS/CSS 直接由瀏覽器載入。新增功能時直接編輯現有檔案，不要引入 build pipeline。

### No Framework
前端使用純 Vanilla JS + DOM 操作。不要引入 React/Vue/Svelte 等框架。保持原有的命令式 UI 渲染模式（`innerHTML` + 事件委派）。

### Dual Backend Support
任何 API/路由變更必須**同步**到 `_worker.js`（雲端）與 `server.js`（本機）。本機模式無認證、單使用者；雲端模式有 JWT + per-user 隔離。

### Single Worker File
`_worker.js` 是 Cloudflare Pages Advanced Mode 的唯一進入點。所有雲端 API handler 都寫在這個檔案裡。不使用 `/functions` 目錄。

### D1 Migration Pattern
新增資料表或欄位時，在 `_worker.js` 的 `ensureDB()` 函數中追加 `try { await db.prepare("ALTER TABLE...").run(); } catch {}` 區塊。使用遞增的 `// vN migration` 註解標記版本。**同時更新** `server.js` 的本地 schema。

### Design Token System (CSS Variables)
所有 UI 樣式必須使用 design tokens，**不要硬編碼數值**：

| Token 類別 | 用途 |
|-----------|------|
| `--bg0/1/2/3` | 背景階層 |
| `--t1/2/3` | 文字階層 |
| `--accent`、`--green`、`--red`、`--amber`、`--blue` | 語意色（含 `-soft`、`-bg`、`-d` 變體）|
| `--space-0..12` | Spacing scale (2/4/6/8/10/12/14/16/20/24/32/40/48 px) |
| `--text-xs..4xl` | Text size scale (10..28 px) |
| `--radius-sm/md/lg/xl/pill` | 圓角 (4/8/12/16/999 px) |
| `--ctrl-sm/md/lg/xl` | 控件高度 (28/32/36/42 px) |
| `--dur-fast/base/slow` | 動效 duration (0.1/0.15/0.25 s) |
| `--shadow-sm/md/lg/pill/card/elevated` | 陰影（card / elevated 為 theme-aware）|
| `--bg-hover`、`--border-focus`、`--text-disabled` | 語意 token |

**深色主題**（dark/midnight/emerald）需透過 cascade override 補上 `--shadow-card` / `--shadow-elevated` / `--shadow-inset-highlight` 的冷色版。

**禁止** 寫死 RGB 或 px 值（除非是極特殊情況有註解說明）。

### Theme System
6 種主題透過 `html[data-theme="xxx"]` 切換：

| theme value | 色調 |
|-------------|------|
| (default) | paper — 暖米白 + 橘咖啡 accent |
| `ivory` | 奶油象牙 |
| `paperDense` / `compact` | 緊湊紙感 |
| `dark` | 經典深色 |
| `midnight` | 午夜藍 |
| `emerald` | 翡翠綠 |

新增主題時：在 `:root` 之後新增 `html[data-theme="xxx"]` 區塊，**完整覆寫** 所有色彩 tokens 與必要 shadow tokens。

### Price Decimal Configuration
價格小數位可由使用者按市場/商品類型分別設定。格式化價格時使用 `fmtPrice(n, market, type)`（journal.js）或對應 `fmt`/`fP`/`fM` helper（app.js）。

## Coding Conventions

### JavaScript Style
- 使用 `const`/`let`，不使用 `var`
- 工具函數使用簡短命名：`$`(querySelector), `$$`(querySelectorAll), `fmt`, `fP`, `fM`, `gV`, `gVraw`
- XSS 防護：使用者輸入必須經過 `_esc()`（app.js）或 `esc()`（journal.js）處理後才能放入 innerHTML
- API 回應使用 `jsonRes(data, status)` / `jsonErr(status, message)` 輔助函數
- 前端 API 呼叫使用 `api(path, opts)` wrapper（journal.js）
- 設定物件存在 `localStorage` key `tg-settings`，全域透過 `CFG` 物件存取

### CSS Style
- 變數定義在 `:root`，各主題透過 `html[data-theme="xxx"]` 覆寫
- **優先使用 design tokens**（`var(--space-5)` 而不是 `padding: 12px`）
- 使用 BEM-like 命名（`.calc-layout`、`.input-panel`、`.toggle-btn`）
- Journal 區用 `.j-` 前綴；計算器用 `.calc-` 前綴；設定用 `.stg-` 前綴
- 響應式斷點透過 `@media` query
- **避免 `!important`**，遇到 specificity 衝突先思考 selector 層級而非加 important
- Modal 用 `position: fixed; top:50%; left:50%; transform: translate(-50%,-50%)` 居中（不依賴 flex parent）

### Error Messages
面向使用者的錯誤訊息使用繁體中文。console.log/error 使用 `[Prism]` 或 `[Journal]` 前綴。

## UI Design Principles

當重新設計或調整 UI 時，必須遵循以下優先順序：

1. **整潔、節省空間** — 用最少的像素傳達最多資訊。偏好 inline strip / pill 式佈局，避免佔據大面積的 card box
2. **一目了然** — 關鍵數值、狀態用顏色語義（綠/紅/黃/橙）即時傳達，不需要額外閱讀
3. **美觀清晰** — 保持視覺層次分明（label 小而淡、value 大而醒目），善用 monospace 字體 + `font-variant-numeric: tabular-nums` 對齊數值
4. **不犧牲功能** — 壓縮空間時保留所有互動功能（tooltip 詳細資訊、點擊連結、拖拽排序等）
5. **同時優化桌面與行動裝置** — 每次 UI 變更都必須處理 RWD（見下方 RWD 強制規範）
6. **Theme-resilient** — 任何 shadow / 邊框 / 光澤效果必須使用 theme-aware tokens（`--shadow-card` / `--line-strong`），**不可硬編碼 rgba**

常用的緊湊 UI 模式：
- **Toolbar card**：相關工具列用單一 card 包覆 + hairline divider 分組（參考 `.j-toolbar` + `.j-tb-row`）
- **Inline stats strip**：水平捲動列，用 `·` 或 token 分隔（參考 `.j-stats-strip`）
- **Pill badge**：`標籤 數值 狀態tag` 組合成 inline-flex 元素
- **隱藏 scrollbar 的水平捲動**：`overflow-x:auto; scrollbar-width:none`

## RWD 強制規範（MANDATORY）

**每一次頁面變更都必須同時考慮行動裝置的 RWD 優化。** 這不是可選的，而是所有 UI 工作的強制要求。

### 斷點定義
| 斷點 | 寬度 | 目標裝置 |
|------|------|----------|
| 桌面 | > 1024px | 桌上型電腦、大螢幕筆電 |
| 平板 | 768px ~ 1024px | iPad、平板 |
| 手機 | 420px ~ 768px | 一般手機 |
| 小螢幕手機 | < 420px | iPhone SE、小螢幕 Android |

### 每次 UI 變更必須檢查
- [ ] **768px 斷點**：佈局是否需要從多欄切換為單欄或堆疊
- [ ] **420px 斷點**：字體、間距、元素大小是否需要進一步縮小
- [ ] **水平溢出**：沒有任何元素超出螢幕寬度
- [ ] **固定寬度**：所有 `width:Npx` 元素都必須有 `max-width:100%` 或在行動斷點中覆寫
- [ ] **最小字體**：行動裝置上可讀內容不低於 `0.6rem`（9.6px），輔助標籤不低於 `0.48rem`（7.7px）
- [ ] **觸控目標**：按鈕和可點擊元素最小 `32px × 32px`（slider thumb 最小 22px + 4px focus ring）
- [ ] **表格處理**：超過 4 欄的表格需要 `overflow-x:auto` 容器，或在行動版切換為卡片列表
- [ ] **5 主題驗證**：用 Playwright 切換 paper/dark/midnight 三主題截圖比對

### 效能規範（適用所有裝置）
- **禁止** 常駐的 `animation: ... infinite`（loading 指示器除外）
- **禁止** 常駐的 `backdrop-filter:blur()`（modal overlay 除外）
- **禁止** 動畫中使用 `filter:blur()` 變化
- **禁止** `transition: all`，必須列明具體屬性
- **必須** 保留 `@media(prefers-reduced-motion:reduce)` 全域停用動畫
- hover 效果優先使用 `opacity` 或 `border-color`，避免 `box-shadow` + `transform` 同時 transition
- 按鈕 hover 統一使用 `opacity:.85`，不使用 `translateY` lift 效果

### 行動裝置常用模式
- 桌面多欄 grid → 行動版 `grid-template-columns:1fr`
- 桌面 flex 水平排列 → 行動版 `flex-wrap:wrap` 或 `flex-direction:column`
- 桌面表格 → 行動版卡片列表（`.j-table-wrap{display:none}` + `.j-card-list{display:flex}`）
- 超寬內容 → `overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none`
- 底部導航列需保留 `env(safe-area-inset-bottom)` 給瀏海手機

## Security Checklist

修改 `_worker.js` 時必須確認：

- [ ] 所有需要認證的路由都有 `await getUser(request, env)` 檢查
- [ ] 使用者只能存取自己的資料（`WHERE user_id = ?`）
- [ ] 輸入長度有上限（symbol 20 字、name 100 字、notes 5000 字等）
- [ ] JSON body 大小有上限
- [ ] SQL 使用參數化查詢（`db.prepare().bind()`）
- [ ] Proxy 只允許白名單 hostname（`PROXY_ALLOWED`）
- [ ] 不在錯誤訊息中洩漏敏感資訊
- [ ] Rate limiting 已套用（register 5/min, login 10/min）

## Environment Variables

| 變數 | 說明 | 設定位置 |
|------|------|----------|
| `JWT_SECRET` | JWT 簽名密鑰 | Cloudflare Pages → Settings → Environment Variables |

## CORS Configuration

允許的 origins 定義在 `_worker.js` → `corsHeaders()`：
- `https://prism-7t8.pages.dev`（production）
- `http://localhost:3000` / `http://localhost:8788`（dev）
- `http://127.0.0.1:3000` / `http://127.0.0.1:8788`（dev）

新增部署域名時需同步更新此白名單。

## Cache Strategy（重要）

修改 CSS 或 JS 後**必須**同步：

1. `index.html` 內 `<link href="css/style.css?v=YYYYMMDDx">` 與 `<script src="js/journal.js?v=...">` 的 query string
2. `sw.js` 中的 `CACHE_NAME` 版本號（例如 `prism-v59` → `prism-v60`）
3. `sw.js` 內 `STATIC_ASSETS` 陣列裡的 `?v=` 字串

**`server.js`（本機模式）已對 HTML 與 sw.js 強制 `Cache-Control: no-cache`**，所以本機開發 Ctrl+R 即可看到最新版本，但靜態資源（CSS/JS）仍依 query string 控制。

## Broker File Import

券商交易檔匯入工具：把檔案放到 `import/` 資料夾，在 Claude Code 內執行 `/imp` 指令。

腳本：`scripts/prism-parse-import.mjs <files...>` — 解析 + FIFO 配對 + 輸出 trades JSON。

支援格式：
- 元大證券台股 CSV (Big5 編碼，含小計列)
- 元大證券美股 CSV (Big5)
- 元富證券 HTML 偽裝為 .xls 的投資明細
- 群益期貨 XLSX 沖銷報表
- 其他使用相似欄位名稱（成交日期/代號/數量/單價/手續費/交易稅/買賣）的券商報表

## Context Hub (chub) Integration

此專案有安裝全域 `chub`（Context Hub）。與外部 API/SDK 互動時，使用 chub 取得正確文件：

```bash
chub search <query>        # 搜尋相關文件
chub get <id> --lang js    # 取得 JS 版文件
chub annotate <id> "note"  # 儲存學習筆記
```

**使用時機**：整合外部 API/SDK、不確定 API 用法、遇到可能因知識過時導致的錯誤。
**不使用時機**：標準 HTML/CSS/JS、專案內部程式碼、已有足夠上下文。

## Important Notes

- `js/app.js` 約 5,700 行，`js/journal.js` 約 3,500 行，`css/style.css` 約 3,800 行 — 讀取時需分段
- Auth token 存在 `localStorage` key `prism_token`，使用者資訊在 `prism_user_info`
- 前端在 `file://` 或 `localhost` 時自動將 API 導向 `https://prism-7t8.pages.dev`（雲端模式才有效；本機模式 server.js 直接服務 API）
- Service Worker 在 localhost 開發時自動取消註冊以避免快取問題
- DB 遷移是累積式的（v1~v11），雲端模式每次 API 請求都會執行 `ensureDB()`（結果有快取）
- 本機模式的 `prism.db` 使用 SQLite WAL 模式，實際資料在 `prism.db-wal`

## Changelog Protocol

當專案發生以下變更時，必須同步更新此 CLAUDE.md：
- 新增或移除檔案
- 修改技術架構（新增 build tool、framework、database 等）
- 修改 API 路由結構
- 修改認證/安全機制
- 修改部署流程
- 新增重要的 coding convention 或規則
- 修改環境變數或 Cloudflare 設定
- **新增 design tokens 或主題**
- **修改 cache 策略或 server response headers**
