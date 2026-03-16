# Prism Project Instructions

## Project Overview

Prism 是一站式交易風險管理 PWA，部署於 Cloudflare Pages。前端為純 Vanilla JS（無框架），後端為 Cloudflare Pages Advanced Mode Worker + D1 資料庫。

## Tech Stack

- **Frontend**: HTML + CSS + Vanilla JavaScript (no framework, no build tool)
- **Backend**: Cloudflare Pages Advanced Mode (`_worker.js`)
- **Database**: Cloudflare D1 (SQLite)
- **Auth**: JWT (HMAC-SHA256) + PBKDF2 password hashing
- **Deployment**: Cloudflare Pages (`prism-7t8.pages.dev`)
- **PWA**: Service Worker with stale-while-revalidate caching

## File Structure & Responsibilities

```
Prism/
├── index.html          # 頁面結構，所有 tab 的 HTML 骨架
├── css/style.css       # 全域樣式，5 種主題（CSS 變數切換）
├── js/
│   ├── app.js          # 主模組：計算引擎、PriceService、UI 渲染、設定面板、Guide
│   └── journal.js      # 交易日誌：CRUD、列表/日曆/統計視圖、每日日記、Auth UI
├── _worker.js          # Cloudflare Worker：所有 /api/* 路由、CORS proxy、DB 遷移
├── sw.js               # Service Worker：離線快取策略
├── schema.sql          # D1 Schema 參考文件（實際遷移在 _worker.js 中）
├── manifest.json       # PWA manifest
├── favicon.svg         # SVG favicon
└── wrangler.toml       # Cloudflare 設定（D1 binding）
```

### Key Code Locations

| 功能 | 檔案 | 說明 |
|------|------|------|
| 計算引擎（股票/期貨/選擇權/加密貨幣） | `js/app.js` | 各 tab 的 `renderXxxInputs()` + `calcXxx()` |
| 即時報價服務 | `js/app.js` → `PriceService` | 多來源架構，含 CORS proxy fallback |
| 指數定義 | `js/app.js` → `INDEX_DEFS` | 12 個指數/幣種的定義 |
| 設定面板 | `js/app.js` → `renderSettings()` | 報價來源、主題、字體、小數位等 |
| 交易日誌 UI | `js/journal.js` | IIFE 模組，獨立的 state 管理 |
| Auth（登入/註冊） | `js/journal.js` → header auth UI | JWT token 存 localStorage |
| API 路由 | `_worker.js` → `export default { fetch }` | 路由分發在底部 Router 區段 |
| DB 自動遷移 | `_worker.js` → `ensureDB()` | v1~v11 累積遷移 |
| 密碼雜湊/JWT | `_worker.js` | 內建實作（未使用外部套件） |

## Development Commands

```bash
npm run dev      # wrangler pages dev . --port 3000 --d1 DB
npm run deploy   # wrangler pages deploy .
```

## Architecture Rules

### No Build System
此專案刻意不使用打包工具（Webpack/Vite/etc）。所有 JS/CSS 直接由瀏覽器載入。新增功能時直接編輯現有檔案，不要引入 build pipeline。

### No Framework
前端使用純 Vanilla JS + DOM 操作。不要引入 React/Vue/Svelte 等框架。保持原有的命令式 UI 渲染模式（`innerHTML` + 事件委派）。

### Single Worker File
`_worker.js` 是 Cloudflare Pages Advanced Mode 的唯一進入點。所有 API handler 都寫在這個檔案裡。不使用 `/functions` 目錄。

### D1 Migration Pattern
新增資料表或欄位時，在 `_worker.js` 的 `ensureDB()` 函數中追加 `try { await db.prepare("ALTER TABLE...").run(); } catch {}` 區塊。使用遞增的 `// vN migration` 註解標記版本。

### CSS Variable Theming
所有顏色使用 CSS 變數（`--bg0`, `--t1`, `--accent`, `--green`, `--red` 等）。新增 UI 元素時必須使用這些變數，不要硬編碼顏色值。

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
- 使用 BEM-like 命名（`.calc-layout`, `.input-panel`, `.toggle-btn`）
- 響應式斷點透過 `@media` query

### Error Messages
面向使用者的錯誤訊息使用繁體中文。console.log/error 使用 `[Prism]` 或 `[Journal]` 前綴。

## UI Design Principles

當重新設計或調整 UI 時，必須遵循以下優先順序：

1. **整潔、節省空間** — 用最少的像素傳達最多資訊。偏好 inline strip / pill 式佈局，避免佔據大面積的 card box
2. **一目了然** — 關鍵數值、狀態用顏色語義（綠/紅/黃/橙）即時傳達，不需要額外閱讀
3. **美觀清晰** — 保持視覺層次分明（label 小而淡、value 大而醒目），善用 monospace 字體對齊數值
4. **不犧牲功能** — 壓縮空間時保留所有互動功能（tooltip 詳細資訊、點擊連結、拖拽排序等）
5. **同時優化桌面與行動裝置** — 每次 UI 變更都必須處理 RWD（見下方 RWD 強制規範）

常用的緊湊 UI 模式：
- **Inline stats strip**：一行式水平捲動列，用 `·` 或邊框分隔各指標（參考 `.j-stats-strip`、`.sentiment-strip`）
- **Pill badge**：`標籤 數值 狀態tag` 組合成一個 inline-flex 元素
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
- [ ] **水平溢出**：沒有任何元素超出螢幕寬度（檢查 `white-space:nowrap` 配合 `overflow-x:auto`）
- [ ] **固定寬度**：所有 `width:Npx` 元素都必須有 `max-width:100%` 或在行動斷點中覆寫
- [ ] **最小字體**：行動裝置上可讀內容不低於 `0.6rem`（9.6px），輔助標籤不低於 `0.48rem`（7.7px）
- [ ] **觸控目標**：按鈕和可點擊元素最小 `32px × 32px`
- [ ] **表格處理**：超過 4 欄的表格需要 `overflow-x:auto` 容器，或在行動版切換為卡片列表

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
- [ ] 使用者只能存取自己的資料（WHERE user_id = ?）
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

## Service Worker Cache

`sw.js` 中的 `CACHE_NAME` 版本號需要在每次部署靜態資源更新後遞增。同時更新 `index.html` 中 `<script src>` 和 `<link href>` 的 `?v=` query string。

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

- `js/app.js` 約 5,700 行，`js/journal.js` 約 3,500 行 — 讀取時需分段
- Auth token 存在 `localStorage` key `prism_token`，使用者資訊在 `prism_user_info`
- 前端在 `file://` 或 `localhost` 時自動將 API 導向 `https://prism-7t8.pages.dev`
- Service Worker 在 localhost 開發時自動取消註冊以避免快取問題
- DB 遷移是累積式的（v1~v11），每次 API 請求都會執行 `ensureDB()`（結果有快取）

## Changelog Protocol

當專案發生以下變更時，必須同步更新此 CLAUDE.md：
- 新增或移除檔案
- 修改技術架構（新增 build tool、framework、database 等）
- 修改 API 路由結構
- 修改認證/安全機制
- 修改部署流程
- 新增重要的 coding convention 或規則
- 修改環境變數或 Cloudflare 設定
