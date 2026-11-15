import * as maplibregl from 'maplibre-gl';
import type { DiscrepancyGridResult } from '../types/geospatial';

const TILE_SIZE = 256;
const MAX_DEM_ZOOM = 15;

// Bounded in-memory cache of decoded elevation grids (Float32Array of 256x256 meters)
const decodedDemCache = new Map<string, Float32Array>();
const pendingDemFetches = new Map<string, Promise<Float32Array | null>>();

function setDemCache(key: string, grid: Float32Array): void {
  if (decodedDemCache.size >= 140) {
    const oldest = decodedDemCache.keys().next().value;
    if (oldest !== undefined) decodedDemCache.delete(oldest);
  }
  decodedDemCache.set(key, grid);
}

function tileLatRad(z: number, y: number): number {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / Math.pow(2, z);
  return Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function lonLatToTile(lon: number, lat: number, zoom: number): { z: number; x: number; y: number; px: number; py: number } {
  const z = Math.max(0, Math.min(MAX_DEM_ZOOM, Math.floor(zoom)));
  const n = Math.pow(2, z);
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const latRad = (clampedLat * Math.PI) / 180;

  const xf = ((lon + 180) / 360) * n;
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;

  const x = Math.max(0, Math.min(n - 1, Math.floor(xf)));
  const y = Math.max(0, Math.min(n - 1, Math.floor(yf)));
  const px = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor((xf - x) * TILE_SIZE)));
  const py = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor((yf - y) * TILE_SIZE)));

  return { z, x, y, px, py };
}

export async function fetchDecodedDemTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Float32Array | null> {
  const clampedZ = Math.max(0, Math.min(MAX_DEM_ZOOM, z));
  const key = `${clampedZ}/${x}/${y}`;
  const cached = decodedDemCache.get(key);
  if (cached) return cached;

  const existing = pendingDemFetches.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const resp = await fetch(`/api/tiles/terrarium/${clampedZ}/${x}/${y}.png`, { signal });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);

      const canvas = document.createElement('canvas');
      canvas.width = TILE_SIZE;
      canvas.height = TILE_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        bitmap.close();
        return null;
      }
      ctx.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
      bitmap.close();

      const imgData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
      const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);

      for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
        const off = i * 4;
        const r = imgData[off];
        const g = imgData[off + 1];
        const b = imgData[off + 2];
        elevations[i] = r * 256 + g + b / 256 - 32768;
      }

      setDemCache(key, elevations);
      return elevations;
    } catch {
      return null;
    } finally {
      pendingDemFetches.delete(key);
    }
  })();

  pendingDemFetches.set(key, promise);
  return promise;
}

function computeCellSlopeAspect(
  elevations: Float32Array,
  row: number,
  col: number,
  metersPerPixel: number,
): { slopeDeg: number; aspectDeg: number } {
  const r0 = Math.max(0, row - 1);
  const r2 = Math.min(TILE_SIZE - 1, row + 1);
  const c0 = Math.max(0, col - 1);
  const c2 = Math.min(TILE_SIZE - 1, col + 1);

  const a = elevations[r0 * TILE_SIZE + c0];
  const b = elevations[r0 * TILE_SIZE + col];
  const c = elevations[r0 * TILE_SIZE + c2];
  const d = elevations[row * TILE_SIZE + c0];
  const f = elevations[row * TILE_SIZE + c2];
  const g = elevations[r2 * TILE_SIZE + c0];
  const h = elevations[r2 * TILE_SIZE + col];
  const i = elevations[r2 * TILE_SIZE + c2];

  const denom = 8 * Math.max(0.5, metersPerPixel);
  const dzdx = (c + 2 * f + i - (a + 2 * d + g)) / denom;
  const dzdy = (g + 2 * h + i - (a + 2 * b + c)) / denom;

  const slopeRad = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
  const slopeDeg = (slopeRad * 180) / Math.PI;

  // Downhill normal vector: East = -dzdx, North = dzdy
  let aspectDeg = (Math.atan2(-dzdx, dzdy) * 180) / Math.PI;
  if (aspectDeg < 0) aspectDeg += 360;

  return { slopeDeg, aspectDeg };
}

export async function sampleTerrariumPoint(
  lon: number,
  lat: number,
  mapZoom: number,
): Promise<{ elevationMeters: number | null; slopeDeg: number | null; aspectDeg: number | null }> {
  const z = Math.min(MAX_DEM_ZOOM, Math.max(6, Math.round(mapZoom)));
  const { x, y, px, py } = lonLatToTile(lon, lat, z);
  const elevations = await fetchDecodedDemTile(z, x, y);
  if (!elevations) {
    return { elevationMeters: null, slopeDeg: null, aspectDeg: null };
  }

  const elev = elevations[py * TILE_SIZE + px];
  const latRad = tileLatRad(z, y);
  const metersPerPixel = (40075016.686 * Math.cos(latRad)) / (TILE_SIZE * Math.pow(2, z));
  const { slopeDeg, aspectDeg } = computeCellSlopeAspect(elevations, py, px, metersPerPixel);

  return {
    elevationMeters: Number.isFinite(elev) ? Math.round(elev * 10) / 10 : null,
    slopeDeg: Number.isFinite(slopeDeg) ? Math.round(slopeDeg * 10) / 10 : null,
    aspectDeg: slopeDeg > 0.4 && Number.isFinite(aspectDeg) ? Math.round(aspectDeg) : null,
  };
}

function lerpColor(
  stops: Array<[number, [number, number, number, number]]>,
  value: number,
): [number, number, number, number] {
  if (value <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1] = stops[i];
    const [v0, c0] = stops[i - 1];
    if (value <= v1) {
      const t = (value - v0) / Math.max(1e-6, v1 - v0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * t),
        Math.round(c0[1] + (c1[1] - c0[1]) * t),
        Math.round(c0[2] + (c1[2] - c0[2]) * t),
        Math.round(c0[3] + (c1[3] - c0[3]) * t),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

const SLOPE_STOPS: Array<[number, [number, number, number, number]]> = [
  [0, [241, 245, 249, 130]],
  [5, [186, 230, 253, 185]],
  [15, [56, 189, 248, 210]],
  [25, [250, 204, 21, 220]],
  [38, [234, 88, 12, 232]],
  [52, [185, 28, 28, 242]],
  [70, [109, 16, 44, 248]],
];

const ASPECT_STOPS: Array<[number, [number, number, number, number]]> = [
  [0, [37, 99, 235, 210]],    // N - Cobalt
  [90, [5, 150, 105, 210]],   // E - Emerald
  [180, [217, 119, 6, 210]],  // S - Amber
  [270, [124, 58, 237, 210]], // W - Violet
  [360, [37, 99, 235, 210]],  // N - Cobalt wrap
];

let demProtocolRegistered = false;

export function registerDemAnalysisProtocol(): void {
  if (demProtocolRegistered) return;
  demProtocolRegistered = true;

  maplibregl.addProtocol(
    'dem-analysis',
    async (params: maplibregl.RequestParameters, abortController: AbortController) => {
    const cleanUrl = params.url.replace('dem-analysis://', '');
    const parts = cleanUrl.split('/');
    const mode = parts[0] as 'slope' | 'aspect';
    const z = Number.parseInt(parts[1] || '0', 10);
    const x = Number.parseInt(parts[2] || '0', 10);
    const y = Number.parseInt(parts[3] || '0', 10);

    const canvas = document.createElement('canvas');
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext('2d');

    if (!ctx || z > MAX_DEM_ZOOM) {
      return { data: new ArrayBuffer(0) };
    }

    const elevations = await fetchDecodedDemTile(z, x, y, abortController.signal);
    if (!elevations) {
      return { data: new ArrayBuffer(0) };
    }

    const latRad = tileLatRad(z, y);
    const metersPerPixel = (40075016.686 * Math.cos(latRad)) / (TILE_SIZE * Math.pow(2, z));

    const out = ctx.createImageData(TILE_SIZE, TILE_SIZE);
    const data = out.data;

    for (let r = 0; r < TILE_SIZE; r++) {
      for (let c = 0; c < TILE_SIZE; c++) {
        const idx = r * TILE_SIZE + c;
        const elev = elevations[idx];
        const off = idx * 4;

        // Sea level / ocean water stays faint cool slate
        if (elev <= 0.1) {
          data[off] = 226;
          data[off + 1] = 232;
          data[off + 2] = 240;
          data[off + 3] = 80;
          continue;
        }

        const { slopeDeg, aspectDeg } = computeCellSlopeAspect(elevations, r, c, metersPerPixel);
        let rgba: [number, number, number, number];

        if (mode === 'slope') {
          rgba = lerpColor(SLOPE_STOPS, slopeDeg);
        } else {
          if (slopeDeg < 1.2) {
            rgba = [241, 245, 249, 130];
          } else {
            rgba = lerpColor(ASPECT_STOPS, aspectDeg);
          }
        }

        data[off] = rgba[0];
        data[off + 1] = rgba[1];
        data[off + 2] = rgba[2];
        data[off + 3] = rgba[3];
      }
    }

    ctx.putImageData(out, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return { data: new ArrayBuffer(0) };
    const buffer = await blob.arrayBuffer();
    return { data: buffer };
  });
}

// Diverging Coolwarm scale for ASTER - SRTM discrepancy (-25m to +25m)
const DELTA_STOPS: Array<[number, [number, number, number, number]]> = [
  [-25, [29, 78, 216, 205]],    // Deep Cobalt (ASTER much lower than SRTM)
  [-10, [56, 189, 248, 175]],   // Sky Blue
  [0, [248, 250, 252, 45]],     // Near-zero neutral translucent
  [10, [245, 158, 11, 175]],    // Amber
  [25, [220, 38, 38, 205]],     // Crimson (ASTER much higher than SRTM)
];

export function renderDiscrepancyDataUrl(grid: DiscrepancyGridResult): string {
  const width = 256;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const img = ctx.createImageData(width, height);
  const { rows, cols, cells } = grid;

  // Build quick 2D lookup of delta values
  const matrix: Array<number | null> = new Array(rows * cols).fill(null);
  for (const cell of cells) {
    matrix[cell.row * cols + cell.col] = cell.deltaMeters;
  }

  for (let py = 0; py < height; py++) {
    const gy = (py / (height - 1)) * (rows - 1);
    const r0 = Math.floor(gy);
    const r1 = Math.min(rows - 1, r0 + 1);
    const ty = gy - r0;

    for (let px = 0; px < width; px++) {
      const gx = (px / (width - 1)) * (cols - 1);
      const c0 = Math.floor(gx);
      const c1 = Math.min(cols - 1, c0 + 1);
      const tx = gx - c0;

      const v00 = matrix[r0 * cols + c0];
      const v10 = matrix[r0 * cols + c1];
      const v01 = matrix[r1 * cols + c0];
      const v11 = matrix[r1 * cols + c1];

      let weightedSum = 0;
      let weightTotal = 0;
      const samples: Array<[number | null, number]> = [
        [v00, (1 - tx) * (1 - ty)],
        [v10, tx * (1 - ty)],
        [v01, (1 - tx) * ty],
        [v11, tx * ty],
      ];

      for (const [val, w] of samples) {
        if (val !== null) {
          weightedSum += val * w;
          weightTotal += w;
        }
      }

      const off = (py * width + px) * 4;
      if (weightTotal < 0.05) {
        img.data[off + 3] = 0;
        continue;
      }

      const delta = weightedSum / weightTotal;
      const rgba = lerpColor(DELTA_STOPS, delta);
      img.data[off] = rgba[0];
      img.data[off + 1] = rgba[1];
      img.data[off + 2] = rgba[2];
      img.data[off + 3] = rgba[3];
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}
