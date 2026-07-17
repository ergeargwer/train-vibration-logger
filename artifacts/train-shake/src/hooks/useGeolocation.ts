import { useState, useEffect } from 'react';

export type GeoStatus = 'normal' | 'locating' | 'weak' | 'unavailable';

export function useGeolocation() {
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [status, setStatus] = useState<GeoStatus>('locating');

  useEffect(() => {
    if (!navigator.geolocation) {
      setStatus('unavailable');
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setLat(position.coords.latitude);
        setLng(position.coords.longitude);
        setAccuracy(position.coords.accuracy);

        if (position.coords.accuracy > 50) {
          setStatus('weak');
        } else {
          setStatus('normal');
        }
      },
      (error) => {
        console.error('Geolocation error:', error);
        setStatus('unavailable');
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000,
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  return { lat, lng, accuracy, status };
}