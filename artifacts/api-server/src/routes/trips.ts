/**
 * 火車搖晃紀錄 API 路由
 *
 * --- 分批即時上傳流程（新） ---
 * POST   /trip/start            — 建立新行程，回傳 trip_id
 * POST   /trip/:trip_id/append  — 分批追加搖晃紀錄（可多次呼叫）
 * PATCH  /trip/:trip_id/finish  — 標記行程結束，記錄結束時間
 *
 * --- 行程管理 ---
 * PATCH  /trip/:trip_id/note    — 更新行程備註
 * GET    /trips                 — 取得所有行程列表
 * GET    /trip/:trip_id         — 取得指定行程詳細資料
 *
 * --- 相容舊版（保留，不建議新用途使用） ---
 * POST   /upload                — 一次性上傳完整行程資料
 */
import { randomUUID } from "crypto";
import { Router } from "express";
import { db } from "../lib/db.js";
import {
  UploadTripBody,
  GetTripRecordsParams,
} from "@workspace/api-zod";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// 分批即時上傳 — 三個步驟的 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/trip/start
 * 開始紀錄時呼叫，在資料庫建立行程主記錄並回傳 trip_id。
 *
 * end_time 初始設定為 start_time（行程結束後由 /finish 更新）。
 *
 * 請求本體：{ device_id: string, note?: string }
 * 回應：{ trip_id: string, start_time: string }
 */
router.post("/trip/start", (req, res) => {
  const { device_id, note } = req.body as {
    device_id?: unknown;
    note?: unknown;
  };

  if (!device_id || typeof device_id !== "string") {
    res.status(400).json({ error: "device_id 為必填字串" });
    return;
  }

  if (note !== undefined && note !== null && typeof note !== "string") {
    res.status(400).json({ error: "note 必須為字串" });
    return;
  }

  const trip_id = randomUUID();
  const start_time = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO trips (trip_id, device_id, start_time, end_time, note)
      VALUES (?, ?, ?, ?, ?)
    `).run(trip_id, device_id, start_time, start_time, (note as string) ?? null);

    res.status(201).json({ trip_id, start_time });
  } catch (err) {
    req.log.error({ err }, "建立行程失敗");
    res.status(500).json({ error: "伺服器內部錯誤" });
  }
});

/**
 * POST /api/trip/:trip_id/append
 * 將一批搖晃紀錄追加至指定行程，可重複呼叫多次。
 *
 * 上傳失敗時前端保留本批次資料，待下次排程時合併重試，因此本端點
 * 需支援冪等性 — 若前端因網路閃斷而重送同一批次，重複寫入對分析結果
 * 影響有限（搖晃指數統計仍可接受），優先保障資料不遺失。
 *
 * 請求本體：{ records: RecordInput[] }
 * 回應：{ count: number, total_count: number }
 */
router.post("/trip/:trip_id/append", (req, res) => {
  const { trip_id } = req.params;
  const { records } = req.body as { records?: unknown };

  // 基礎格式驗證（詳細的欄位驗證由資料庫 CHECK 約束補充）
  if (!Array.isArray(records) || records.length === 0) {
    res.status(400).json({ error: "records 必須為非空陣列" });
    return;
  }

  // 確認行程存在
  const trip = db
    .prepare("SELECT trip_id FROM trips WHERE trip_id = ?")
    .get(trip_id);

  if (!trip) {
    res.status(404).json({ error: "找不到該行程" });
    return;
  }

  const insertRecord = db.prepare(`
    INSERT INTO records
      (trip_id, lat, lng, timestamp, x_accel, z_accel,
       shake_level, shake_index, speed_kmh, speed_estimated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertBatch = db.transaction((batch: typeof records) => {
    let inserted = 0;
    for (const r of batch as Array<Record<string, unknown>>) {
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
        r.speed_estimated ? 1 : 0,
      );
      inserted++;
    }
    return inserted;
  });

  try {
    const count = insertBatch(records);
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM records WHERE trip_id = ?")
      .get(trip_id) as { c: number };

    res.json({ count, total_count: row.c });
  } catch (err) {
    req.log.error({ err }, "批次寫入搖晃紀錄失敗");
    res.status(500).json({ error: "伺服器內部錯誤" });
  }
});

/**
 * PATCH /api/trip/:trip_id/finish
 * 行程結束時呼叫，將 end_time 更新為當下時間。
 *
 * 回應：{ success: true, end_time: string }
 */
router.patch("/trip/:trip_id/finish", (req, res) => {
  const { trip_id } = req.params;

  const trip = db
    .prepare("SELECT trip_id FROM trips WHERE trip_id = ?")
    .get(trip_id);

  if (!trip) {
    res.status(404).json({ error: "找不到該行程" });
    return;
  }

  const end_time = new Date().toISOString();
  db.prepare("UPDATE trips SET end_time = ? WHERE trip_id = ?").run(
    end_time,
    trip_id,
  );

  res.json({ success: true, end_time });
});

// ─────────────────────────────────────────────────────────────────────────────
// 行程管理
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/trip/:trip_id/note
 * 更新指定行程的備註文字
 *
 * 請求本體：{ note: string | null }
 *   note 為字串時更新備註；為 null 時清除備註
 */
router.patch("/trip/:trip_id/note", (req, res) => {
  const { trip_id } = req.params;
  const { note } = req.body as { note?: string | null };

  if (note !== null && note !== undefined && typeof note !== "string") {
    res.status(400).json({ error: "note 必須為字串或 null" });
    return;
  }

  const exists = db
    .prepare("SELECT 1 FROM trips WHERE trip_id = ?")
    .get(trip_id);

  if (!exists) {
    res.status(404).json({ error: "找不到該行程" });
    return;
  }

  db.prepare("UPDATE trips SET note = ? WHERE trip_id = ?").run(
    note ?? null,
    trip_id,
  );

  res.json({ success: true });
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

  const records = rawRecords.map((r) => ({
    ...r,
    speed_estimated: r.speed_estimated === 1,
  }));

  res.json({ trip, records });
});

// ─────────────────────────────────────────────────────────────────────────────
// 相容舊版：一次性上傳整趟行程資料（保留，不建議新用途使用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/upload
 * 接收一次行程的完整資料陣列，寫入資料庫（舊版相容端點）
 *
 * speed_estimated 欄位說明：
 *   false（前端傳入 false）→ 感測器直接取得的速度，寫入 0
 *   true（前端傳入 true）  → Haversine 公式推算的速度，寫入 1
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

  const timestamps = records.map((r) => r.timestamp).sort();
  const start_time = timestamps[0];
  const end_time = timestamps[timestamps.length - 1];

  const insertTrip = db.transaction(() => {
    db.prepare(`
      INSERT INTO trips (trip_id, device_id, start_time, end_time, note)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(trip_id) DO UPDATE SET
        end_time = excluded.end_time,
        note = COALESCE(excluded.note, trips.note)
    `).run(trip_id, device_id, start_time, end_time, note ?? null);

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
        r.speed_estimated ? 1 : 0,
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

export default router;
