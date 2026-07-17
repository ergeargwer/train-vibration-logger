/**
 * SQLite 資料庫初始化與連線管理
 * 使用 better-sqlite3 同步 API，適合小型嵌入式資料庫場景
 */
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../../data/shake.db");

// 建立資料庫連線（若資料夾不存在則自動建立）
import { mkdirSync } from "fs";
mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

// 啟用 WAL 模式以提升寫入效能
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * 初始化資料庫結構
 *
 * 建立 trips 與 records 兩張資料表（若不存在）。
 * 亦處理舊版資料庫的欄位遷移：若 records 表已存在但缺少
 * speed_kmh 或 speed_estimated 欄位，以 ALTER TABLE 補齊，
 * 並以 0 作為舊資料的預設值。
 *
 * trips 表：行程主表
 *   - trip_id    TEXT 主鍵
 *   - device_id  TEXT 裝置識別碼（預留多使用者擴充）
 *   - start_time TEXT 行程開始時間（ISO 8601）
 *   - end_time   TEXT 行程結束時間（ISO 8601）
 *   - note       TEXT 備註（可為 NULL）
 *   - created_at TEXT 建立時間
 *
 * records 表：逐筆搖晃紀錄
 *   - id               INTEGER 主鍵（自動遞增）
 *   - trip_id          TEXT 外鍵指向 trips
 *   - lat              REAL 緯度
 *   - lng              REAL 經度
 *   - timestamp        TEXT 時間戳記（ISO 8601）
 *   - x_accel          REAL X 軸加速度 RMS 值（左右搖晃）
 *   - z_accel          REAL Z 軸加速度 RMS 值（上下震動）
 *   - shake_level      INTEGER 搖晃等級（1 至 5 級）
 *   - shake_index      REAL 綜合搖晃指數（加權合成值）
 *   - speed_kmh        REAL 行駛速度（km/h，感測器值或 Haversine 推算值）
 *   - speed_estimated  INTEGER 速度是否為推算值（0=感測器實測，1=座標推算）
 */
export function initDb(): void {
  // 建立基礎資料表
  db.exec(`
    CREATE TABLE IF NOT EXISTS trips (
      trip_id   TEXT    NOT NULL PRIMARY KEY,
      device_id TEXT    NOT NULL,
      start_time TEXT   NOT NULL,
      end_time   TEXT   NOT NULL,
      note       TEXT,
      created_at TEXT   NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS records (
      id               INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      trip_id          TEXT    NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
      lat              REAL    NOT NULL,
      lng              REAL    NOT NULL,
      timestamp        TEXT    NOT NULL,
      x_accel          REAL    NOT NULL,
      z_accel          REAL    NOT NULL,
      shake_level      INTEGER NOT NULL CHECK(shake_level BETWEEN 1 AND 5),
      shake_index      REAL    NOT NULL,
      speed_kmh        REAL    NOT NULL DEFAULT 0,
      speed_estimated  INTEGER NOT NULL DEFAULT 0 CHECK(speed_estimated IN (0, 1))
    );

    CREATE INDEX IF NOT EXISTS idx_records_trip_id ON records(trip_id);
    CREATE INDEX IF NOT EXISTS idx_trips_device_id ON trips(device_id);
  `);

  // 遷移舊版資料庫：若欄位不存在則新增（舊資料以 0 填充）
  // SQLite 的 ADD COLUMN 若欄位已存在會拋錯，使用 try-catch 安全處理
  const migrations: Array<{ column: string; sql: string }> = [
    {
      column: "speed_kmh",
      sql: "ALTER TABLE records ADD COLUMN speed_kmh REAL NOT NULL DEFAULT 0",
    },
    {
      column: "speed_estimated",
      sql: "ALTER TABLE records ADD COLUMN speed_estimated INTEGER NOT NULL DEFAULT 0 CHECK(speed_estimated IN (0, 1))",
    },
  ];

  for (const migration of migrations) {
    try {
      db.exec(migration.sql);
    } catch {
      // 欄位已存在，忽略錯誤繼續執行
    }
  }
}
