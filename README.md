# 🚂 火車搖晃程度紀錄系統

> 以行動裝置感測器即時收集火車行駛搖晃數據、GPS 軌跡與速度，並在地圖上以熱力圖呈現，供鐵路工程分析使用。

---

## 📸 功能概覽

| 功能 | 說明 |
|------|------|
| **即時紀錄** | 加速度感測器（DeviceMotion）+ GPS，每秒採樣，搖晃等級 1–5 |
| **雙軸波形圖** | 即時顯示搖晃指數與速度趨勢，地下路段自動顯示折線斷開 |
| **分批即時上傳** | 每 30 秒或累積 30 筆自動批次上傳，防止網路中斷造成資料遺失 |
| **熱力圖地圖** | Leaflet + leaflet.heat，依搖晃等級疊加顏色，行程可加備註 |
| **跨行程分析** | 多行程合併、50m 網格 IQR 統計、PDF 列印、Excel 匯出 |

---

## 🏗️ 專案架構

採用 **pnpm monorepo** 管理，分為應用程式（`artifacts/`）與共用套件（`lib/`）兩層。

```
.
├── artifacts/
│   ├── train-shake/          # 前端 React SPA（手機瀏覽器使用）
│   └── api-server/           # 後端 Express API
└── lib/
    ├── api-spec/             # OpenAPI 3.1.0 規範 + orval codegen 設定
    ├── api-client-react/     # 前端用 React Query hooks（orval 自動生成）
    ├── api-zod/              # 後端用 Zod schema（orval 自動生成）
    └── db/                   # Drizzle ORM 資料庫層（SQLite）
```

---

## 🛠️ 技術棧

### 前端（`artifacts/train-shake`）

| 分類 | 套件 |
|------|------|
| 框架 | React 19 + Vite |
| 路由 | Wouter |
| 樣式 | Tailwind CSS v4 + Radix UI |
| 地圖 | Leaflet + leaflet.heat（熱力圖） |
| 圖表 | Chart.js（雙Y軸波形圖）|
| API 通訊 | TanStack Query + orval 生成的 hooks |

### 後端（`artifacts/api-server`）

| 分類 | 套件 |
|------|------|
| 框架 | Express 5 |
| 資料庫 | SQLite + better-sqlite3 + Drizzle ORM |
| 驗證 | Zod（orval 自動生成 schema） |
| 日誌 | Pino |
| 匯出 | ExcelJS（Excel）、PDFKit（PDF） |

---

## 🚀 快速開始

### 環境需求

- Node.js 20+
- pnpm 9+

### 安裝與啟動

```bash
# 安裝所有套件
pnpm install

# 生成 API 型別與 Zod schema（首次執行或修改 openapi.yaml 後必須執行）
pnpm --filter @workspace/api-spec run codegen

# 啟動後端（http://localhost:8080）
pnpm --filter @workspace/api-server run dev

# 另開終端，啟動前端（http://localhost:PORT/train-shake）
pnpm --filter @workspace/train-shake run dev
```

---

## 📱 使用方式

### 1. 開始紀錄行程

1. 以手機瀏覽器開啟應用程式
2. iOS Safari 使用者點擊「請求感測器權限」
3. 等待 GPS 定位完成後，點擊「開始紀錄」
4. 搭乘火車，系統自動每秒記錄搖晃程度與 GPS 位置
5. 抵達目的地後點擊「結束紀錄」，資料自動上傳並跳轉至地圖

### 2. 分批即時上傳機制

為防止行程結束時網路不穩造成全部資料遺失，系統採用分批上傳策略：

- **每 30 秒**或**累積 30 筆**資料時，自動批次上傳
- 上傳失敗時保留資料，下次自動重試，頁面顯示延遲警告
- 結束行程時若仍有未上傳資料，系統停留在頁面並顯示「重新嘗試上傳」按鈕

### 3. 地下路段自動處理

GPS 訊號中斷超過 10 秒時，系統自動：
- 暫停紀錄（不寫入無效座標）
- 波形圖以折線斷開呈現中斷期間
- 頁面顯示「訊號中斷，暫停紀錄中」提示
- GPS 恢復後自動繼續

---

## 🗺️ 頁面說明

| 路由 | 頁面 | 功能 |
|------|------|------|
| `/` | 首頁 | 導覽至各功能 |
| `/record` | 紀錄行程 | 即時感測、波形圖、分批上傳 |
| `/map` | 歷史紀錄 | 行程選擇、Leaflet 熱力圖、備註編輯 |
| `/cumulative` | 累積分析 | 多行程合併 50m 網格分析、PDF / Excel 匯出 |

---

## 🔌 API 端點

所有端點掛載於 `/api` 路徑。

### 行程管理

| 方法 | 路徑 | 說明 |
|------|------|------|
| `POST` | `/api/trip/start` | 建立新行程，回傳 `trip_id` |
| `POST` | `/api/trip/:id/append` | 分批寫入搖晃紀錄點 |
| `PATCH` | `/api/trip/:id/finish` | 標記行程結束時間 |
| `GET` | `/api/trips` | 取得所有行程摘要列表 |
| `GET` | `/api/trip/:id` | 取得特定行程詳細資料與所有點位 |
| `PATCH` | `/api/trip/:id/note` | 更新行程備註 |
| `POST` | `/api/upload` | 一次性上傳完整行程（舊版相容） |

### 分析

| 方法 | 路徑 | 說明 |
|------|------|------|
| `POST` | `/api/cumulative-analysis` | 跨行程 50m 網格 IQR 統計分析 |
| `POST` | `/api/export/excel` | 匯出分析結果為 Excel |

### 其他

| 方法 | 路徑 | 說明 |
|------|------|------|
| `GET` | `/api/healthz` | 健康檢查 |

---

## 🗄️ 資料庫結構

SQLite 資料庫位於 `artifacts/api-server/data/shake.db`。

```sql
-- 行程表
trips (
  id TEXT PRIMARY KEY,        -- UUID
  device_id TEXT,             -- 裝置識別碼
  start_time TEXT,            -- 開始時間（ISO 8601）
  end_time TEXT,              -- 結束時間（ISO 8601，結束後寫入）
  note TEXT                   -- 使用者備註
)

-- 搖晃紀錄表
records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT,               -- 關聯 trips.id
  lat REAL,                   -- 緯度
  lng REAL,                   -- 經度
  timestamp TEXT,             -- 採樣時間（ISO 8601）
  x_accel REAL,               -- X 軸加速度（m/s²）
  z_accel REAL,               -- Z 軸加速度（m/s²）
  shake_index REAL,           -- 綜合搖晃指數（低通濾波後）
  shake_level INTEGER,        -- 搖晃等級 1–5
  speed_kmh REAL,             -- 速度（km/h）
  speed_estimated INTEGER     -- 是否為 Haversine 推算速度
)
```

---

## 🔧 開發工具

### 修改 API 後重新生成型別

```bash
# 修改 lib/api-spec/openapi.yaml 後執行
pnpm --filter @workspace/api-spec run codegen
```

> **注意**：orval v8 在 split mode 下每次執行會追加 workspace 層級的 `index.ts`。
> 本專案已加入 `postcodegen.mjs` 腳本自動修正此問題，無需手動介入。

### 型別檢查

```bash
# 前端
pnpm --filter @workspace/train-shake run typecheck

# 後端
pnpm --filter @workspace/api-server run typecheck

# 共用套件（api-zod、api-client-react）
pnpm -w run typecheck:libs
```

---

## 📊 搖晃等級定義

| 等級 | 顏色 | 搖晃指數範圍 | 描述 |
|------|------|-------------|------|
| 1 | 🟢 綠色 | < 0.5 | 平穩 |
| 2 | 🟡 黃綠 | 0.5 – 1.0 | 輕微搖晃 |
| 3 | 🟡 黃色 | 1.0 – 2.0 | 中度搖晃 |
| 4 | 🟠 橘色 | 2.0 – 4.0 | 明顯搖晃 |
| 5 | 🔴 紅色 | ≥ 4.0 | 劇烈搖晃 |

搖晃指數由 `DeviceMotion` 事件的 `acceleration`（X、Z 軸）經**低通濾波**後合成，以排除單次衝擊噪音，反映持續性搖晃程度。

---

## 📄 授權

MIT License
