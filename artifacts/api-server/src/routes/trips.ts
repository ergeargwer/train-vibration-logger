/**
 * 火車搖晃紀錄 API 路由
 *
 * POST /upload       — 上傳行程完整資料
 * GET  /trips        — 取得所有行程列表
 * GET  /trip/:trip_id — 取得指定行程詳細資料
 */
import { Router } from "express";
import { db } from "../lib/db.js";
import {
  UploadTripBody,
  GetTripRecordsParams,
} from "@workspace/api-zod";

const router = Router();

/**
 * POST /api/upload
 * 接收一次行程的完整資料陣列，寫入資料庫
 *
 * speed_estimated 欄位說明：
 *   false（前端傳入 false）→ 感測器直接取得的速度，寫入 0
 *   true（前端傳入 true）  → Haversine 公式推算的速度，寫入 1
 *   SQLite 以 INTEGER 0/1 儲存布林值
 */
router.post("/upload", (req, res) => {
  const parseResult = UploadTripBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "資料格式錯誤：" + parseResult.error.message });
    return;
  }

  const { device_id, trip_id, note, records } = parseResult.data;

  if (records.length === 0) {
    res.status(400).json({ error: "資料陣列不得為空" });
    return;
  }

  // 依時間戳記排序，取得行程開始與結束時間
  const timestamps = records.map((r) => r.timestamp).sort();
  const start_time = timestamps[0];
  const end_time = timestamps[timestamps.length - 1];

  // 使用交易確保原子性寫入
  const insertTrip = db.transaction(() => {
    // 寫入或更新行程主表
    db.prepare(`
      INSERT INTO trips (trip_id, device_id, start_time, end_time, note)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(trip_id) DO UPDATE SET
        end_time = excluded.end_time,
        note = COALESCE(excluded.note, trips.note)
    `).run(trip_id, device_id, start_time, end_time, note ?? null);

    // 批次寫入逐筆紀錄
    const insertRecord = db.prepare(`
      INSERT INTO records
        (trip_id, lat, lng, timestamp, x_accel, z_accel, shake_level, shake_index,
         speed_kmh, speed_estimated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const r of records) {
      insertRecord.run(
        trip_id,
        r.lat,
        r.lng,
        r.timestamp,
        r.x_accel,
        r.z_accel,
        r.shake_level,
        r.shake_index,
        r.speed_kmh,
        r.speed_estimated ? 1 : 0,   // SQLite 以 INTEGER 儲存布林值
      );
    }

    return records.length;
  });

  try {
    const count = insertTrip();
    res.status(201).json({ success: true, trip_id, count });
  } catch (err) {
    req.log.error({ err }, "寫入行程資料失敗");
    res.status(500).json({ error: "伺服器內部錯誤" });
  }
});

/**
 * GET /api/trips
 * 取得所有行程列表（摘要資訊，含紀錄筆數）
 */
router.get("/trips", (_req, res) => {
  const trips = db
    .prepare(
      `
      SELECT
        t.trip_id,
        t.device_id,
        t.start_time,
        t.end_time,
        t.note,
        COUNT(r.id) AS record_count
      FROM trips t
      LEFT JOIN records r ON r.trip_id = t.trip_id
      GROUP BY t.trip_id
      ORDER BY t.start_time DESC
    `,
    )
    .all();

  res.json(trips);
});

/**
 * GET /api/trip/:trip_id
 * 取得指定行程的行程資訊與所有搖晃紀錄點
 * speed_estimated 從 SQLite INTEGER (0/1) 轉換回 boolean 後回傳
 */
router.get("/trip/:trip_id", (req, res) => {
  const parseResult = GetTripRecordsParams.safeParse(req.params);
  if (!parseResult.success) {
    res.status(400).json({ error: "路徑參數格式錯誤" });
    return;
  }

  const { trip_id } = parseResult.data;

  const trip = db
    .prepare(
      `
      SELECT
        t.trip_id,
        t.device_id,
        t.start_time,
        t.end_time,
        t.note,
        COUNT(r.id) AS record_count
      FROM trips t
      LEFT JOIN records r ON r.trip_id = t.trip_id
      WHERE t.trip_id = ?
      GROUP BY t.trip_id
    `,
    )
    .get(trip_id);

  if (!trip) {
    res.status(404).json({ error: "找不到該行程" });
    return;
  }

  const rawRecords = db
    .prepare(
      `
      SELECT
        id, trip_id, lat, lng, timestamp,
        x_accel, z_accel, shake_level, shake_index,
        speed_kmh, speed_estimated
      FROM records
      WHERE trip_id = ?
      ORDER BY timestamp ASC
    `,
    )
    .all(trip_id) as Array<Record<string, unknown>>;

  // 將 SQLite INTEGER 0/1 轉換回 JavaScript boolean
  const records = rawRecords.map((r) => ({
    ...r,
    speed_estimated: r.speed_estimated === 1,
  }));

  res.json({ trip, records });
});

export default router;
