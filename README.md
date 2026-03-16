# Prism

一站式交易風險管理工具，支援台灣、美國與加密貨幣市場的股票融資融券、期貨、選擇權、合約風險計算，搭配即時行情、交易日誌與跨裝置同步。

## 功能特色

### 股票融資融券

- 支援台灣（現股/融資/融券）與美國（Cash/Margin Long/Short）市場
- 個股、指數 ETF、槓桿 ETF 三種產品類型
- 即時計算維持率、追繳線、斷頭線
- 完整費用計算（手續費、證交稅、融資利息、借券費）
- 壓力測試：模擬不同價格下的風險狀態
- 券商處置流程說明（追繳通知、強制平倉時間點）
- 每筆計算皆附完整公式展開，顯示每個變數的實際數值

### 期貨

- 台灣期貨：大台、小台、微台、電子、金融、股票期貨
- 美國期貨：E-mini / Micro E-mini S&P 500、Nasdaq 100、Dow Jones
- 即時抓取期交所（TAIFEX）最新保證金資料
- 原始保證金、維持保證金、每點價值自動帶入
- 手續費與期交稅計算
- 自訂初始權益數（1x ~ 5x 保證金快捷按鈕）
- 風險指標（RI%）與追繳 / 砍倉價位計算

### 選擇權

- 買方（Buyer）與賣方（Seller）風險計算
- 台灣（台指選擇權）與美國（SPX / SPY Options）市場
- 手續費與交易稅整合
- 買方最大損失、賣方保證金壓力分析
- 到期損益與 Greeks 參考

### 加密貨幣

- 現貨（Spot）買入成本與損益計算
- 合約（Perpetual）槓桿風險分析
- 做多 / 做空雙向支援
- 強平價格、保證金率計算

### 即時行情

- 12 個指數/幣種即時報價：加權指數、台指期、S&P 期貨、那指期貨、道瓊期貨、費半、日經期貨、KOSPI、上證、恆生、BTC、ETH、SOL
- 多資料來源架構（TWSE、Yahoo Finance、Finnhub、Binance）
- 自建 CORS Proxy 避免跨域問題
- 可在設定中自訂顯示哪些指數
- 一鍵帶入行情到計算表單

### 交易日誌

- 完整交易紀錄 CRUD（建立、查看、編輯、刪除）
- 三種視圖模式：列表、日曆、統計
- 每日交易日記：心情、盤面筆記、交易計畫、檢討、重點收穫
- 交易評分系統：紀律、時機、部位大小（Process vs Outcome 分析）
- 星級評價（1-5 星）
- 標籤分類與帳戶管理
- 篩選、排序、搜尋
- 截圖 URL 紀錄
- 跨裝置同步（登入後自動同步至雲端）

### 跨裝置同步

登入帳號後，以下資料自動同步至所有裝置：

- 交易紀錄與每日日記
- 應用程式設定（報價來源、顯示偏好等）
- 商品預設值（乘數、保證金）
- 交易範本
- 計算器狀態

### 設定

點擊右上角齒輪按鈕可調整：

- **報價來源**：台灣市場（TWSE / Yahoo）、美國市場（Yahoo / Finnhub）、加密貨幣（Binance）
- **顯示指數**：勾選要在行情列顯示的指數
- **自動取報價**：開啟頁面時自動抓取最新行情
- **字體大小**：5 段縮放（XS ~ XL）
- **主題**：Dark、Light、Midnight Blue、Emerald、Warm
- **色彩模式**：綠升紅跌 / 紅升綠跌
- **價格小數位**：可按市場與商品類型分別設定

## 技術架構

```
Prism/
├── index.html          # 主頁面結構（294 行）
├── css/
│   └── style.css       # RWD 樣式，5 種主題（1,493 行）
├── js/
│   ├── app.js          # 主應用邏輯：計算引擎、報價服務、UI 渲染（5,741 行）
│   └── journal.js      # 交易日誌模組：CRUD、視圖、統計（3,457 行）
├── _worker.js          # Cloudflare Pages Worker：API 路由（584 行）
├── sw.js               # Service Worker：離線快取
├── schema.sql          # D1 資料庫 Schema 參考
├── manifest.json       # PWA manifest
├── favicon.svg         # SVG favicon（三稜鏡圖示）
├── wrangler.toml       # Cloudflare 設定
└── package.json        # wrangler devDependency
```

### 前端

- **純前端**：HTML + CSS + Vanilla JavaScript，無框架、無建置工具
- **即時計算**：表單輸入即時觸發計算，無需按送出按鈕
- **響應式設計**：支援桌面、平板、手機瀏覽
- **PWA**：可安裝至主畫面，離線可用（Service Worker stale-while-revalidate）
- **多主題**：5 種色彩主題 + 紅升/綠升色彩模式，透過 CSS 變數切換

### 後端

- **Cloudflare Pages Advanced Mode**：`_worker.js` 處理 API 路由 + 靜態資源
- **Cloudflare D1**：SQLite 資料庫，自動遷移（v1 ~ v11）
- **認證**：JWT (HMAC-SHA256, 7 天過期) + PBKDF2 (100,000 次迭代) 密碼雜湊
- **安全**：常數時間密碼比對、Rate Limiting、CORS 白名單、Proxy 主機白名單、輸入驗證

### 資料來源

| 來源 | 用途 | 金鑰需求 |
|------|------|----------|
| TWSE 證交所 | 台灣上市即時報價 | 免費 |
| TPEX 櫃買中心 | 台灣上櫃即時報價 | 免費 |
| Yahoo Finance | 全球指數與個股（透過代理） | 免費 |
| Finnhub | 美股即時報價 | 免費 API Key |
| Binance | 加密貨幣即時報價 | 免費 |
| TAIFEX 期交所 | 期貨保證金即時查詢 | 免費 |

### 資料庫 Schema

| 資料表 | 用途 |
|--------|------|
| `users` | 使用者帳號（username + PBKDF2 hash） |
| `trades` | 交易紀錄（含評分、標籤、帳戶、截圖 URL） |
| `daily_journal` | 每日交易日記（心情、紀律、重點收穫） |
| `user_settings` | 使用者設定 |
| `presets` | 商品預設值（乘數、保證金） |
| `templates` | 交易範本 |
| `app_state` | 計算器狀態 |

### API 路由

| 方法 | 路徑 | 用途 |
|------|------|------|
| POST | `/api/auth/register` | 註冊 |
| POST | `/api/auth/login` | 登入 |
| GET | `/api/auth/me` | 驗證 token |
| GET | `/api/trades` | 取得所有交易紀錄 |
| POST | `/api/trades` | 建立交易紀錄 |
| PUT | `/api/trades/:id` | 更新交易紀錄 |
| DELETE | `/api/trades/:id` | 刪除交易紀錄 |
| GET / PUT | `/api/settings` | 使用者設定 |
| GET / PUT | `/api/presets` | 商品預設值 |
| GET / PUT | `/api/templates` | 交易範本 |
| GET / PUT | `/api/app-state` | 計算器狀態 |
| GET / PUT | `/api/daily-journal` | 每日日記 |
| GET | `/api/proxy?url=` | CORS 代理（白名單制） |
| POST | `/api/migrate-trades` | 交易類型一次性遷移 |

## 開發

### 環境需求

- Node.js 18+
- Wrangler CLI（透過 devDependency 安裝）

### 本地開發

```bash
npm install
npm run dev
# 啟動在 http://localhost:3000，自動綁定 D1 本地資料庫
```

### 部署

```bash
npm run deploy
# 部署至 Cloudflare Pages (prism-7t8.pages.dev)
```

### 環境變數

| 變數 | 說明 | 必要 |
|------|------|------|
| `JWT_SECRET` | JWT 簽名密鑰 | 是（Cloudflare Pages Environment Variables 設定） |

### D1 資料庫

- Binding 名稱：`DB`
- Database name：`prism-db`
- 自動遷移：Worker 首次收到 API 請求時自動建表與升級（v1 ~ v11）

## 免責聲明

本工具僅供學習與參考用途，實際交易規則、保證金、費率以各券商及期貨商公告為準。投資有風險，使用者應自行評估並承擔交易決策之責任。

## License

MIT
