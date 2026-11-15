import React, { useEffect, useRef, useState } from 'react';
import { TopBar } from './components/TopBar';
import { ControlSidebar } from './components/ControlSidebar';
import { MapViewport } from './components/MapViewport';
import type { MapViewportHandle } from './components/MapViewport';
import { FeatureInspector } from './components/FeatureInspector';
import { TelemetryTray } from './components/TelemetryTray';
import { REGION_PRESETS } from './types/geospatial';
import { vincentyInverse } from './utils/geodesic';
import type {
  ActiveTool,
  BuildingColorMode,
  DiscrepancyGridResult,
  DistanceMeasurementResult,
  ElevationProfileResult,
  ElevationRampPreset,
  OvertureConfig,
  OvertureLayerVisibility,
  ProfileSample,
  ProjectionMode,
  RegionPreset,
  SelectedOvertureFeature,
  TerrainMode,
} from './types/geospatial';

const FALLBACK_OVERTURE_CONFIG: OvertureConfig = {
  release: '2026-10-21.0',
  baseUrl: 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-10-21.0',
  buildingsUrl:
    'pmtiles://https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-10-21.0/buildings.pmtiles',
  transportationUrl:
    'pmtiles://https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-10-21.0/transportation.pmtiles',
  baseLayerUrl:
    'pmtiles://https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-10-21.0/base.pmtiles',
  resolvedAt: new Date().toISOString(),
};

export default function App() {
  const mapHandleRef = useRef<MapViewportHandle | null>(null);

  const [overtureConfig, setOvertureConfig] = useState<OvertureConfig | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const [activePreset, setActivePreset] = useState<RegionPreset>(REGION_PRESETS[0]);
  const [projection, setProjection] = useState<ProjectionMode>('globe');
  const [showGraticule, setShowGraticule] = useState<boolean>(true);
  const [terrainMode, setTerrainMode] = useState<TerrainMode>('hypsometric');
  const [elevationRamp, setElevationRamp] = useState<ElevationRampPreset>('scientific-terrain');
  const [exaggeration, setExaggeration] = useState<number>(1.4);
  const [sunAzimuth, setSunAzimuth] = useState<number>(315);
  const [hillshadeIntensity, setHillshadeIntensity] = useState<number>(0.55);

  const [overtureLayers, setOvertureLayers] = useState<OvertureLayerVisibility>({
    buildings: true,
    transportation: true,
    infrastructure: true,
    waterAndLand: true,
  });
  const [buildingColorMode, setBuildingColorMode] = useState<BuildingColorMode>('architectural');

  const [selectedFeature, setSelectedFeature] = useState<SelectedOvertureFeature | null>(null);

  const [activeTool, setActiveTool] = useState<ActiveTool>('inspect');
  const [transectVertices, setTransectVertices] = useState<Array<[number, number]>>([]);
  const [profileResult, setProfileResult] = useState<ElevationProfileResult | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [hoveredProfileSample, setHoveredProfileSample] = useState<ProfileSample | null>(null);

  const [distancePoints, setDistancePoints] = useState<Array<[number, number]>>([]);
  const [distanceResult, setDistanceResult] = useState<DistanceMeasurementResult | null>(null);

  const [discrepancyGrid, setDiscrepancyGrid] = useState<DiscrepancyGridResult | null>(null);
  const [discrepancyOpacity, setDiscrepancyOpacity] = useState<number>(0.68);
  const [discrepancyLoading, setDiscrepancyLoading] = useState(false);
  const [discrepancyError, setDiscrepancyError] = useState<string | null>(null);

  const [activeTrayTab, setActiveTrayTab] = useState<'profile' | 'discrepancy'>('profile');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/overture/config');
        if (res.ok) {
          const cfg = (await res.json()) as OvertureConfig;
          if (!cancelled) setOvertureConfig(cfg);
          return;
        }
      } catch {
        // Fallback below
      }
      if (!cancelled) setOvertureConfig(FALLBACK_OVERTURE_CONFIG);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 2600);
  };

  const handleSelectPreset = (preset: RegionPreset) => {
    setActivePreset(preset);
    setSelectedFeature(null);
    setTransectVertices([]);
    setProfileResult(null);
    setHoveredProfileSample(null);
    setDistancePoints([]);
    setDistanceResult(null);
    setDiscrepancyGrid(null);
    setActiveTool('inspect');
    mapHandleRef.current?.flyTo(preset.center, preset.zoom, preset.pitch, preset.bearing);
  };

  const handleFlyToLocation = (lon: number, lat: number, label: string) => {
    setSelectedFeature(null);
    setTransectVertices([]);
    setProfileResult(null);
    setHoveredProfileSample(null);
    setDistancePoints([]);
    setDistanceResult(null);
    setDiscrepancyGrid(null);
    setActiveTool('inspect');
    mapHandleRef.current?.flyTo([lon, lat], 13.4, 56, -20);
    showToast(`Navigated to ${label}`);
  };

  const handleResetCurrentRegion = () => {
    mapHandleRef.current?.flyTo(
      activePreset.center,
      activePreset.zoom,
      activePreset.pitch,
      activePreset.bearing,
    );
  };

  const handleToggleOvertureLayer = (key: keyof OvertureLayerVisibility) => {
    setOvertureLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleAddTransectVertex = (coord: [number, number]) => {
    setProfileError(null);
    setTransectVertices((prev) => [...prev, coord]);
  };

  const handleRunProfile = async () => {
    if (transectVertices.length < 2) return;
    setProfileLoading(true);
    setProfileError(null);

    try {
      const res = await fetch('/api/elevation/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: transectVertices, sampleCount: 72 }),
      });

      const payload = (await res.json()) as ElevationProfileResult & { error?: string };
      if (!res.ok) {
        throw new Error(payload.error || 'Elevation profile request failed');
      }

      setProfileResult(payload);
      setActiveTrayTab('profile');
      setActiveTool('inspect');
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Unable to sample elevation profile');
    } finally {
      setProfileLoading(false);
    }
  };

  const handleClearProfile = () => {
    setTransectVertices([]);
    setProfileResult(null);
    setProfileError(null);
    setHoveredProfileSample(null);
    setActiveTool('inspect');
    if (discrepancyGrid) setActiveTrayTab('discrepancy');
  };

  const handleAddDistancePoint = async (coord: [number, number]) => {
    if (distancePoints.length === 0 || distancePoints.length >= 2) {
      setDistancePoints([coord]);
      setDistanceResult(null);
      return;
    }

    const pointA = distancePoints[0];
    const pointB = coord;
    setDistancePoints([pointA, pointB]);

    const { distanceMeters, initialBearingDeg } = vincentyInverse(
      pointA[0],
      pointA[1],
      pointB[0],
      pointB[1],
    );

    setDistanceResult({
      pointA,
      pointB,
      geodesicMeters: distanceMeters,
      initialBearingDeg,
      surfaceSrtmMeters: null,
      surfaceAsterMeters: null,
      elevASrtm: null,
      elevBSrtm: null,
      elevAAster: null,
      elevBAster: null,
      ascentSrtmMeters: null,
      descentSrtmMeters: null,
      maxGradePct: null,
      sampleCount: 48,
      loading: true,
      error: null,
    });

    try {
      const res = await fetch('/api/elevation/distance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointA, pointB, sampleCount: 48 }),
      });

      const payload = (await res.json()) as Partial<DistanceMeasurementResult> & { error?: string };
      if (!res.ok) {
        throw new Error(payload.error || '3D distance query failed');
      }

      setDistanceResult((prev) =>
        prev
          ? {
              ...prev,
              ...payload,
              loading: false,
              error: null,
            }
          : null,
      );
    } catch (err) {
      setDistanceResult((prev) =>
        prev
          ? {
              ...prev,
              loading: false,
              error: err instanceof Error ? err.message : 'Unable to fetch SRTM/ASTER elevations',
            }
          : null,
      );
    }
  };

  const handleClearDistance = () => {
    setDistancePoints([]);
    setDistanceResult(null);
    if (activeTool === 'measure-distance') {
      setActiveTool('inspect');
    }
  };

  const handleComputeDiscrepancy = async () => {
    const rawBbox = mapHandleRef.current?.getBoundsBbox();
    if (!rawBbox) return;

    // Clamp overly wide planetary bounding boxes to the central 0.25 deg window for meaningful 30m DEM comparison
    let [minLon, minLat, maxLon, maxLat] = rawBbox;
    const lonSpan = maxLon - minLon;
    const latSpan = maxLat - minLat;
    if (lonSpan > 0.6 || latSpan > 0.6) {
      const cLon = (minLon + maxLon) / 2;
      const cLat = (minLat + maxLat) / 2;
      const halfLon = Math.min(0.25, lonSpan / 2);
      const halfLat = Math.min(0.2, latSpan / 2);
      minLon = cLon - halfLon;
      maxLon = cLon + halfLon;
      minLat = cLat - halfLat;
      maxLat = cLat + halfLat;
    }

    setDiscrepancyLoading(true);
    setDiscrepancyError(null);

    try {
      const res = await fetch('/api/elevation/diff-grid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bbox: [minLon, minLat, maxLon, maxLat], cols: 9, rows: 9 }),
      });

      const payload = (await res.json()) as DiscrepancyGridResult & { error?: string };
      if (!res.ok) {
        throw new Error(payload.error || 'Failed to compute discrepancy grid');
      }

      setDiscrepancyGrid(payload);
      setActiveTrayTab('discrepancy');
    } catch (err) {
      setDiscrepancyError(
        err instanceof Error ? err.message : 'Unable to compute SRTM/ASTER discrepancy grid',
      );
    } finally {
      setDiscrepancyLoading(false);
    }
  };

  const handleClearDiscrepancy = () => {
    setDiscrepancyGrid(null);
    setDiscrepancyError(null);
    if (profileResult) setActiveTrayTab('profile');
  };

  const handleCloseTray = () => {
    setProfileResult(null);
    setHoveredProfileSample(null);
    setDiscrepancyGrid(null);
  };

  const handleExportSnapshot = () => {
    const dataUrl = mapHandleRef.current?.captureSnapshot();
    if (!dataUrl) {
      showToast('Viewport not ready for snapshot');
      return;
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `terragraph-${activePreset.id}-${Date.now()}.png`;
    a.click();
    showToast('3D viewport PNG snapshot exported');
  };

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[#F8FAFC] text-slate-900">
      <TopBar
        activePresetId={activePreset.id}
        onSelectPreset={handleSelectPreset}
        onExportSnapshot={handleExportSnapshot}
      />

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <ControlSidebar
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
          projection={projection}
          onChangeProjection={setProjection}
          showGraticule={showGraticule}
          onToggleGraticule={() => setShowGraticule((v) => !v)}
          onFlyToLocation={handleFlyToLocation}
          terrainMode={terrainMode}
          onChangeTerrainMode={setTerrainMode}
          elevationRamp={elevationRamp}
          onChangeElevationRamp={setElevationRamp}
          exaggeration={exaggeration}
          onChangeExaggeration={setExaggeration}
          sunAzimuth={sunAzimuth}
          onChangeSunAzimuth={setSunAzimuth}
          hillshadeIntensity={hillshadeIntensity}
          onChangeHillshadeIntensity={setHillshadeIntensity}
          overtureConfig={overtureConfig}
          overtureLayers={overtureLayers}
          onToggleOvertureLayer={handleToggleOvertureLayer}
          buildingColorMode={buildingColorMode}
          onChangeBuildingColorMode={setBuildingColorMode}
          activeTool={activeTool}
          onSetActiveTool={setActiveTool}
          transectVerticesCount={transectVertices.length}
          onRunProfile={handleRunProfile}
          onClearProfile={handleClearProfile}
          profileLoading={profileLoading}
          profileError={profileError}
          hasDistanceMeasurement={distancePoints.length > 0}
          onClearDistance={handleClearDistance}
          onComputeDiscrepancy={handleComputeDiscrepancy}
          discrepancyLoading={discrepancyLoading}
          discrepancyError={discrepancyError}
          discrepancyGrid={discrepancyGrid}
          discrepancyOpacity={discrepancyOpacity}
          onChangeDiscrepancyOpacity={setDiscrepancyOpacity}
          onClearDiscrepancy={handleClearDiscrepancy}
        />

        <div className="flex-1 min-w-0 flex flex-col overflow-hidden relative">
          <div className="flex-1 min-h-0 flex overflow-hidden">
            {overtureConfig ? (
              <MapViewport
                mapHandleRef={mapHandleRef}
                initialCenter={REGION_PRESETS[0].center}
                initialZoom={REGION_PRESETS[0].zoom}
                initialPitch={REGION_PRESETS[0].pitch}
                initialBearing={REGION_PRESETS[0].bearing}
                overtureConfig={overtureConfig}
                projection={projection}
                showGraticule={showGraticule}
                onToggleGraticule={() => setShowGraticule((v) => !v)}
                terrainMode={terrainMode}
                elevationRamp={elevationRamp}
                exaggeration={exaggeration}
                sunAzimuth={sunAzimuth}
                hillshadeIntensity={hillshadeIntensity}
                overtureLayers={overtureLayers}
                buildingColorMode={buildingColorMode}
                activeTool={activeTool}
                onSetActiveTool={setActiveTool}
                transectVertices={transectVertices}
                onAddTransectVertex={handleAddTransectVertex}
                distancePoints={distancePoints}
                distanceResult={distanceResult}
                onAddDistancePoint={handleAddDistancePoint}
                onClearDistance={handleClearDistance}
                hoveredProfileSample={hoveredProfileSample}
                discrepancyGrid={discrepancyGrid}
                discrepancyOpacity={discrepancyOpacity}
                selectedFeatureId={selectedFeature?.id || null}
                onSelectFeature={setSelectedFeature}
                onResetCurrentRegion={handleResetCurrentRegion}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center bg-[#F8FAFC] text-xs font-mono text-slate-500">
                Resolving Overture Maps PMTiles catalog...
              </div>
            )}

            {selectedFeature && (
              <FeatureInspector
                feature={selectedFeature}
                onClose={() => setSelectedFeature(null)}
              />
            )}
          </div>

          <TelemetryTray
            profile={profileResult}
            discrepancyGrid={discrepancyGrid}
            activeTab={activeTrayTab}
            onChangeTab={setActiveTrayTab}
            onHoverSample={setHoveredProfileSample}
            onCloseTray={handleCloseTray}
          />
        </div>
      </div>

      {toastMessage && (
        <div className="fixed bottom-4 right-4 bg-slate-900 text-white text-xs px-3.5 py-2 rounded-md shadow-md z-50">
          {toastMessage}
        </div>
      )}
    </div>
  );
}
