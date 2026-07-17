import { useState, useEffect, useCallback, useRef } from 'react';
import { useShakeSensor } from '@/hooks/useShakeSensor';
import { useGeolocation } from '@/hooks/useGeolocation';
import { useUploadTrip } from '@workspace/api-client-react';
import { Link, useLocation } from 'wouter';
import { ChevronLeft, AlertTriangle, ShieldAlert, Navigation2, Play, Square, Activity } from 'lucide-react';
import type { RecordInput } from '@workspace/api-client-react';

export default function Record() {
  const [, setLocation] = useLocation();
  const { permission, requestPermission, currentShake, isRecording, startRecording, stopRecording } = useShakeSensor();
  const { lat, lng, accuracy, status: geoStatus } = useGeolocation();
  
  const uploadTrip = useUploadTrip();
  const [deviceId, setDeviceId] = useState<string>('');
  const [records, setRecords] = useState<RecordInput[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Initialize device ID
  useEffect(() => {
    let id = localStorage.getItem('device_id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('device_id', id);
    }
    setDeviceId(id);
  }, []);

  const handleStart = useCallback(() => {
    setRecords([]);
    setUploadError(null);
    startRecording((data) => {
      if (lat !== null && lng !== null) {
        setRecords(prev => [
          ...prev,
          {
            lat,
            lng,
            timestamp: new Date().toISOString(),
            x_accel: data.x_accel,
            z_accel: data.z_accel,
            shake_index: data.shake_index,
            shake_level: data.shake_level
          }
        ]);
      }
    });
  }, [startRecording, lat, lng]);

  const handleStop = useCallback(async () => {
    stopRecording();
    
    if (records.length === 0) {
      alert('無有效紀錄資料');
      return;
    }

    setIsUploading(true);
    setUploadError(null);
    const trip_id = crypto.randomUUID();

    uploadTrip.mutate(
      {
        data: {
          device_id: deviceId,
          trip_id,
          records
        }
      },
      {
        onSuccess: () => {
          setIsUploading(false);
          alert('上傳成功');
          setLocation('/map');
        },
        onError: (error) => {
          setIsUploading(false);
          setUploadError('上傳失敗，請檢查網路連線。');
          console.error('Upload error:', error);
        }
      }
    );
  }, [stopRecording, records, deviceId, uploadTrip, setLocation]);

  // UI Helpers
  const getLevelColor = (level: number) => {
    switch(level) {
      case 1: return 'text-chart-1'; // Green
      case 2: return 'text-chart-2'; // Yellow-Green
      case 3: return 'text-chart-3'; // Yellow
      case 4: return 'text-chart-4'; // Orange
      case 5: return 'text-chart-5'; // Red
      default: return 'text-muted-foreground';
    }
  };

  const getLevelBgColor = (level: number) => {
    switch(level) {
      case 1: return 'bg-chart-1/10 border-chart-1/20'; 
      case 2: return 'bg-chart-2/10 border-chart-2/20'; 
      case 3: return 'bg-chart-3/10 border-chart-3/20'; 
      case 4: return 'bg-chart-4/10 border-chart-4/20'; 
      case 5: return 'bg-chart-5/10 border-chart-5/20'; 
      default: return 'bg-muted border-border';
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      {/* Header */}
      <header className="h-14 border-b flex items-center px-4 shrink-0 bg-card">
        <Link href="/" className="mr-4 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-6 h-6" />
        </Link>
        <h1 className="font-medium text-lg text-foreground">紀錄行程</h1>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto">
        
        {/* Permission Banner */}
        {permission !== 'granted' && (
          <div className="bg-secondary p-4 rounded-lg border flex flex-col gap-3">
            <div className="flex items-center gap-2 text-secondary-foreground font-medium">
              <ShieldAlert className="w-5 h-5 text-destructive" />
              <span>需要感測器權限</span>
            </div>
            <p className="text-sm text-muted-foreground">
              系統需要裝置感測器才能紀錄搖晃程度。如果您使用的是 iOS Safari，請點擊下方按鈕授權。
            </p>
            <button 
              onClick={requestPermission}
              className="mt-2 bg-primary text-primary-foreground py-2 px-4 rounded-md font-medium text-sm w-full transition-opacity hover:opacity-90 active:scale-[0.98]"
            >
              請求感測器權限
            </button>
          </div>
        )}

        {/* GPS Status Banner */}
        {geoStatus !== 'normal' && (
          <div className="bg-secondary p-3 rounded-lg border flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-chart-3 shrink-0 mt-0.5" />
            <div className="flex flex-col">
              <span className="text-sm font-medium text-secondary-foreground">GPS 訊號狀態異常</span>
              <span className="text-xs text-muted-foreground">
                {geoStatus === 'locating' ? '正在定位中...' : 
                 geoStatus === 'weak' ? `訊號微弱 (誤差 > 50m)` : 
                 '無法取得 GPS 位置，請確保已開啟定位服務。'}
              </span>
            </div>
          </div>
        )}

        {/* Real-time Status Card */}
        <div className={`flex flex-col items-center justify-center p-8 rounded-xl border-2 transition-colors duration-500 ${currentShake ? getLevelBgColor(currentShake.shake_level) : 'bg-card border-border'}`}>
          <div className="text-sm font-medium text-muted-foreground mb-2">目前搖晃等級</div>
          <div className={`text-6xl font-bold tracking-tighter mb-4 ${currentShake ? getLevelColor(currentShake.shake_level) : 'text-muted-foreground'}`}>
            {currentShake ? currentShake.shake_level : '-'}
          </div>
          
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 w-full max-w-xs mt-4">
            <div className="flex flex-col items-center">
              <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">綜合指數</span>
              <span className="font-mono font-medium text-foreground text-lg">
                {currentShake ? currentShake.shake_index.toFixed(2) : '0.00'}
              </span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">已紀錄筆數</span>
              <span className="font-mono font-medium text-foreground text-lg">
                {records.length}
              </span>
            </div>
          </div>
        </div>

        {/* Info Grid */}
        <div className="grid grid-cols-1 gap-3">
          <div className="flex items-center justify-between p-3 rounded-lg border bg-card">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Navigation2 className="w-4 h-4" />
              <span className="text-sm">目前座標</span>
            </div>
            <span className="text-sm font-mono font-medium text-foreground">
              {lat !== null && lng !== null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : '等待中...'}
            </span>
          </div>
          
          <div className="flex items-center justify-between p-3 rounded-lg border bg-card">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Activity className="w-4 h-4" />
              <span className="text-sm">感測器狀態</span>
            </div>
            <span className="text-sm font-medium text-foreground">
              {permission === 'granted' ? '正常運作' : permission === 'no-response' ? '無回應' : '未授權'}
            </span>
          </div>
        </div>

        {uploadError && (
          <div className="text-destructive text-sm text-center mt-2 font-medium">
            {uploadError}
          </div>
        )}

      </main>

      {/* Footer Controls */}
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
            結束紀錄
          </button>
        )}
      </footer>
    </div>
  );
}