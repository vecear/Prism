---
description: 自動掃描券商交易紀錄資料夾並匯入 Prism 系統（支援元大 CSV / 群益 xlsx / FIFO 配對）
argument-hint: [檔案路徑1 檔案路徑2 ...]
---

# 匯入交易紀錄到 Prism

## 執行步驟

### 1. 決定要匯入的檔案

若 `$ARGUMENTS` 有提供檔案路徑，則直接使用。

**若沒有提供任何引數**，則自動掃描資料夾：
- 匯入來源：`G:\我的雲端硬碟\prism-record\import`
- 列出其中所有 `.csv`、`.xlsx`、`.xls` 檔案
- 若資料夾為空或不存在，回報並停止

### 2. 驗證檔案存在

逐一確認每個要處理的檔案路徑存在；若不存在，直接回報並停止。

### 3. 解析 + FIFO 配對

執行 `node scripts/prism-parse-import.mjs <檔案路徑...>`，把 stdout 存成暫存檔（例如 `C:/Users/wseu/AppData/Local/Temp/prism-import-<timestamp>.json`）。

輸出內容為：
```json
{
  "summary": { "files": [...], "rawLegs": N, "paired": N, "closed": N, "open": N, "byMarket": {...}, "byType": {...} },
  "trades": [ ... ]
}
```

### 4. 與使用者確認

把 `summary` 列出來給使用者看，包含：
- 每個檔案解析出多少筆單腿
- 配對後總筆數（closed + open）
- 按市場 / 類型分布
- 前 3 筆樣本（date, symbol, direction, entry, exit, qty）

詢問是否要匯入。**若使用者沒明確說「確定/繼續/匯入」就停下，不要自己執行。**

### 5. 檢查既有重複（可選）

若使用者同意匯入，用 Playwright MCP：
- 開啟 `http://localhost:3000`（本機伺服器，無需登入）
- `browser_evaluate` 取現有 trades 做去重 key（`date|symbol|entryPrice|quantity`）
- 告知使用者有多少筆會被視為重複而跳過

### 6. 執行匯入

- 讀暫存 JSON 的 `trades` 陣列
- 在 `browser_evaluate` 裡逐筆 `fetch('/api/trades', { method: 'POST', ... })`（本機模式不需要 Bearer token）
- 回報成功/失敗數與剩餘線上總筆數

### 7. 移動已處理檔案

匯入成功後，把來源檔從 `import` 資料夾移動到 `G:\我的雲端硬碟\prism-record\processed`：
- 使用 PowerShell：`Move-Item -Path "<來源>" -Destination "G:\我的雲端硬碟\prism-record\processed\" -Force`
- 每個檔案移動成功後回報
- 若 `processed` 資料夾不存在，先用 `New-Item -ItemType Directory` 建立

### 8. 期貨合約乘數後處理

匯入後，把 `type === 'index_futures'` 但 `contractMul` 為空或錯誤的交易，依商品代號自動套：

| 符號 | contractMul |
|------|-------------|
| TXF / TX | 200 |
| MXF / MTX | 50 |
| FITM / TMF | 10（微台）|
| EXF | 200 |
| FXF | 4000 |

`scripts/prism-parse-import.mjs` 已經有 `FUTURES_MUL` 查表，匯入時會自動填；但若有查不到的商品代號，請詢問使用者正確乘數後再補上。

### 9. 股票分割 / 股利提醒

匯入完成後，提示使用者：「若某檔股票近期有分割/股利配發，記得提供詳細資訊（比例、除權息日）由我協助調整。」

## 安全規範

- **絕不** 在沒明確確認下刪除使用者線上資料
- 若解析結果有異常（負價、超大數量、未知代號），先回報不要硬塞
- 匯入失敗時完整回報錯誤內容，不要吞錯誤
- 暫存 JSON 存到 `Temp/` 而非 repo 目錄，避免意外 commit
- 只有在**全部匯入成功**後才移動檔案（失敗的檔案留在 import 資料夾）

## 輸出格式

最後一次性回報：
```
✅ 匯入完成
- 來源檔：<files>
- 配對後：<N> 筆 (<closed> closed + <open> open)
- 匯入成功：<N> 筆，跳過重複 <N>，失敗 <N>
- 線上總筆數：<N>
- 已移至 processed：<files>
```
