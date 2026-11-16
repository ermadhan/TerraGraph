import { fetchDecodedDemTile } from './demProtocol';
import { vincentyInverse } from './geodesic';
import type {
  DroneAirspaceGrid,
  DroneBuildingFootprint,
  DroneCorridorAnalysis,
  DroneCorridorSample,
  DroneZoneConfig,
} from '../types/geospatial';

const TILE_SIZE = 256;

export const DEFAULT_DRONE_ZONE_CONFIG: DroneZoneConfig = {
  enabled: false,
  showMapOverlay: true,
  showInspectorModal: false,
  showEnvelopeMesh: true,
  showCeilingMesh: true,
  showWireframe: true,
  autoClimbCorridor: true,
  altitudeMode: 'agl',
  ceilingMeters: 120,
  verticalBufferMeters: 15,
  horizontalBufferMeters: 12,
  envelopeOpacity: 0.6,
  ceilingOpacity: 0.34,
};

const EARTH_CIRCUMFERENCE_METERS = 2 * Math.PI * 6378137;

/**
 * Pure Web Mercator [0..1] projection matching maplibregl.MercatorCoordinate.fromLngLat.
 */
export function lngLatToMercator01(lon: number, lat: number): { x: number; y: number } {
  const clampedLat = Math.max(-85.0511287798, Math.min(85.0511287798, lat));
  const x = (180 + lon) / 360;
  const sinLat = Math.sin((clampedLat * Math.PI) / 180);
  const y = 0.5 - (0.25 * Math.log((1 + sinLat) / (1 - sinLat))) / Math.PI;
  return { x, y };
}

export function mercator01ToLngLat(x: number, y: number): [number, number] {
  const lon = x * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lon, lat];
}

export function meterInMercatorUnitsAtLat(lat: number): number {
  const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  return 1 / (EARTH_CIRCUMFERENCE_METERS * cosLat);
}

/**
 * Converts lon/lat to metric offsets (East, South) relative to the MapLibre Mercator projection origin.
 */
export function lngLatToMapLibreOriginMeters(
  lon: number,
  lat: number,
  originCenter: [number, number],
): { eastMeters: number; southMeters: number } {
  const originMerc = lngLatToMercator01(originCenter[0], originCenter[1]);
  const ptMerc = lngLatToMercator01(lon, lat);
  const mercPerMeter = meterInMercatorUnitsAtLat(originCenter[1]);
  return {
    eastMeters: (ptMerc.x - originMerc.x) / mercPerMeter,
    southMeters: (ptMerc.y - originMerc.y) / mercPerMeter,
  };
}

export function mapLibreOriginMetersToLngLat(
  eastMeters: number,
  southMeters: number,
  originCenter: [number, number],
): [number, number] {
  const originMerc = lngLatToMercator01(originCenter[0], originCenter[1]);
  const mercPerMeter = meterInMercatorUnitsAtLat(originCenter[1]);
  return mercator01ToLngLat(
    originMerc.x + eastMeters * mercPerMeter,
    originMerc.y + southMeters * mercPerMeter,
  );
}

function pointInRing(x: number, y: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointToSegmentDistSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

function pointToPolygonDistanceMeters(
  px: number,
  py: number,
  ringMeters: Array<[number, number]>,
): number {
  if (ringMeters.length < 3) return Infinity;
  if (pointInRing(px, py, ringMeters)) return 0;

  let minSq = Infinity;
  for (let i = 0; i < ringMeters.length; i++) {
    const [ax, ay] = ringMeters[i];
    const [bx, by] = ringMeters[(i + 1) % ringMeters.length];
    const dSq = pointToSegmentDistSq(px, py, ax, ay, bx, by);
    if (dSq < minSq) minSq = dSq;
  }
  return Math.sqrt(minSq);
}

function lonLatToTileFractional(
  lon: number,
  lat: number,
  zoom: number,
): { z: number; x: number; y: number; fx: number; fy: number } {
  const z = Math.max(0, Math.min(15, Math.floor(zoom)));
  const n = Math.pow(2, z);
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const latRad = (clampedLat * Math.PI) / 180;

  const xf = ((lon + 180) / 360) * n;
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;

  const x = Math.max(0, Math.min(n - 1, Math.floor(xf)));
  const y = Math.max(0, Math.min(n - 1, Math.floor(yf)));
  const fx = Math.max(0, Math.min(TILE_SIZE - 1, (xf - x) * TILE_SIZE));
  const fy = Math.max(0, Math.min(TILE_SIZE - 1, (yf - y) * TILE_SIZE));

  return { z, x, y, fx, fy };
}

function sampleTileBilinear(tile: Float32Array, fx: number, fy: number): number {
  const c0 = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(fx)));
  const r0 = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(fy)));
  const c1 = Math.min(TILE_SIZE - 1, c0 + 1);
  const r1 = Math.min(TILE_SIZE - 1, r0 + 1);
  const tx = fx - c0;
  const ty = fy - r0;

  const v00 = tile[r0 * TILE_SIZE + c0];
  const v10 = tile[r0 * TILE_SIZE + c1];
  const v01 = tile[r1 * TILE_SIZE + c0];
  const v11 = tile[r1 * TILE_SIZE + c1];

  const val =
    v00 * (1 - tx) * (1 - ty) +
    v10 * tx * (1 - ty) +
    v01 * (1 - tx) * ty +
    v11 * tx * ty;
  return Number.isFinite(val) ? val : 0;
}

function sampleGridBilinear(
  grid: Pick<DroneAirspaceGrid, 'bbox' | 'cols' | 'rows'>,
  arr: Float32Array,
  lon: number,
  lat: number,
): number {
  const [minLon, minLat, maxLon, maxLat] = grid.bbox;
  const u = Math.max(0, Math.min(1, (lon - minLon) / Math.max(1e-9, maxLon - minLon)));
  const v = Math.max(0, Math.min(1, (maxLat - lat) / Math.max(1e-9, maxLat - minLat)));

  const fx = u * (grid.cols - 1);
  const fy = v * (grid.rows - 1);
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  const c1 = Math.min(grid.cols - 1, c0 + 1);
  const r1 = Math.min(grid.rows - 1, r0 + 1);
  const tx = fx - c0;
  const ty = fy - r0;

  const v00 = arr[r0 * grid.cols + c0];
  const v10 = arr[r0 * grid.cols + c1];
  const v01 = arr[r1 * grid.cols + c0];
  const v11 = arr[r1 * grid.cols + c1];

  return (
    v00 * (1 - tx) * (1 - ty) +
    v10 * tx * (1 - ty) +
    v01 * (1 - tx) * ty +
    v11 * tx * ty
  );
}

/**
 * Computes bilinear terrain elevations from AWS Terrarium DEM tiles for an AOI grid
 * centered on the camera's focal point, and conservatively rasterizes Overture building footprints.
 */
export async function buildDroneAirspaceGrid(
  rawBbox: [number, number, number, number],
  mapZoom: number,
  buildings: DroneBuildingFootprint[],
  config: DroneZoneConfig,
  cols = 72,
  rows = 72,
  focalCenter?: [number, number],
): Promise<DroneAirspaceGrid> {
  // Use the actual camera focal center so pitched 3D views (e.g. 62°) don't drift toward the horizon.
  let [minLon, minLat, maxLon, maxLat] = rawBbox;
  const cLon = focalCenter ? focalCenter[0] : (minLon + maxLon) / 2;
  const cLat = focalCenter ? focalCenter[1] : (minLat + maxLat) / 2;

  const maxLonSpan = 0.028;
  const maxLatSpan = 0.022;
  const minLonSpan = 0.008;
  const minLatSpan = 0.0065;

  const halfLon = Math.max(minLonSpan / 2, Math.min(maxLonSpan / 2, (maxLon - minLon) * 0.32));
  const halfLat = Math.max(minLatSpan / 2, Math.min(maxLatSpan / 2, (maxLat - minLat) * 0.32));

  minLon = cLon - halfLon;
  maxLon = cLon + halfLon;
  minLat = Math.max(-84, cLat - halfLat);
  maxLat = Math.min(84, cLat + halfLat);

  const bbox: [number, number, number, number] = [minLon, minLat, maxLon, maxLat];
  const cosLat = Math.max(0.15, Math.cos((cLat * Math.PI) / 180));
  const metersPerDegLat = 111319.9;
  const metersPerDegLon = 111319.9 * cosLat;

  const widthMeters = Math.max(100, (maxLon - minLon) * metersPerDegLon);
  const depthMeters = Math.max(100, (maxLat - minLat) * metersPerDegLat);

  // Sample Terrarium DEM tiles at a high detail zoom (11..14) for reliable crisp coverage
  const demZ = Math.min(14, Math.max(11, Math.round(mapZoom)));
  const tileCache = new Map<string, Float32Array | null>();
  const neededTiles = new Map<string, { z: number; x: number; y: number }>();

  const gridMeta: Array<{ lon: number; lat: number; z: number; x: number; y: number; fx: number; fy: number }> = [];

  for (let r = 0; r < rows; r++) {
    const v = rows > 1 ? r / (rows - 1) : 0.5;
    // Row 0 = North (maxLat), Row rows-1 = South (minLat)
    const lat = maxLat - v * (maxLat - minLat);
    for (let c = 0; c < cols; c++) {
      const u = cols > 1 ? c / (cols - 1) : 0.5;
      const lon = minLon + u * (maxLon - minLon);
      const t = lonLatToTileFractional(lon, lat, demZ);
      const key = `${t.z}/${t.x}/${t.y}`;
      if (!neededTiles.has(key)) neededTiles.set(key, { z: t.z, x: t.x, y: t.y });
      gridMeta.push({ lon, lat, ...t });
    }
  }

  let demTilesLoaded = 0;
  await Promise.all(
    Array.from(neededTiles.entries()).map(async ([key, t]) => {
      let data = await fetchDecodedDemTile(t.z, t.x, t.y);
      if (!data && t.z > 11) {
        data = await fetchDecodedDemTile(t.z - 1, Math.floor(t.x / 2), Math.floor(t.y / 2));
      }
      if (data) demTilesLoaded++;
      tileCache.set(key, data);
    }),
  );

  const totalCells = cols * rows;
  const terrainElev = new Float32Array(totalCells);
  let minTerrainMeters = Infinity;
  let maxTerrainMeters = -Infinity;

  for (let i = 0; i < totalCells; i++) {
    const m = gridMeta[i];
    const tile = tileCache.get(`${m.z}/${m.x}/${m.y}`);
    const elev = tile ? sampleTileBilinear(tile, m.fx, m.fy) : 0;
    terrainElev[i] = elev;
    if (elev < minTerrainMeters) minTerrainMeters = elev;
    if (elev > maxTerrainMeters) maxTerrainMeters = elev;
  }

  if (!Number.isFinite(minTerrainMeters)) minTerrainMeters = 0;
  if (!Number.isFinite(maxTerrainMeters)) maxTerrainMeters = 0;

  // Filter buildings intersecting the AOI bbox (with margin for horizontal buffer)
  const marginLon = 110 / metersPerDegLon;
  const marginLat = 110 / metersPerDegLat;
  const filteredBuildings = buildings.filter((b) => {
    for (const [lon, lat] of b.ring) {
      if (
        lon >= minLon - marginLon &&
        lon <= maxLon + marginLon &&
        lat >= minLat - marginLat &&
        lat <= maxLat + marginLat
      ) {
        return true;
      }
    }
    return false;
  });

  const rawBuildingHeight = new Float32Array(totalCells);
  const bufferedBuildingHeight = new Float32Array(totalCells);
  const envelopeElev = new Float32Array(totalCells);
  const ceilingElev = new Float32Array(totalCells);
  const clearance = new Float32Array(totalCells);

  const partialGrid: DroneAirspaceGrid = {
    bbox,
    center: [cLon, cLat],
    cols,
    rows,
    widthMeters,
    depthMeters,
    terrainElev,
    rawBuildingHeight,
    bufferedBuildingHeight,
    envelopeElev,
    ceilingElev,
    clearance,
    minTerrainMeters,
    maxTerrainMeters,
    maxBuildingHeightMeters: 0,
    maxObstacleElevMeters: maxTerrainMeters,
    minClearanceMeters: 0,
    violationCellCount: 0,
    cautionCellCount: 0,
    totalCells,
    violationPct: 0,
    buildingCount: filteredBuildings.length,
    demTilesLoaded,
    buildings: filteredBuildings,
    capturedAt: new Date().toISOString(),
  };

  const result = recomputeDroneClearance(partialGrid, config, true);

  // Structured vertex & elevation debug log for spatial verification
  const centerIdx = Math.floor(rows / 2) * cols + Math.floor(cols / 2);
  let peakIdx = 0;
  for (let i = 1; i < result.envelopeElev.length; i++) {
    if (result.envelopeElev[i] > result.envelopeElev[peakIdx]) peakIdx = i;
  }
  const sampleVertexInfo = (idx: number) => {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const v = rows > 1 ? r / (rows - 1) : 0.5;
    const u = cols > 1 ? c / (cols - 1) : 0.5;
    const lon = minLon + u * (maxLon - minLon);
    const lat = maxLat - v * (maxLat - minLat);
    const originOffsets = lngLatToMapLibreOriginMeters(lon, lat, result.center);
    return {
      rc: `[${r},${c}]`,
      lon: Number(lon.toFixed(5)),
      lat: Number(lat.toFixed(5)),
      eastM: Number(originOffsets.eastMeters.toFixed(1)),
      southM: Number(originOffsets.southMeters.toFixed(1)),
      terrainM: Number(result.terrainElev[idx].toFixed(1)),
      bldgM: Number(result.bufferedBuildingHeight[idx].toFixed(1)),
      envelopeM: Number(result.envelopeElev[idx].toFixed(1)),
      ceilingM: Number(result.ceilingElev[idx].toFixed(1)),
    };
  };

  console.info('[DroneAirspaceGrid] Synthesized composite terrain + building grid', {
    originCenter: [Number(cLon.toFixed(5)), Number(cLat.toFixed(5))],
    gridSize: `${cols}x${rows} (${totalCells} vertices)`,
    demTilesLoaded,
    buildingsInAoi: filteredBuildings.length,
    terrainRangeM: [Number(minTerrainMeters.toFixed(1)), Number(maxTerrainMeters.toFixed(1))],
    maxBuildingHeightM: result.maxBuildingHeightMeters,
    maxObstacleElevM: result.maxObstacleElevMeters,
    sampleVertices: {
      nw: sampleVertexInfo(0),
      center: sampleVertexInfo(centerIdx),
      peakObstacle: sampleVertexInfo(peakIdx),
      se: sampleVertexInfo(totalCells - 1),
    },
  });

  return result;
}

/**
 * Recomputes buffered building envelope, flight ceiling, and net clearance over an existing grid.
 * Uses conservative spatial + 4-corner quad expansion and slope-aware roof maximums so no building
 * roof or terrain ridge protrudes above the composite obstacle envelope mesh.
 */
export function recomputeDroneClearance(
  grid: DroneAirspaceGrid,
  config: DroneZoneConfig,
  recomputeFootprints = true,
): DroneAirspaceGrid {
  const {
    bbox: [minLon, minLat, maxLon, maxLat],
    center: [cLon, cLat],
    cols,
    rows,
    terrainElev,
    buildings,
  } = grid;

  const totalCells = cols * rows;
  const cosLat = Math.max(0.15, Math.cos((cLat * Math.PI) / 180));
  const metersPerDegLon = 111319.9 * cosLat;
  const metersPerDegLat = 111319.9;

  const rawBuildingHeight = recomputeFootprints
    ? new Float32Array(totalCells)
    : grid.rawBuildingHeight;
  const bufferedBuildingHeight = recomputeFootprints
    ? new Float32Array(totalCells)
    : grid.bufferedBuildingHeight;

  if (recomputeFootprints && buildings.length > 0) {
    const hBuf = Math.max(0, config.horizontalBufferMeters);
    const cellMetersX = grid.widthMeters / Math.max(1, cols - 1);
    const cellMetersY = grid.depthMeters / Math.max(1, rows - 1);
    // Conservative half-cell diagonal ensures buildings smaller than grid spacing never fall between vertices
    const cellHalfDiag = 0.52 * Math.hypot(cellMetersX, cellMetersY);
    const effectiveRadius = hBuf + cellHalfDiag;
    const lonRange = Math.max(1e-9, maxLon - minLon);
    const latRange = Math.max(1e-9, maxLat - minLat);

    for (const b of buildings) {
      if (b.ring.length < 3) continue;

      let bMinX = Infinity;
      let bMaxX = -Infinity;
      let bMinY = Infinity;
      let bMaxY = -Infinity;
      let sumLon = 0;
      let sumLat = 0;
      let bTerrainMax = -Infinity;

      const ringMeters: Array<[number, number]> = b.ring.map(([lon, lat]) => {
        sumLon += lon;
        sumLat += lat;
        const vTerrain = sampleGridBilinear(grid, terrainElev, lon, lat);
        if (vTerrain > bTerrainMax) bTerrainMax = vTerrain;

        const mx = (lon - cLon) * metersPerDegLon;
        const my = (lat - cLat) * metersPerDegLat;
        if (mx < bMinX) bMinX = mx;
        if (mx > bMaxX) bMaxX = mx;
        if (my < bMinY) bMinY = my;
        if (my > bMaxY) bMaxY = my;
        return [mx, my];
      });

      const centroidTerrain = sampleGridBilinear(
        grid,
        terrainElev,
        sumLon / b.ring.length,
        sumLat / b.ring.length,
      );
      if (centroidTerrain > bTerrainMax) bTerrainMax = centroidTerrain;
      if (!Number.isFinite(bTerrainMax)) bTerrainMax = grid.minTerrainMeters;

      // Building roof MSL elevation anchored on the highest terrain point beneath the footprint
      const bRoofTopElev = bTerrainMax + b.heightMeters;
      const pad = effectiveRadius + Math.max(cellMetersX, cellMetersY);

      const cStart = Math.max(
        0,
        Math.floor((((bMinX - pad) / metersPerDegLon + cLon - minLon) / lonRange) * (cols - 1)),
      );
      const cEnd = Math.min(
        cols - 1,
        Math.ceil((((bMaxX + pad) / metersPerDegLon + cLon - minLon) / lonRange) * (cols - 1)),
      );
      const rStart = Math.max(
        0,
        Math.floor(((maxLat - ((bMaxY + pad) / metersPerDegLat + cLat)) / latRange) * (rows - 1)),
      );
      const rEnd = Math.min(
        rows - 1,
        Math.ceil(((maxLat - ((bMinY - pad) / metersPerDegLat + cLat)) / latRange) * (rows - 1)),
      );

      const raiseVertex = (idx: number, rawHit: boolean) => {
        const vTerrain = terrainElev[idx];
        // Ensure vertex terrain + bufferedBuildingHeight[idx] >= bRoofTopElev across terrain slopes
        const requiredRelH = Math.max(b.heightMeters, bRoofTopElev - vTerrain);
        if (rawHit && b.heightMeters > rawBuildingHeight[idx]) {
          rawBuildingHeight[idx] = b.heightMeters;
        }
        if (requiredRelH > bufferedBuildingHeight[idx]) {
          bufferedBuildingHeight[idx] = requiredRelH;
        }
      };

      // 1) Direct vertex distance evaluation
      for (let r = rStart; r <= rEnd; r++) {
        const v = rows > 1 ? r / (rows - 1) : 0.5;
        const lat = maxLat - v * latRange;
        const py = (lat - cLat) * metersPerDegLat;
        for (let c = cStart; c <= cEnd; c++) {
          const u = cols > 1 ? c / (cols - 1) : 0.5;
          const lon = minLon + u * lonRange;
          const px = (lon - cLon) * metersPerDegLon;

          const dist = pointToPolygonDistanceMeters(px, py, ringMeters);
          const idx = r * cols + c;
          if (dist <= 0.25) {
            raiseVertex(idx, true);
          } else if (dist <= effectiveRadius) {
            raiseVertex(idx, false);
          }
        }
      }

      // 2) Conservative quad-cell expansion: if a building touches a quad cell center or its bbox
      // overlaps a cell, lift all 4 quad corners so interpolated mesh triangles never dip below the roof
      const rCellEnd = Math.min(rows - 2, rEnd);
      const cCellEnd = Math.min(cols - 2, cEnd);
      for (let r = rStart; r <= rCellEnd; r++) {
        const latCenter = maxLat - ((r + 0.5) / Math.max(1, rows - 1)) * latRange;
        const cy = (latCenter - cLat) * metersPerDegLat;
        for (let c = cStart; c <= cCellEnd; c++) {
          const lonCenter = minLon + ((c + 0.5) / Math.max(1, cols - 1)) * lonRange;
          const cx = (lonCenter - cLon) * metersPerDegLon;

          const centerDist = pointToPolygonDistanceMeters(cx, cy, ringMeters);
          if (centerDist <= effectiveRadius) {
            const i00 = r * cols + c;
            const i10 = i00 + 1;
            const i01 = (r + 1) * cols + c;
            const i11 = i01 + 1;
            raiseVertex(i00, centerDist <= cellHalfDiag);
            raiseVertex(i10, centerDist <= cellHalfDiag);
            raiseVertex(i01, centerDist <= cellHalfDiag);
            raiseVertex(i11, centerDist <= cellHalfDiag);
          }
        }
      }
    }
  }

  const envelopeElev = new Float32Array(totalCells);
  const ceilingElev = new Float32Array(totalCells);
  const clearance = new Float32Array(totalCells);

  let maxBuildingHeightMeters = 0;
  let maxObstacleElevMeters = -Infinity;
  let minClearanceMeters = Infinity;
  let violationCellCount = 0;
  let cautionCellCount = 0;

  for (let i = 0; i < totalCells; i++) {
    const tElev = terrainElev[i];
    const bH = bufferedBuildingHeight[i];
    const env = tElev + bH + config.verticalBufferMeters;
    const ceil =
      config.altitudeMode === 'agl' ? tElev + config.ceilingMeters : config.ceilingMeters;
    const clr = ceil - env;

    envelopeElev[i] = env;
    ceilingElev[i] = ceil;
    clearance[i] = clr;

    if (rawBuildingHeight[i] > maxBuildingHeightMeters) {
      maxBuildingHeightMeters = rawBuildingHeight[i];
    }
    const obstaclePeak = Math.max(tElev + rawBuildingHeight[i], tElev + bH);
    if (obstaclePeak > maxObstacleElevMeters) {
      maxObstacleElevMeters = obstaclePeak;
    }
    if (clr < minClearanceMeters) minClearanceMeters = clr;
    if (clr < 0) violationCellCount++;
    else if (clr < 15) cautionCellCount++;
  }

  return {
    ...grid,
    rawBuildingHeight,
    bufferedBuildingHeight,
    envelopeElev,
    ceilingElev,
    clearance,
    maxBuildingHeightMeters: Math.round(maxBuildingHeightMeters * 10) / 10,
    maxObstacleElevMeters: Number.isFinite(maxObstacleElevMeters)
      ? Math.round(maxObstacleElevMeters * 10) / 10
      : 0,
    minClearanceMeters: Number.isFinite(minClearanceMeters)
      ? Math.round(minClearanceMeters * 10) / 10
      : 0,
    violationCellCount,
    cautionCellCount,
    violationPct: Math.round((violationCellCount / Math.max(1, totalCells)) * 1000) / 10,
  };
}

/**
 * Evaluates a user-drawn multi-waypoint drone flight corridor against the composite
 * terrain + Overture building obstacle envelope and AGL/MSL ceiling, and computes
 * an obstacle-aware safe climb elevation profile.
 */
export function analyzeDroneCorridor(
  waypoints: Array<[number, number]>,
  grid: DroneAirspaceGrid | null,
  config: DroneZoneConfig,
): DroneCorridorAnalysis | null {
  if (waypoints.length < 2 || !grid) return null;

  const segLengths: number[] = [];
  let totalLengthMeters = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const d = vincentyInverse(
      waypoints[i - 1][0],
      waypoints[i - 1][1],
      waypoints[i][0],
      waypoints[i][1],
    ).distanceMeters;
    segLengths.push(d);
    totalLengthMeters += d;
  }

  const totalSteps = 72;
  const samples: DroneCorridorSample[] = [];
  let minClearanceMeters = Infinity;
  let maxEnvelopeMeters = -Infinity;
  let maxSafeFlightMeters = -Infinity;
  let maxBuildingMeters = 0;
  let violationSampleCount = 0;
  let cautionSampleCount = 0;

  for (let s = 0; s <= totalSteps; s++) {
    const targetDist = (s / totalSteps) * totalLengthMeters;
    let accum = 0;
    let segIdx = 0;
    while (segIdx < segLengths.length - 1 && accum + segLengths[segIdx] < targetDist) {
      accum += segLengths[segIdx];
      segIdx++;
    }
    const segLen = Math.max(1e-6, segLengths[segIdx] || 1);
    const localT = Math.max(0, Math.min(1, (targetDist - accum) / segLen));

    const [lonA, latA] = waypoints[segIdx];
    const [lonB, latB] = waypoints[segIdx + 1];
    const lon = lonA + (lonB - lonA) * localT;
    const lat = latA + (latB - latA) * localT;

    const terrainMeters = sampleGridBilinear(grid, grid.terrainElev, lon, lat);
    const buildingHeightMeters = sampleGridBilinear(grid, grid.bufferedBuildingHeight, lon, lat);
    const envelopeMeters = terrainMeters + buildingHeightMeters + config.verticalBufferMeters;
    const ceilingMeters =
      config.altitudeMode === 'agl' ? terrainMeters + config.ceilingMeters : config.ceilingMeters;
    const safeFlightMeters = Math.max(ceilingMeters, envelopeMeters + 5);
    const clearanceMeters = ceilingMeters - envelopeMeters;

    const status: DroneCorridorSample['status'] =
      clearanceMeters < 0 ? 'VIOLATION' : clearanceMeters < 15 ? 'CAUTION' : 'CLEAR';

    if (clearanceMeters < minClearanceMeters) minClearanceMeters = clearanceMeters;
    if (envelopeMeters > maxEnvelopeMeters) maxEnvelopeMeters = envelopeMeters;
    if (safeFlightMeters > maxSafeFlightMeters) maxSafeFlightMeters = safeFlightMeters;
    if (buildingHeightMeters > maxBuildingMeters) maxBuildingMeters = buildingHeightMeters;
    if (status === 'VIOLATION') violationSampleCount++;
    else if (status === 'CAUTION') cautionSampleCount++;

    samples.push({
      index: s,
      distanceMeters: Math.round(targetDist * 10) / 10,
      lon,
      lat,
      terrainMeters: Math.round(terrainMeters * 10) / 10,
      buildingHeightMeters: Math.round(buildingHeightMeters * 10) / 10,
      envelopeMeters: Math.round(envelopeMeters * 10) / 10,
      ceilingMeters: Math.round(ceilingMeters * 10) / 10,
      safeFlightMeters: Math.round(safeFlightMeters * 10) / 10,
      clearanceMeters: Math.round(clearanceMeters * 10) / 10,
      status,
    });
  }

  const overallStatus: DroneCorridorAnalysis['summary']['status'] =
    violationSampleCount > 0 ? 'VIOLATION' : cautionSampleCount > 0 ? 'CAUTION' : 'CLEAR';

  return {
    waypoints,
    samples,
    summary: {
      totalLengthMeters: Math.round(totalLengthMeters * 10) / 10,
      minClearanceMeters: Number.isFinite(minClearanceMeters)
        ? Math.round(minClearanceMeters * 10) / 10
        : 0,
      maxEnvelopeMeters: Number.isFinite(maxEnvelopeMeters)
        ? Math.round(maxEnvelopeMeters * 10) / 10
        : 0,
      maxSafeFlightMeters: Number.isFinite(maxSafeFlightMeters)
        ? Math.round(maxSafeFlightMeters * 10) / 10
        : 0,
      maxBuildingMeters: Math.round(maxBuildingMeters * 10) / 10,
      violationSampleCount,
      cautionSampleCount,
      status: overallStatus,
    },
  };
}
