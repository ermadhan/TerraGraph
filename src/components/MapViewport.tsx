import React, { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { ImageSource, GeoJSONSource, StyleSpecification } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { Protocol } from 'pmtiles';
import {
  Plus,
  Minus,
  Compass,
  Box,
  RotateCcw,
  Grid,
  RotateCw,
  Orbit,
  MoveHorizontal,
  X,
} from 'lucide-react';
import {
  registerDemAnalysisProtocol,
  renderDiscrepancyDataUrl,
  sampleTerrariumPoint,
} from '../utils/demProtocol';
import { formatDistance, sampleGreatCircle } from '../utils/geodesic';
import type {
  ActiveTool,
  BuildingColorMode,
  CursorTelemetry,
  DiscrepancyGridResult,
  DistanceMeasurementResult,
  ElevationRampPreset,
  OvertureConfig,
  OvertureLayerVisibility,
  ProfileSample,
  ProjectionMode,
  SelectedOvertureFeature,
  TerrainMode,
} from '../types/geospatial';

let pmtilesProtocolRegistered = false;
function ensureProtocols(): void {
  if (!pmtilesProtocolRegistered) {
    pmtilesProtocolRegistered = true;
    maplibregl.setWorkerUrl(maplibreWorkerUrl);
    const protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
  }
  registerDemAnalysisProtocol();
}

type GraticuleFeature = {
  type: 'Feature';
  properties: { axis: 'lon' | 'lat'; deg: number; isMajor: boolean; isZero: boolean };
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
};

let cachedGraticuleGeoJSON: { type: 'FeatureCollection'; features: GraticuleFeature[] } | null = null;

function getOneDegreeGraticuleGeoJSON(): { type: 'FeatureCollection'; features: GraticuleFeature[] } {
  if (cachedGraticuleGeoJSON) return cachedGraticuleGeoJSON;

  const features: GraticuleFeature[] = [];

  // Meridians at 1-degree longitude intervals (-179° to +180°)
  for (let lon = -179; lon <= 180; lon++) {
    const coords: Array<[number, number]> = [];
    for (let lat = -85; lat <= 85; lat += 5) {
      coords.push([lon, lat]);
    }
    features.push({
      type: 'Feature',
      properties: {
        axis: 'lon',
        deg: lon,
        isMajor: lon % 10 === 0,
        isZero: lon === 0,
      },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }

  // Parallels at 1-degree latitude intervals (-85° to +85°)
  for (let lat = -85; lat <= 85; lat++) {
    const coords: Array<[number, number]> = [];
    for (let lon = -180; lon <= 180; lon += 5) {
      coords.push([lon, lat]);
    }
    features.push({
      type: 'Feature',
      properties: {
        axis: 'lat',
        deg: lat,
        isMajor: lat % 10 === 0,
        isZero: lat === 0,
      },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }

  cachedGraticuleGeoJSON = { type: 'FeatureCollection', features };
  return cachedGraticuleGeoJSON;
}

function formatDegreeLabel(deg: number, axis: 'lat' | 'lon'): string {
  if (deg === 0) return axis === 'lat' ? '0° EQ' : '0° PM';
  const suffix = axis === 'lat' ? (deg > 0 ? 'N' : 'S') : deg > 0 ? 'E' : 'W';
  return `${Math.abs(deg)}°${suffix}`;
}

function getElevationRampExpression(ramp: ElevationRampPreset): maplibregl.ExpressionSpecification {
  if (ramp === 'alpine-monochrome') {
    return [
      'interpolate',
      ['linear'],
      ['elevation'],
      -100, '#CBD5E1',
      0, '#E2E8F0',
      300, '#CBD5E1',
      900, '#94A3B8',
      1800, '#64748B',
      2800, '#475569',
      4000, '#F8FAFC',
    ];
  }
  if (ramp === 'high-contrast') {
    return [
      'interpolate',
      ['linear'],
      ['elevation'],
      -100, '#1E3A8A',
      0, '#E2E8F0',
      150, '#BFDBFE',
      600, '#38BDF8',
      1400, '#FACC15',
      2400, '#EA580C',
      3600, '#991B1B',
      4800, '#FFFFFF',
    ];
  }
  // 'scientific-terrain'
  return [
    'interpolate',
    ['linear'],
    ['elevation'],
    -100, '#DBEAFE',
    0, '#E2E8F0',
    40, '#F1F5F9',
    250, '#D9E8D8',
    700, '#E8DFC5',
    1500, '#D4B895',
    2600, '#A88A73',
    3800, '#F8FAFC',
  ];
}

function parseJsonField<T>(raw: unknown): T | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return null;
}

function extractFeatureTitle(props: Record<string, unknown>, fallback: string): string {
  const namesObj = parseJsonField<{ primary?: string }>(props.names);
  if (namesObj?.primary) return namesObj.primary;
  if (typeof props.name === 'string' && props.name.trim()) return props.name;
  if (typeof props['name:en'] === 'string' && props['name:en'].trim()) return props['name:en'];
  if (typeof props.class === 'string' && props.class.trim()) {
    return `${props.class.replace(/_/g, ' ')} structure`;
  }
  return fallback;
}

export interface MapViewportHandle {
  flyTo: (center: [number, number], zoom: number, pitch?: number, bearing?: number) => void;
  getBoundsBbox: () => [number, number, number, number] | null;
  captureSnapshot: () => string | null;
}

interface MapViewportProps {
  mapHandleRef: React.MutableRefObject<MapViewportHandle | null>;
  initialCenter: [number, number];
  initialZoom: number;
  initialPitch: number;
  initialBearing: number;
  overtureConfig: OvertureConfig;
  projection: ProjectionMode;
  showGraticule: boolean;
  onToggleGraticule: () => void;
  terrainMode: TerrainMode;
  elevationRamp: ElevationRampPreset;
  exaggeration: number;
  sunAzimuth: number;
  hillshadeIntensity: number;
  overtureLayers: OvertureLayerVisibility;
  buildingColorMode: BuildingColorMode;
  activeTool: ActiveTool;
  onSetActiveTool: (tool: ActiveTool) => void;
  transectVertices: Array<[number, number]>;
  onAddTransectVertex: (coord: [number, number]) => void;
  distancePoints: Array<[number, number]>;
  distanceResult: DistanceMeasurementResult | null;
  onAddDistancePoint: (coord: [number, number]) => void;
  onClearDistance: () => void;
  hoveredProfileSample: ProfileSample | null;
  discrepancyGrid: DiscrepancyGridResult | null;
  discrepancyOpacity: number;
  selectedFeatureId: string | null;
  onSelectFeature: (feature: SelectedOvertureFeature | null) => void;
  onResetCurrentRegion: () => void;
}

export const MapViewport: React.FC<MapViewportProps> = ({
  mapHandleRef,
  initialCenter,
  initialZoom,
  initialPitch,
  initialBearing,
  overtureConfig,
  projection,
  showGraticule,
  onToggleGraticule,
  terrainMode,
  elevationRamp,
  exaggeration,
  sunAzimuth,
  hillshadeIntensity,
  overtureLayers,
  buildingColorMode,
  activeTool,
  onSetActiveTool,
  transectVertices,
  onAddTransectVertex,
  distancePoints,
  distanceResult,
  onAddDistancePoint,
  onClearDistance,
  hoveredProfileSample,
  discrepancyGrid,
  discrepancyOpacity,
  selectedFeatureId,
  onSelectFeature,
  onResetCurrentRegion,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [dragMode, setDragMode] = useState<'pan' | 'orbit'>('pan');
  const [measurePreviewCoord, setMeasurePreviewCoord] = useState<[number, number] | null>(null);
  const [cameraOrientation, setCameraOrientation] = useState<{ bearing: number; pitch: number }>({
    bearing: initialBearing,
    pitch: initialPitch,
  });
  const [graticuleLabels, setGraticuleLabels] = useState<
    Array<{ key: string; text: string; x: number; y: number; axis: 'lat' | 'lon' }>
  >([]);
  const [telemetry, setTelemetry] = useState<CursorTelemetry | null>(null);
  const [hoveredGridCell, setHoveredGridCell] = useState<{
    x: number;
    y: number;
    srtm: number | null;
    aster: number | null;
    delta: number | null;
  } | null>(null);

  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;
  const dragModeRef = useRef(dragMode);
  dragModeRef.current = dragMode;
  const orbitDragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    startBearing: number;
    startPitch: number;
    moved: boolean;
  } | null>(null);
  const compassDragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    startBearing: number;
    startPitch: number;
    moved: boolean;
  } | null>(null);
  const showGraticuleRef = useRef(showGraticule);
  showGraticuleRef.current = showGraticule;
  const onAddVertexRef = useRef(onAddTransectVertex);
  onAddVertexRef.current = onAddTransectVertex;
  const onAddDistancePointRef = useRef(onAddDistancePoint);
  onAddDistancePointRef.current = onAddDistancePoint;
  const distancePointsLengthRef = useRef(distancePoints.length);
  distancePointsLengthRef.current = distancePoints.length;
  const onSelectFeatureRef = useRef(onSelectFeature);
  onSelectFeatureRef.current = onSelectFeature;

  const sampleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    ensureProtocols();

    const style: StyleSpecification = {
      version: 8,
      projection: { type: projection },
      sources: {
        'terrarium-dem': {
          type: 'raster-dem',
          tiles: ['/api/tiles/terrarium/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 15,
          encoding: 'terrarium',
        },
        'slope-tiles': {
          type: 'raster',
          tiles: ['dem-analysis://slope/{z}/{x}/{y}'],
          tileSize: 256,
          maxzoom: 15,
        },
        'aspect-tiles': {
          type: 'raster',
          tiles: ['dem-analysis://aspect/{z}/{x}/{y}'],
          tileSize: 256,
          maxzoom: 15,
        },
        'overture-base': {
          type: 'vector',
          url: overtureConfig.baseLayerUrl,
          maxzoom: 13,
        },
        'overture-transportation': {
          type: 'vector',
          url: overtureConfig.transportationUrl,
          maxzoom: 14,
        },
        'overture-buildings': {
          type: 'vector',
          url: overtureConfig.buildingsUrl,
          maxzoom: 14,
        },
        'transect-geo': {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        },
        'transect-hover-geo': {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        },
        'discrepancy-points-geo': {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        },
        'graticule-geo': {
          type: 'geojson',
          data: getOneDegreeGraticuleGeoJSON(),
        },
        'distance-measure-geo': {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        },
      },
      terrain: {
        source: 'terrarium-dem',
        exaggeration,
      },
      sky: {
        'sky-color': '#E2E8F0',
        'sky-horizon-blend': 0.6,
        'horizon-color': '#F8FAFC',
        'atmosphere-blend': 0.45,
      },
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: { 'background-color': '#E2E8F0' },
        },
        {
          id: 'terrain-color-relief',
          type: 'color-relief',
          source: 'terrarium-dem',
          layout: {
            visibility: terrainMode === 'hypsometric' || terrainMode === 'natural' ? 'visible' : 'none',
          },
          paint: {
            'color-relief-opacity': terrainMode === 'natural' ? 0.55 : 0.92,
            'color-relief-color': getElevationRampExpression(elevationRamp),
          },
        },
        {
          id: 'terrain-slope-layer',
          type: 'raster',
          source: 'slope-tiles',
          layout: { visibility: terrainMode === 'slope' ? 'visible' : 'none' },
          paint: { 'raster-opacity': 0.92 },
        },
        {
          id: 'terrain-aspect-layer',
          type: 'raster',
          source: 'aspect-tiles',
          layout: { visibility: terrainMode === 'aspect' ? 'visible' : 'none' },
          paint: { 'raster-opacity': 0.9 },
        },
        {
          id: 'terrain-hillshade',
          type: 'hillshade',
          source: 'terrarium-dem',
          paint: {
            'hillshade-exaggeration': hillshadeIntensity,
            'hillshade-illumination-direction': sunAzimuth,
            'hillshade-illumination-anchor': 'map',
            'hillshade-shadow-color': '#334155',
            'hillshade-highlight-color': '#FFFFFF',
            'hillshade-accent-color': '#475569',
          },
        },
        {
          id: 'graticule-lines',
          type: 'line',
          source: 'graticule-geo',
          layout: {
            visibility: showGraticule ? 'visible' : 'none',
          },
          paint: {
            'line-color': [
              'case',
              ['get', 'isZero'],
              '#2563EB',
              ['get', 'isMajor'],
              '#334155',
              '#475569',
            ],
            'line-width': ['case', ['get', 'isZero'], 1.5, ['get', 'isMajor'], 1.1, 0.75],
            'line-opacity': ['case', ['get', 'isZero'], 0.68, ['get', 'isMajor'], 0.48, 0.34],
          },
        },
        {
          id: 'overture-land-use',
          type: 'fill',
          source: 'overture-base',
          'source-layer': 'land_use',
          layout: { visibility: overtureLayers.waterAndLand ? 'visible' : 'none' },
          paint: {
            'fill-color': '#E2E8F0',
            'fill-opacity': 0.25,
          },
        },
        {
          id: 'overture-water',
          type: 'fill',
          source: 'overture-base',
          'source-layer': 'water',
          layout: { visibility: overtureLayers.waterAndLand ? 'visible' : 'none' },
          paint: {
            'fill-color': '#BFDBFE',
            'fill-opacity': 0.72,
          },
        },
        {
          id: 'overture-infrastructure',
          type: 'fill',
          source: 'overture-base',
          'source-layer': 'infrastructure',
          layout: { visibility: overtureLayers.infrastructure ? 'visible' : 'none' },
          paint: {
            'fill-color': '#0891B2',
            'fill-opacity': 0.35,
            'fill-outline-color': '#0E7490',
          },
        },
        {
          id: 'overture-roads-casing',
          type: 'line',
          source: 'overture-transportation',
          'source-layer': 'segment',
          minzoom: 10,
          layout: {
            visibility: overtureLayers.transportation ? 'visible' : 'none',
            'line-cap': 'round',
            'line-join': 'round',
          },
          paint: {
            'line-color': '#CBD5E1',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 4.5, 17, 9],
          },
        },
        {
          id: 'overture-roads',
          type: 'line',
          source: 'overture-transportation',
          'source-layer': 'segment',
          minzoom: 10,
          layout: {
            visibility: overtureLayers.transportation ? 'visible' : 'none',
            'line-cap': 'round',
            'line-join': 'round',
          },
          paint: {
            'line-color': [
              'match',
              ['get', 'class'],
              'motorway', '#F59E0B',
              'trunk', '#FBBF24',
              'primary', '#FFFFFF',
              'secondary', '#F8FAFC',
              'rail', '#475569',
              '#FFFFFF',
            ],
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 2.5, 17, 6],
          },
        },
        {
          id: 'overture-buildings-3d',
          type: 'fill-extrusion',
          source: 'overture-buildings',
          'source-layer': 'building',
          minzoom: 11,
          layout: { visibility: overtureLayers.buildings ? 'visible' : 'none' },
          paint: {
            'fill-extrusion-color': '#94A3B8',
            'fill-extrusion-height': [
              'coalesce',
              ['get', 'height'],
              ['*', ['coalesce', ['get', 'num_floors'], 2], 3.5],
              7,
            ],
            'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
            'fill-extrusion-opacity': 0.9,
          },
        },
        {
          id: 'overture-building-parts-3d',
          type: 'fill-extrusion',
          source: 'overture-buildings',
          'source-layer': 'building_part',
          minzoom: 13,
          layout: { visibility: overtureLayers.buildings ? 'visible' : 'none' },
          paint: {
            'fill-extrusion-color': '#64748B',
            'fill-extrusion-height': [
              'coalesce',
              ['get', 'height'],
              ['*', ['coalesce', ['get', 'num_floors'], 2], 3.5],
              7,
            ],
            'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
            'fill-extrusion-opacity': 0.92,
          },
        },
        {
          id: 'overture-selected-highlight',
          type: 'fill-extrusion',
          source: 'overture-buildings',
          'source-layer': 'building',
          minzoom: 11,
          filter: ['==', ['get', 'id'], '__none__'],
          paint: {
            'fill-extrusion-color': '#0891B2',
            'fill-extrusion-height': [
              'coalesce',
              ['get', 'height'],
              ['*', ['coalesce', ['get', 'num_floors'], 2], 3.5],
              7,
            ],
            'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
            'fill-extrusion-opacity': 0.98,
          },
        },
        {
          id: 'discrepancy-points',
          type: 'circle',
          source: 'discrepancy-points-geo',
          paint: {
            'circle-radius': 4,
            'circle-color': '#0F172A',
            'circle-opacity': 0.55,
            'circle-stroke-width': 1,
            'circle-stroke-color': '#FFFFFF',
          },
        },
        {
          id: 'transect-line',
          type: 'line',
          source: 'transect-geo',
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: {
            'line-color': '#2563EB',
            'line-width': 3,
          },
        },
        {
          id: 'transect-vertices',
          type: 'circle',
          source: 'transect-geo',
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 5,
            'circle-color': '#FFFFFF',
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#2563EB',
          },
        },
        {
          id: 'transect-hover-marker',
          type: 'circle',
          source: 'transect-hover-geo',
          paint: {
            'circle-radius': 6.5,
            'circle-color': '#D97706',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#FFFFFF',
          },
        },
        {
          id: 'distance-measure-line',
          type: 'line',
          source: 'distance-measure-geo',
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: {
            'line-color': '#0891B2',
            'line-width': 3,
          },
        },
        {
          id: 'distance-measure-points',
          type: 'circle',
          source: 'distance-measure-geo',
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 5.5,
            'circle-color': '#0891B2',
            'circle-stroke-width': 2,
            'circle-color-transition': { duration: 100 },
            'circle-stroke-color': '#FFFFFF',
          },
        },
      ],
    };

    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center: initialCenter,
      zoom: initialZoom,
      pitch: initialPitch,
      bearing: initialBearing,
      maxPitch: 78,
      dragRotate: true,
      pitchWithRotate: true,
      touchZoomRotate: true,
      touchPitch: true,
      keyboard: true,
      canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
    });

    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.touchPitch.enable();

    map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-right');

    const computeGraticuleEdgeLabels = () => {
      if (!showGraticuleRef.current) {
        setGraticuleLabels([]);
        return;
      }
      const b = map.getBounds();
      const canvas = map.getCanvas();
      if (!b || !canvas) return;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const west = Math.max(-179, b.getWest());
      const east = Math.min(180, b.getEast());
      const south = Math.max(-85, b.getSouth());
      const north = Math.min(85, b.getNorth());

      const lonSpan = east - west;
      const latSpan = north - south;
      const lonStep = lonSpan > 45 ? 10 : lonSpan > 14 ? 5 : 1;
      const latStep = latSpan > 35 ? 10 : latSpan > 12 ? 5 : 1;

      const labels: Array<{ key: string; text: string; x: number; y: number; axis: 'lat' | 'lon' }> =
        [];

      const startLon = Math.ceil(west / lonStep) * lonStep;
      const refLat = Math.max(-85, Math.min(85, south + latSpan * 0.08));
      for (let lon = startLon; lon <= east && labels.length < 18; lon += lonStep) {
        const pt = map.project([lon, refLat]);
        if (pt.x > 70 && pt.x < w - 70) {
          labels.push({
            key: `lon-${lon}`,
            text: formatDegreeLabel(lon, 'lon'),
            x: pt.x,
            y: h - 38,
            axis: 'lon',
          });
        }
      }

      const startLat = Math.ceil(south / latStep) * latStep;
      const refLon = Math.max(-179, Math.min(180, west + lonSpan * 0.08));
      for (let lat = startLat; lat <= north && labels.length < 32; lat += latStep) {
        const pt = map.project([refLon, lat]);
        if (pt.y > 70 && pt.y < h - 65) {
          labels.push({
            key: `lat-${lat}`,
            text: formatDegreeLabel(lat, 'lat'),
            x: 14,
            y: pt.y,
            axis: 'lat',
          });
        }
      }

      setGraticuleLabels(labels);
    };

    map.on('load', () => {
      setMapReady(true);
      setCameraOrientation({ bearing: map.getBearing(), pitch: map.getPitch() });
      computeGraticuleEdgeLabels();
    });

    map.on('move', () => {
      const nextBearing = map.getBearing();
      const nextPitch = map.getPitch();
      setCameraOrientation((prev) =>
        Math.abs(prev.bearing - nextBearing) > 0.25 || Math.abs(prev.pitch - nextPitch) > 0.25
          ? { bearing: nextBearing, pitch: nextPitch }
          : prev,
      );
      computeGraticuleEdgeLabels();
    });

    map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
      const { lng, lat } = e.lngLat;

      if (activeToolRef.current === 'measure-distance' && distancePointsLengthRef.current === 1) {
        setMeasurePreviewCoord([lng, lat]);
      } else {
        setMeasurePreviewCoord(null);
      }

      // Check discrepancy grid point hover only if layer exists in style
      if (map.getLayer('discrepancy-points')) {
        const gridFeatures = map.queryRenderedFeatures(e.point, { layers: ['discrepancy-points'] });
        if (gridFeatures.length > 0) {
          const p = gridFeatures[0].properties || {};
          setHoveredGridCell({
            x: e.point.x,
            y: e.point.y,
            srtm: typeof p.srtm === 'number' ? p.srtm : null,
            aster: typeof p.aster === 'number' ? p.aster : null,
            delta: typeof p.delta === 'number' ? p.delta : null,
          });
        } else {
          setHoveredGridCell(null);
        }
      } else {
        setHoveredGridCell(null);
      }

      if (sampleTimerRef.current !== null) {
        window.clearTimeout(sampleTimerRef.current);
      }
      sampleTimerRef.current = window.setTimeout(async () => {
        const z = map.getZoom();
        const sampled = await sampleTerrariumPoint(lng, lat, z);
        setTelemetry({
          lon: lng,
          lat,
          elevationMeters: sampled.elevationMeters,
          slopeDeg: sampled.slopeDeg,
          aspectDeg: sampled.aspectDeg,
        });
      }, 45);
    });

    map.on('click', (e: maplibregl.MapMouseEvent) => {
      if (orbitDragRef.current?.moved) {
        orbitDragRef.current.moved = false;
        return;
      }
      if (activeToolRef.current === 'profile-draw') {
        onAddVertexRef.current([e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      if (activeToolRef.current === 'measure-distance') {
        setMeasurePreviewCoord(null);
        onAddDistancePointRef.current([e.lngLat.lng, e.lngLat.lat]);
        return;
      }

      const clickableLayers = [
        'overture-buildings-3d',
        'overture-building-parts-3d',
        'overture-roads',
        'overture-infrastructure',
      ].filter((id) => Boolean(map.getLayer(id)));

      if (clickableLayers.length === 0) return;

      const hits = map.queryRenderedFeatures(e.point, { layers: clickableLayers });
      if (hits.length === 0) {
        onSelectFeatureRef.current(null);
        return;
      }

      const hit = hits[0];
      const props = (hit.properties || {}) as Record<string, unknown>;
      const layerId = hit.layer.id;
      const layerType: SelectedOvertureFeature['layerType'] =
        layerId === 'overture-roads'
          ? 'segment'
          : layerId === 'overture-infrastructure'
            ? 'infrastructure'
            : layerId === 'overture-building-parts-3d'
              ? 'building_part'
              : 'building';

      const parsedSources =
        parseJsonField<Array<{ dataset?: string; record_id?: string; confidence?: number }>>(
          props.sources,
        ) || [];

      const featureId = String(props.id || hit.id || `${layerType}-${e.lngLat.lng.toFixed(5)}`);
      const heightVal = typeof props.height === 'number' ? props.height : undefined;
      const floorsVal = typeof props.num_floors === 'number' ? props.num_floors : undefined;

      onSelectFeatureRef.current({
        layerType,
        id: featureId,
        title: extractFeatureTitle(props, `Overture ${layerType.replace('_', ' ')}`),
        subtype: typeof props.subtype === 'string' ? props.subtype : undefined,
        featureClass: typeof props.class === 'string' ? props.class : undefined,
        height: heightVal,
        numFloors: floorsVal,
        roofShape: typeof props.roof_shape === 'string' ? props.roof_shape : undefined,
        surface: typeof props.surface === 'string' ? props.surface : undefined,
        sources: Array.isArray(parsedSources) ? parsedSources : [],
        properties: props,
        lngLat: [e.lngLat.lng, e.lngLat.lat],
      });
    });

    mapRef.current = map;

    mapHandleRef.current = {
      flyTo: (center, zoom, pitch = 56, bearing = -20) => {
        map.flyTo({ center, zoom, pitch, bearing, duration: 1500, essential: true });
      },
      getBoundsBbox: () => {
        const b = map.getBounds();
        if (!b) return null;
        return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      },
      captureSnapshot: () => {
        try {
          return map.getCanvas().toDataURL('image/png');
        } catch {
          return null;
        }
      },
    };

    return () => {
      if (sampleTimerRef.current !== null) window.clearTimeout(sampleTimerRef.current);
      mapHandleRef.current = null;
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [overtureConfig]);

  // Toggle MapLibre dragPan vs custom Left-Drag 3D Orbit mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (dragMode === 'orbit' && activeTool !== 'profile-draw' && activeTool !== 'measure-distance') {
      map.dragPan.disable();
    } else {
      map.dragPan.enable();
    }
  }, [dragMode, activeTool, mapReady]);

  // Update projection
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setProjection({ type: projection });
  }, [projection, mapReady]);

  // Update 1-degree graticule visibility
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getLayer('graticule-lines')) return;
    map.setLayoutProperty('graticule-lines', 'visibility', showGraticule ? 'visible' : 'none');
    if (!showGraticule) {
      setGraticuleLabels([]);
    } else {
      map.fire('move');
    }
  }, [showGraticule, mapReady]);

  // Update terrain exaggeration
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setTerrain({ source: 'terrarium-dem', exaggeration });
  }, [exaggeration, mapReady]);

  // Update terrain mode & ramp
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const showRelief = terrainMode === 'hypsometric' || terrainMode === 'natural';
    map.setLayoutProperty('terrain-color-relief', 'visibility', showRelief ? 'visible' : 'none');
    map.setPaintProperty(
      'terrain-color-relief',
      'color-relief-opacity',
      terrainMode === 'natural' ? 0.55 : 0.92,
    );
    map.setPaintProperty(
      'terrain-color-relief',
      'color-relief-color',
      getElevationRampExpression(elevationRamp),
    );
    map.setLayoutProperty(
      'terrain-slope-layer',
      'visibility',
      terrainMode === 'slope' ? 'visible' : 'none',
    );
    map.setLayoutProperty(
      'terrain-aspect-layer',
      'visibility',
      terrainMode === 'aspect' ? 'visible' : 'none',
    );
  }, [terrainMode, elevationRamp, mapReady]);

  // Update hillshade solar azimuth & intensity
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setPaintProperty('terrain-hillshade', 'hillshade-illumination-direction', sunAzimuth);
    map.setPaintProperty('terrain-hillshade', 'hillshade-exaggeration', hillshadeIntensity);
  }, [sunAzimuth, hillshadeIntensity, mapReady]);

  // Update Overture layer visibility & building shading
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    map.setLayoutProperty(
      'overture-buildings-3d',
      'visibility',
      overtureLayers.buildings ? 'visible' : 'none',
    );
    map.setLayoutProperty(
      'overture-building-parts-3d',
      'visibility',
      overtureLayers.buildings ? 'visible' : 'none',
    );
    map.setLayoutProperty(
      'overture-roads',
      'visibility',
      overtureLayers.transportation ? 'visible' : 'none',
    );
    map.setLayoutProperty(
      'overture-roads-casing',
      'visibility',
      overtureLayers.transportation ? 'visible' : 'none',
    );
    map.setLayoutProperty(
      'overture-infrastructure',
      'visibility',
      overtureLayers.infrastructure ? 'visible' : 'none',
    );
    map.setLayoutProperty(
      'overture-water',
      'visibility',
      overtureLayers.waterAndLand ? 'visible' : 'none',
    );
    map.setLayoutProperty(
      'overture-land-use',
      'visibility',
      overtureLayers.waterAndLand ? 'visible' : 'none',
    );

    const colorExpr: maplibregl.DataDrivenPropertyValueSpecification<string> =
      buildingColorMode === 'height'
        ? [
            'interpolate',
            ['linear'],
            ['coalesce', ['get', 'height'], ['*', ['coalesce', ['get', 'num_floors'], 2], 3.5], 7],
            5, '#CBD5E1',
            20, '#60A5FA',
            55, '#2563EB',
            120, '#0891B2',
            220, '#D97706',
          ]
        : '#94A3B8';

    map.setPaintProperty('overture-buildings-3d', 'fill-extrusion-color', colorExpr);
  }, [overtureLayers, buildingColorMode, mapReady]);

  // Update selected building highlight filter
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getLayer('overture-selected-highlight')) return;
    map.setFilter('overture-selected-highlight', ['==', ['get', 'id'], selectedFeatureId || '__none__']);
  }, [selectedFeatureId, mapReady]);

  // Update transect polyline & vertices
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const src = map.getSource('transect-geo') as GeoJSONSource | undefined;
    if (!src) return;

    const features: Array<{
      type: 'Feature';
      properties: Record<string, unknown>;
      geometry:
        | { type: 'Point'; coordinates: [number, number] }
        | { type: 'LineString'; coordinates: Array<[number, number]> };
    }> = transectVertices.map((pt) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: pt },
    }));

    if (transectVertices.length >= 2) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: transectVertices },
      });
    }

    src.setData({ type: 'FeatureCollection', features });
  }, [transectVertices, mapReady]);

  // Update profile hover sync marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const src = map.getSource('transect-hover-geo') as GeoJSONSource | undefined;
    if (!src) return;

    if (!hoveredProfileSample) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    src.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Point',
            coordinates: [hoveredProfileSample.lon, hoveredProfileSample.lat],
          },
        },
      ],
    });
  }, [hoveredProfileSample, mapReady]);

  // Update 3D geodesic distance measurement source
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const src = map.getSource('distance-measure-geo') as GeoJSONSource | undefined;
    if (!src) return;

    const features: Array<{
      type: 'Feature';
      properties: Record<string, unknown>;
      geometry:
        | { type: 'Point'; coordinates: [number, number] }
        | { type: 'LineString'; coordinates: Array<[number, number]> };
    }> = distancePoints.map((pt, idx) => ({
      type: 'Feature',
      properties: { label: idx === 0 ? 'A' : 'B' },
      geometry: { type: 'Point', coordinates: pt },
    }));

    const endCoord =
      distancePoints.length >= 2
        ? distancePoints[1]
        : distancePoints.length === 1 && measurePreviewCoord
          ? measurePreviewCoord
          : null;

    if (distancePoints.length >= 1 && endCoord) {
      const arcCoords = sampleGreatCircle(distancePoints[0], endCoord, 48);
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: arcCoords },
      });
    }

    src.setData({ type: 'FeatureCollection', features });
  }, [distancePoints, measurePreviewCoord, mapReady]);

  // Update SRTM vs ASTER discrepancy overlay image + points
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const pointsSrc = map.getSource('discrepancy-points-geo') as GeoJSONSource | undefined;
    if (!discrepancyGrid) {
      if (map.getLayer('discrepancy-raster-layer')) map.removeLayer('discrepancy-raster-layer');
      if (map.getSource('discrepancy-image')) map.removeSource('discrepancy-image');
      pointsSrc?.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    const dataUrl = renderDiscrepancyDataUrl(discrepancyGrid);
    const [minLon, minLat, maxLon, maxLat] = discrepancyGrid.bbox;
    const coords: [[number, number], [number, number], [number, number], [number, number]] = [
      [minLon, maxLat],
      [maxLon, maxLat],
      [maxLon, minLat],
      [minLon, minLat],
    ];

    const existingImg = map.getSource('discrepancy-image') as ImageSource | undefined;
    if (existingImg) {
      existingImg.updateImage({ url: dataUrl, coordinates: coords });
    } else {
      map.addSource('discrepancy-image', {
        type: 'image',
        url: dataUrl,
        coordinates: coords,
      });
      map.addLayer(
        {
          id: 'discrepancy-raster-layer',
          type: 'raster',
          source: 'discrepancy-image',
          paint: {
            'raster-opacity': discrepancyOpacity,
            'raster-fade-duration': 150,
          },
        },
        'overture-roads-casing',
      );
    }

    if (map.getLayer('discrepancy-raster-layer')) {
      map.setPaintProperty('discrepancy-raster-layer', 'raster-opacity', discrepancyOpacity);
    }

    pointsSrc?.setData({
      type: 'FeatureCollection',
      features: discrepancyGrid.cells
        .filter((c) => c.deltaMeters !== null)
        .map((c) => ({
          type: 'Feature',
          properties: {
            srtm: c.srtmMeters,
            aster: c.asterMeters,
            delta: c.deltaMeters,
          },
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        })),
    });
  }, [discrepancyGrid, discrepancyOpacity, mapReady]);

  return (
    <div
      className="relative flex-1 h-full min-w-0 bg-[#E2E8F0]"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDownCapture={(e) => {
        const map = mapRef.current;
        if (!map || activeTool === 'profile-draw' || activeTool === 'measure-distance') return;
        // Left-drag in Orbit mode, or Shift/Alt + Left-drag in Pan mode
        const wantsOrbit =
          e.button === 0 && (dragModeRef.current === 'orbit' || e.shiftKey || e.altKey);
        if (!wantsOrbit) return;
        // Ignore clicks on floating HUD buttons
        if ((e.target as HTMLElement).closest('button')) return;

        if (e.shiftKey || e.altKey) {
          map.dragPan.disable();
        }
        orbitDragRef.current = {
          active: true,
          startX: e.clientX,
          startY: e.clientY,
          startBearing: map.getBearing(),
          startPitch: map.getPitch(),
          moved: false,
        };
      }}
      onPointerMove={(e) => {
        const map = mapRef.current;
        if (!map) return;

        if (orbitDragRef.current?.active) {
          const dx = e.clientX - orbitDragRef.current.startX;
          const dy = e.clientY - orbitDragRef.current.startY;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            orbitDragRef.current.moved = true;
          }
          const nextBearing = orbitDragRef.current.startBearing + dx * 0.45;
          const nextPitch = Math.max(0, Math.min(78, orbitDragRef.current.startPitch - dy * 0.35));
          map.jumpTo({ bearing: nextBearing, pitch: nextPitch });
        }

        if (compassDragRef.current?.active) {
          const dx = e.clientX - compassDragRef.current.startX;
          const dy = e.clientY - compassDragRef.current.startY;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            compassDragRef.current.moved = true;
          }
          const nextBearing = compassDragRef.current.startBearing - dx * 0.75;
          const nextPitch = Math.max(0, Math.min(78, compassDragRef.current.startPitch + dy * 0.45));
          map.jumpTo({ bearing: nextBearing, pitch: nextPitch });
        }
      }}
      onPointerUp={() => {
        const map = mapRef.current;
        if (orbitDragRef.current?.active) {
          orbitDragRef.current.active = false;
          if (map && dragModeRef.current === 'pan') {
            map.dragPan.enable();
          }
        }
        if (compassDragRef.current?.active) {
          compassDragRef.current.active = false;
        }
      }}
      onPointerCancel={() => {
        const map = mapRef.current;
        if (orbitDragRef.current) orbitDragRef.current.active = false;
        if (compassDragRef.current) compassDragRef.current.active = false;
        if (map && dragModeRef.current === 'pan') map.dragPan.enable();
      }}
    >
      <div
        ref={containerRef}
        className={`w-full h-full ${
          activeTool === 'profile-draw' || activeTool === 'measure-distance'
            ? 'cursor-crosshair'
            : dragMode === 'orbit'
              ? 'cursor-grab active:cursor-grabbing'
              : ''
        }`}
      />

      {/* Top-Left Minimalist Draggable 3D Orientation Compass */}
      {(() => {
        const headingDeg = Math.round(((cameraOrientation.bearing % 360) + 360) % 360);
        const pitchDeg = Math.round(cameraOrientation.pitch);
        const visualTilt = Math.min(70, Math.max(0, cameraOrientation.pitch * 0.85));

        return (
          <button
            type="button"
            onPointerDown={(e) => {
              const map = mapRef.current;
              if (!map || e.button !== 0) return;
              compassDragRef.current = {
                active: true,
                startX: e.clientX,
                startY: e.clientY,
                startBearing: map.getBearing(),
                startPitch: map.getPitch(),
                moved: false,
              };
            }}
            onClick={() => {
              if (compassDragRef.current?.moved) return;
              mapRef.current?.easeTo({ bearing: 0, duration: 420 });
            }}
            onDoubleClick={() =>
              mapRef.current?.easeTo({
                bearing: 0,
                pitch: pitchDeg > 15 ? 0 : 56,
                duration: 480,
              })
            }
            title="3D Orientation Compass · Drag to rotate/tilt 3D view, click to align North, double-click to toggle tilt"
            className="absolute top-3 left-3 bg-white/92 border border-slate-200 rounded-md px-2.5 py-2 flex flex-col items-center gap-1.5 z-10 hover:bg-white transition-colors cursor-grab active:cursor-grabbing select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            <div
              className="w-14 h-14 flex items-center justify-center"
              style={{ perspective: '200px' }}
            >
              <div
                className="w-13 h-13 flex items-center justify-center will-change-transform"
                style={{
                  transform: `rotateX(${visualTilt.toFixed(1)}deg) rotateZ(${(-cameraOrientation.bearing).toFixed(1)}deg)`,
                  transformStyle: 'preserve-3d',
                }}
              >
                <svg viewBox="0 0 64 64" className="w-full h-full overflow-visible">
                  {/* Outer Calibrated Ring */}
                  <circle
                    cx="32"
                    cy="32"
                    r="28"
                    fill="#F8FAFC"
                    stroke="#CBD5E1"
                    strokeWidth="1.25"
                  />
                  {/* Minor Degree Ticks */}
                  {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
                    <line
                      key={deg}
                      x1="32"
                      y1={deg % 90 === 0 ? '4' : '6'}
                      x2="32"
                      y2={deg % 90 === 0 ? '9.5' : '8.5'}
                      stroke={deg === 0 ? '#2563EB' : '#94A3B8'}
                      strokeWidth={deg === 0 ? '2' : '1'}
                      transform={`rotate(${deg} 32 32)`}
                    />
                  ))}
                  {/* Cardinal Labels */}
                  <text
                    x="32"
                    y="17"
                    textAnchor="middle"
                    fontSize="8.5"
                    fontWeight="700"
                    fill="#2563EB"
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    N
                  </text>
                  <text
                    x="49"
                    y="35"
                    textAnchor="middle"
                    fontSize="7"
                    fontWeight="600"
                    fill="#64748B"
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    E
                  </text>
                  <text
                    x="32"
                    y="53"
                    textAnchor="middle"
                    fontSize="7"
                    fontWeight="600"
                    fill="#64748B"
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    S
                  </text>
                  <text
                    x="15"
                    y="35"
                    textAnchor="middle"
                    fontSize="7"
                    fontWeight="600"
                    fill="#64748B"
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    W
                  </text>
                  {/* Split North / South Needle */}
                  <polygon points="32,19 35.5,32 28.5,32" fill="#2563EB" />
                  <polygon points="32,45 35.5,32 28.5,32" fill="#CBD5E1" />
                  <circle cx="32" cy="32" r="2.2" fill="#0F172A" />
                </svg>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-[10px] font-mono tabular-nums text-slate-600 leading-none whitespace-nowrap">
              <span>
                HDG <strong className="text-slate-900 font-semibold">{String(headingDeg).padStart(3, '0')}°</strong>
              </span>
              <span aria-hidden="true" className="text-slate-300">·</span>
              <span>
                PITCH <strong className="text-slate-900 font-semibold">{pitchDeg}°</strong>
              </span>
            </div>
          </button>
        );
      })()}

      {/* Top-Right Compact Camera & Mode Controls */}
      <div className="absolute top-3 right-3 flex flex-col gap-1.5 z-10">
        <div className="bg-white/95 border border-slate-200 rounded-md shadow-xs flex flex-col divide-y divide-slate-200 overflow-hidden">
          <button
            type="button"
            onClick={() => mapRef.current?.zoomIn()}
            title="Zoom In"
            className="w-8 h-8 flex items-center justify-center text-slate-700 hover:bg-slate-100 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => mapRef.current?.zoomOut()}
            title="Zoom Out"
            className="w-8 h-8 flex items-center justify-center text-slate-700 hover:bg-slate-100 cursor-pointer"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setDragMode((m) => (m === 'pan' ? 'orbit' : 'pan'))}
            title={
              dragMode === 'orbit'
                ? 'Orbit Mode Active (Left-drag rotates & tilts 3D view) · Click for Pan'
                : 'Enable 3D Orbit Drag Mode (or hold Shift + Left-drag / Right-drag)'
            }
            className={`w-8 h-8 flex items-center justify-center transition-colors cursor-pointer ${
              dragMode === 'orbit'
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Orbit className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const map = mapRef.current;
              if (!map) return;
              map.easeTo({ bearing: map.getBearing() - 45, duration: 350 });
            }}
            title="Rotate Counter-Clockwise 45°"
            className="w-8 h-8 flex items-center justify-center text-slate-700 hover:bg-slate-100 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              const map = mapRef.current;
              if (!map) return;
              map.easeTo({ bearing: map.getBearing() + 45, duration: 350 });
            }}
            title="Rotate Clockwise 45°"
            className="w-8 h-8 flex items-center justify-center text-slate-700 hover:bg-slate-100 cursor-pointer"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => mapRef.current?.easeTo({ bearing: 0, duration: 400 })}
            title="Align North"
            className="w-8 h-8 flex items-center justify-center text-slate-700 hover:bg-slate-100 cursor-pointer"
          >
            <Compass className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const map = mapRef.current;
              if (!map) return;
              const currentPitch = map.getPitch();
              map.easeTo({ pitch: currentPitch > 20 ? 0 : 58, duration: 450 });
            }}
            title="Toggle 2D / 3D Tilt"
            className="w-8 h-8 flex items-center justify-center text-slate-700 hover:bg-slate-100 cursor-pointer"
          >
            <Box className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onToggleGraticule}
            title={showGraticule ? 'Hide 1° Graticule Grid' : 'Show 1° Graticule Grid'}
            className={`w-8 h-8 flex items-center justify-center transition-colors cursor-pointer ${
              showGraticule
                ? 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Grid className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() =>
              onSetActiveTool(activeTool === 'measure-distance' ? 'inspect' : 'measure-distance')
            }
            title={
              activeTool === 'measure-distance'
                ? 'Exit 3D Distance Tool'
                : 'Measure 3D Geodesic Distance (Point A to B)'
            }
            className={`w-8 h-8 flex items-center justify-center transition-colors cursor-pointer ${
              activeTool === 'measure-distance'
                ? 'bg-cyan-700 text-white hover:bg-cyan-800'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <MoveHorizontal className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onResetCurrentRegion}
            title="Reset Region View"
            className="w-8 h-8 flex items-center justify-center text-slate-700 hover:bg-slate-100 cursor-pointer text-[10px] font-mono font-semibold"
          >
            RST
          </button>
        </div>
      </div>

      {/* Floating Geodesic & Terrain 3D Distance Measurement HUD */}
      {distancePoints.length > 0 && (
        <div className="absolute bottom-12 left-3 bg-white/95 border border-slate-200 rounded-md px-3.5 py-2.5 shadow-xs z-20 min-w-[290px] max-w-[360px]">
          <div className="flex items-center justify-between gap-3 pb-1.5 border-b border-slate-100">
            <span className="text-[11px] font-semibold text-slate-800 flex items-center gap-1.5">
              <MoveHorizontal className="w-3.5 h-3.5 text-cyan-700" />
              Geodesic & Terrain Distance
            </span>
            <button
              type="button"
              onClick={onClearDistance}
              title="Clear Measurement"
              className="text-slate-400 hover:text-slate-700 p-0.5 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {distancePoints.length === 1 && (
            <div className="pt-2 text-[11px] text-slate-600 font-mono tabular-nums">
              Point A: {distancePoints[0][1].toFixed(4)}°, {distancePoints[0][0].toFixed(4)}°
              <div className="font-sans text-slate-500 mt-0.5">
                Click Point B on the terrain to calculate geodesic & 3D surface distance.
              </div>
            </div>
          )}

          {distanceResult && (
            <div className="pt-2 space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    WGS84 Geodesic
                  </div>
                  <div className="text-sm font-mono font-semibold tabular-nums text-slate-900">
                    {formatDistance(distanceResult.geodesicMeters)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Bearing (A→B)
                  </div>
                  <div className="text-sm font-mono font-semibold tabular-nums text-slate-900">
                    {distanceResult.initialBearingDeg.toFixed(1)}°
                  </div>
                </div>
              </div>

              {distanceResult.loading ? (
                <div className="text-[11px] text-slate-500 font-mono">
                  Sampling SRTM 30m & ASTER 30m along arc...
                </div>
              ) : distanceResult.error ? (
                <div className="text-[11px] text-rose-600">{distanceResult.error}</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 pt-1.5 border-t border-slate-100">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-blue-700">
                        3D Surface (SRTM)
                      </div>
                      <div className="text-xs font-mono font-semibold tabular-nums text-slate-900">
                        {distanceResult.surfaceSrtmMeters !== null
                          ? formatDistance(distanceResult.surfaceSrtmMeters)
                          : 'N/A'}
                      </div>
                      {distanceResult.surfaceSrtmMeters !== null &&
                        distanceResult.geodesicMeters > 0 && (
                          <div className="text-[10px] font-mono tabular-nums text-slate-500">
                            +
                            {(
                              ((distanceResult.surfaceSrtmMeters - distanceResult.geodesicMeters) /
                                distanceResult.geodesicMeters) *
                              100
                            ).toFixed(2)}
                            % relief
                          </div>
                        )}
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-amber-700">
                        3D Surface (ASTER)
                      </div>
                      <div className="text-xs font-mono font-semibold tabular-nums text-slate-900">
                        {distanceResult.surfaceAsterMeters !== null
                          ? formatDistance(distanceResult.surfaceAsterMeters)
                          : 'N/A'}
                      </div>
                      {distanceResult.surfaceAsterMeters !== null &&
                        distanceResult.geodesicMeters > 0 && (
                          <div className="text-[10px] font-mono tabular-nums text-slate-500">
                            +
                            {(
                              ((distanceResult.surfaceAsterMeters - distanceResult.geodesicMeters) /
                                distanceResult.geodesicMeters) *
                              100
                            ).toFixed(2)}
                            % relief
                          </div>
                        )}
                    </div>
                  </div>

                  <div className="pt-1.5 border-t border-slate-100 text-[10px] font-mono tabular-nums text-slate-600 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>
                      Elev:{' '}
                      {distanceResult.elevASrtm !== null && distanceResult.elevBSrtm !== null
                        ? `${Math.round(distanceResult.elevASrtm)}m → ${Math.round(distanceResult.elevBSrtm)}m`
                        : 'N/A'}
                    </span>
                    {distanceResult.ascentSrtmMeters !== null && (
                      <span>
                        +{distanceResult.ascentSrtmMeters}m / -{distanceResult.descentSrtmMeters}m
                      </span>
                    )}
                    {distanceResult.maxGradePct !== null && (
                      <span>Max {distanceResult.maxGradePct}%</span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Projected 1-Degree Graticule Coordinate Tick Labels */}
      {showGraticule &&
        graticuleLabels.map((lbl) => (
          <div
            key={lbl.key}
            className="pointer-events-none absolute text-[10px] font-mono tabular-nums text-slate-700 bg-white/85 border border-slate-200/90 px-1.5 py-0.5 rounded-xs z-10 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap"
            style={{
              left: lbl.axis === 'lat' ? 32 : lbl.x,
              top: lbl.y,
            }}
          >
            {lbl.text}
          </div>
        ))}

      {/* Bottom-Left Live Telemetry HUD */}
      <div className="pointer-events-none absolute bottom-3 left-3 bg-white/92 border border-slate-200 rounded-md px-3 py-1.5 text-[11px] font-mono tabular-nums text-slate-700 flex items-center gap-3 z-10">
        {telemetry ? (
          <>
            <span>
              {telemetry.lat.toFixed(4)}°, {telemetry.lon.toFixed(4)}°
            </span>
            <span aria-hidden="true" className="text-slate-300">|</span>
            <span>
              Elev:{' '}
              <strong className="text-slate-900 font-semibold">
                {telemetry.elevationMeters !== null ? `${telemetry.elevationMeters} m` : '—'}
              </strong>
            </span>
            <span aria-hidden="true" className="text-slate-300">|</span>
            <span>
              Slope:{' '}
              <strong className="text-slate-900 font-semibold">
                {telemetry.slopeDeg !== null ? `${telemetry.slopeDeg}°` : '—'}
              </strong>
            </span>
            {telemetry.aspectDeg !== null && (
              <>
                <span aria-hidden="true" className="text-slate-300">|</span>
                <span>
                  Aspect: <strong className="text-slate-900 font-semibold">{telemetry.aspectDeg}°</strong>
                </span>
              </>
            )}
          </>
        ) : (
          <span className="text-slate-400">Move cursor over terrain for elevation & slope telemetry</span>
        )}
      </div>

      {/* Bottom-Right Calibrated Color Ramp Legend (above ScaleControl) */}
      <div className="pointer-events-none absolute bottom-10 right-3 bg-white/92 border border-slate-200 rounded-md px-3 py-2 text-[10px] z-10 min-w-[180px]">
        {discrepancyGrid ? (
          <div className="space-y-1">
            <div className="font-medium text-slate-700">Δh (ASTER − SRTM)</div>
            <div
              className="h-2 rounded-xs w-full"
              style={{
                background: 'linear-gradient(to right, #1D4ED8, #38BDF8, #F8FAFC, #F59E0B, #DC2626)',
              }}
            />
            <div className="flex justify-between font-mono tabular-nums text-slate-500">
              <span>-25m</span>
              <span>0m</span>
              <span>+25m</span>
            </div>
          </div>
        ) : terrainMode === 'slope' ? (
          <div className="space-y-1">
            <div className="font-medium text-slate-700">Terrain Slope Steepness</div>
            <div
              className="h-2 rounded-xs w-full"
              style={{
                background: 'linear-gradient(to right, #E2E8F0, #38BDF8, #FACC15, #EA580C, #991B1B)',
              }}
            />
            <div className="flex justify-between font-mono tabular-nums text-slate-500">
              <span>0°</span>
              <span>25°</span>
              <span>55°+</span>
            </div>
          </div>
        ) : terrainMode === 'aspect' ? (
          <div className="space-y-1">
            <div className="font-medium text-slate-700">Aspect Compass Bearing</div>
            <div
              className="h-2 rounded-xs w-full"
              style={{
                background: 'linear-gradient(to right, #2563EB, #059669, #D97706, #7C3AED, #2563EB)',
              }}
            />
            <div className="flex justify-between font-mono tabular-nums text-slate-500">
              <span>N 0°</span>
              <span>E 90°</span>
              <span>S 180°</span>
              <span>W 270°</span>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="font-medium text-slate-700">Hypsometric Elevation</div>
            <div
              className="h-2 rounded-xs w-full"
              style={{
                background:
                  elevationRamp === 'high-contrast'
                    ? 'linear-gradient(to right, #1E3A8A, #38BDF8, #FACC15, #EA580C, #FFFFFF)'
                    : elevationRamp === 'alpine-monochrome'
                      ? 'linear-gradient(to right, #E2E8F0, #94A3B8, #475569, #F8FAFC)'
                      : 'linear-gradient(to right, #E2E8F0, #D9E8D8, #D4B895, #A88A73, #F8FAFC)',
              }}
            />
            <div className="flex justify-between font-mono tabular-nums text-slate-500">
              <span>0m</span>
              <span>1500m</span>
              <span>3800m+</span>
            </div>
          </div>
        )}
      </div>

      {/* Grid Cell Hover Tooltip */}
      {hoveredGridCell && (
        <div
          className="pointer-events-none absolute bg-white border border-slate-200 rounded shadow-sm px-2.5 py-1.5 text-[11px] font-mono tabular-nums z-20"
          style={{
            left: Math.min(hoveredGridCell.x + 12, window.innerWidth - 220),
            top: Math.max(12, hoveredGridCell.y - 54),
          }}
        >
          <div className="text-blue-700">
            SRTM: {hoveredGridCell.srtm !== null ? `${hoveredGridCell.srtm.toFixed(1)}m` : 'N/A'}
          </div>
          <div className="text-amber-700">
            ASTER: {hoveredGridCell.aster !== null ? `${hoveredGridCell.aster.toFixed(1)}m` : 'N/A'}
          </div>
          <div className="text-slate-900 font-semibold">
            Δh: {hoveredGridCell.delta !== null ? `${hoveredGridCell.delta > 0 ? '+' : ''}${hoveredGridCell.delta.toFixed(1)}m` : 'N/A'}
          </div>
        </div>
      )}
    </div>
  );
};
