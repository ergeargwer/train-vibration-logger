/**
 * GPS 定位 Hook
 *
 * 回傳即時座標、定位精度、速度及定位狀態。
 *
 * 速度取值策略（依優先順序）：
 *   1. 優先使用 position.coords.speed（瀏覽器感測器直接回傳，單位 m/s）
 *      → 換算為 km/h 後儲存，speed_estimated = false
 *   2. 若 coords.speed 為 null 或 undefined（部分 Android 裝置不支援），
 *      則使用 Haversine 公式計算與上一筆座標的距離，
 *      再除以時間差（秒）得到 m/s，轉換為 km/h，speed_estimated = true
 *   3. 本次行程的第一筆定位（無前一筆可計算）→ speed_kmh = 0，speed_estimated = true
 */
import { useState, useEffect, useRef } from 'react';

export type GeoStatus = 'normal' | 'locating' | 'weak' | 'unavailable';

/** 儲存前一筆定位資料（用於 Haversine 備援計算） */
type PrevPosition = {
  lat: number;
  lng: number;
  timestampMs: number;
};

/**
 * Haversine 公式：計算地球表面兩點間的距離（公尺）
 * 輸入單位：十進位度數（Decimal degrees）
 */
function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000; // 地球半徑（公尺）
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function useGeolocation() {
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [speedKmh, setSpeedKmh] = useState<number>(0);
  const [speedEstimated, setSpeedEstimated] = useState<boolean>(true);
  const [status, setStatus] = useState<GeoStatus>('locating');

  // 前一筆定位資料（用於 Haversine 備援計算）
  const prevPositionRef = useRef<PrevPosition | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) {
      setStatus('unavailable');
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy: acc, speed } = position.coords;
        const nowMs = position.timestamp;

        setLat(latitude);
        setLng(longitude);
        setAccuracy(acc);
        setStatus(acc > 50 ? 'weak' : 'normal');

        // --- 速度計算 ---
        if (speed !== null && speed !== undefined) {
          // 優先使用感測器直接回傳的速度
          setSpeedKmh(speed * 3.6);
          setSpeedEstimated(false);
        } else if (prevPositionRef.current !== null) {
          // 備援：Haversine 公式推算
          const prev = prevPositionRef.current;
          const distanceM = haversineDistance(prev.lat, prev.lng, latitude, longitude);
          const timeDiffS = (nowMs - prev.timestampMs) / 1000;

          if (timeDiffS > 0) {
            const speedMs = distanceM / timeDiffS;
            setSpeedKmh(speedMs * 3.6);
          } else {
            setSpeedKmh(0);
          }
          setSpeedEstimated(true);
        } else {
          // 第一筆定位，無前一筆可比對
          setSpeedKmh(0);
          setSpeedEstimated(true);
        }

        // 更新前一筆定位資料（在計算完速度後才更新）
        prevPositionRef.current = { lat: latitude, lng: longitude, timestampMs: nowMs };
      },
      (error) => {
        console.error('定位失敗：', error);
        setStatus('unavailable');
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000,
      },
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
      prevPositionRef.current = null;
    };
  }, []);

  return { lat, lng, accuracy, speedKmh, speedEstimated, status };
}
