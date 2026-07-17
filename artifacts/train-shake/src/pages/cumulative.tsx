/**
 * 累積搖晃分析頁面
 *
 * 功能：
 *   1. 多選歷史行程，合併資料後進行 50 公尺網格化分析
 *   2. 以 Leaflet 熱力圖顯示搖晃分布（正常網格 + 樣本不足標示）
 *   3. 匯出 Excel 報告（行程清單 + 搖晃排行）
 *   4. 列印 PDF（透過瀏覽器列印功能，含格式化報告）
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useGetTrips, useComputeCumulativeAnalysis } from '@workspace/api-client-react';
import type { Trip, GridCell } from '@workspace/api-client-react';
import { Link } from 'wouter';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';
import {
  ChevronLeft,
  BarChart3,
  Loader2,
  FileSpreadsheet,
  Printer,
  CheckSquare2,
  Square,
  AlertTriangle,
  Info,
} from 'lucide-react';

export default function CumulativePage() {
  const [selectedTripIds, setSelectedTripIds] = useState<Set<string>>(new Set());
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [isExportingExcel, setIsExportingExcel] = useState(false);

  const { data: trips, isLoading: isTripsLoading } = useGetTrips();
  const computeAnalysis = useComputeCumulativeAnalysis();

  /** 已計算完成的網格資料，null 表示尚未執行分析 */
  const grids: GridCell[] | null = computeAnalysis.data?.grids ?? null;
  const isAnalyzing = computeAnalysis.isPending;

  // 地圖 refs
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const heatLayerRef = useRef<any>(null);
  const insufficientLayerRef = useRef<L.LayerGroup | null>(null);

  // 初始化地圖（元件掛載後建立一次）
  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = L.map(mapContainerRef.current).setView([23.6978, 120.9605], 8);

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

  /**
   * 當分析結果更新時，重繪地圖圖層
   *   正常網格（樣本充足）→ leaflet.heat 熱力圖，依搖晃指數著色
   *   樣本不足網格      → 灰色圓圈標記，懸停顯示實際數值
   */
  useEffect(() => {
    if (!mapRef.current || grids === null) return;

    // 清除先前的圖層
    if (heatLayerRef.current) {
      mapRef.current.removeLayer(heatLayerRef.current);
      heatLayerRef.current = null;
    }
    if (insufficientLayerRef.current) {
      mapRef.current.removeLayer(insufficientLayerRef.current);
      insufficientLayerRef.current = null;
    }

    if (grids.length === 0) return;

    const normalGrids = grids.filter((g) => !g.insufficient_samples);
    const insufficientGrids = grids.filter((g) => g.insufficient_samples);

    // 正常網格 → 熱力圖
    if (normalGrids.length > 0) {
      const heatData = normalGrids.map((g) => [
        g.lat,
        g.lng,
        Math.min(Math.max(g.shake_index / 5, 0.1), 1),
      ] as [number, number, number]);

      heatLayerRef.current = (L as any)
        .heatLayer(heatData, {
          radius: 22,
          blur: 15,
          maxZoom: 16,
          max: 1.0,
          gradient: {
            0.2: '#16a34a',
            0.4: '#84cc16',
            0.6: '#eab308',
            0.8: '#f97316',
            1.0: '#ef4444',
          },
        })
        .addTo(mapRef.current);
    }

    // 樣本不足網格 → 灰色圓圈
    if (insufficientGrids.length > 0) {
      const markers = insufficientGrids.map((g) =>
        L.circleMarker([g.lat, g.lng], {
          radius: 7,
          color: '#9ca3af',
          fillColor: '#9ca3af',
          fillOpacity: 0.45,
          weight: 1,
        }).bindTooltip(
          `搖晃指數：${g.shake_index.toFixed(3)}<br>累積筆數：${g.count} 筆（樣本不足）`,
          { sticky: true },
        ),
      );
      insufficientLayerRef.current = L.layerGroup(markers).addTo(mapRef.current);
    }

    // 縮放至資料範圍
    const allLats = grids.map((g) => g.lat);
    const allLngs = grids.map((g) => g.lng);
    const bounds = L.latLngBounds(
      [Math.min(...allLats), Math.min(...allLngs)],
      [Math.max(...allLats), Math.max(...allLngs)],
    );
    mapRef.current.fitBounds(bounds, { padding: [50, 50] });
  }, [grids]);

  // --- 行程選擇 handlers ---
  const toggleTrip = useCallback((tripId: string) => {
    setSelectedTripIds((prev) => {
      const next = new Set(prev);
      if (next.has(tripId)) {
        next.delete(tripId);
      } else {
        next.add(tripId);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (!trips) return;
    setSelectedTripIds(new Set(trips.map((t) => t.trip_id)));
  }, [trips]);

  const deselectAll = useCallback(() => {
    setSelectedTripIds(new Set());
  }, []);

  // --- 執行累積分析 ---
  const handleAnalyze = useCallback(() => {
    setAnalysisError(null);
    computeAnalysis.mutate(
      { data: { trip_ids: Array.from(selectedTripIds) } },
      {
        onError: () => {
          setAnalysisError('累積分析失敗，請確認伺服器連線後再試。');
        },
      },
    );
  }, [selectedTripIds, computeAnalysis]);

  // --- 匯出 Excel ---
  const handleExportExcel = useCallback(async () => {
    setIsExportingExcel(true);
    try {
      const response = await fetch('/api/export/excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trip_ids: Array.from(selectedTripIds) }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `shake-analysis-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Excel 匯出錯誤：', err);
      alert('Excel 匯出失敗，請稍後再試。');
    } finally {
      setIsExportingExcel(false);
    }
  }, [selectedTripIds]);

  // 用於列印報告的計算值
  const selectedTrips = (trips ?? []).filter((t) => selectedTripIds.has(t.trip_id));
  const top20 = grids
    ? [...grids].sort((a, b) => b.shake_index - a.shake_index).slice(0, 20)
    : [];
  const normalCount = grids?.filter((g) => !g.insufficient_samples).length ?? 0;
  const insufficientCount = grids?.filter((g) => g.insufficient_samples).length ?? 0;
  const totalPoints = grids?.reduce((s, g) => s + g.count, 0) ?? 0;

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      {/* 頁首 */}
      <header className="h-14 border-b flex items-center px-4 shrink-0 bg-card print:hidden">
        <Link href="/" className="mr-4 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-6 h-6" />
        </Link>
        <h1 className="font-medium text-lg text-foreground flex items-center gap-2">
          <BarChart3 className="w-5 h-5" />
          累積搖晃分析
        </h1>
      </header>

      {/* 主體 */}
      <main className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto print:hidden">

        {/* 行程選擇卡片 */}
        <section className="bg-card rounded-xl border">
          <div className="p-4 border-b flex items-center justify-between">
            <div>
              <h2 className="font-medium text-foreground">選擇行程</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                勾選要納入分析的行程（可複選），再點擊「產生累積分析」
              </p>
            </div>
            {!isTripsLoading && trips && trips.length > 0 && (
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={selectAll}
                  className="text-xs px-2.5 py-1.5 rounded border bg-secondary text-secondary-foreground hover:bg-secondary/80"
                >
                  全選
                </button>
                <button
                  onClick={deselectAll}
                  className="text-xs px-2.5 py-1.5 rounded border bg-secondary text-secondary-foreground hover:bg-secondary/80"
                >
                  取消全選
                </button>
              </div>
            )}
          </div>

          <div className="divide-y max-h-64 overflow-y-auto">
            {isTripsLoading ? (
              <div className="flex items-center justify-center p-8 text-muted-foreground gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">載入行程清單中...</span>
              </div>
            ) : trips?.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                尚無歷史行程紀錄
              </div>
            ) : (
              trips?.map((trip) => {
                const isSelected = selectedTripIds.has(trip.trip_id);
                return (
                  <label
                    key={trip.trip_id}
                    className={`flex items-start gap-3 p-3 cursor-pointer transition-colors ${
                      isSelected ? 'bg-primary/5' : 'hover:bg-secondary/50'
                    }`}
                  >
                    <div className="mt-0.5 shrink-0">
                      {isSelected ? (
                        <CheckSquare2 className="w-5 h-5 text-primary" />
                      ) : (
                        <Square className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={isSelected}
                      onChange={() => toggleTrip(trip.trip_id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground">
                        {formatDate(trip.start_time)}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-xs text-muted-foreground">
                          {trip.record_count} 筆資料
                        </span>
                        {trip.note && (
                          <span className="text-xs text-foreground bg-secondary px-1.5 py-0.5 rounded max-w-[160px] truncate">
                            {trip.note}
                          </span>
                        )}
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>

          <div className="p-4 border-t flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              已選 <span className="font-semibold text-foreground">{selectedTripIds.size}</span> 筆行程
            </span>
            <button
              onClick={handleAnalyze}
              disabled={selectedTripIds.size === 0 || isAnalyzing}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium transition-transform active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none"
            >
              {isAnalyzing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <BarChart3 className="w-4 h-4" />
              )}
              {isAnalyzing ? '分析中...' : '產生累積分析'}
            </button>
          </div>
        </section>

        {/* 分析錯誤提示 */}
        {analysisError && (
          <div className="flex items-center gap-2 p-3 rounded-lg border bg-destructive/10 border-destructive/20 text-destructive text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {analysisError}
          </div>
        )}

        {/* 分析結果 */}
        {grids !== null && (
          <>
            {/* 統計摘要 */}
            <section className="grid grid-cols-3 gap-3">
              <div className="bg-card rounded-xl border p-4 flex flex-col items-center">
                <span className="text-2xl font-bold text-foreground">{grids.length}</span>
                <span className="text-xs text-muted-foreground mt-1 text-center">網格總數</span>
              </div>
              <div className="bg-card rounded-xl border p-4 flex flex-col items-center">
                <span className="text-2xl font-bold text-foreground">{totalPoints}</span>
                <span className="text-xs text-muted-foreground mt-1 text-center">累積筆數</span>
              </div>
              <div className="bg-card rounded-xl border p-4 flex flex-col items-center">
                <span className="text-2xl font-bold text-muted-foreground">{insufficientCount}</span>
                <span className="text-xs text-muted-foreground mt-1 text-center">樣本不足網格</span>
              </div>
            </section>

            {grids.length === 0 && (
              <div className="flex items-center justify-center gap-2 p-6 bg-card rounded-xl border text-muted-foreground text-sm">
                <Info className="w-4 h-4 shrink-0" />
                選取的行程中無可分析的紀錄資料
              </div>
            )}

            {/* 熱力圖 */}
            {grids.length > 0 && (
              <section className="bg-card rounded-xl border overflow-hidden">
                <div className="h-72 relative">
                  <div ref={mapContainerRef} className="w-full h-full" />
                  {/* 圖例 */}
                  <div className="absolute bottom-3 right-3 bg-card/90 backdrop-blur border shadow rounded-lg p-2.5 z-[400] flex flex-col gap-1.5 pointer-events-none text-xs">
                    <div className="font-semibold text-foreground mb-0.5">圖層說明</div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-chart-1 opacity-90"></div>
                      <span className="text-muted-foreground">1 平穩</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-chart-3 opacity-90"></div>
                      <span className="text-muted-foreground">3 中度</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-chart-5 opacity-90"></div>
                      <span className="text-muted-foreground">5 劇烈</span>
                    </div>
                    <div className="flex items-center gap-1.5 pt-1 border-t mt-0.5">
                      <div className="w-3 h-3 rounded-full bg-gray-400 opacity-60 border border-gray-400"></div>
                      <span className="text-muted-foreground">樣本不足</span>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* 匯出按鈕 */}
            {grids.length > 0 && (
              <section className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => window.print()}
                  className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg border bg-card text-foreground text-sm font-medium hover:bg-secondary transition-colors"
                >
                  <Printer className="w-4 h-4" />
                  列印 / 匯出 PDF
                </button>
                <button
                  onClick={handleExportExcel}
                  disabled={isExportingExcel}
                  className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg border bg-card text-foreground text-sm font-medium hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  {isExportingExcel ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <FileSpreadsheet className="w-4 h-4" />
                  )}
                  匯出 Excel
                </button>
              </section>
            )}
          </>
        )}
      </main>

      {/* ---- 列印專用報告（螢幕隱藏，列印時顯示） ---- */}
      <div className="hidden print:block p-8 text-black bg-white">
        <h1 className="text-2xl font-bold mb-1">火車搖晃分析報告</h1>
        <p className="text-sm text-gray-500 mb-6">
          產生時間：{new Date().toLocaleString('zh-TW')}
        </p>

        {/* 行程清單 */}
        <h2 className="text-base font-bold mb-2 border-b pb-1">納入分析行程</h2>
        <table className="w-full text-sm mb-8 border-collapse">
          <thead>
            <tr className="border-b-2 border-black">
              <th className="text-left py-1 pr-4 font-semibold">開始時間</th>
              <th className="text-left py-1 pr-4 font-semibold">資料筆數</th>
              <th className="text-left py-1 font-semibold">備註</th>
            </tr>
          </thead>
          <tbody>
            {selectedTrips.map((trip) => (
              <tr key={trip.trip_id} className="border-b border-gray-200">
                <td className="py-1 pr-4">{formatDate(trip.start_time)}</td>
                <td className="py-1 pr-4">{trip.record_count} 筆</td>
                <td className="py-1">{trip.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 搖晃排行 */}
        {top20.length > 0 && (
          <>
            <h2 className="text-base font-bold mb-2 border-b pb-1">
              最嚴重搖晃網格排行（前 {top20.length} 名）
            </h2>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b-2 border-black">
                  <th className="text-left py-1 pr-3 font-semibold">排名</th>
                  <th className="text-left py-1 pr-3 font-semibold">緯度</th>
                  <th className="text-left py-1 pr-3 font-semibold">經度</th>
                  <th className="text-left py-1 pr-3 font-semibold">搖晃指數</th>
                  <th className="text-left py-1 pr-3 font-semibold">累積筆數</th>
                  <th className="text-left py-1 font-semibold">樣本不足</th>
                </tr>
              </thead>
              <tbody>
                {top20.map((grid, i) => (
                  <tr key={i} className="border-b border-gray-200">
                    <td className="py-1 pr-3 font-mono">{i + 1}</td>
                    <td className="py-1 pr-3 font-mono">{grid.lat.toFixed(6)}</td>
                    <td className="py-1 pr-3 font-mono">{grid.lng.toFixed(6)}</td>
                    <td className="py-1 pr-3 font-mono font-semibold">
                      {grid.shake_index.toFixed(4)}
                    </td>
                    <td className="py-1 pr-3">{grid.count}</td>
                    <td className="py-1">{grid.insufficient_samples ? '是' : '否'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <p className="text-xs text-gray-400 mt-8">
          本報告由火車搖晃紀錄系統自動產生，僅供工程分析參考使用。
        </p>
      </div>
    </div>
  );
}
