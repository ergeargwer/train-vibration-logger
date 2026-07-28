import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Title,
  Legend,
  Tooltip,
  Filler,
} from 'chart.js';
import { useShakeSensor } from '@/hooks/useShakeSensor';
import { useGeolocation } from '@/hooks/useGeolocation';
import { Link, useLocation } from 'wouter';
import {
  ChevronLeft,
  AlertTriangle,
  ShieldAlert,
  Navigation2,
  Play,
  Square,
  Activity,
  Gauge,
  CloudUpload,
  RefreshCw,
  WifiOff,
} from 'lucide-react';
import type { RecordInput } from '@workspace/api-client-react';

// Chart.js 元件注冊
Chart.register(
  LineController, LineElement, PointElement, LinearScale,
  CategoryScale, Title, Legend, Tooltip, Filler,
);

/** 波形圖最多保留最近 N 秒的資料點 */
const MAX_CHART_POINTS = 30;

/**
 * 分批上傳的觸發間隔（毫秒）
 * 每隔此時間自動將 pendingRecordsRef 中的資料批次上傳一次
 */
const BATCH_INTERVAL_MS = 30_000;

/**
 * 筆數門檻：暫存資料累積達此筆數時立即觸發上傳（不等計時器）
 * 取 BATCH_INTERVAL_MS 到達與此筆數門檻兩者先到者先觸發
 */
const BATCH_SIZE_TRIGGER = 30;

/** 各搖晃等級對應的折線顏色 */
const SHAKE_LEVEL_COLORS: Record<number, string> = {
  1: '#22c55e', 2: '#84cc16', 3: '#eab308', 4: '#f97316', 5: '#ef4444',
};

/** 速度折線固定色（藍色系） */
const SPEED_LINE_COLOR = '#3b82f6';

// ─── 後端 API 輔助函式（module-level，不依賴 React 生命週期）─────────────────

/**
 * 呼叫後端建立新行程，回傳 { trip_id, start_time }
 * 失敗時拋出錯誤
 */
async function apiStartTrip(
  deviceId: string,
): Promise<{ trip_id: string; start_time: string }> {
  const res = await fetch('/api/trip/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  });
  if (!res.ok) throw new Error(`建立行程失敗（HTTP ${res.status}）`);
  return res.json() as Promise<{ trip_id: string; start_time: string }>;
}

/**
 * 呼叫後端批次寫入搖晃紀錄（可多次呼叫）
 * 失敗時拋出錯誤
 */
async function apiAppendRecords(
  tripId: string,
  records: RecordInput[],
): Promise<void> {
  const res = await fetch(`/api/trip/${tripId}/append`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  if (!res.ok) throw new Error(`批次上傳失敗（HTTP ${res.status}）`);
}

/**
 * 呼叫後端標記行程結束
 * 失敗時拋出錯誤（但呼叫端選擇以 console.error 記錄即可，不阻止後續流程）
 */
async function apiFinishTrip(tripId: string): Promise<void> {
  const res = await fetch(`/api/trip/${tripId}/finish`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`標記行程結束失敗（HTTP ${res.status}）`);
}

// ─────────────────────────────────────────────────────────────────────────────

export default function Record() {
  const [, setLocation] = useLocation();
  const {
    permission,
    requestPermission,
    currentShake,
    isRecording,
    startRecording,
    stopRecording,
  } = useShakeSensor();
  const {
    lat, lng, accuracy, speedKmh, speedEstimated, isSignalLost, status: geoStatus,
  } = useGeolocation();

  // 裝置識別碼（從 localStorage 讀取，首次使用自動產生）
  const [deviceId, setDeviceId] = useState<string>('');

  // 上傳狀態（顯示用）
  const [pendingCount, setPendingCount] = useState(0);          // 等待上傳的筆數
  const [uploadedCount, setUploadedCount] = useState(0);        // 已成功上傳的筆數
  const [hasUploadDelay, setHasUploadDelay] = useState(false);  // 部分批次上傳失敗（將自動重試）
  const [isFinalUploadFailed, setIsFinalUploadFailed] = useState(false); // 結束時最終上傳失敗
  const [isStartingTrip, setIsStartingTrip] = useState(false);  // 正在向後端建立行程
  const [isFinishing, setIsFinishing] = useState(false);         // 正在執行最終上傳與結束行程

  /**
   * Screen Wake Lock 相關狀態
   *
   * wakeLockSupported：瀏覽器是否支援 Screen Wake Lock API
   *   以 useState 初始化函式計算，組件掛載後固定不再改變。
   *   部分舊版 iOS Safari 或非主流瀏覽器可能不支援。
   *
   * wakeLockFailedOnResume：使用者切換 App 後切回頁面，
   *   系統自動釋放原本的 wake lock，嘗試重新請求但失敗時設為 true。
   *   此時顯示提示請使用者自行留意螢幕不要關閉。
   */
  const [wakeLockSupported] = useState<boolean>(
    () => typeof navigator !== 'undefined' && 'wakeLock' in navigator,
  );
  const [wakeLockFailedOnResume, setWakeLockFailedOnResume] = useState(false);

  // Chart.js 參照
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  /**
   * 核心資料 Refs — 解決 stale closure 問題
   *
   * 問題背景：
   *   startRecording 接收的 onTick 回呼在呼叫當下建立閉包快照，
   *   setInterval 每秒執行的都是同一個閉包實例，React state 的更新
   *   無法穿透閉包，導致閉包內讀到的值永遠是按下「開始」那一刻的快照。
   *
   *   批次上傳 timer 與 visibilitychange 事件回呼同樣面對相同問題。
   *
   * 解法：
   *   將所有需在閉包內讀取最新值的資料，以 useEffect 同步寫入 ref，
   *   閉包改讀 ref.current，每次執行都能取得最新狀態。
   */
  const speedKmhRef        = useRef<number>(speedKmh);
  const speedEstimatedRef  = useRef<boolean>(speedEstimated);
  const latRef             = useRef<number | null>(lat);
  const lngRef             = useRef<number | null>(lng);
  const isSignalLostRef    = useRef<boolean>(false);
  const pendingRecordsRef  = useRef<RecordInput[]>([]);          // 實際待上傳資料陣列
  const currentTripIdRef   = useRef<string | null>(null);        // 目前行程識別碼
  const isUploadingBatchRef = useRef<boolean>(false);            // 防止同時發出多個上傳請求
  const batchIntervalRef   = useRef<ReturnType<typeof setInterval> | null>(null); // 定時上傳 timer

  /**
   * Screen Wake Lock Refs
   *
   * wakeLockRef：持有目前作用中的 WakeLockSentinel 物件。
   *   使用 any 以相容不同版本的 TypeScript DOM 型別定義；
   *   Screen Wake Lock API 為瀏覽器原生 API，不需第三方套件。
   *
   * isRecordingRef：讓 visibilitychange 回呼（在閉包外建立）能讀到最新的紀錄狀態，
   *   避免因閉包捕捉問題導致判斷錯誤。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wakeLockRef        = useRef<any>(null);
  const isRecordingRef     = useRef<boolean>(false);

  useEffect(() => { speedKmhRef.current = speedKmh; }, [speedKmh]);
  useEffect(() => { speedEstimatedRef.current = speedEstimated; }, [speedEstimated]);
  useEffect(() => { latRef.current = lat; }, [lat]);
  useEffect(() => { lngRef.current = lng; }, [lng]);
  useEffect(() => { isSignalLostRef.current = isSignalLost; }, [isSignalLost]);
  // isRecordingRef 需與 isRecording state 保持同步，供 visibilitychange 回呼讀取
  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);

  // 初始化裝置識別碼
  useEffect(() => {
    let id = localStorage.getItem('device_id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('device_id', id);
    }
    setDeviceId(id);
  }, []);

  /**
   * 初始化雙Y軸波形圖
   *   左側 Y 軸（y_shake）：綜合搖晃指數
   *   右側 Y 軸（y_speed）：速度（km/h）
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    chartRef.current = new Chart(canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: '搖晃指數',
            data: [],
            borderColor: SHAKE_LEVEL_COLORS[1],
            backgroundColor: `${SHAKE_LEVEL_COLORS[1]}14`,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 4,
            tension: 0.3,
            fill: true,
            spanGaps: false,  // null 值顯示為折線斷開（訊號中斷期間）
            yAxisID: 'y_shake',
          },
          {
            label: '速度 (km/h)',
            data: [],
            borderColor: SPEED_LINE_COLOR,
            backgroundColor: `${SPEED_LINE_COLOR}14`,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 4,
            tension: 0.3,
            fill: false,
            spanGaps: false,
            yAxisID: 'y_speed',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          title: {
            display: true,
            text: '近期搖晃趨勢',
            font: { size: 13, weight: 'bold' },
            color: '#374151',
            padding: { bottom: 6 },
          },
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: { font: { size: 11 }, color: '#6b7280', boxWidth: 12, padding: 10 },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                if (ctx.datasetIndex === 0) return `搖晃指數：${(ctx.raw as number).toFixed(3)}`;
                return `速度：${(ctx.raw as number).toFixed(1)} km/h`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { font: { size: 10 }, color: '#9ca3af', maxTicksLimit: 6, maxRotation: 0 },
            grid: { color: 'rgba(0,0,0,0.05)' },
          },
          y_shake: {
            type: 'linear',
            position: 'left',
            min: 0,
            title: { display: true, text: '搖晃指數', font: { size: 10 }, color: '#6b7280' },
            ticks: { font: { size: 10 }, color: '#9ca3af' },
            grid: { color: 'rgba(0,0,0,0.05)' },
          },
          y_speed: {
            type: 'linear',
            position: 'right',
            min: 0,
            title: { display: true, text: '速度 (km/h)', font: { size: 10 }, color: '#6b7280' },
            ticks: { font: { size: 10 }, color: '#9ca3af' },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });

    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, []);

  /**
   * 將新資料點推入波形圖
   *
   * shakeIndex / speed 可傳入 null：
   *   null 代表訊號中斷期間的空白點，配合 spanGaps: false
   *   讓 Chart.js 以折線斷開呈現，不連接中斷前後的數值。
   */
  const pushToChart = useCallback(
    (shakeIndex: number | null, level: number, speed: number | null, timeLabel: string) => {
      const chart = chartRef.current;
      if (!chart) return;

      const labels = chart.data.labels as string[];
      const shakeDataset = chart.data.datasets[0];
      const speedDataset = chart.data.datasets[1];

      labels.push(timeLabel);
      (shakeDataset.data as (number | null)[]).push(shakeIndex);
      (speedDataset.data as (number | null)[]).push(speed);

      if (labels.length > MAX_CHART_POINTS) {
        labels.shift();
        (shakeDataset.data as (number | null)[]).shift();
        (speedDataset.data as (number | null)[]).shift();
      }

      // 僅在有實際數值時才更新搖晃等級顏色（null 代表中斷期間，不更新）
      if (shakeIndex !== null) {
        shakeDataset.borderColor = SHAKE_LEVEL_COLORS[level] ?? SHAKE_LEVEL_COLORS[1];
        shakeDataset.backgroundColor = `${SHAKE_LEVEL_COLORS[level] ?? SHAKE_LEVEL_COLORS[1]}14`;
      }

      chart.update('none');
    },
    [],
  );

  /**
   * 將 pendingRecordsRef 中的待上傳資料批次送出
   *
   * 設計原則：
   *   1. isUploadingBatchRef 作為互斥鎖，防止同一時間多個請求同時發出
   *   2. 上傳前先複製一份快照（batch），上傳期間新推入的資料不受影響
   *   3. 上傳成功：以 slice(batch.length) 移除已上傳部分，保留新資料
   *   4. 上傳失敗：保留全部資料（原批次 + 新資料），下次排程時一併重試
   *
   * 此函式設計為可安全地從 interval timer 與 onTick（達到筆數門檻時）兩處呼叫。
   */
  const flushBatch = useCallback(async (tripId: string): Promise<boolean> => {
    if (isUploadingBatchRef.current) return false;   // 已有上傳進行中，略過本次
    if (pendingRecordsRef.current.length === 0) return true;

    isUploadingBatchRef.current = true;
    const batch = [...pendingRecordsRef.current];    // 取快照

    try {
      await apiAppendRecords(tripId, batch);

      // 上傳成功：移除已上傳的部分，保留上傳期間新加入的資料
      pendingRecordsRef.current = pendingRecordsRef.current.slice(batch.length);
      setPendingCount(pendingRecordsRef.current.length);
      setUploadedCount((n) => n + batch.length);
      setHasUploadDelay(false);
      return true;
    } catch {
      // 上傳失敗：保留全部資料（含原批次），下次排程時合併重試
      setHasUploadDelay(true);
      return false;
    } finally {
      isUploadingBatchRef.current = false;
    }
  }, []);

  // ─── Screen Wake Lock 操作函式 ───────────────────────────────────────────────

  /**
   * 請求螢幕常亮（Screen Wake Lock）
   *
   * 成功時將 WakeLockSentinel 存入 wakeLockRef，並監聽系統自動釋放事件。
   * 失敗時（裝置電量過低、使用者拒絕等情況），靜默失敗並回傳 false，
   * 不影響紀錄功能本身，UI 另行顯示對應提示。
   */
  const requestWakeLock = useCallback(async (): Promise<boolean> => {
    if (!wakeLockSupported) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sentinel = await (navigator as any).wakeLock.request('screen');
      wakeLockRef.current = sentinel;
      // WakeLockSentinel 被系統釋放時（進入背景、低電量等）自動清除 ref
      sentinel.addEventListener('release', () => {
        if (wakeLockRef.current === sentinel) {
          wakeLockRef.current = null;
        }
      });
      setWakeLockFailedOnResume(false);
      return true;
    } catch {
      // 請求失敗（例如裝置電量過低時系統拒絕）
      wakeLockRef.current = null;
      return false;
    }
  }, [wakeLockSupported]);

  /**
   * 釋放螢幕常亮（Screen Wake Lock）
   *
   * 紀錄結束時呼叫，釋放 WakeLockSentinel 並清除 ref。
   * 若 sentinel 已被系統釋放（ref 為 null），此呼叫為無操作。
   */
  const releaseWakeLock = useCallback(async (): Promise<void> => {
    if (!wakeLockRef.current) return;
    try {
      await wakeLockRef.current.release();
    } catch {
      // 釋放失敗可忽略，sentinel 已失效或系統已自動釋放
    }
    wakeLockRef.current = null;
    setWakeLockFailedOnResume(false);
  }, []);

  /**
   * 監聽頁面可見性變化，在頁面從背景切回前景時重新請求 Wake Lock
   *
   * 背景原因：
   *   瀏覽器規範規定，頁面進入背景（visibilityState = 'hidden'）時，
   *   系統會自動釋放 Screen Wake Lock。使用者切換其他 App 後切回時，
   *   若紀錄仍在進行中，必須重新請求才能繼續防止螢幕熄滅。
   *
   * 失敗處理：
   *   重新請求失敗（例如切回時電量已低）時，設定 wakeLockFailedOnResume = true，
   *   在頁面顯示警告提示，請使用者自行留意不要讓螢幕關閉。
   */
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && isRecordingRef.current) {
        // 頁面切回前景且紀錄仍在進行中，嘗試重新請求 wake lock
        const ok = await requestWakeLock();
        if (!ok) {
          setWakeLockFailedOnResume(true);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [requestWakeLock]);

  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * 開始紀錄
   *
   * 流程：
   *   1. 呼叫 POST /api/trip/start，建立行程並取得 trip_id
   *   2. 啟動感測器（useShakeSensor.startRecording），每秒觸發 onTick
   *   3. 啟動 BATCH_INTERVAL_MS 定時器，定期批次上傳 pendingRecordsRef
   *   4. 請求螢幕常亮（Screen Wake Lock），防止手機螢幕熄滅中斷紀錄
   *
   * onTick 每秒執行一次：
   *   - GPS 訊號中斷時：推入 null 讓波形圖折線斷開，不寫入紀錄
   *   - 正常時：推入資料到 pendingRecordsRef 並更新波形圖
   *   - 達到 BATCH_SIZE_TRIGGER 筆時：立即觸發批次上傳（不等計時器）
   */
  const handleStart = useCallback(async () => {
    // 清空波形圖
    const chart = chartRef.current;
    if (chart) {
      chart.data.labels = [];
      chart.data.datasets[0].data = [];
      chart.data.datasets[1].data = [];
      chart.data.datasets[0].borderColor = SHAKE_LEVEL_COLORS[1];
      chart.update('none');
    }

    // 重置所有上傳狀態
    pendingRecordsRef.current = [];
    isUploadingBatchRef.current = false;
    setPendingCount(0);
    setUploadedCount(0);
    setHasUploadDelay(false);
    setIsFinalUploadFailed(false);

    // 步驟一：向後端建立行程
    setIsStartingTrip(true);
    let tripId: string;
    try {
      const result = await apiStartTrip(deviceId);
      tripId = result.trip_id;
    } catch (err) {
      setIsStartingTrip(false);
      console.error('建立行程失敗：', err);
      alert('無法建立行程，請確認網路連線後再試。');
      return;
    }
    currentTripIdRef.current = tripId;
    setIsStartingTrip(false);

    // 步驟二：啟動感測器
    startRecording((data) => {
      const now = new Date();
      const timeLabel =
        `${String(now.getHours()).padStart(2, '0')}:` +
        `${String(now.getMinutes()).padStart(2, '0')}:` +
        `${String(now.getSeconds()).padStart(2, '0')}`;

      // ref.current 每次執行都反映最新值，不受閉包捕捉時機限制
      const currentSpeed = speedKmhRef.current;
      const currentSpeedEstimated = speedEstimatedRef.current;
      const currentLat = latRef.current;
      const currentLng = lngRef.current;

      // 訊號中斷（進入地下路段）：推入 null 讓波形圖折線斷開，不寫入紀錄
      if (isSignalLostRef.current) {
        pushToChart(null, 1, null, timeLabel);
        return;
      }

      pushToChart(data.shake_index, data.shake_level, currentSpeed, timeLabel);

      if (currentLat !== null && currentLng !== null) {
        const record: RecordInput = {
          lat: currentLat,
          lng: currentLng,
          timestamp: now.toISOString(),
          x_accel: data.x_accel,
          z_accel: data.z_accel,
          shake_index: data.shake_index,
          shake_level: data.shake_level,
          speed_kmh: currentSpeed,
          speed_estimated: currentSpeedEstimated,
        };

        pendingRecordsRef.current.push(record);
        setPendingCount((n) => n + 1);

        // 達到筆數門檻：立即觸發批次上傳
        if (
          pendingRecordsRef.current.length >= BATCH_SIZE_TRIGGER &&
          currentTripIdRef.current
        ) {
          flushBatch(currentTripIdRef.current);
        }
      }
    });

    // 步驟三：啟動定時批次上傳
    batchIntervalRef.current = setInterval(() => {
      if (pendingRecordsRef.current.length > 0 && currentTripIdRef.current) {
        flushBatch(currentTripIdRef.current);
      }
    }, BATCH_INTERVAL_MS);

    // 步驟四：請求螢幕常亮
    // 防止手機螢幕自動熄滅，避免瀏覽器暫停分頁導致 GPS 與感測器停止擷取。
    // 若瀏覽器不支援或請求失敗，不影響紀錄功能，UI 另行顯示對應提示。
    requestWakeLock();
  }, [startRecording, pushToChart, deviceId, flushBatch, requestWakeLock]);

  /**
   * 等待目前批次上傳完成後，執行最終批次上傳
   * 若等待超過 10 秒（網路極慢或卡死），視為失敗
   */
  const flushFinal = useCallback(async (tripId: string): Promise<boolean> => {
    if (isUploadingBatchRef.current) {
      const released = await new Promise<boolean>((resolve) => {
        let elapsed = 0;
        const check = setInterval(() => {
          elapsed += 100;
          if (!isUploadingBatchRef.current) {
            clearInterval(check);
            resolve(true);
          } else if (elapsed >= 10_000) {
            clearInterval(check);
            resolve(false);
          }
        }, 100);
      });
      if (!released) return false;
    }

    if (pendingRecordsRef.current.length === 0) return true;
    return flushBatch(tripId);
  }, [flushBatch]);

  /**
   * 結束紀錄
   *
   * 流程：
   *   1. 停止感測器
   *   2. 停止定時批次上傳 timer
   *   3. 釋放螢幕常亮（紀錄已結束，不再需要保持螢幕開啟）
   *   4. 最後一次批次上傳（flushFinal，包含所有剩餘 pending 資料）
   *   5. 若上傳失敗：停留在頁面，顯示「重新嘗試上傳」按鈕
   *   6. 呼叫 PATCH /api/trip/:id/finish，標記行程結束時間
   *   7. 跳轉至地圖頁面
   *
   * 步驟 6 失敗（finish API）不阻止頁面跳轉，因資料已安全寫入 records 表。
   */
  const handleStop = useCallback(async () => {
    stopRecording();

    // 停止定時批次上傳
    if (batchIntervalRef.current) {
      clearInterval(batchIntervalRef.current);
      batchIntervalRef.current = null;
    }

    // 釋放螢幕常亮資源（紀錄已結束，避免不必要耗電）
    releaseWakeLock();

    const tripId = currentTripIdRef.current;
    if (!tripId) return;  // 行程尚未建立（例如建立失敗後立即停止）

    setIsFinishing(true);

    // 最終上傳
    const uploadOk = await flushFinal(tripId);
    if (!uploadOk) {
      setIsFinishing(false);
      setIsFinalUploadFailed(true);
      return;  // 停留在頁面，等待使用者手動重試
    }

    // 標記行程結束（失敗不影響資料完整性）
    try {
      await apiFinishTrip(tripId);
    } catch (err) {
      console.error('標記行程結束失敗（資料已完整寫入，不影響後續分析）：', err);
    }

    setIsFinishing(false);
    currentTripIdRef.current = null;
    setLocation('/map');
  }, [stopRecording, setLocation, flushFinal, releaseWakeLock]);

  /**
   * 手動重試最終上傳（最後批次失敗時顯示的重試按鈕觸發）
   */
  const handleRetryFinalUpload = useCallback(async () => {
    const tripId = currentTripIdRef.current;
    if (!tripId) return;

    setIsFinishing(true);
    setIsFinalUploadFailed(false);

    const uploadOk = await flushFinal(tripId);
    if (!uploadOk) {
      setIsFinishing(false);
      setIsFinalUploadFailed(true);
      return;
    }

    try {
      await apiFinishTrip(tripId);
    } catch (err) {
      console.error('標記行程結束失敗：', err);
    }

    setIsFinishing(false);
    currentTripIdRef.current = null;
    // 上傳完成，確保釋放螢幕常亮資源（stop 時已釋放，此為防禦性呼叫）
    releaseWakeLock();
    setLocation('/map');
  }, [flushFinal, setLocation, releaseWakeLock]);

  // 搖晃等級 → CSS 輔助函式
  const getLevelColor = (level: number) => {
    switch (level) {
      case 1: return 'text-chart-1';
      case 2: return 'text-chart-2';
      case 3: return 'text-chart-3';
      case 4: return 'text-chart-4';
      case 5: return 'text-chart-5';
      default: return 'text-muted-foreground';
    }
  };

  const getLevelBgColor = (level: number) => {
    switch (level) {
      case 1: return 'bg-chart-1/10 border-chart-1/20';
      case 2: return 'bg-chart-2/10 border-chart-2/20';
      case 3: return 'bg-chart-3/10 border-chart-3/20';
      case 4: return 'bg-chart-4/10 border-chart-4/20';
      case 5: return 'bg-chart-5/10 border-chart-5/20';
      default: return 'bg-card border-border';
    }
  };

  const getLevelText = (level: number) => {
    switch (level) {
      case 1: return '平穩';
      case 2: return '輕微搖晃';
      case 3: return '中度搖晃';
      case 4: return '明顯搖晃';
      case 5: return '劇烈搖晃';
      default: return '尚未開始紀錄';
    }
  };

  const totalRecordCount = uploadedCount + pendingCount;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      {/* 頁首 */}
      <header className="h-14 border-b flex items-center px-4 shrink-0 bg-card">
        <Link href="/" className="mr-4 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-6 h-6" />
        </Link>
        <h1 className="font-medium text-lg text-foreground">紀錄行程</h1>
        {isRecording && (
          <span className="ml-auto flex items-center gap-1.5 text-xs font-medium text-destructive">
            <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
            紀錄中
          </span>
        )}
      </header>

      {/* 主要內容 */}
      <main className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto">

        {/* 感測器權限提示 */}
        {permission !== 'granted' && (
          <div className="bg-secondary p-4 rounded-lg border flex flex-col gap-3">
            <div className="flex items-center gap-2 text-secondary-foreground font-medium">
              <ShieldAlert className="w-5 h-5 text-destructive" />
              <span>需要感測器權限</span>
            </div>
            <p className="text-sm text-muted-foreground">
              系統需要裝置動作感測器才能紀錄搖晃程度。iOS Safari 使用者請點擊下方按鈕授權；Android 與桌機瀏覽器不需要此步驟。
            </p>
            <button
              onClick={requestPermission}
              className="mt-1 bg-primary text-primary-foreground py-2 px-4 rounded-md font-medium text-sm w-full transition-opacity hover:opacity-90 active:scale-[0.98]"
            >
              請求感測器權限
            </button>
          </div>
        )}

        {/* 地下段訊號中斷警告（紀錄中才顯示） */}
        {isRecording && isSignalLost && (
          <div className="bg-destructive/10 border border-destructive/30 p-3 rounded-lg flex items-start gap-3">
            <span className="w-2.5 h-2.5 rounded-full bg-destructive animate-pulse shrink-0 mt-1" />
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-destructive">
                訊號中斷，暫停紀錄中
              </span>
              <span className="text-xs text-destructive/80 mt-0.5">
                可能進入地下路段。GPS 恢復後將自動繼續紀錄，中斷期間資料不計入。
              </span>
            </div>
          </div>
        )}

        {/* GPS 狀態警告 */}
        {geoStatus !== 'normal' && (
          <div className="bg-secondary p-3 rounded-lg border flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-chart-3 shrink-0 mt-0.5" />
            <div className="flex flex-col">
              <span className="text-sm font-medium text-secondary-foreground">GPS 訊號狀態</span>
              <span className="text-xs text-muted-foreground">
                {geoStatus === 'locating'
                  ? '正在定位中，請稍候...'
                  : geoStatus === 'weak'
                    ? '訊號微弱（誤差 > 50m，建議移至戶外後再開始紀錄）'
                    : '無法取得 GPS 位置，請確認已開啟定位服務與應用程式權限。'}
              </span>
            </div>
          </div>
        )}

        {/* 瀏覽器不支援螢幕常亮功能提示（紀錄中才顯示） */}
        {isRecording && !wakeLockSupported && (
          <div className="bg-secondary p-3 rounded-lg border flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-chart-3 shrink-0 mt-0.5" />
            <span className="text-xs text-muted-foreground">
              此瀏覽器不支援防止螢幕熄滅功能，請自行保持螢幕開啟。
            </span>
          </div>
        )}

        {/* 螢幕常亮重新請求失敗提示（切換 App 後返回，重新請求失敗） */}
        {isRecording && wakeLockSupported && wakeLockFailedOnResume && (
          <div className="bg-secondary p-3 rounded-lg border flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-chart-3 shrink-0 mt-0.5" />
            <span className="text-xs text-muted-foreground">
              螢幕保持喚醒失敗，請留意勿讓螢幕關閉，否則紀錄可能中斷。
            </span>
          </div>
        )}

        {/* 即時上傳狀態（紀錄進行中，最終上傳未失敗時顯示） */}
        {isRecording && !isFinalUploadFailed && (
          <div className={`p-3 rounded-lg border flex items-start gap-3 ${
            hasUploadDelay
              ? 'bg-chart-3/10 border-chart-3/30'
              : 'bg-primary/5 border-primary/20'
          }`}>
            <CloudUpload className={`w-4 h-4 shrink-0 mt-0.5 ${
              hasUploadDelay ? 'text-chart-3' : 'text-primary'
            }`} />
            <div className="flex flex-col flex-1">
              {hasUploadDelay ? (
                <>
                  <span className="text-sm font-semibold text-chart-3">
                    部分資料上傳延遲，將自動重試
                  </span>
                  <span className="text-xs text-chart-3/80 mt-0.5">
                    已上傳 {uploadedCount} 筆　等待上傳 {pendingCount} 筆
                  </span>
                </>
              ) : (
                <>
                  <span className="text-sm font-medium text-primary">即時上傳中</span>
                  <span className="text-xs text-muted-foreground mt-0.5">
                    已上傳 {uploadedCount} 筆　等待上傳 {pendingCount} 筆
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {/* 最終上傳失敗提示（結束行程後仍有資料未送出） */}
        {isFinalUploadFailed && (
          <div className="bg-destructive/10 border border-destructive/30 p-4 rounded-lg flex flex-col gap-3">
            <div className="flex items-start gap-3">
              <WifiOff className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
              <div className="flex flex-col">
                <span className="text-sm font-bold text-destructive">
                  有 {pendingCount} 筆資料尚未成功上傳
                </span>
                <span className="text-xs text-destructive/80 mt-1">
                  請確認網路連線後，點擊下方按鈕重新嘗試。請勿離開此頁面，否則未上傳的資料將遺失。
                </span>
              </div>
            </div>
            <button
              onClick={handleRetryFinalUpload}
              disabled={isFinishing}
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-destructive text-destructive-foreground rounded-lg font-medium text-sm disabled:opacity-50 transition-transform active:scale-[0.98]"
            >
              {isFinishing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  上傳中...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4" />
                  重新嘗試上傳（{pendingCount} 筆）
                </>
              )}
            </button>
          </div>
        )}

        {/* 搖晃等級主卡片 */}
        <div
          className={`flex flex-col items-center justify-center p-6 rounded-xl border-2 transition-colors duration-500 ${
            currentShake ? getLevelBgColor(currentShake.shake_level) : 'bg-card border-border'
          }`}
        >
          <div className="text-xs font-medium text-muted-foreground tracking-widest uppercase mb-1">
            目前搖晃等級
          </div>
          <div
            className={`text-7xl font-bold tracking-tighter leading-none my-2 ${
              currentShake ? getLevelColor(currentShake.shake_level) : 'text-muted-foreground'
            }`}
          >
            {currentShake ? currentShake.shake_level : '-'}
          </div>
          <div className="text-sm font-medium text-muted-foreground mb-4">
            {currentShake ? getLevelText(currentShake.shake_level) : '尚未開始紀錄'}
          </div>

          <div className="grid grid-cols-3 gap-4 w-full max-w-xs">
            <div className="flex flex-col items-center">
              <span className="text-xs text-muted-foreground mb-1">搖晃指數</span>
              <span className="font-mono font-semibold text-foreground">
                {currentShake ? currentShake.shake_index.toFixed(3) : '0.000'}
              </span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-xs text-muted-foreground mb-1">已紀錄</span>
              <span className="font-mono font-semibold text-foreground">
                {totalRecordCount} 筆
              </span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-xs text-muted-foreground mb-1">感測器</span>
              <span className="text-xs font-medium text-foreground">
                {permission === 'granted' ? '正常' : permission === 'no-response' ? '無回應' : '未授權'}
              </span>
            </div>
          </div>
        </div>

        {/* 即時波形圖（雙Y軸：左側搖晃指數 / 右側速度） */}
        <div className="bg-card rounded-xl border p-4">
          <div className="h-48">
            <canvas ref={canvasRef} />
          </div>
        </div>

        {/* GPS 座標、速度與精度資訊列 */}
        <div className="grid grid-cols-1 gap-2">
          <div className="flex items-center justify-between p-3 rounded-lg border bg-card">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Navigation2 className="w-4 h-4" />
              <span className="text-sm">目前座標</span>
            </div>
            <span className="text-sm font-mono font-medium text-foreground">
              {lat !== null && lng !== null
                ? `${lat.toFixed(5)}, ${lng.toFixed(5)}`
                : '等待定位...'}
            </span>
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border bg-card">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Gauge className="w-4 h-4" />
              <span className="text-sm">目前速度</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-mono font-semibold text-foreground">
                {speedKmh.toFixed(1)} km/h
              </span>
              {speedEstimated && (
                <span className="text-xs text-muted-foreground">(推算)</span>
              )}
            </div>
          </div>

          {accuracy !== null && (
            <div className="flex items-center justify-between p-3 rounded-lg border bg-card">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Activity className="w-4 h-4" />
                <span className="text-sm">定位精度</span>
              </div>
              <span className="text-sm font-mono font-medium text-foreground">
                {accuracy < 10
                  ? `${accuracy.toFixed(1)} m（良好）`
                  : accuracy < 50
                    ? `${accuracy.toFixed(1)} m（普通）`
                    : `${accuracy.toFixed(0)} m（訊號弱）`}
              </span>
            </div>
          )}
        </div>

      </main>

      {/* 底部控制按鈕 */}
      <footer className="p-4 border-t bg-card shrink-0 pb-safe">

        {/* 螢幕提示：請勿關閉螢幕或切換其他 App（按鈕上方固定顯示） */}
        <p className="text-xs text-center text-muted-foreground mb-3">
          紀錄進行中請勿手動關閉螢幕或切換其他 App，以免中斷紀錄
        </p>

        {/* 正在紀錄中且最終上傳未失敗：顯示「結束紀錄」按鈕 */}
        {isRecording && !isFinalUploadFailed && (
          <button
            onClick={handleStop}
            disabled={isFinishing}
            className="w-full h-14 bg-destructive text-destructive-foreground rounded-lg font-bold text-lg flex items-center justify-center gap-2 transition-transform active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none"
            data-testid="button-stop-recording"
          >
            {isFinishing ? (
              <>
                <RefreshCw className="w-5 h-5 animate-spin" />
                上傳最後批次中...
              </>
            ) : (
              <>
                <Square className="w-5 h-5 fill-current" />
                結束紀錄
              </>
            )}
          </button>
        )}

        {/* 未在紀錄中且最終上傳未失敗：顯示「開始紀錄」按鈕 */}
        {!isRecording && !isFinalUploadFailed && (
          <button
            onClick={handleStart}
            disabled={permission !== 'granted' || geoStatus === 'unavailable' || isStartingTrip}
            className="w-full h-14 bg-primary text-primary-foreground rounded-lg font-bold text-lg flex items-center justify-center gap-2 transition-transform active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none"
            data-testid="button-start-recording"
          >
            {isStartingTrip ? (
              <>
                <RefreshCw className="w-5 h-5 animate-spin" />
                建立行程中...
              </>
            ) : (
              <>
                <Play className="w-5 h-5 fill-current" />
                開始紀錄
              </>
            )}
          </button>
        )}

        {/* 最終上傳失敗：底部不顯示按鈕（已在主體內顯示重試區塊） */}
      </footer>
    </div>
  );
}
