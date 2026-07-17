/**
 * 累積分析 API 路由
 *
 * POST /cumulative-analysis — 跨行程網格化累積搖晃分析
 * POST /export/excel         — 匯出 Excel 報告（含行程清單與搖晃排行）
 */
import { Router } from "express";
import ExcelJS from "exceljs";
import { db } from "../lib/db.js";

const router = Router();

/**
 * 網格大小（度數）
 * 台灣位於北緯約 25°，此處以 0.00045° 約換算為 50 公尺
 * 若需調整網格解析度，修改此常數即可
 */
const GRID_DEGREES = 0.00045;

/**
 * 網格最低樣本數門檻
 * 低於此筆數的網格視為「樣本不足」，直接取平均值，不套用 IQR 離群值過濾
 */
const MIN_GRID_SAMPLES = 5;

type RawRecord = { lat: number; lng: number; shake_index: number };

type GridCell = {
  lat: number;
  lng: number;
  shake_index: number;
  count: number;
  insufficient_samples: boolean;
};

/**
 * IQR 離群值過濾
 * 依四分位距排除落在「中位數 ± 1.5 倍 IQR」範圍外的值
 * 若過濾後結果為空（例如所有值都相同），回傳原始陣列
 */
function removeOutliers(values: number[]): number[] {
  if (values.length < 4) return values;

  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;

  const filtered = values.filter((v) => v >= lower && v <= upper);
  return filtered.length > 0 ? filtered : values;
}

/**
 * 網格化累積分析核心函式
 *
 * 演算法：
 *   1. 依 (floor(lat / GRID_DEGREES), floor(lng / GRID_DEGREES)) 將紀錄分配至網格
 *   2. 每個網格若累積筆數達 MIN_GRID_SAMPLES：
 *      a. 排序搖晃指數，計算 Q1、Q3、IQR
 *      b. 過濾落在 [Q1 - 1.5*IQR, Q3 + 1.5*IQR] 外的離群值
 *      c. 計算過濾後的平均值作為代表性搖晃指數
 *   3. 筆數不足時直接取平均值，並標記 insufficient_samples = true
 *   4. 代表座標取網格內所有紀錄的平均經緯度
 */
function computeGridAnalysis(records: RawRecord[]): GridCell[] {
  type CellData = { lats: number[]; lngs: number[]; shakeValues: number[] };
  const gridMap = new Map<string, CellData>();

  for (const r of records) {
    const gridRow = Math.floor(r.lat / GRID_DEGREES);
    const gridCol = Math.floor(r.lng / GRID_DEGREES);
    const key = `${gridRow},${gridCol}`;

    if (!gridMap.has(key)) {
      gridMap.set(key, { lats: [], lngs: [], shakeValues: [] });
    }
    const cell = gridMap.get(key)!;
    cell.lats.push(r.lat);
    cell.lngs.push(r.lng);
    cell.shakeValues.push(r.shake_index);
  }

  const result: GridCell[] = [];

  for (const cell of gridMap.values()) {
    const count = cell.shakeValues.length;
    const insufficientSamples = count < MIN_GRID_SAMPLES;

    let representativeShake: number;
    if (insufficientSamples) {
      representativeShake =
        cell.shakeValues.reduce((s, v) => s + v, 0) / count;
    } else {
      const filtered = removeOutliers(cell.shakeValues);
      representativeShake = filtered.reduce((s, v) => s + v, 0) / filtered.length;
    }

    const centerLat = cell.lats.reduce((s, v) => s + v, 0) / count;
    const centerLng = cell.lngs.reduce((s, v) => s + v, 0) / count;

    result.push({
      lat: centerLat,
      lng: centerLng,
      shake_index: representativeShake,
      count,
      insufficient_samples: insufficientSamples,
    });
  }

  return result;
}

/**
 * POST /api/cumulative-analysis
 * 接收行程識別碼清單，跨行程合併紀錄後進行網格化分析
 *
 * 請求本體：{ trip_ids: string[] }
 * 回應：{ grids: GridCell[] }
 */
router.post("/cumulative-analysis", (req, res) => {
  const { trip_ids } = req.body;

  if (
    !Array.isArray(trip_ids) ||
    trip_ids.length === 0 ||
    !trip_ids.every((id) => typeof id === "string")
  ) {
    res.status(400).json({ error: "trip_ids 必須為非空字串陣列" });
    return;
  }

  const placeholders = trip_ids.map(() => "?").join(", ");

  const records = db
    .prepare(
      `SELECT lat, lng, shake_index
       FROM records
       WHERE trip_id IN (${placeholders})`,
    )
    .all(...trip_ids) as RawRecord[];

  if (records.length === 0) {
    res.json({ grids: [] });
    return;
  }

  const grids = computeGridAnalysis(records);
  res.json({ grids });
});

/**
 * POST /api/export/excel
 * 產生 Excel 報告並以附件形式回傳
 *
 * 報告包含兩個工作表：
 *   1. 行程清單 — 本次分析納入的所有行程基本資料
 *   2. 搖晃排行 — 依代表性搖晃指數由高至低排序，最多列出 20 個最嚴重網格
 *
 * 請求本體：{ trip_ids: string[] }
 */
router.post("/export/excel", async (req, res) => {
  const { trip_ids } = req.body;

  if (
    !Array.isArray(trip_ids) ||
    trip_ids.length === 0 ||
    !trip_ids.every((id) => typeof id === "string")
  ) {
    res.status(400).json({ error: "trip_ids 必須為非空字串陣列" });
    return;
  }

  const placeholders = trip_ids.map(() => "?").join(", ");

  // 查詢行程基本資料
  const trips = db
    .prepare(
      `SELECT trip_id, device_id, start_time, end_time, note,
              (SELECT COUNT(*) FROM records r WHERE r.trip_id = t.trip_id) AS record_count
       FROM trips t
       WHERE trip_id IN (${placeholders})
       ORDER BY start_time ASC`,
    )
    .all(...trip_ids) as Array<{
    trip_id: string;
    start_time: string;
    end_time: string;
    note: string | null;
    record_count: number;
  }>;

  // 查詢紀錄資料進行網格分析
  const records = db
    .prepare(
      `SELECT lat, lng, shake_index
       FROM records
       WHERE trip_id IN (${placeholders})`,
    )
    .all(...trip_ids) as RawRecord[];

  const grids = computeGridAnalysis(records);

  // 依搖晃指數由高到低排序，取前 20 個最嚴重網格
  const top20 = [...grids]
    .sort((a, b) => b.shake_index - a.shake_index)
    .slice(0, 20);

  // --- 產生 Excel 工作簿 ---
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "火車搖晃紀錄系統";
  workbook.created = new Date();

  // 工作表一：行程清單
  const tripSheet = workbook.addWorksheet("行程清單");
  tripSheet.columns = [
    { header: "行程識別碼", key: "trip_id", width: 40 },
    { header: "開始時間", key: "start_time", width: 22 },
    { header: "結束時間", key: "end_time", width: 22 },
    { header: "資料筆數", key: "record_count", width: 10 },
    { header: "備註", key: "note", width: 32 },
  ];
  // 標題列加粗
  tripSheet.getRow(1).font = { bold: true };
  for (const trip of trips) {
    tripSheet.addRow({
      trip_id: trip.trip_id,
      start_time: trip.start_time,
      end_time: trip.end_time,
      record_count: trip.record_count,
      note: trip.note ?? "",
    });
  }

  // 工作表二：搖晃排行（前 20 名）
  const rankSheet = workbook.addWorksheet("搖晃排行");
  rankSheet.columns = [
    { header: "排名", key: "rank", width: 6 },
    { header: "緯度", key: "lat", width: 14 },
    { header: "經度", key: "lng", width: 14 },
    { header: "代表性搖晃指數", key: "shake_index", width: 18 },
    { header: "累積筆數", key: "count", width: 10 },
    { header: "樣本不足", key: "insufficient", width: 10 },
  ];
  rankSheet.getRow(1).font = { bold: true };
  top20.forEach((grid, i) => {
    rankSheet.addRow({
      rank: i + 1,
      lat: grid.lat.toFixed(6),
      lng: grid.lng.toFixed(6),
      shake_index: grid.shake_index.toFixed(4),
      count: grid.count,
      insufficient: grid.insufficient_samples ? "是" : "否",
    });
  });

  // 回傳 Excel 二進位內容
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    "attachment; filename*=UTF-8''shake-analysis.xlsx",
  );
  res.send(buffer);
});

export default router;
