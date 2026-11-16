export type TerrainMode = 'hypsometric' | 'slope' | 'aspect' | 'natural';

export type BuildingColorMode = 'architectural' | 'height';

export type ActiveTool = 'inspect' | 'profile-draw' | 'measure-distance' | 'drone-corridor';

export type ProjectionMode = 'globe' | 'mercator';

export type ElevationRampPreset = 'scientific-terrain' | 'alpine-monochrome' | 'high-contrast';

export type DroneAltitudeMode = 'agl' | 'msl';

export interface DroneZoneConfig {
  enabled: boolean;
  showMapOverlay: boolean;
  showInspectorModal: boolean;
  showEnvelopeMesh: boolean;
  showCeilingMesh: boolean;
  showWireframe: boolean;
  altitudeMode: DroneAltitudeMode;
  ceilingMeters: number;
  verticalBufferMeters: number;
  horizontalBufferMeters: number;
  envelopeOpacity: number;
  ceilingOpacity: number;
}

export interface DroneBuildingFootprint {
  id: string;
  title: string;
  heightMeters: number;
  minHeightMeters: number;
  ring: Array<[number, number]>;
}

export interface DroneAirspaceGrid {
  bbox: [number, number, number, number];
  center: [number, number];
  cols: number;
  rows: number;
  widthMeters: number;
  depthMeters: number;
  terrainElev: Float32Array;
  rawBuildingHeight: Float32Array;
  bufferedBuildingHeight: Float32Array;
  envelopeElev: Float32Array;
  ceilingElev: Float32Array;
  clearance: Float32Array;
  minTerrainMeters: number;
  maxTerrainMeters: number;
  maxBuildingHeightMeters: number;
  maxObstacleElevMeters: number;
  minClearanceMeters: number;
  violationCellCount: number;
  cautionCellCount: number;
  totalCells: number;
  violationPct: number;
  buildingCount: number;
  demTilesLoaded: number;
  buildings: DroneBuildingFootprint[];
  capturedAt: string;
}

export interface DroneCorridorSample {
  index: number;
  distanceMeters: number;
  lon: number;
  lat: number;
  terrainMeters: number;
  buildingHeightMeters: number;
  envelopeMeters: number;
  ceilingMeters: number;
  clearanceMeters: number;
  status: 'CLEAR' | 'CAUTION' | 'VIOLATION';
}

export interface DroneCorridorAnalysis {
  waypoints: Array<[number, number]>;
  samples: DroneCorridorSample[];
  summary: {
    totalLengthMeters: number;
    minClearanceMeters: number;
    maxEnvelopeMeters: number;
    maxBuildingMeters: number;
    violationSampleCount: number;
    cautionSampleCount: number;
    status: 'CLEAR' | 'CAUTION' | 'VIOLATION';
  };
}

export interface RegionPreset {
  id: string;
  label: string;
  fullName: string;
  subtitle: string;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  maxElevationHint: number;
}

export interface OvertureConfig {
  release: string;
  baseUrl: string;
  buildingsUrl: string;
  transportationUrl: string;
  baseLayerUrl: string;
  resolvedAt: string;
}

export interface OvertureLayerVisibility {
  buildings: boolean;
  transportation: boolean;
  infrastructure: boolean;
  waterAndLand: boolean;
}

export interface CursorTelemetry {
  lon: number;
  lat: number;
  elevationMeters: number | null;
  slopeDeg: number | null;
  aspectDeg: number | null;
}

export interface SelectedOvertureFeature {
  layerType: 'building' | 'building_part' | 'segment' | 'infrastructure';
  id: string;
  title: string;
  subtype?: string;
  featureClass?: string;
  height?: number;
  numFloors?: number;
  roofShape?: string;
  surface?: string;
  sources: Array<{ dataset?: string; record_id?: string; confidence?: number }>;
  properties: Record<string, unknown>;
  lngLat: [number, number];
}

export interface ProfileSample {
  index: number;
  distanceKm: number;
  lon: number;
  lat: number;
  srtmMeters: number | null;
  asterMeters: number | null;
  deltaMeters: number | null;
}

export interface ElevationProfileResult {
  totalDistanceKm: number;
  samples: ProfileSample[];
  summary: {
    validComparison: number;
    srtmCount: number;
    asterCount: number;
    meanBias: number | null;
    rmse: number | null;
    minDelta: number | null;
    maxDelta: number | null;
    maxAbsDiff: number | null;
    minElev: number | null;
    maxElev: number | null;
    totalGainSrtm: number;
    totalGainAster: number;
    totalSamples: number;
  };
}

export interface DiscrepancyCell {
  row: number;
  col: number;
  lon: number;
  lat: number;
  srtmMeters: number | null;
  asterMeters: number | null;
  deltaMeters: number | null;
}

export interface DiscrepancyGridResult {
  bbox: [number, number, number, number];
  rows: number;
  cols: number;
  cells: DiscrepancyCell[];
  stats: {
    validComparison: number;
    srtmCount: number;
    asterCount: number;
    meanBias: number | null;
    rmse: number | null;
    minDelta: number | null;
    maxDelta: number | null;
    maxAbsDiff: number | null;
    minElev: number | null;
    maxElev: number | null;
    totalCells: number;
    srtmOutsideLatCoverage: boolean;
  };
}

export interface DistanceMeasurementResult {
  pointA: [number, number];
  pointB: [number, number];
  geodesicMeters: number;
  initialBearingDeg: number;
  surfaceSrtmMeters: number | null;
  surfaceAsterMeters: number | null;
  elevASrtm: number | null;
  elevBSrtm: number | null;
  elevAAster: number | null;
  elevBAster: number | null;
  ascentSrtmMeters: number | null;
  descentSrtmMeters: number | null;
  maxGradePct: number | null;
  sampleCount: number;
  loading: boolean;
  error: string | null;
}

export interface GeocodeResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  elevation?: number;
  country?: string;
  admin1?: string;
}

export const REGION_PRESETS: RegionPreset[] = [
  {
    id: 'san-francisco',
    label: 'San Francisco',
    fullName: 'San Francisco & Marin Headlands',
    subtitle: 'Golden Gate span, steep coastal ridges & dense urban skyline',
    center: [-122.448, 37.784],
    zoom: 12.6,
    pitch: 62,
    bearing: -34,
    maxElevationHint: 450,
  },
  {
    id: 'mt-fuji',
    label: 'Mt. Fuji',
    fullName: 'Fujiyoshida & Mount Fuji',
    subtitle: '3,776m volcanic cone meeting basin settlements',
    center: [138.775, 35.432],
    zoom: 12.1,
    pitch: 62,
    bearing: -155,
    maxElevationHint: 3800,
  },
  {
    id: 'zermatt',
    label: 'Zermatt',
    fullName: 'Zermatt & Matterhorn',
    subtitle: 'High alpine glacial valley & mountain infrastructure',
    center: [7.734, 46.008],
    zoom: 12.8,
    pitch: 60,
    bearing: -145,
    maxElevationHint: 4500,
  },
  {
    id: 'rio',
    label: 'Rio',
    fullName: 'Rio de Janeiro & Sugarloaf',
    subtitle: 'Granite monoliths intersecting coastal metropolis',
    center: [-43.175, -22.948],
    zoom: 13.4,
    pitch: 58,
    bearing: 32,
    maxElevationHint: 900,
  },
  {
    id: 'hoover-dam',
    label: 'Hoover Dam',
    fullName: 'Hoover Dam & Black Canyon',
    subtitle: 'Steep Colorado River gorge & hydro-civil structures',
    center: [-114.7375, 36.016],
    zoom: 14.2,
    pitch: 62,
    bearing: -55,
    maxElevationHint: 900,
  },
];
