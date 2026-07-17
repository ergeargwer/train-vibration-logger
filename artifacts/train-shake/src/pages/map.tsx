import { useEffect, useRef, useState } from 'react';
import { useGetTrips, useGetTripRecords } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { ChevronLeft, Map as MapIcon, Loader2 } from 'lucide-react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';

export default function MapPage() {
  const [selectedTripId, setSelectedTripId] = useState<string>('');
  
  const { data: trips, isLoading: isTripsLoading } = useGetTrips();
  const { data: tripDetail, isLoading: isRecordsLoading } = useGetTripRecords(selectedTripId, {
    query: {
      enabled: !!selectedTripId,
      queryKey: ['trip', selectedTripId] // Manually specified since it needs tripId
    }
  });

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const heatLayerRef = useRef<any>(null);

  // Initialize Map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    // Default to Taiwan roughly
    const map = L.map(mapContainerRef.current).setView([23.6978, 120.9605], 7);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update Heatmap when data changes
  useEffect(() => {
    if (!mapRef.current) return;

    // Clear previous layer
    if (heatLayerRef.current) {
      mapRef.current.removeLayer(heatLayerRef.current);
      heatLayerRef.current = null;
    }

    if (tripDetail && tripDetail.records.length > 0) {
      const heatData = tripDetail.records.map(r => {
        // Normalize shake_index to 0-1 for heatmap intensity
        // shake_index 0-5 corresponds to level 1-5
        const intensity = Math.min(Math.max(r.shake_index / 5, 0.1), 1);
        return [r.lat, r.lng, intensity] as [number, number, number];
      });

      // Heatmap gradient: Green to Red
      // 0.2: Green, 0.4: Yellow-Green, 0.6: Yellow, 0.8: Orange, 1.0: Red
      const heatOptions = {
        radius: 20,
        blur: 15,
        maxZoom: 15,
        max: 1.0,
        gradient: {
          0.2: '#16a34a', // chart-1 (Level 1)
          0.4: '#84cc16', // chart-2 (Level 2)
          0.6: '#eab308', // chart-3 (Level 3)
          0.8: '#f97316', // chart-4 (Level 4)
          1.0: '#ef4444'  // chart-5 (Level 5)
        }
      };

      heatLayerRef.current = (L as any).heatLayer(heatData, heatOptions).addTo(mapRef.current);

      // Fit bounds to data
      const lats = tripDetail.records.map(r => r.lat);
      const lngs = tripDetail.records.map(r => r.lng);
      const bounds = L.latLngBounds(
        [Math.min(...lats), Math.min(...lngs)],
        [Math.max(...lats), Math.max(...lngs)]
      );
      
      // Add a little padding
      mapRef.current.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [tripDetail]);

  // Set default selection when trips load
  useEffect(() => {
    if (trips && trips.length > 0 && !selectedTripId) {
      setSelectedTripId(trips[0].trip_id);
    }
  }, [trips, selectedTripId]);

  return (
    <div className="flex flex-col h-[100dvh] bg-background">
      {/* Header */}
      <header className="h-14 border-b flex items-center px-4 shrink-0 bg-card z-10 relative">
        <Link href="/" className="mr-4 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-6 h-6" />
        </Link>
        <h1 className="font-medium text-lg text-foreground flex items-center gap-2">
          <MapIcon className="w-5 h-5" />
          歷史紀錄地圖
        </h1>
      </header>

      {/* Controls */}
      <div className="p-4 bg-card border-b shrink-0 z-10 relative shadow-sm">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-muted-foreground">選擇行程</label>
          <div className="relative">
            <select
              value={selectedTripId}
              onChange={(e) => setSelectedTripId(e.target.value)}
              className="w-full h-10 px-3 py-2 bg-background border rounded-md text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary appearance-none"
              disabled={isTripsLoading}
              data-testid="select-trip"
            >
              {isTripsLoading ? (
                <option value="">載入行程中...</option>
              ) : trips?.length === 0 ? (
                <option value="">無歷史行程紀錄</option>
              ) : (
                trips?.map((trip) => {
                  const date = new Date(trip.start_time).toLocaleString('zh-TW', {
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit'
                  });
                  return (
                    <option key={trip.trip_id} value={trip.trip_id}>
                      {date} — {trip.record_count} 筆資料
                    </option>
                  );
                })
              )}
            </select>
            {isRecordsLoading && (
              <div className="absolute right-8 top-1/2 -translate-y-1/2">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Map Container */}
      <div className="flex-1 relative z-0">
        <div ref={mapContainerRef} className="w-full h-full" />
        
        {/* Legend Overlay */}
        <div className="absolute bottom-6 right-4 bg-card/90 backdrop-blur border shadow-md rounded-lg p-3 z-[400] flex flex-col gap-2 pointer-events-none">
          <div className="text-xs font-semibold text-foreground mb-1">搖晃等級</div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-chart-1"></div>
            <span className="text-xs text-muted-foreground">1 平穩</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-chart-2"></div>
            <span className="text-xs text-muted-foreground">2 輕微</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-chart-3"></div>
            <span className="text-xs text-muted-foreground">3 中度</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-chart-4"></div>
            <span className="text-xs text-muted-foreground">4 明顯</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-chart-5"></div>
            <span className="text-xs text-muted-foreground">5 劇烈</span>
          </div>
        </div>
      </div>
    </div>
  );
}