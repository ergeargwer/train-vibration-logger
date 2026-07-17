import { useEffect, useRef, useState, useCallback } from 'react';
import { useGetTrips, useGetTripRecords, useUpdateTripNote } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ChevronLeft, Map as MapIcon, Loader2, Pencil, Check, X } from 'lucide-react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';

export default function MapPage() {
  const queryClient = useQueryClient();
  const [selectedTripId, setSelectedTripId] = useState<string>('');

  // 備註編輯狀態
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [editNoteValue, setEditNoteValue] = useState('');

  const { data: trips, isLoading: isTripsLoading, refetch: refetchTrips } = useGetTrips();
  const { data: tripDetail, isLoading: isRecordsLoading } = useGetTripRecords(selectedTripId, {
    query: {
      enabled: !!selectedTripId,
      queryKey: ['trip', selectedTripId],
    },
  });

  const updateNote = useUpdateTripNote();

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const heatLayerRef = useRef<any>(null);

  // 初始化地圖
  useEffect(() => {
    if (!mapContainerRef.current) return;

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

  // 更新熱力圖
  useEffect(() => {
    if (!mapRef.current) return;

    if (heatLayerRef.current) {
      mapRef.current.removeLayer(heatLayerRef.current);
      heatLayerRef.current = null;
    }

    if (tripDetail && tripDetail.records.length > 0) {
      const heatData = tripDetail.records.map((r) => {
        const intensity = Math.min(Math.max(r.shake_index / 5, 0.1), 1);
        return [r.lat, r.lng, intensity] as [number, number, number];
      });

      const heatOptions = {
        radius: 20,
        blur: 15,
        maxZoom: 15,
        max: 1.0,
        gradient: {
          0.2: '#16a34a',
          0.4: '#84cc16',
          0.6: '#eab308',
          0.8: '#f97316',
          1.0: '#ef4444',
        },
      };

      heatLayerRef.current = (L as any).heatLayer(heatData, heatOptions).addTo(mapRef.current);

      const lats = tripDetail.records.map((r) => r.lat);
      const lngs = tripDetail.records.map((r) => r.lng);
      const bounds = L.latLngBounds(
        [Math.min(...lats), Math.min(...lngs)],
        [Math.max(...lats), Math.max(...lngs)],
      );
      mapRef.current.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [tripDetail]);

  // 自動選取最新行程
  useEffect(() => {
    if (trips && trips.length > 0 && !selectedTripId) {
      setSelectedTripId(trips[0].trip_id);
    }
  }, [trips, selectedTripId]);

  // 切換行程時關閉備註編輯模式
  useEffect(() => {
    setIsEditingNote(false);
  }, [selectedTripId]);

  // 取得目前選取行程的備註
  const selectedTrip = trips?.find((t) => t.trip_id === selectedTripId);

  const handleEditStart = useCallback(() => {
    setEditNoteValue(selectedTrip?.note ?? '');
    setIsEditingNote(true);
  }, [selectedTrip]);

  const handleEditCancel = useCallback(() => {
    setIsEditingNote(false);
    setEditNoteValue('');
  }, []);

  const handleEditSave = useCallback(() => {
    if (!selectedTripId) return;

    const noteToSave = editNoteValue.trim() || null;
    updateNote.mutate(
      { tripId: selectedTripId, data: { note: noteToSave } },
      {
        onSuccess: () => {
          setIsEditingNote(false);
          // 重新取得行程列表以更新備註顯示
          refetchTrips();
        },
        onError: () => {
          alert('備註更新失敗，請稍後再試。');
        },
      },
    );
  }, [selectedTripId, editNoteValue, updateNote, refetchTrips]);

  return (
    <div className="flex flex-col h-[100dvh] bg-background">
      {/* 頁首 */}
      <header className="h-14 border-b flex items-center px-4 shrink-0 bg-card z-10 relative">
        <Link href="/" className="mr-4 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-6 h-6" />
        </Link>
        <h1 className="font-medium text-lg text-foreground flex items-center gap-2">
          <MapIcon className="w-5 h-5" />
          歷史紀錄地圖
        </h1>
      </header>

      {/* 控制列 */}
      <div className="p-4 bg-card border-b shrink-0 z-10 relative shadow-sm">
        <div className="flex flex-col gap-3">
          {/* 行程選擇 */}
          <div className="flex flex-col gap-1.5">
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
                      year: 'numeric',
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    });
                    return (
                      <option key={trip.trip_id} value={trip.trip_id}>
                        {date} — {trip.record_count} 筆{trip.note ? ` — ${trip.note}` : ''}
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

          {/* 備註顯示與編輯 */}
          {selectedTripId && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-muted-foreground">行程備註</label>

              {!isEditingNote ? (
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-foreground min-h-[2rem] flex items-center px-3 py-1.5 bg-background border rounded-md">
                    {selectedTrip?.note ? (
                      selectedTrip.note
                    ) : (
                      <span className="text-muted-foreground italic">尚無備註</span>
                    )}
                  </span>
                  <button
                    onClick={handleEditStart}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors shrink-0"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    編輯
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={editNoteValue}
                    onChange={(e) => setEditNoteValue(e.target.value)}
                    placeholder="輸入備註（如：尖峰時段、施工路段）"
                    className="flex-1 h-9 px-3 text-sm bg-background border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleEditSave();
                      if (e.key === 'Escape') handleEditCancel();
                    }}
                    autoFocus
                  />
                  <button
                    onClick={handleEditSave}
                    disabled={updateNote.isPending}
                    className="flex items-center justify-center w-9 h-9 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 shrink-0"
                    title="儲存"
                  >
                    {updateNote.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={handleEditCancel}
                    className="flex items-center justify-center w-9 h-9 rounded-md border bg-card hover:bg-secondary shrink-0"
                    title="取消"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 地圖容器 */}
      <div className="flex-1 relative z-0">
        <div ref={mapContainerRef} className="w-full h-full" />

        {/* 圖例 */}
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
