import express from 'express';
import type { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { vincentyInverse, sampleGreatCircle } from './src/utils/geodesic.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

// Simple bounded LRU Map
class LruCache<T> {
  private map = new Map<string, T>();
  private maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, value);
  }
}

// Overture release resolver cache
interface OvertureConfig {
  release: string;
  baseUrl: string;
  buildingsUrl: string;
  transportationUrl: string;
  baseLayerUrl: string;
  resolvedAt: string;
}

const FALLBACK_OVERTURE_RELEASE = '2026-10-21.0';
let cachedOvertureConfig: { data: OvertureConfig; expiresAt: number } | null = null;

async function resolveOvertureConfig(): Promise<OvertureConfig> {
  const now = Date.now();
  if (cachedOvertureConfig && now < cachedOvertureConfig.expiresAt) {
    return cachedOvertureConfig.data;
  }

  let release = FALLBACK_OVERTURE_RELEASE;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch('https://stac.overturemaps.org/catalog.json', {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) {
      const json = (await resp.json()) as { latest?: string };
      if (typeof json.latest === 'string' && /^\d{4}-\d{2}-\d{2}\.\d+$/.test(json.latest)) {
        release = json.latest;
      }
    }
  } catch {
    // Use verified fallback release
  }

  const baseUrl = `https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${release}`;
  const config: OvertureConfig = {
    release,
    baseUrl,
    buildingsUrl: `pmtiles://${baseUrl}/buildings.pmtiles`,
    transportationUrl: `pmtiles://${baseUrl}/transportation.pmtiles`,
    baseLayerUrl: `pmtiles://${baseUrl}/base.pmtiles`,
    resolvedAt: new Date().toISOString(),
  };

  cachedOvertureConfig = {
    data: config,
    expiresAt: now + 60 * 60 * 1000,
  };
  return config;
}

// Terrarium tile LRU cache
const terrariumTileCache = new LruCache<Buffer>(400);

// OpenTopoData serialized queue (public tier limit: 1 req/sec, 100 locations/req)
const topoCache = new LruCache<(number | null)[]>(300);
let topoQueueTail: Promise<unknown> = Promise.resolve();
let lastTopoCallMs = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryOpenTopoData(
  dataset: 'srtm30m' | 'aster30m',
  coords: Array<[number, number]>,
): Promise<(number | null)[]> {
  if (coords.length === 0) return [];
  if (coords.length > 100) {
    throw new Error('OpenTopoData batch limit is 100 coordinates per request');
  }

  const locStr = coords.map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join('|');
  const cacheKey = `${dataset}:${locStr}`;
  const cached = topoCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const runTask = async (): Promise<(number | null)[]> => {
    const again = topoCache.get(cacheKey);
    if (again) return again;

    const elapsed = Date.now() - lastTopoCallMs;
    if (elapsed < 1080) {
      await sleep(1080 - elapsed);
    }

    lastTopoCallMs = Date.now();
    const url = `https://api.opentopodata.org/v1/${dataset}?locations=${encodeURIComponent(locStr)}&interpolation=bilinear`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'TerraGraph-Geospatial-Explorer/1.0',
        },
      });
      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`OpenTopoData ${dataset} returned ${response.status}: ${text.slice(0, 160)}`);
      }

      const payload = (await response.json()) as {
        status?: string;
        results?: Array<{ elevation: number | null }>;
      };

      const elevations = (payload.results || []).map((r) =>
        typeof r.elevation === 'number' && Number.isFinite(r.elevation) ? r.elevation : null,
      );
      topoCache.set(cacheKey, elevations);
      return elevations;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  };

  const taskPromise = topoQueueTail.then(runTask, runTask);
  topoQueueTail = taskPromise.catch(() => undefined);
  return taskPromise;
}

// Haversine distance in kilometers
function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371.0088;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function samplePolyline(
  vertices: Array<[number, number]>,
  sampleCount: number,
): Array<{ lon: number; lat: number; distanceKm: number }> {
  const segLengths: number[] = [];
  let totalKm = 0;
  for (let i = 0; i < vertices.length - 1; i++) {
    const d = haversineKm(vertices[i][0], vertices[i][1], vertices[i + 1][0], vertices[i + 1][1]);
    segLengths.push(d);
    totalKm += d;
  }

  if (totalKm === 0) {
    return [{ lon: vertices[0][0], lat: vertices[0][1], distanceKm: 0 }];
  }

  const samples: Array<{ lon: number; lat: number; distanceKm: number }> = [];
  for (let s = 0; s < sampleCount; s++) {
    const targetKm = (totalKm * s) / Math.max(1, sampleCount - 1);
    let accum = 0;
    let placed = false;

    for (let i = 0; i < segLengths.length; i++) {
      const segLen = segLengths[i];
      if (accum + segLen >= targetKm || i === segLengths.length - 1) {
        const localT = segLen > 0 ? Math.min(1, Math.max(0, (targetKm - accum) / segLen)) : 0;
        const lon = vertices[i][0] + (vertices[i + 1][0] - vertices[i][0]) * localT;
        const lat = vertices[i][1] + (vertices[i + 1][1] - vertices[i][1]) * localT;
        samples.push({ lon, lat, distanceKm: targetKm });
        placed = true;
        break;
      }
      accum += segLen;
    }

    if (!placed) {
      const last = vertices[vertices.length - 1];
      samples.push({ lon: last[0], lat: last[1], distanceKm: totalKm });
    }
  }
  return samples;
}

function computeStats(pairs: Array<{ srtm: number | null; aster: number | null }>) {
  let validComparison = 0;
  let srtmCount = 0;
  let asterCount = 0;
  let sumDelta = 0;
  let sumSqDelta = 0;
  let minDelta = Infinity;
  let maxDelta = -Infinity;
  let maxAbsDiff = 0;
  let minElev = Infinity;
  let maxElev = -Infinity;

  for (const p of pairs) {
    if (p.srtm !== null) {
      srtmCount++;
      minElev = Math.min(minElev, p.srtm);
      maxElev = Math.max(maxElev, p.srtm);
    }
    if (p.aster !== null) {
      asterCount++;
      minElev = Math.min(minElev, p.aster);
      maxElev = Math.max(maxElev, p.aster);
    }
    if (p.srtm !== null && p.aster !== null) {
      const delta = p.aster - p.srtm;
      validComparison++;
      sumDelta += delta;
      sumSqDelta += delta * delta;
      minDelta = Math.min(minDelta, delta);
      maxDelta = Math.max(maxDelta, delta);
      maxAbsDiff = Math.max(maxAbsDiff, Math.abs(delta));
    }
  }

  return {
    validComparison,
    srtmCount,
    asterCount,
    meanBias: validComparison > 0 ? sumDelta / validComparison : null,
    rmse: validComparison > 0 ? Math.sqrt(sumSqDelta / validComparison) : null,
    minDelta: validComparison > 0 ? minDelta : null,
    maxDelta: validComparison > 0 ? maxDelta : null,
    maxAbsDiff: validComparison > 0 ? maxAbsDiff : null,
    minElev: Number.isFinite(minElev) ? minElev : null,
    maxElev: Number.isFinite(maxElev) ? maxElev : null,
  };
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'TerraGraph', timestamp: new Date().toISOString() });
  });

  app.get('/api/overture/config', async (_req: Request, res: Response) => {
    try {
      const config = await resolveOvertureConfig();
      res.json(config);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to resolve Overture config',
      });
    }
  });

  // Terrarium elevation tile proxy (avoids CORS canvas tainting for client Slope/Aspect shaders)
  app.get('/api/tiles/terrarium/:z/:x/:y.png', async (req: Request, res: Response) => {
    const z = Number.parseInt(String(req.params.z), 10);
    const x = Number.parseInt(String(req.params.x), 10);
    const y = Number.parseInt(String(req.params.y), 10);

    if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y) || z < 0 || z > 15) {
      res.status(404).send('Tile out of range');
      return;
    }

    const maxTile = 1 << z;
    if (x < 0 || x >= maxTile || y < 0 || y >= maxTile) {
      res.status(404).send('Tile coordinates out of bounds');
      return;
    }

    const key = `${z}/${x}/${y}`;
    const cached = terrariumTileCache.get(key);
    if (cached) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(cached);
      return;
    }

    try {
      const upstream = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
      if (!upstream.ok) {
        res.status(upstream.status).send('Upstream tile error');
        return;
      }
      const arrayBuf = await upstream.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      terrariumTileCache.set(key, buffer);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(buffer);
    } catch {
      res.status(502).send('Failed to fetch terrain tile');
    }
  });

  // Dual SRTM 30m vs ASTER 30m Elevation Cross-Section Profile
  app.post('/api/elevation/profile', async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        points?: Array<[number, number]>;
        sampleCount?: number;
      };

      if (!Array.isArray(body?.points) || body.points.length < 2) {
        res.status(400).json({ error: 'At least 2 [lon, lat] vertices are required.' });
        return;
      }

      const vertices = body.points
        .slice(0, 12)
        .filter(
          (p): p is [number, number] =>
            Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
        );

      if (vertices.length < 2) {
        res.status(400).json({ error: 'Invalid coordinate vertices.' });
        return;
      }

      const requestedCount = Number(body.sampleCount || 72);
      const sampleCount = Math.max(10, Math.min(95, requestedCount));
      const sampled = samplePolyline(vertices, sampleCount);
      const coordPairs = sampled.map((s): [number, number] => [s.lon, s.lat]);

      const srtm = await queryOpenTopoData('srtm30m', coordPairs);
      const aster = await queryOpenTopoData('aster30m', coordPairs);

      const samples = sampled.map((pt, idx) => {
        const srtmVal = srtm[idx] ?? null;
        const asterVal = aster[idx] ?? null;
        const delta = srtmVal !== null && asterVal !== null ? asterVal - srtmVal : null;
        return {
          index: idx,
          distanceKm: Number(pt.distanceKm.toFixed(4)),
          lon: Number(pt.lon.toFixed(6)),
          lat: Number(pt.lat.toFixed(6)),
          srtmMeters: srtmVal,
          asterMeters: asterVal,
          deltaMeters: delta !== null ? Number(delta.toFixed(2)) : null,
        };
      });

      let totalGainSrtm = 0;
      let totalGainAster = 0;
      for (let i = 1; i < samples.length; i++) {
        const prevS = samples[i - 1].srtmMeters;
        const currS = samples[i].srtmMeters;
        if (prevS !== null && currS !== null && currS > prevS) {
          totalGainSrtm += currS - prevS;
        }
        const prevA = samples[i - 1].asterMeters;
        const currA = samples[i].asterMeters;
        if (prevA !== null && currA !== null && currA > prevA) {
          totalGainAster += currA - prevA;
        }
      }

      const stats = computeStats(
        samples.map((s) => ({ srtm: s.srtmMeters, aster: s.asterMeters })),
      );

      res.json({
        totalDistanceKm: samples[samples.length - 1]?.distanceKm ?? 0,
        samples,
        summary: {
          ...stats,
          totalGainSrtm: Math.round(totalGainSrtm),
          totalGainAster: Math.round(totalGainAster),
          totalSamples: samples.length,
        },
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to compute SRTM/ASTER profile',
      });
    }
  });

  // Geodesic & Terrain-Aware 3D Distance (WGS84 + SRTM 30m + ASTER 30m)
  app.post('/api/elevation/distance', async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        pointA?: [number, number];
        pointB?: [number, number];
        sampleCount?: number;
      };

      const isCoord = (p: unknown): p is [number, number] =>
        Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

      if (!isCoord(body?.pointA) || !isCoord(body?.pointB)) {
        res.status(400).json({ error: 'Valid pointA and pointB [lon, lat] coordinates required.' });
        return;
      }

      const [lonA, latA] = body.pointA;
      const [lonB, latB] = body.pointB;
      const { distanceMeters: geodesicMeters, initialBearingDeg } = vincentyInverse(
        lonA,
        latA,
        lonB,
        latB,
      );

      const sampleCount = Math.max(12, Math.min(80, Number(body.sampleCount || 48)));
      const pathCoords = sampleGreatCircle(body.pointA, body.pointB, sampleCount);

      const srtm = await queryOpenTopoData('srtm30m', pathCoords);
      const aster = await queryOpenTopoData('aster30m', pathCoords);

      const integrateSurface = (elevs: (number | null)[]) => {
        const validCount = elevs.filter((v): v is number => v !== null).length;
        if (validCount < 2) {
          return { surfaceMeters: null, ascentMeters: null, descentMeters: null, maxGradePct: null };
        }

        let surfaceMeters = 0;
        let ascentMeters = 0;
        let descentMeters = 0;
        let maxGradePct = 0;

        let prevIdx = elevs.findIndex((v) => v !== null);
        for (let i = prevIdx + 1; i < elevs.length; i++) {
          const currElev = elevs[i];
          const prevElev = elevs[prevIdx];
          if (currElev === null || prevElev === null) continue;

          const segHoriz = vincentyInverse(
            pathCoords[prevIdx][0],
            pathCoords[prevIdx][1],
            pathCoords[i][0],
            pathCoords[i][1],
          ).distanceMeters;
          const dElev = currElev - prevElev;
          surfaceMeters += Math.sqrt(segHoriz * segHoriz + dElev * dElev);

          if (dElev > 0) ascentMeters += dElev;
          else descentMeters += Math.abs(dElev);

          if (segHoriz > 1) {
            const grade = (Math.abs(dElev) / segHoriz) * 100;
            if (grade > maxGradePct) maxGradePct = grade;
          }
          prevIdx = i;
        }

        return {
          surfaceMeters: Number(surfaceMeters.toFixed(2)),
          ascentMeters: Math.round(ascentMeters),
          descentMeters: Math.round(descentMeters),
          maxGradePct: Number(maxGradePct.toFixed(1)),
        };
      };

      const srtmMetrics = integrateSurface(srtm);
      const asterMetrics = integrateSurface(aster);

      res.json({
        pointA: body.pointA,
        pointB: body.pointB,
        geodesicMeters: Number(geodesicMeters.toFixed(2)),
        initialBearingDeg: Number(initialBearingDeg.toFixed(1)),
        surfaceSrtmMeters: srtmMetrics.surfaceMeters,
        surfaceAsterMeters: asterMetrics.surfaceMeters,
        elevASrtm: srtm[0] ?? null,
        elevBSrtm: srtm[srtm.length - 1] ?? null,
        elevAAster: aster[0] ?? null,
        elevBAster: aster[aster.length - 1] ?? null,
        ascentSrtmMeters: srtmMetrics.ascentMeters,
        descentSrtmMeters: srtmMetrics.descentMeters,
        maxGradePct: srtmMetrics.maxGradePct ?? asterMetrics.maxGradePct,
        sampleCount: pathCoords.length,
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to compute 3D geodesic distance',
      });
    }
  });

  // Dual SRTM 30m vs ASTER 30m Discrepancy Grid
  app.post('/api/elevation/diff-grid', async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        bbox?: [number, number, number, number];
        cols?: number;
        rows?: number;
      };

      const bbox = body?.bbox;
      if (
        !Array.isArray(bbox) ||
        bbox.length !== 4 ||
        !bbox.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        res.status(400).json({ error: 'Valid [minLon, minLat, maxLon, maxLat] bbox required.' });
        return;
      }

      const [minLon, minLat, maxLon, maxLat] = bbox;
      if (minLon >= maxLon || minLat >= maxLat) {
        res.status(400).json({ error: 'Invalid bounding box ordering.' });
        return;
      }

      const cols = Math.max(4, Math.min(10, Number(body.cols || 9)));
      const rows = Math.max(4, Math.min(10, Number(body.rows || 9)));

      const gridCoords: Array<[number, number]> = [];
      for (let r = 0; r < rows; r++) {
        const lat = maxLat - ((maxLat - minLat) * (r + 0.5)) / rows;
        for (let c = 0; c < cols; c++) {
          const lon = minLon + ((maxLon - minLon) * (c + 0.5)) / cols;
          gridCoords.push([lon, lat]);
        }
      }

      const srtm = await queryOpenTopoData('srtm30m', gridCoords);
      const aster = await queryOpenTopoData('aster30m', gridCoords);

      const cells = gridCoords.map(([lon, lat], idx) => {
        const srtmVal = srtm[idx] ?? null;
        const asterVal = aster[idx] ?? null;
        const delta = srtmVal !== null && asterVal !== null ? asterVal - srtmVal : null;
        return {
          row: Math.floor(idx / cols),
          col: idx % cols,
          lon: Number(lon.toFixed(6)),
          lat: Number(lat.toFixed(6)),
          srtmMeters: srtmVal,
          asterMeters: asterVal,
          deltaMeters: delta !== null ? Number(delta.toFixed(2)) : null,
        };
      });

      const stats = computeStats(
        cells.map((c) => ({ srtm: c.srtmMeters, aster: c.asterMeters })),
      );

      res.json({
        bbox,
        rows,
        cols,
        cells,
        stats: {
          ...stats,
          totalCells: cells.length,
          srtmOutsideLatCoverage: minLat < -56 || maxLat > 60,
        },
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to compute discrepancy grid',
      });
    }
  });

  // Geocoding search proxy (Open-Meteo public geocoding API, zero key required)
  app.get('/api/geocode', async (req: Request, res: Response) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      res.json({ results: [] });
      return;
    }

    try {
      const upstream = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`,
      );
      if (!upstream.ok) {
        res.status(upstream.status).json({ results: [] });
        return;
      }
      const data = (await upstream.json()) as {
        results?: Array<{
          id: number;
          name: string;
          latitude: number;
          longitude: number;
          elevation?: number;
          country?: string;
          admin1?: string;
          feature_code?: string;
        }>;
      };
      res.json({ results: data.results || [] });
    } catch {
      res.status(502).json({ results: [] });
    }
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TerraGraph server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start TerraGraph server:', err);
  process.exit(1);
});
