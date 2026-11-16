import React, { useState, useMemo } from 'react';
import { Download, ChevronDown, ChevronUp, X } from 'lucide-react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TooltipContentProps } from 'recharts';
import type { DiscrepancyGridResult, ElevationProfileResult, ProfileSample } from '../types/geospatial';

interface TelemetryTrayProps {
  profile: ElevationProfileResult | null;
  discrepancyGrid: DiscrepancyGridResult | null;
  activeTab: 'profile' | 'discrepancy';
  onChangeTab: (tab: 'profile' | 'discrepancy') => void;
  onHoverSample: (sample: ProfileSample | null) => void;
  onCloseTray: () => void;
}

const TerrainProfileTooltip: React.FC<Partial<TooltipContentProps>> = ({
  active,
  payload,
}) => {
  if (!active || !payload || payload.length === 0) return null;
  const sample = payload[0]?.payload as ProfileSample | undefined;
  if (!sample) return null;

  return (
    <div className="bg-white border border-slate-200 rounded-md shadow-sm px-2.5 py-2 text-[11px] font-mono tabular-nums text-slate-700 space-y-1">
      <div className="flex items-center justify-between gap-3 pb-1 border-b border-slate-100 text-[10px] text-slate-500">
        <span>{sample.distanceKm.toFixed(2)} km</span>
        <span>
          {sample.lat.toFixed(4)}°, {sample.lon.toFixed(4)}°
        </span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-slate-600">SRTM 30m</span>
        <strong className="text-blue-700">
          {sample.srtmMeters !== null ? `${sample.srtmMeters.toFixed(1)} m` : 'N/A'}
        </strong>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-slate-600">ASTER 30m</span>
        <strong className="text-amber-700">
          {sample.asterMeters !== null ? `${sample.asterMeters.toFixed(1)} m` : 'N/A'}
        </strong>
      </div>
      <div className="flex items-center justify-between gap-4 pt-0.5 border-t border-slate-100">
        <span className="text-slate-500">Δh (ASTER − SRTM)</span>
        <strong className="text-slate-900">
          {sample.deltaMeters !== null
            ? `${sample.deltaMeters > 0 ? '+' : ''}${sample.deltaMeters.toFixed(1)} m`
            : 'N/A'}
        </strong>
      </div>
    </div>
  );
};

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
  const [showSrtm, setShowSrtm] = useState(true);
  const [showAster, setShowAster] = useState(true);

  const chartBounds = useMemo(() => {
    if (!profile || profile.samples.length === 0) return null;
    const vals: number[] = [];
    let srtmCount = 0;
    let asterCount = 0;
    for (const s of profile.samples) {
      if (s.srtmMeters !== null) {
        vals.push(s.srtmMeters);
        srtmCount++;
      }
      if (s.asterMeters !== null) {
        vals.push(s.asterMeters);
        asterCount++;
      }
    }
    if (vals.length === 0) return null;
    const rawMin = Math.min(...vals);
    const rawMax = Math.max(...vals);
    const pad = Math.max(15, (rawMax - rawMin) * 0.12);
    return {
      minElev: Math.floor(rawMin - pad),
      maxElev: Math.ceil(rawMax + pad),
      maxDist: Math.max(0.01, profile.totalDistanceKm),
      hasSrtm: srtmCount >= 2,
      hasAster: asterCount >= 2,
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

  const toggleSrtm = () => {
    if (showSrtm && !showAster) return;
    setShowSrtm((v) => !v);
  };

  const toggleAster = () => {
    if (showAster && !showSrtm) return;
    setShowAster((v) => !v);
  };

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
        <div className="h-[228px] px-4 py-3 flex items-stretch gap-5">
          {activeTab === 'profile' && profile && (
            <>
              {/* Recharts Terrain Elevation Profile Chart */}
              <div className="flex-1 min-w-0 flex flex-col">
                <div className="flex items-center justify-between text-[11px] mb-1.5 gap-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={toggleSrtm}
                      className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] transition-colors cursor-pointer whitespace-nowrap ${
                        showSrtm
                          ? 'bg-blue-50/70 border-blue-200 text-slate-800'
                          : 'bg-white border-slate-200 text-slate-400'
                      }`}
                    >
                      <span className="w-3 h-0.5 bg-blue-600 inline-block" />
                      NASA SRTM 30m
                    </button>
                    <button
                      type="button"
                      onClick={toggleAster}
                      className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] transition-colors cursor-pointer whitespace-nowrap ${
                        showAster
                          ? 'bg-amber-50/70 border-amber-200 text-slate-800'
                          : 'bg-white border-slate-200 text-slate-400'
                      }`}
                    >
                      <span className="w-3 h-0.5 border-b-2 border-dashed border-amber-600 inline-block" />
                      NASA/METI ASTER 30m
                    </button>
                  </div>

                  {hoveredSample ? (
                    <div className="font-mono tabular-nums text-[11px] text-slate-800 flex items-center gap-3 truncate">
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
                    <span className="text-[11px] text-slate-400 truncate">
                      Hover chart to inspect elevation &amp; scrub 3D transect marker
                    </span>
                  )}
                </div>

                {chartBounds ? (
                  <div className="relative flex-1 min-h-0 w-full border border-slate-200 rounded bg-[#F8FAFC] pr-1 pt-1.5 pb-0.5">
                    <ResponsiveContainer width="100%" height="100%" minWidth={200} minHeight={120}>
                      <ComposedChart
                        data={profile.samples}
                        margin={{ top: 6, right: 14, left: 2, bottom: 2 }}
                        onMouseMove={(state) => {
                          const rawIdx = state?.activeTooltipIndex;
                          const idx =
                            typeof rawIdx === 'number'
                              ? rawIdx
                              : typeof rawIdx === 'string' && rawIdx !== ''
                                ? Number(rawIdx)
                                : NaN;
                          if (Number.isInteger(idx) && idx >= 0 && idx < profile.samples.length) {
                            setHoveredIdx(idx);
                            onHoverSample(profile.samples[idx]);
                          }
                        }}
                        onMouseLeave={() => {
                          setHoveredIdx(null);
                          onHoverSample(null);
                        }}
                      >
                        <defs>
                          <linearGradient id="srtmTerrainFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#2563EB" stopOpacity={0.24} />
                            <stop offset="85%" stopColor="#2563EB" stopOpacity={0.05} />
                            <stop offset="100%" stopColor="#2563EB" stopOpacity={0.01} />
                          </linearGradient>
                          <linearGradient id="asterTerrainFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#D97706" stopOpacity={0.2} />
                            <stop offset="100%" stopColor="#D97706" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" />
                        <XAxis
                          dataKey="distanceKm"
                          type="number"
                          domain={[0, chartBounds.maxDist]}
                          tickFormatter={(v) => `${Number(v).toFixed(1)} km`}
                          tick={{
                            fontSize: 10,
                            fill: '#64748B',
                            fontFamily: 'IBM Plex Mono, monospace',
                          }}
                          stroke="#CBD5E1"
                          tickLine={false}
                          minTickGap={40}
                        />
                        <YAxis
                          domain={[chartBounds.minElev, chartBounds.maxElev]}
                          width={54}
                          tickFormatter={(v) => `${Math.round(Number(v))} m`}
                          tick={{
                            fontSize: 10,
                            fill: '#64748B',
                            fontFamily: 'IBM Plex Mono, monospace',
                          }}
                          stroke="#CBD5E1"
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip
                          cursor={{ stroke: '#0F172A', strokeWidth: 1, strokeDasharray: '2 2' }}
                          content={<TerrainProfileTooltip />}
                        />
                        {chartBounds.minElev < 0 && chartBounds.maxElev > 0 && (
                          <ReferenceLine
                            y={0}
                            stroke="#94A3B8"
                            strokeDasharray="4 4"
                            label={{
                              value: 'MSL 0m',
                              position: 'insideTopRight',
                              fill: '#64748B',
                              fontSize: 9,
                              fontFamily: 'IBM Plex Mono, monospace',
                            }}
                          />
                        )}
                        {showSrtm && chartBounds.hasSrtm && (
                          <Area
                            type="monotone"
                            dataKey="srtmMeters"
                            name="NASA SRTM 30m"
                            stroke="#2563EB"
                            strokeWidth={2}
                            fill="url(#srtmTerrainFill)"
                            baseValue={chartBounds.minElev}
                            connectNulls
                            isAnimationActive={false}
                            dot={false}
                            activeDot={{
                              r: 3.5,
                              fill: '#2563EB',
                              stroke: '#FFFFFF',
                              strokeWidth: 1.5,
                            }}
                          />
                        )}
                        {showAster &&
                          chartBounds.hasAster &&
                          (!showSrtm || !chartBounds.hasSrtm ? (
                            <Area
                              type="monotone"
                              dataKey="asterMeters"
                              name="NASA/METI ASTER 30m"
                              stroke="#D97706"
                              strokeWidth={1.75}
                              strokeDasharray="5 3"
                              fill="url(#asterTerrainFill)"
                              baseValue={chartBounds.minElev}
                              connectNulls
                              isAnimationActive={false}
                              dot={false}
                              activeDot={{
                                r: 3.5,
                                fill: '#D97706',
                                stroke: '#FFFFFF',
                                strokeWidth: 1.5,
                              }}
                            />
                          ) : (
                            <Line
                              type="monotone"
                              dataKey="asterMeters"
                              name="NASA/METI ASTER 30m"
                              stroke="#D97706"
                              strokeWidth={1.75}
                              strokeDasharray="5 3"
                              connectNulls
                              isAnimationActive={false}
                              dot={false}
                              activeDot={{
                                r: 3.5,
                                fill: '#D97706',
                                stroke: '#FFFFFF',
                                strokeWidth: 1.5,
                              }}
                            />
                          ))}
                      </ComposedChart>
                    </ResponsiveContainer>
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
