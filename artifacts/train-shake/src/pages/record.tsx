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
import { useUploadTrip } from '@workspace/api-client-react';
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
} from 'lucide-react';
import type { RecordInput } from '@workspace/api-client-react';

// 注冊 Chart.js 所需元件
Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Title,
  Legend,
  Tooltip,
  Filler,
);

/** 波形圖最多保留最近 N 秒的資料點 */
const MAX_CHART_POINTS = 30;

/** 各搖晃等級對應的「搖晃指數」折線顏色 */
const SHAKE_LEVEL_COLORS: Record<number, string> = {
  1: '#22c55e',
  2: '#84cc16',
  3: '#eab308',
  4: '#f97316',
  5: '#ef4444',
};

/** 速度折線固定色（藍色系，與搖晃指數顏色系列不重疊） */
const SPEED_LINE_COLOR = '#3b82f6';

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
  const { lat, lng, accuracy, speedKmh, speedEstimated, status: geoStatus } = useGeolocation();

  const uploadTrip = useUploadTrip();
  const [deviceId, setDeviceId] = useState<string>('');
  const [records, setRecords] = useState<RecordInput[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Chart.js 參照
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  /**
   * 速度與座標的 Ref 橋接
   *
   * 問題背景：startRecording 接收的 onTick 回呼在呼叫當下捕捉閉包，
   * 之後 setInterval 每秒呼叫的都是同一個 onTick，React state 的更新
   * 無法穿透已建立的閉包，導致 speedKmh / lat / lng 永遠是按下「開始」
   * 當下的初始值（stale closure）。
   *
   * 修正方式：將這四個會隨時間變化的值同步寫入 ref，
   * onTick 改讀 ref.current，每次執行都能取得最新值，
   * 不受閉包捕捉時機限制。
   */
  const speedKmhRef = useRef<number>(speedKmh);
  const speedEstimatedRef = useRef<boolean>(speedEstimated);
  const latRef = useRef<number | null>(lat);
  const lngRef = useRef<number | null>(lng);

  useEffect(() => { speedKmhRef.current = speedKmh; }, [speedKmh]);
  useEffect(() => { speedEstimatedRef.current = speedEstimated; }, [speedEstimated]);
  useEffect(() => { latRef.current = lat; }, [lat]);
  useEffect(() => { lngRef.current = lng; }, [lng]);

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
   * 元件卸載時銷毀圖表實例，避免 canvas 記憶體洩漏
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
            yAxisID: 'y_speed',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: {
          mode: 'index',
          intersect: false,
        },
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
            labels: {
              font: { size: 11 },
              color: '#6b7280',
              boxWidth: 12,
              padding: 10,
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                if (ctx.datasetIndex === 0) {
                  return `搖晃指數：${(ctx.raw as number).toFixed(3)}`;
                }
                return `速度：${(ctx.raw as number).toFixed(1)} km/h`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: {
              font: { size: 10 },
              color: '#9ca3af',
              maxTicksLimit: 6,
              maxRotation: 0,
            },
            grid: { color: 'rgba(0,0,0,0.05)' },
          },
          y_shake: {
            type: 'linear',
            position: 'left',
            min: 0,
            title: {
              display: true,
              text: '搖晃指數',
              font: { size: 10 },
              color: '#6b7280',
            },
            ticks: {
              font: { size: 10 },
              color: '#9ca3af',
            },
            grid: { color: 'rgba(0,0,0,0.05)' },
          },
          y_speed: {
            type: 'linear',
            position: 'right',
            min: 0,
            title: {
              display: true,
              text: '速度 (km/h)',
              font: { size: 10 },
              color: '#6b7280',
            },
            ticks: {
              font: { size: 10 },
              color: '#9ca3af',
            },
            // 右側 Y 軸的格線不重複繪製，避免視覺干擾
            grid: { drawOnChartArea: false },
          },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);

  /**
   * 將新的一秒資料推入波形圖
   * 超過 MAX_CHART_POINTS 時移除最舊的點
   * 使用 chart.update('none') 直接渲染，不執行動畫，效能最佳
   */
  const pushToChart = useCallback(
    (shakeIndex: number, level: number, speed: number, timeLabel: string) => {
      const chart = chartRef.current;
      if (!chart) return;

      const labels = chart.data.labels as string[];
      const shakeDataset = chart.data.datasets[0];
      const speedDataset = chart.data.datasets[1];

      labels.push(timeLabel);
      (shakeDataset.data as number[]).push(shakeIndex);
      (speedDataset.data as number[]).push(speed);

      if (labels.length > MAX_CHART_POINTS) {
        labels.shift();
        (shakeDataset.data as number[]).shift();
        (speedDataset.data as number[]).shift();
      }

      // 依搖晃等級更新搖晃指數折線的顏色
      shakeDataset.borderColor = SHAKE_LEVEL_COLORS[level] ?? SHAKE_LEVEL_COLORS[1];
      shakeDataset.backgroundColor = `${SHAKE_LEVEL_COLORS[level] ?? SHAKE_LEVEL_COLORS[1]}14`;

      chart.update('none');
    },
    [],
  );

  const handleStart = useCallback(() => {
    // 清空波形圖資料
    const chart = chartRef.current;
    if (chart) {
      chart.data.labels = [];
      chart.data.datasets[0].data = [];
      chart.data.datasets[1].data = [];
      chart.data.datasets[0].borderColor = SHAKE_LEVEL_COLORS[1];
      chart.update('none');
    }

    setRecords([]);
    setUploadError(null);

    startRecording((data) => {
      const now = new Date();
      const timeLabel =
        `${String(now.getHours()).padStart(2, '0')}:` +
        `${String(now.getMinutes()).padStart(2, '0')}:` +
        `${String(now.getSeconds()).padStart(2, '0')}`;

      // ref.current 在每次 interval 觸發時都反映最新值，
      // 不受閉包建立時的快照限制
      const currentSpeed = speedKmhRef.current;
      const currentSpeedEstimated = speedEstimatedRef.current;
      const currentLat = latRef.current;
      const currentLng = lngRef.current;

      pushToChart(data.shake_index, data.shake_level, currentSpeed, timeLabel);

      if (currentLat !== null && currentLng !== null) {
        setRecords((prev) => [
          ...prev,
          {
            lat: currentLat,
            lng: currentLng,
            timestamp: now.toISOString(),
            x_accel: data.x_accel,
            z_accel: data.z_accel,
            shake_index: data.shake_index,
            shake_level: data.shake_level,
            speed_kmh: currentSpeed,
            speed_estimated: currentSpeedEstimated,
          },
        ]);
      }
    });
    // speedKmh / speedEstimated / lat / lng 已改由 ref 讀取，
    // 不再需要列入依賴陣列，避免每次 GPS 更新都重建回呼
  }, [startRecording, pushToChart]);

  const handleStop = useCallback(async () => {
    stopRecording();

    if (records.length === 0) {
      alert('無有效紀錄資料（請確認 GPS 已定位且感測器已授權）');
      return;
    }

    setIsUploading(true);
    setUploadError(null);
    const trip_id = crypto.randomUUID();

    uploadTrip.mutate(
      { data: { device_id: deviceId, trip_id, records } },
      {
        onSuccess: () => {
          setIsUploading(false);
          alert('上傳成功');
          setLocation('/map');
        },
        onError: (error) => {
          setIsUploading(false);
          setUploadError('上傳失敗，請檢查網路連線。');
          console.error('上傳錯誤：', error);
        },
      },
    );
  }, [stopRecording, records, deviceId, uploadTrip, setLocation]);

  // 搖晃等級對應的文字顏色
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
                {records.length} 筆
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

        {uploadError && (
          <div className="text-destructive text-sm text-center font-medium bg-destructive/10 rounded-lg p-3 border border-destructive/20">
            {uploadError}
          </div>
        )}

      </main>

      {/* 底部控制按鈕 */}
      <footer className="p-4 border-t bg-card shrink-0 pb-safe">
        {!isRecording ? (
          <button
            onClick={handleStart}
            disabled={permission !== 'granted' || geoStatus === 'unavailable' || isUploading}
            className="w-full h-14 bg-primary text-primary-foreground rounded-lg font-bold text-lg flex items-center justify-center gap-2 transition-transform active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none"
            data-testid="button-start-recording"
          >
            <Play className="w-5 h-5 fill-current" />
            開始紀錄
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="w-full h-14 bg-destructive text-destructive-foreground rounded-lg font-bold text-lg flex items-center justify-center gap-2 transition-transform active:scale-[0.98]"
            data-testid="button-stop-recording"
          >
            <Square className="w-5 h-5 fill-current" />
            結束紀錄並上傳
          </button>
        )}
      </footer>
    </div>
  );
}
