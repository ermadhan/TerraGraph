import React, { useState, useMemo } from 'react';
import { Download, ChevronDown, ChevronUp, X } from 'lucide-react';
import type { DiscrepancyGridResult, ElevationProfileResult, ProfileSample } from '../types/geospatial';

interface TelemetryTrayProps {
  profile: ElevationProfileResult | null;
  discrepancyGrid: DiscrepancyGridResult | null;
  activeTab: 'profile' | 'discrepancy';
  onChangeTab: (tab: 'profile' | 'discrepancy') => void;
  onHoverSample: (sample: ProfileSample | null) => void;
  onCloseTray: () => void;
}

export const TelemetryTray: React.FC<TelemetryTrayProps> = ({
  profile,
  discrepancyGrid,
  activeTab,
  onChangeTab,
  onHoverSample,
  onCloseTray,
}) => {
  const [minimized, setMinimized] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const chartBounds = useMemo(() => {
    if (!profile || profile.samples.length === 0) return null;
    const vals: number[] = [];
    for (const s of profile.samples) {
      if (s.srtmMeters !== null) vals.push(s.srtmMeters);
      if (s.asterMeters !== null) vals.push(s.asterMeters);
    }
    if (vals.length === 0) return null;
    const rawMin = Math.min(...vals);
    const rawMax = Math.max(...vals);
    const pad = Math.max(15, (rawMax - rawMin) * 0.12);
    return {
      minElev: rawMin - pad,
      maxElev: rawMax + pad,
      maxDist: Math.max(0.01, profile.totalDistanceKm),
    };
  }, [profile]);

  const histogramBins = useMemo(() => {
    if (!discrepancyGrid) return [];
    const bins = [
      { label: '< -20m', min: -Infinity, max: -20, count: 0, color: '#1D4ED8' },
      { label: '-20..-10', min: -20, max: -10, count: 0, color: '#38BDF8' },
      { label: '-10..-3', min: -10, max: -3, count: 0, color: '#93C5FD' },
      { label: '-3..+3', min: -3, max: 3, count: 0, color: '#CBD5E1' },
      { label: '+3..+10', min: 3, max: 10, count: 0, color: '#FCD34D' },
      { label: '+10..+20', min: 10, max: 20, count: 0, color: '#F59E0B' },
      { label: '> +20m', min: 20, max: Infinity, count: 0, color: '#DC2626' },
    ];
    for (const c of discrepancyGrid.cells) {
      if (c.deltaMeters === null) continue;
      for (const b of bins) {
        if (c.deltaMeters >= b.min && c.deltaMeters < b.max) {
          b.count++;
          break;
        }
      }
    }
    const maxCount = Math.max(1, ...bins.map((b) => b.count));
    return bins.map((b) => ({ ...b, pct: (b.count / maxCount) * 100 }));
  }, [discrepancyGrid]);

  if (!profile && !discrepancyGrid) return null;

  const handleExportCsv = () => {
    if (activeTab === 'profile' && profile) {
      const header = 'index,distance_km,lon,lat,srtm30m_m,aster30m_m,delta_aster_minus_srtm_m\n';
      const rows = profile.samples
        .map(
          (s) =>
            `${s.index},${s.distanceKm},${s.lon},${s.lat},${s.srtmMeters ?? ''},${s.asterMeters ?? ''},${s.deltaMeters ?? ''}`,
        )
        .join('\n');
      const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `terragraph-profile-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } else if (activeTab === 'discrepancy' && discrepancyGrid) {
      const header = 'row,col,lon,lat,srtm30m_m,aster30m_m,delta_aster_minus_srtm_m\n';
      const rows = discrepancyGrid.cells
        .map(
          (c) =>
            `${c.row},${c.col},${c.lon},${c.lat},${c.srtmMeters ?? ''},${c.asterMeters ?? ''},${c.deltaMeters ?? ''}`,
        )
        .join('\n');
      const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `terragraph-discrepancy-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const hoveredSample =
    profile && hoveredIdx !== null && profile.samples[hoveredIdx]
      ? profile.samples[hoveredIdx]
      : null;

  return (
    <section className="shrink-0 bg-white border-t border-slate-200 z-20">
      {/* Tray Header */}
      <div className="h-9 px-4 border-b border-slate-200 bg-[#F8FAFC] flex items-center justify-between gap-4">
        <div className="flex items-center gap-1">
          {profile && (
            <button
              type="button"
              onClick={() => onChangeTab('profile')}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'profile'
                  ? 'bg-white text-slate-900 border border-slate-200 shadow-2xs'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              Elevation Cross-Section
            </button>
          )}
          {discrepancyGrid && (
            <button
              type="button"
              onClick={() => onChangeTab('discrepancy')}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'discrepancy'
                  ? 'bg-white text-slate-900 border border-slate-200 shadow-2xs'
                  : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              SRTM vs. ASTER Discrepancy
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExportCsv}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 whitespace-nowrap cursor-pointer"
          >
            <Download className="w-3 h-3" />
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => setMinimized((m) => !m)}
            title={minimized ? 'Expand Tray' : 'Minimize Tray'}
            className="p-1 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-200/60 cursor-pointer"
          >
            {minimized ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={onCloseTray}
            title="Close Telemetry Tray"
            className="p-1 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-200/60 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {!minimized && (
        <div className="h-[210px] px-4 py-3 flex items-stretch gap-5">
          {activeTab === 'profile' && profile && (
            <>
              {/* SVG Dual-Axis Profile Chart */}
              <div className="flex-1 min-w-0 flex flex-col">
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <div className="flex items-center gap-4 text-slate-600">
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-0.5 bg-blue-600 inline-block" />
                      NASA SRTM 30m
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-0.5 border-b-2 border-dashed border-amber-600 inline-block" />
                      NASA/METI ASTER 30m
                    </span>
                  </div>

                  {hoveredSample ? (
                    <div className="font-mono tabular-nums text-[11px] text-slate-800 flex items-center gap-3">
                      <span>{hoveredSample.distanceKm.toFixed(2)} km</span>
                      <span>
                        SRTM:{' '}
                        <strong className="text-blue-700">
                          {hoveredSample.srtmMeters !== null
                            ? `${hoveredSample.srtmMeters.toFixed(1)} m`
                            : 'N/A'}
                        </strong>
                      </span>
                      <span>
                        ASTER:{' '}
                        <strong className="text-amber-700">
                          {hoveredSample.asterMeters !== null
                            ? `${hoveredSample.asterMeters.toFixed(1)} m`
                            : 'N/A'}
                        </strong>
                      </span>
                      <span>
                        Δh:{' '}
                        <strong>
                          {hoveredSample.deltaMeters !== null
                            ? `${hoveredSample.deltaMeters > 0 ? '+' : ''}${hoveredSample.deltaMeters.toFixed(1)} m`
                            : 'N/A'}
                        </strong>
                      </span>
                    </div>
                  ) : (
                    <span className="text-[11px] text-slate-400">
                      Hover chart to scrub 3D transect position
                    </span>
                  )}
                </div>

                {chartBounds ? (
                  <div
                    className="relative flex-1 w-full border border-slate-200 rounded bg-[#F8FAFC]"
                    onMouseLeave={() => {
                      setHoveredIdx(null);
                      onHoverSample(null);
                    }}
                  >
                    <svg
                      viewBox="0 0 800 140"
                      preserveAspectRatio="none"
                      className="w-full h-full cursor-crosshair"
                      onMouseMove={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        const idx = Math.round(relX * (profile.samples.length - 1));
                        setHoveredIdx(idx);
                        onHoverSample(profile.samples[idx] || null);
                      }}
                    >
                      {/* Horizontal Reference Grid Lines */}
                      {[0.25, 0.5, 0.75].map((frac) => (
                        <line
                          key={frac}
                          x1={0}
                          x2={800}
                          y1={frac * 140}
                          y2={frac * 140}
                          stroke="#E2E8F0"
                          strokeWidth={1}
                        />
                      ))}

                      {/* SRTM Fill + Solid Path */}
                      {(() => {
                        const pts = profile.samples
                          .map((s, i) => {
                            if (s.srtmMeters === null) return null;
                            const x = (i / Math.max(1, profile.samples.length - 1)) * 800;
                            const y =
                              130 -
                              ((s.srtmMeters - chartBounds.minElev) /
                                Math.max(1, chartBounds.maxElev - chartBounds.minElev)) *
                                118;
                            return { x, y };
                          })
                          .filter((p): p is { x: number; y: number } => p !== null);

                        if (pts.length < 2) return null;
                        const d = pts
                          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                          .join(' ');
                        const areaD = `${d} L ${pts[pts.length - 1].x.toFixed(1)} 140 L ${pts[0].x.toFixed(1)} 140 Z`;

                        return (
                          <>
                            <path d={areaD} fill="rgba(37, 99, 235, 0.08)" />
                            <path d={d} fill="none" stroke="#2563EB" strokeWidth={2} />
                          </>
                        );
                      })()}

                      {/* ASTER Dashed Path */}
                      {(() => {
                        const pts = profile.samples
                          .map((s, i) => {
                            if (s.asterMeters === null) return null;
                            const x = (i / Math.max(1, profile.samples.length - 1)) * 800;
                            const y =
                              130 -
                              ((s.asterMeters - chartBounds.minElev) /
                                Math.max(1, chartBounds.maxElev - chartBounds.minElev)) *
                                118;
                            return { x, y };
                          })
                          .filter((p): p is { x: number; y: number } => p !== null);

                        if (pts.length < 2) return null;
                        const d = pts
                          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                          .join(' ');

                        return (
                          <path
                            d={d}
                            fill="none"
                            stroke="#D97706"
                            strokeWidth={1.75}
                            strokeDasharray="5 3"
                          />
                        );
                      })()}

                      {/* Crosshair Line */}
                      {hoveredIdx !== null && (
                        <line
                          x1={(hoveredIdx / Math.max(1, profile.samples.length - 1)) * 800}
                          x2={(hoveredIdx / Math.max(1, profile.samples.length - 1)) * 800}
                          y1={0}
                          y2={140}
                          stroke="#0F172A"
                          strokeWidth={1}
                          strokeDasharray="2 2"
                        />
                      )}
                    </svg>

                    {/* Min / Max Axis Labels */}
                    <div className="pointer-events-none absolute top-1 left-2 text-[10px] font-mono tabular-nums text-slate-400">
                      {Math.round(chartBounds.maxElev)} m
                    </div>
                    <div className="pointer-events-none absolute bottom-1 left-2 text-[10px] font-mono tabular-nums text-slate-400">
                      {Math.round(chartBounds.minElev)} m
                    </div>
                    <div className="pointer-events-none absolute bottom-1 right-2 text-[10px] font-mono tabular-nums text-slate-400">
                      {profile.totalDistanceKm.toFixed(2)} km
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-xs text-slate-400 border border-slate-200 rounded bg-[#F8FAFC]">
                    No valid terrestrial elevation samples along this transect.
                  </div>
                )}
              </div>

              {/* Profile Summary Metrics */}
              <div className="w-[260px] shrink-0 grid grid-cols-2 gap-2.5 content-start border-l border-slate-200 pl-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Transect Span
                  </div>
                  <div className="text-sm font-mono font-semibold tabular-nums text-slate-900">
                    {profile.totalDistanceKm.toFixed(2)}
                    <span className="text-[11px] font-normal text-slate-500 ml-1">km</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    RMSE (ASTER/SRTM)
                  </div>
                  <div className="text-sm font-mono font-semibold tabular-nums text-slate-900">
                    {profile.summary.rmse !== null ? profile.summary.rmse.toFixed(1) : '—'}
                    <span className="text-[11px] font-normal text-slate-500 ml-1">m</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Mean Bias (Δh)
                  </div>
                  <div className="text-sm font-mono font-semibold tabular-nums text-slate-900">
                    {profile.summary.meanBias !== null
                      ? `${profile.summary.meanBias > 0 ? '+' : ''}${profile.summary.meanBias.toFixed(1)}`
                      : '—'}
                    <span className="text-[11px] font-normal text-slate-500 ml-1">m</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Max |Δh|
                  </div>
                  <div className="text-sm font-mono font-semibold tabular-nums text-slate-900">
                    {profile.summary.maxAbsDiff !== null
                      ? profile.summary.maxAbsDiff.toFixed(1)
                      : '—'}
                    <span className="text-[11px] font-normal text-slate-500 ml-1">m</span>
                  </div>
                </div>
                <div className="col-span-2 pt-1 border-t border-slate-100 text-[11px] font-mono tabular-nums text-slate-500">
                  Gain: +{profile.summary.totalGainSrtm}m SRTM · +{profile.summary.totalGainAster}m ASTER
                </div>
              </div>
            </>
          )}

          {activeTab === 'discrepancy' && discrepancyGrid && (
            <>
              {/* Residual Distribution Histogram */}
              <div className="flex-1 min-w-0 flex flex-col">
                <div className="flex items-center justify-between text-[11px] mb-2">
                  <span className="font-medium text-slate-700">
                    Elevation Residual Distribution (Δh = ASTER 30m − SRTM 30m)
                  </span>
                  <span className="font-mono tabular-nums text-slate-500">
                    {discrepancyGrid.stats.validComparison} / {discrepancyGrid.stats.totalCells} paired cells
                  </span>
                </div>

                <div className="flex-1 grid grid-cols-7 gap-2 items-end border border-slate-200 rounded bg-[#F8FAFC] px-4 pt-4 pb-2">
                  {histogramBins.map((bin) => (
                    <div key={bin.label} className="h-full flex flex-col items-center justify-end gap-1">
                      <span className="text-[10px] font-mono tabular-nums text-slate-600">
                        {bin.count}
                      </span>
                      <div className="w-full flex-1 flex items-end">
                        <div
                          className="w-full rounded-t transition-all"
                          style={{
                            height: `${Math.max(4, bin.pct)}%`,
                            backgroundColor: bin.color,
                          }}
                        />
                      </div>
                      <span className="text-[10px] font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {bin.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Discrepancy KPI Strip */}
              <div className="w-[300px] shrink-0 grid grid-cols-2 gap-2.5 content-start border-l border-slate-200 pl-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">RMSE</div>
                  <div className="text-base font-mono font-semibold tabular-nums text-slate-900">
                    {discrepancyGrid.stats.rmse !== null
                      ? discrepancyGrid.stats.rmse.toFixed(2)
                      : '—'}
                    <span className="text-xs font-normal text-slate-500 ml-1">m</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Mean Bias
                  </div>
                  <div className="text-base font-mono font-semibold tabular-nums text-slate-900">
                    {discrepancyGrid.stats.meanBias !== null
                      ? `${discrepancyGrid.stats.meanBias > 0 ? '+' : ''}${discrepancyGrid.stats.meanBias.toFixed(2)}`
                      : '—'}
                    <span className="text-xs font-normal text-slate-500 ml-1">m</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Min / Max Δh
                  </div>
                  <div className="text-xs font-mono tabular-nums text-slate-800 mt-0.5">
                    {discrepancyGrid.stats.minDelta !== null
                      ? `${discrepancyGrid.stats.minDelta.toFixed(1)} / +${discrepancyGrid.stats.maxDelta?.toFixed(1)} m`
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Coverage
                  </div>
                  <div className="text-xs font-mono tabular-nums text-slate-800 mt-0.5">
                    SRTM {discrepancyGrid.stats.srtmCount} · ASTER {discrepancyGrid.stats.asterCount}
                  </div>
                </div>
                <div className="col-span-2 text-[11px] text-slate-500 leading-snug pt-1 border-t border-slate-100">
                  {discrepancyGrid.stats.srtmOutsideLatCoverage
                    ? 'Note: Viewport approaches SRTM C-band ±60° latitude limit; ASTER covers ±83°.'
                    : 'Positive Δh indicates ASTER optical stereo reads higher than SRTM C-band radar.'}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
};
