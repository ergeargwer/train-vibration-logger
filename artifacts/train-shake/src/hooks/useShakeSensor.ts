import { useEffect, useState, useCallback, useRef } from 'react';

export type ShakeData = {
  x_accel: number;
  z_accel: number;
  shake_index: number;
  shake_level: number;
};

export type PermissionStatus = 'granted' | 'denied' | 'prompt' | 'no-response';

/**
 * 搖晃等級門檻常數（單位：m/s²，基於線性加速度，已扣除重力分量）
 *
 * 門檻設定依據：
 *   一般火車在平順路段的線性加速度約 0.05–0.2 m/s²，
 *   輕微顛簸約 0.2–0.8 m/s²，中度搖晃約 0.8–2.0 m/s²，
 *   明顯震動約 2.0–4.0 m/s²，劇烈衝擊超過 4.0 m/s²。
 *   這些數值適用於正確扣除重力後的純加速度訊號。
 *   實測後如需調整，請修改此處常數，不要動下方計算邏輯。
 */
const THRESHOLD_LEVEL_2 = 0.3;  // shake_index >= 此值 → 等級 2（輕微搖晃）
const THRESHOLD_LEVEL_3 = 0.8;  // shake_index >= 此值 → 等級 3（中度搖晃）
const THRESHOLD_LEVEL_4 = 2.0;  // shake_index >= 此值 → 等級 4（明顯搖晃）
const THRESHOLD_LEVEL_5 = 4.0;  // shake_index >= 此值 → 等級 5（劇烈搖晃）

/**
 * 低通濾波器 alpha 值（用於從 accelerationIncludingGravity 估算重力分量）
 * alpha 越大，重力估算越貼近前一幀（濾波越強，動態響應越慢）
 * 建議範圍：0.8–0.95
 */
const GRAVITY_FILTER_ALPHA = 0.8;

/**
 * 計算搖晃等級（依 THRESHOLD_LEVEL_* 常數切分）
 */
function calcShakeLevel(shakeIndex: number): number {
  if (shakeIndex >= THRESHOLD_LEVEL_5) return 5;
  if (shakeIndex >= THRESHOLD_LEVEL_4) return 4;
  if (shakeIndex >= THRESHOLD_LEVEL_3) return 3;
  if (shakeIndex >= THRESHOLD_LEVEL_2) return 2;
  return 1;
}

export function useShakeSensor() {
  const [permission, setPermission] = useState<PermissionStatus>('prompt');
  const [currentShake, setCurrentShake] = useState<ShakeData | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  // 每秒採樣緩衝區
  const bufferRef = useRef<{ x: number[]; z: number[] }>({ x: [], z: [] });
  const intervalRef = useRef<number | null>(null);

  /**
   * 低通濾波器狀態：用於從 accelerationIncludingGravity 估算重力分量
   * 當 event.acceleration 可用時不使用此值
   */
  const gravityRef = useRef<{ x: number; z: number } | null>(null);

  // 請求感測器權限（iOS Safari 需明確按鈕觸發）
  const requestPermission = useCallback(async () => {
    try {
      if (
        typeof (DeviceMotionEvent as any) !== 'undefined' &&
        typeof (DeviceMotionEvent as any).requestPermission === 'function'
      ) {
        const response = await (DeviceMotionEvent as any).requestPermission();
        setPermission(response === 'granted' ? 'granted' : 'denied');
      } else {
        // Android 與桌機不需要明確請求，直接視為已授權
        setPermission('granted');
      }
    } catch (err) {
      console.error('DeviceMotion permission error:', err);
      setPermission('denied');
    }
  }, []);

  const handleMotion = useCallback(
    (event: DeviceMotionEvent) => {
      let linearX: number;
      let linearZ: number;

      /**
       * 加速度取值策略：
       * 優先使用 event.acceleration（瀏覽器已扣除重力的線性加速度）。
       * 若為 null（部分 Android 裝置不支援），改用指數移動平均低通濾波器
       * 從 accelerationIncludingGravity 估算並扣除重力分量：
       *   gravity_n = alpha * gravity_(n-1) + (1 - alpha) * raw_n
       *   linear_n  = raw_n - gravity_n
       */
      const acc = event.acceleration;
      const accWithGravity = event.accelerationIncludingGravity;

      if (acc && acc.x !== null && acc.z !== null) {
        // 直接使用瀏覽器提供的線性加速度
        linearX = acc.x ?? 0;
        linearZ = acc.z ?? 0;
        // 確認感測器有在回應
        if (permission !== 'granted') {
          setPermission('granted');
        }
      } else if (accWithGravity && accWithGravity.x !== null && accWithGravity.z !== null) {
        // 低通濾波估算重力，再扣除
        const rawX = accWithGravity.x ?? 0;
        const rawZ = accWithGravity.z ?? 0;

        if (gravityRef.current === null) {
          // 第一幀：以當前值初始化重力估算
          gravityRef.current = { x: rawX, z: rawZ };
        } else {
          gravityRef.current.x =
            GRAVITY_FILTER_ALPHA * gravityRef.current.x + (1 - GRAVITY_FILTER_ALPHA) * rawX;
          gravityRef.current.z =
            GRAVITY_FILTER_ALPHA * gravityRef.current.z + (1 - GRAVITY_FILTER_ALPHA) * rawZ;
        }

        linearX = rawX - gravityRef.current.x;
        linearZ = rawZ - gravityRef.current.z;

        if (permission !== 'granted') {
          setPermission('granted');
        }
      } else {
        // 感測器完全無回應
        if (permission !== 'no-response') {
          setPermission('no-response');
        }
        return;
      }

      if (isRecording) {
        bufferRef.current.x.push(linearX);
        bufferRef.current.z.push(linearZ);
      }
    },
    [isRecording, permission],
  );

  // 掛載感測器事件監聽
  useEffect(() => {
    if (permission === 'granted' || permission === 'prompt') {
      window.addEventListener('devicemotion', handleMotion);
    }
    return () => {
      window.removeEventListener('devicemotion', handleMotion);
    };
  }, [permission, handleMotion]);

  /**
   * 開始紀錄：每 1000ms 觸發一次 onTick，
   * 傳入當前秒的 RMS 計算結果與搖晃等級
   */
  const startRecording = useCallback((onTick: (data: ShakeData) => void) => {
    bufferRef.current = { x: [], z: [] };
    gravityRef.current = null; // 重置重力估算，避免切換裝置狀態時帶入舊值
    setIsRecording(true);

    intervalRef.current = window.setInterval(() => {
      const { x: xs, z: zs } = bufferRef.current;
      bufferRef.current = { x: [], z: [] };

      let x_rms = 0;
      let z_rms = 0;
      let shake_index = 0;
      let shake_level = 1;

      if (xs.length > 0 && zs.length > 0) {
        x_rms = Math.sqrt(xs.reduce((sum, v) => sum + v * v, 0) / xs.length);
        z_rms = Math.sqrt(zs.reduce((sum, v) => sum + v * v, 0) / zs.length);
        x_rms = Number.isNaN(x_rms) ? 0 : x_rms;
        z_rms = Number.isNaN(z_rms) ? 0 : z_rms;

        // 綜合搖晃指數：Z 軸（上下震動）權重 0.6，X 軸（左右）0.4
        shake_index = 0.4 * x_rms + 0.6 * z_rms;
        shake_level = calcShakeLevel(shake_index);
      }

      const newData: ShakeData = { x_accel: x_rms, z_accel: z_rms, shake_index, shake_level };
      setCurrentShake(newData);
      onTick(newData);
    }, 1000);
  }, []);

  const stopRecording = useCallback(() => {
    setIsRecording(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return {
    permission,
    requestPermission,
    currentShake,
    isRecording,
    startRecording,
    stopRecording,
  };
}
