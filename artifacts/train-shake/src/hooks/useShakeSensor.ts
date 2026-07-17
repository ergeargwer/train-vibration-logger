import { useEffect, useState, useCallback, useRef } from 'react';

export type ShakeData = {
  x_accel: number;
  z_accel: number;
  shake_index: number;
  shake_level: number;
};

export type PermissionStatus = 'granted' | 'denied' | 'prompt' | 'no-response';

export function useShakeSensor() {
  const [permission, setPermission] = useState<PermissionStatus>('prompt');
  const [currentShake, setCurrentShake] = useState<ShakeData | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  
  const bufferRef = useRef<{x: number[], z: number[]}>({ x: [], z: [] });
  const intervalRef = useRef<number | null>(null);

  // Helper to request permission (specifically for iOS)
  const requestPermission = useCallback(async () => {
    try {
      if (
        typeof (DeviceMotionEvent as any) !== 'undefined' &&
        typeof (DeviceMotionEvent as any).requestPermission === 'function'
      ) {
        const response = await (DeviceMotionEvent as any).requestPermission();
        if (response === 'granted') {
          setPermission('granted');
        } else {
          setPermission('denied');
        }
      } else {
        // Non-iOS 13+ devices, directly grant
        setPermission('granted');
      }
    } catch (err) {
      console.error('DeviceMotion permission error:', err);
      setPermission('denied');
    }
  }, []);

  const handleMotion = useCallback((event: DeviceMotionEvent) => {
    const x = event.accelerationIncludingGravity?.x || 0;
    const z = event.accelerationIncludingGravity?.z || 0;
    
    // Quick test if sensor responds at all
    if (event.accelerationIncludingGravity?.x !== null) {
      if (permission !== 'granted') {
        setPermission('granted');
      }
    } else {
      if (permission !== 'no-response') {
        setPermission('no-response');
      }
    }

    if (isRecording) {
      bufferRef.current.x.push(x);
      bufferRef.current.z.push(z);
    }
  }, [isRecording, permission]);

  // Setup motion listener
  useEffect(() => {
    if (permission === 'granted' || permission === 'prompt') {
      window.addEventListener('devicemotion', handleMotion);
    }
    
    // For non-HTTPS or missing APIs, let's just listen and see if we get events
    if (permission === 'prompt') {
      // Check if we get any events in 1 second, else might be unavailable or requires click
      const timeout = setTimeout(() => {
        if (permission === 'prompt' && bufferRef.current.x.length === 0) {
          // If we are on desktop or unsupported, it might never fire
        }
      }, 1000);
      return () => {
        window.removeEventListener('devicemotion', handleMotion);
        clearTimeout(timeout);
      };
    }

    return () => {
      window.removeEventListener('devicemotion', handleMotion);
    };
  }, [permission, handleMotion]);

  // Start/Stop processing interval
  const startRecording = useCallback((onTick: (data: ShakeData) => void) => {
    bufferRef.current = { x: [], z: [] };
    setIsRecording(true);
    
    intervalRef.current = window.setInterval(() => {
      const { x: xs, z: zs } = bufferRef.current;
      // Reset buffer for next second
      bufferRef.current = { x: [], z: [] };
      
      let x_rms = 0;
      let z_rms = 0;
      let shake_index = 0;
      let shake_level = 1;

      if (xs.length > 0 && zs.length > 0) {
        x_rms = Math.sqrt(xs.reduce((sum, v) => sum + v * v, 0) / xs.length);
        z_rms = Math.sqrt(zs.reduce((sum, v) => sum + v * v, 0) / zs.length);
        
        // Ensure values are numbers and not NaN
        x_rms = Number.isNaN(x_rms) ? 0 : x_rms;
        z_rms = Number.isNaN(z_rms) ? 0 : z_rms;
        
        shake_index = 0.4 * x_rms + 0.6 * z_rms;
        
        if (shake_index < 0.5) shake_level = 1;
        else if (shake_index < 1.5) shake_level = 2;
        else if (shake_index < 3.0) shake_level = 3;
        else if (shake_index < 5.0) shake_level = 4;
        else shake_level = 5;
      }

      const newData = { x_accel: x_rms, z_accel: z_rms, shake_index, shake_level };
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

  // Cleanup on unmount
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
    stopRecording
  };
}