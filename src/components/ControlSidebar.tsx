import React, { useState, useEffect } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Globe,
  Layers,
  Sun,
  Ruler,
  Grid2x2,
  X,
  Loader2,
  MoveHorizontal,
} from 'lucide-react';
import type {
  ActiveTool,
  BuildingColorMode,
  DiscrepancyGridResult,
  ElevationRampPreset,
  GeocodeResult,
  OvertureConfig,
  OvertureLayerVisibility,
  ProjectionMode,
  TerrainMode,
} from '../types/geospatial';

interface ControlSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  projection: ProjectionMode;
  onChangeProjection: (p: ProjectionMode) => void;
  showGraticule: boolean;
  onToggleGraticule: () => void;
  onFlyToLocation: (lon: number, lat: number, label: string) => void;
  terrainMode: TerrainMode;
  onChangeTerrainMode: (mode: TerrainMode) => void;
  elevationRamp: ElevationRampPreset;
  onChangeElevationRamp: (ramp: ElevationRampPreset) => void;
  exaggeration: number;
  onChangeExaggeration: (val: number) => void;
  sunAzimuth: number;
  onChangeSunAzimuth: (deg: number) => void;
  hillshadeIntensity: number;
  onChangeHillshadeIntensity: (val: number) => void;
  overtureConfig: OvertureConfig | null;
  overtureLayers: OvertureLayerVisibility;
  onToggleOvertureLayer: (key: keyof OvertureLayerVisibility) => void;
  buildingColorMode: BuildingColorMode;
  onChangeBuildingColorMode: (mode: BuildingColorMode) => void;
  activeTool: ActiveTool;
  onSetActiveTool: (tool: ActiveTool) => void;
  transectVerticesCount: number;
  onRunProfile: () => void;
  onClearProfile: () => void;
  profileLoading: boolean;
  profileError: string | null;
  hasDistanceMeasurement: boolean;
  onClearDistance: () => void;
  onComputeDiscrepancy: () => void;
  discrepancyLoading: boolean;
  discrepancyError: string | null;
  discrepancyGrid: DiscrepancyGridResult | null;
  discrepancyOpacity: number;
  onChangeDiscrepancyOpacity: (val: number) => void;
  onClearDiscrepancy: () => void;
}

export const ControlSidebar: React.FC<ControlSidebarProps> = ({
  collapsed,
  onToggleCollapse,
  projection,
  onChangeProjection,
  showGraticule,
  onToggleGraticule,
  onFlyToLocation,
  terrainMode,
  onChangeTerrainMode,
  elevationRamp,
  onChangeElevationRamp,
  exaggeration,
  onChangeExaggeration,
  sunAzimuth,
  onChangeSunAzimuth,
  hillshadeIntensity,
  onChangeHillshadeIntensity,
  overtureConfig,
  overtureLayers,
  onToggleOvertureLayer,
  buildingColorMode,
  onChangeBuildingColorMode,
  activeTool,
  onSetActiveTool,
  transectVerticesCount,
  onRunProfile,
  onClearProfile,
  profileLoading,
  profileError,
  hasDistanceMeasurement,
  onClearDistance,
  onComputeDiscrepancy,
  discrepancyLoading,
  discrepancyError,
  discrepancyGrid,
  discrepancyOpacity,
  onChangeDiscrepancyOpacity,
  onClearDiscrepancy,
}) => {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<GeocodeResult[]>([]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as { results?: GeocodeResult[] };
          setResults(data.results || []);
        }
      } catch {
        // Ignore aborted requests
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  if (collapsed) {
    return (
      <aside className="w-11 shrink-0 bg-white border-r border-slate-200 flex flex-col items-center py-3 z-20">
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expand Controls"
          className="w-8 h-8 flex items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-[320px] shrink-0 bg-white border-r border-slate-200 flex flex-col h-full overflow-hidden z-20">
      <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between bg-[#F8FAFC]">
        <span className="text-xs font-semibold tracking-wide text-slate-700">
          Telemetry & Layer Controls
        </span>
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Collapse Controls"
          className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:bg-slate-200/60 hover:text-slate-900 cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-slate-200">
        {/* 1. Search & Projection */}
        <section className="p-4 space-y-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search city, peak, or valley..."
              className="w-full pl-8 pr-7 py-1.5 text-xs bg-[#F8FAFC] border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:bg-white"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setResults([]);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}

            {results.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-md shadow-md z-30 max-h-56 overflow-y-auto divide-y divide-slate-100">
                {results.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      onFlyToLocation(r.longitude, r.latitude, r.name);
                      setQuery('');
                      setResults([]);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    <div className="text-xs font-medium text-slate-900 truncate">{r.name}</div>
                    <div className="text-[11px] text-slate-500 font-mono tabular-nums truncate">
                      {[r.admin1, r.country].filter(Boolean).join(', ')} ·{' '}
                      {r.latitude.toFixed(3)}, {r.longitude.toFixed(3)}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {searching && (
              <div className="mt-1 text-[11px] text-slate-400">Searching coordinates...</div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-600 flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-slate-400" />
              Projection
            </span>
            <div className="flex items-center bg-slate-100 p-0.5 rounded-md">
              <button
                type="button"
                onClick={() => onChangeProjection('globe')}
                className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  projection === 'globe'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                3D Globe
              </button>
              <button
                type="button"
                onClick={() => onChangeProjection('mercator')}
                className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  projection === 'mercator'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Mercator
              </button>
            </div>
          </div>

          <label className="flex items-center justify-between text-xs text-slate-600 cursor-pointer select-none pt-0.5">
            <span>1° Graticule Grid (Lat/Lon)</span>
            <input
              type="checkbox"
              checked={showGraticule}
              onChange={onToggleGraticule}
              className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
            />
          </label>
        </section>

        {/* 2. Terrain & DEM Shading */}
        <section className="p-4 space-y-3.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-900">NASA SRTM & ASTER Terrain</h2>
            <span className="text-[11px] font-mono text-slate-400">30m DEM</span>
          </div>

          <div className="grid grid-cols-2 gap-1.5 bg-slate-100 p-1 rounded-md">
            {(
              [
                ['hypsometric', 'Elevation Bands'],
                ['slope', 'Slope Steepness'],
                ['aspect', 'Aspect Bearing'],
                ['natural', 'Natural Relief'],
              ] as Array<[TerrainMode, string]>
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChangeTerrainMode(mode)}
                className={`px-2 py-1.5 text-[11px] font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  terrainMode === mode
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {terrainMode === 'hypsometric' && (
            <div className="space-y-1.5">
              <label className="block text-[11px] text-slate-500">Hypsometric Color Ramp</label>
              <div className="grid grid-cols-3 gap-1 bg-slate-100 p-0.5 rounded-md">
                {(
                  [
                    ['scientific-terrain', 'Standard'],
                    ['alpine-monochrome', 'Slate'],
                    ['high-contrast', 'Thermal'],
                  ] as Array<[ElevationRampPreset, string]>
                ).map(([ramp, label]) => (
                  <button
                    key={ramp}
                    type="button"
                    onClick={() => onChangeElevationRamp(ramp)}
                    className={`py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                      elevationRamp === ramp
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-600">Vertical Exaggeration</span>
              <span className="font-mono tabular-nums text-slate-900 font-medium">
                {exaggeration.toFixed(1)}×
              </span>
            </div>
            <input
              type="range"
              min={0.5}
              max={4.0}
              step={0.1}
              value={exaggeration}
              onChange={(e) => onChangeExaggeration(Number(e.target.value))}
              className="w-full sci-slider"
            />
            <div className="grid grid-cols-4 gap-1">
              {[1.0, 1.8, 2.5, 3.5].map((val) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => onChangeExaggeration(val)}
                  className={`py-0.5 text-[10px] font-mono rounded border transition-colors cursor-pointer ${
                    Math.abs(exaggeration - val) < 0.05
                      ? 'bg-blue-50 border-blue-200 text-blue-700 font-medium'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {val.toFixed(1)}×
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* 3. Solar Illumination & Hillshade */}
        <section className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
              <Sun className="w-3.5 h-3.5 text-amber-600" />
              Solar Illumination
            </h2>
            <span className="text-[11px] font-mono tabular-nums text-slate-500">
              {sunAzimuth}° Azimuth
            </span>
          </div>

          <div className="space-y-1.5">
            <input
              type="range"
              min={0}
              max={355}
              step={5}
              value={sunAzimuth}
              onChange={(e) => onChangeSunAzimuth(Number(e.target.value))}
              className="w-full sci-slider"
            />
            <div className="grid grid-cols-4 gap-1">
              {[
                { label: 'NW 315°', deg: 315 },
                { label: 'NE 45°', deg: 45 },
                { label: 'SE 135°', deg: 135 },
                { label: 'SW 225°', deg: 225 },
              ].map((preset) => (
                <button
                  key={preset.deg}
                  type="button"
                  onClick={() => onChangeSunAzimuth(preset.deg)}
                  className={`py-1 text-[10px] font-mono rounded border transition-colors whitespace-nowrap cursor-pointer ${
                    sunAzimuth === preset.deg
                      ? 'bg-blue-50 border-blue-200 text-blue-700'
                      : 'bg-[#F8FAFC] border-slate-200 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-600">Hillshade Contrast</span>
              <span className="font-mono tabular-nums text-slate-900 font-medium">
                {Math.round(hillshadeIntensity * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={hillshadeIntensity}
              onChange={(e) => onChangeHillshadeIntensity(Number(e.target.value))}
              className="w-full sci-slider"
            />
          </div>
        </section>

        {/* 4. Overture Maps Structures */}
        <section className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-cyan-600" />
              Overture Maps Structures
            </h2>
            <span className="text-[11px] font-mono text-slate-400">
              {overtureConfig ? overtureConfig.release : 'Resolving...'}
            </span>
          </div>

          <div className="space-y-2">
            {(
              [
                ['buildings', 'Buildings (3D Extruded)'],
                ['transportation', 'Roads, Rail & Bridges'],
                ['infrastructure', 'Civil Infrastructure'],
                ['waterAndLand', 'Hydrology & Land Cover'],
              ] as Array<[keyof OvertureLayerVisibility, string]>
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex items-center justify-between text-xs text-slate-700 cursor-pointer select-none"
              >
                <span>{label}</span>
                <input
                  type="checkbox"
                  checked={overtureLayers[key]}
                  onChange={() => onToggleOvertureLayer(key)}
                  className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                />
              </label>
            ))}
          </div>

          <div className="pt-1 flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500">Building Shading</span>
            <div className="flex items-center bg-slate-100 p-0.5 rounded-md">
              <button
                type="button"
                onClick={() => onChangeBuildingColorMode('architectural')}
                className={`px-2 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  buildingColorMode === 'architectural'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Architectural
              </button>
              <button
                type="button"
                onClick={() => onChangeBuildingColorMode('height')}
                className={`px-2 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  buildingColorMode === 'height'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                By Height
              </button>
            </div>
          </div>
        </section>

        {/* 5. SRTM vs ASTER Empirical Comparison */}
        <section className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-900">SRTM vs. ASTER Analysis</h2>
            <span className="text-[11px] font-mono text-slate-400">OpenTopoData</span>
          </div>

          {/* Elevation Cross-Section Tool */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() =>
                onSetActiveTool(activeTool === 'profile-draw' ? 'inspect' : 'profile-draw')
              }
              className={`w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                activeTool === 'profile-draw'
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-[#F8FAFC] border-slate-200 text-slate-800 hover:bg-slate-100'
              }`}
            >
              <Ruler className="w-3.5 h-3.5" />
              {activeTool === 'profile-draw'
                ? 'Drawing Profile (Click Map)'
                : 'Draw Elevation Profile'}
            </button>

            {activeTool === 'profile-draw' && (
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Click 2 or more points across the 3D terrain to trace a transect, then compute the
                SRTM 30m vs. ASTER 30m profile.
              </p>
            )}

            {transectVerticesCount > 0 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={transectVerticesCount < 2 || profileLoading}
                  onClick={onRunProfile}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-40 cursor-pointer whitespace-nowrap"
                >
                  {profileLoading ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Sampling...
                    </>
                  ) : (
                    `Analyze (${transectVerticesCount} pts)`
                  )}
                </button>
                <button
                  type="button"
                  onClick={onClearProfile}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-100 cursor-pointer whitespace-nowrap"
                >
                  Clear
                </button>
              </div>
            )}

            {profileError && (
              <p className="text-[11px] text-rose-600 bg-rose-50 border border-rose-200 rounded px-2.5 py-1.5">
                {profileError}
              </p>
            )}
          </div>

          {/* 3D Geodesic Distance Measurement Tool */}
          <div className="pt-2 border-t border-slate-100 space-y-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  onSetActiveTool(
                    activeTool === 'measure-distance' ? 'inspect' : 'measure-distance',
                  )
                }
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                  activeTool === 'measure-distance'
                    ? 'bg-cyan-700 border-cyan-700 text-white'
                    : 'bg-[#F8FAFC] border-slate-200 text-slate-800 hover:bg-slate-100'
                }`}
              >
                <MoveHorizontal className="w-3.5 h-3.5" />
                {activeTool === 'measure-distance'
                  ? 'Measuring (Click A & B)'
                  : 'Measure 3D Distance'}
              </button>
              {hasDistanceMeasurement && (
                <button
                  type="button"
                  onClick={onClearDistance}
                  className="px-2.5 py-2 text-xs font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-100 cursor-pointer whitespace-nowrap"
                >
                  Clear
                </button>
              )}
            </div>

            {activeTool === 'measure-distance' && (
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Click Point A and Point B on the map to compute WGS84 geodesic and SRTM/ASTER 3D
                terrain surface distances.
              </p>
            )}
          </div>

          {/* Viewport Discrepancy Heatmap */}
          <div className="pt-2 border-t border-slate-100 space-y-2">
            <button
              type="button"
              disabled={discrepancyLoading}
              onClick={onComputeDiscrepancy}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-md border border-slate-200 bg-[#F8FAFC] text-slate-800 hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
            >
              {discrepancyLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />
                  Querying SRTM & ASTER...
                </>
              ) : (
                <>
                  <Grid2x2 className="w-3.5 h-3.5 text-amber-600" />
                  Compare Viewport (Δh Grid)
                </>
              )}
            </button>

            {discrepancyGrid && (
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-600">Overlay Opacity</span>
                  <span className="font-mono tabular-nums text-slate-900">
                    {Math.round(discrepancyOpacity * 100)}%
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={discrepancyOpacity}
                    onChange={(e) => onChangeDiscrepancyOpacity(Number(e.target.value))}
                    className="flex-1 sci-slider"
                  />
                  <button
                    type="button"
                    onClick={onClearDiscrepancy}
                    className="text-[11px] text-slate-500 hover:text-slate-900 px-1.5 py-0.5 border border-slate-200 rounded cursor-pointer"
                  >
                    Hide
                  </button>
                </div>
              </div>
            )}

            {discrepancyError && (
              <p className="text-[11px] text-rose-600 bg-rose-50 border border-rose-200 rounded px-2.5 py-1.5">
                {discrepancyError}
              </p>
            )}
          </div>
        </section>
      </div>
    </aside>
  );
};
