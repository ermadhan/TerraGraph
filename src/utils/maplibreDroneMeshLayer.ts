import * as maplibregl from 'maplibre-gl';
import type {
  DroneAirspaceGrid,
  DroneCorridorAnalysis,
  DroneZoneConfig,
} from '../types/geospatial';

interface CompiledProgram {
  program: WebGLProgram;
  uOpacity: WebGLUniformLocation | null;
  uProjMatrix: WebGLUniformLocation | null;
  uFallbackMatrix: WebGLUniformLocation | null;
  uTileMercatorCoords: WebGLUniformLocation | null;
  uClippingPlane: WebGLUniformLocation | null;
  uTransition: WebGLUniformLocation | null;
}

interface GeometryBatch {
  vao: WebGLVertexArrayObject | null;
  vbo: WebGLBuffer | null;
  ibo: WebGLBuffer | null;
  indexCount: number;
}

function createShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): { shader: WebGLShader | null; error: string | null } {
  const shader = gl.createShader(type);
  if (!shader) return { shader: null, error: 'Failed to allocate WebGL2 shader object' };
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'Unknown GLSL shader compilation error';
    console.error('DroneMesh shader compile error:', log);
    gl.deleteShader(shader);
    return { shader: null, error: log };
  }
  return { shader, error: null };
}

function createEmptyBatch(): GeometryBatch {
  return { vao: null, vbo: null, ibo: null, indexCount: 0 };
}

function disposeBatch(gl: WebGL2RenderingContext, batch: GeometryBatch): void {
  if (batch.vao) gl.deleteVertexArray(batch.vao);
  if (batch.vbo) gl.deleteBuffer(batch.vbo);
  if (batch.ibo) gl.deleteBuffer(batch.ibo);
  batch.vao = null;
  batch.vbo = null;
  batch.ibo = null;
  batch.indexCount = 0;
}

function uploadBatch(
  gl: WebGL2RenderingContext,
  batch: GeometryBatch,
  verts: Float32Array,
  indices: Uint32Array,
): void {
  if (verts.length === 0 || indices.length === 0) {
    batch.indexCount = 0;
    return;
  }

  if (!batch.vao) batch.vao = gl.createVertexArray();
  if (!batch.vbo) batch.vbo = gl.createBuffer();
  if (!batch.ibo) batch.ibo = gl.createBuffer();

  gl.bindVertexArray(batch.vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, batch.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);

  const stride = 6 * 4; // mercX, mercY, elevMeters, r, g, b
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 12);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, batch.ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);

  gl.bindVertexArray(null);
  batch.indexCount = indices.length;
}

function sampleTerrainBilinear(grid: DroneAirspaceGrid, lon: number, lat: number): number {
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

  const v00 = grid.terrainElev[r0 * grid.cols + c0];
  const v10 = grid.terrainElev[r0 * grid.cols + c1];
  const v01 = grid.terrainElev[r1 * grid.cols + c0];
  const v11 = grid.terrainElev[r1 * grid.cols + c1];

  return (
    v00 * (1 - tx) * (1 - ty) +
    v10 * tx * (1 - ty) +
    v01 * (1 - tx) * ty +
    v11 * tx * ty
  );
}

export class MapLibreDroneMeshLayer implements maplibregl.CustomLayerInterface {
  id = 'drone-airspace-3d-mesh';
  type = 'custom' as const;
  renderingMode = '3d' as const;

  private gl: WebGL2RenderingContext | null = null;
  private map: maplibregl.Map | null = null;
  private programs = new Map<string, CompiledProgram>();

  private envFill = createEmptyBatch();
  private envWire = createEmptyBatch();
  private bldgFill = createEmptyBatch();
  private bldgWire = createEmptyBatch();
  private ceilFill = createEmptyBatch();
  private ceilWire = createEmptyBatch();
  private curtainFill = createEmptyBatch();
  private corridorWire = createEmptyBatch();

  private grid: DroneAirspaceGrid | null = null;
  private config: DroneZoneConfig | null = null;
  private corridorAnalysis: DroneCorridorAnalysis | null = null;
  private exaggeration = 1.8;
  private dirtyBuffers = false;

  private lastShaderError: string | null = null;
  private onErrorCallback?: (err: string | null) => void;

  private mainMat32 = new Float32Array(16);
  private fallbackMat32 = new Float32Array(16);
  private tileMerc32 = new Float32Array(4);
  private clipPlane32 = new Float32Array(4);

  constructor(onError?: (err: string | null) => void) {
    this.onErrorCallback = onError;
  }

  onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    if (this.grid && this.config) {
      this.dirtyBuffers = true;
    }
  }

  onRemove(_map: maplibregl.Map, gl: WebGL2RenderingContext): void {
    this.cleanupGlResources(gl);
    this.gl = null;
    this.map = null;
  }

  updateData(
    grid: DroneAirspaceGrid | null,
    config: DroneZoneConfig,
    exaggeration: number,
    corridorAnalysis: DroneCorridorAnalysis | null = null,
  ): void {
    this.grid = grid;
    this.config = config;
    this.exaggeration = exaggeration;
    this.corridorAnalysis = corridorAnalysis;
    this.dirtyBuffers = true;
    this.map?.triggerRepaint();
  }

  private reportError(err: string | null): void {
    if (this.lastShaderError !== err) {
      this.lastShaderError = err;
      this.onErrorCallback?.(err);
    }
  }

  private getOrCompileProgram(
    gl: WebGL2RenderingContext,
    shaderData: maplibregl.CustomRenderMethodInput['shaderData'],
  ): CompiledProgram | null {
    const cached = this.programs.get(shaderData.variantName);
    if (cached) return cached;

    const vertSrc = `#version 300 es
${shaderData.define}
${shaderData.vertexShaderPrelude}
layout(location = 0) in vec2 a_pos_mercator;
layout(location = 1) in float a_elev_meters;
layout(location = 2) in vec3 a_color;
out vec3 v_color;

void main() {
  v_color = a_color;
  gl_Position = projectTileFor3D(a_pos_mercator, a_elev_meters);
}
`;

    const fragSrc = `#version 300 es
precision highp float;
uniform float u_opacity;
in vec3 v_color;
out vec4 fragColor;

void main() {
  fragColor = vec4(v_color * u_opacity, u_opacity);
}
`;

    const vsRes = createShader(gl, gl.VERTEX_SHADER, vertSrc);
    const fsRes = createShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    if (!vsRes.shader || !fsRes.shader) {
      if (vsRes.shader) gl.deleteShader(vsRes.shader);
      if (fsRes.shader) gl.deleteShader(fsRes.shader);
      this.reportError(vsRes.error || fsRes.error || 'WebGL2 shader compile failed');
      return null;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vsRes.shader);
      gl.deleteShader(fsRes.shader);
      this.reportError('Failed to create WebGL2 program');
      return null;
    }

    gl.attachShader(program, vsRes.shader);
    gl.attachShader(program, fsRes.shader);
    gl.linkProgram(program);
    gl.deleteShader(vsRes.shader);
    gl.deleteShader(fsRes.shader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || 'Program link failed';
      console.error('DroneMesh program link error:', log);
      gl.deleteProgram(program);
      this.reportError(log);
      return null;
    }

    this.reportError(null);

    const compiled: CompiledProgram = {
      program,
      uOpacity: gl.getUniformLocation(program, 'u_opacity'),
      uProjMatrix: gl.getUniformLocation(program, 'u_projection_matrix'),
      uFallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
      uTileMercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
      uClippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
      uTransition: gl.getUniformLocation(program, 'u_projection_transition'),
    };

    this.programs.set(shaderData.variantName, compiled);
    return compiled;
  }

  private rebuildBuffers(gl: WebGL2RenderingContext): void {
    this.dirtyBuffers = false;
    const grid = this.grid;
    const config = this.config;

    if (!grid || !config || !config.enabled || !config.showMapOverlay) {
      this.envFill.indexCount = 0;
      this.envWire.indexCount = 0;
      this.bldgFill.indexCount = 0;
      this.bldgWire.indexCount = 0;
      this.ceilFill.indexCount = 0;
      this.ceilWire.indexCount = 0;
      this.curtainFill.indexCount = 0;
      this.corridorWire.indexCount = 0;
      return;
    }

    const {
      cols,
      rows,
      bbox,
      center: [cLon, cLat],
      terrainElev,
      envelopeElev,
      ceilingElev,
      clearance,
      bufferedBuildingHeight,
      buildings,
    } = grid;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const vertCount = cols * rows;
    const floatsPerVert = 6;

    const envVerts = new Float32Array(vertCount * floatsPerVert);
    const ceilVerts = new Float32Array(vertCount * floatsPerVert);

    let envElevMin = Infinity;
    let envElevMax = -Infinity;
    let ceilElevMin = Infinity;
    let ceilElevMax = -Infinity;

    for (let r = 0; r < rows; r++) {
      const v = rows > 1 ? r / (rows - 1) : 0.5;
      const lat = maxLat - v * (maxLat - minLat);
      for (let c = 0; c < cols; c++) {
        const u = cols > 1 ? c / (cols - 1) : 0.5;
        const lon = minLon + u * (maxLon - minLon);
        const merc = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);

        const idx = r * cols + c;
        const tElev = terrainElev[idx];
        const clr = clearance[idx];
        const bH = bufferedBuildingHeight[idx];

        // +3.0m visual lift prevents coarse terrain mesh ridges from Z-occluding the envelope sheet
        const envRenderElev = tElev * this.exaggeration + (envelopeElev[idx] - tElev) + 3.0;
        const ceilRenderElev = tElev * this.exaggeration + (ceilingElev[idx] - tElev) + 4.0;

        if (envRenderElev < envElevMin) envElevMin = envRenderElev;
        if (envRenderElev > envElevMax) envElevMax = envRenderElev;
        if (ceilRenderElev < ceilElevMin) ceilElevMin = ceilRenderElev;
        if (ceilRenderElev > ceilElevMax) ceilElevMax = ceilRenderElev;

        let er = 0.05;
        let eg = 0.58;
        let eb = 0.53;
        if (clr < 0) {
          er = 0.88;
          eg = 0.11;
          eb = 0.28;
        } else if (clr < 15) {
          er = 0.85;
          eg = 0.47;
          eb = 0.02;
        } else if (bH > 0.5) {
          er = 0.03;
          eg = 0.57;
          eb = 0.7;
        }

        const base = idx * floatsPerVert;
        envVerts[base] = merc.x;
        envVerts[base + 1] = merc.y;
        envVerts[base + 2] = envRenderElev;
        envVerts[base + 3] = er;
        envVerts[base + 4] = eg;
        envVerts[base + 5] = eb;

        let cr = 0.02;
        let cg = 0.68;
        let cb = 0.82;
        if (clr < 0) {
          cr = 0.94;
          cg = 0.18;
          cb = 0.34;
        } else if (clr < 15) {
          cr = 0.94;
          cg = 0.58;
          cb = 0.05;
        }

        ceilVerts[base] = merc.x;
        ceilVerts[base + 1] = merc.y;
        ceilVerts[base + 2] = ceilRenderElev;
        ceilVerts[base + 3] = cr;
        ceilVerts[base + 4] = cg;
        ceilVerts[base + 5] = cb;
      }
    }

    // Clamp envelope vertices cleanly above exaggerated Overture building roofs across sloped terrain
    const hBuf = Math.max(0, config.horizontalBufferMeters);
    const vBuf = Math.max(0, config.verticalBufferMeters);
    const cosLat = Math.max(0.15, Math.cos((cLat * Math.PI) / 180));
    const metersPerDegLat = 111319.9;
    const metersPerDegLon = 111319.9 * cosLat;
    const lonSpan = Math.max(1e-9, maxLon - minLon);
    const latSpan = Math.max(1e-9, maxLat - minLat);
    const cellM = Math.max(grid.widthMeters / Math.max(1, cols - 1), grid.depthMeters / Math.max(1, rows - 1));
    const padLon = (hBuf + cellM) / metersPerDegLon;
    const padLat = (hBuf + cellM) / metersPerDegLat;

    for (const b of buildings) {
      if (b.ring.length < 3) continue;
      let bMinLon = Infinity;
      let bMaxLon = -Infinity;
      let bMinLat = Infinity;
      let bMaxLat = -Infinity;
      let bTerrainMax = -Infinity;

      for (const [lon, lat] of b.ring) {
        if (lon < bMinLon) bMinLon = lon;
        if (lon > bMaxLon) bMaxLon = lon;
        if (lat < bMinLat) bMinLat = lat;
        if (lat > bMaxLat) bMaxLat = lat;
        const t = sampleTerrainBilinear(grid, lon, lat);
        if (t > bTerrainMax) bTerrainMax = t;
      }
      if (!Number.isFinite(bTerrainMax)) continue;

      const minReqEnvElev = bTerrainMax * this.exaggeration + b.heightMeters + vBuf + 3.5;
      const c0 = Math.max(0, Math.floor(((bMinLon - padLon - minLon) / lonSpan) * (cols - 1)));
      const c1 = Math.min(cols - 1, Math.ceil(((bMaxLon + padLon - minLon) / lonSpan) * (cols - 1)));
      const r0 = Math.max(0, Math.floor(((maxLat - (bMaxLat + padLat)) / latSpan) * (rows - 1)));
      const r1 = Math.min(rows - 1, Math.ceil(((maxLat - (bMinLat - padLat)) / latSpan) * (rows - 1)));

      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const base = (r * cols + c) * floatsPerVert;
          if (envVerts[base + 2] < minReqEnvElev) {
            envVerts[base + 2] = minReqEnvElev;
            if (minReqEnvElev > envElevMax) envElevMax = minReqEnvElev;
          }
        }
      }
    }

    const triIndices = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let tPtr = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const i00 = r * cols + c;
        const i10 = i00 + 1;
        const i01 = (r + 1) * cols + c;
        const i11 = i01 + 1;
        triIndices[tPtr++] = i00;
        triIndices[tPtr++] = i01;
        triIndices[tPtr++] = i10;
        triIndices[tPtr++] = i10;
        triIndices[tPtr++] = i01;
        triIndices[tPtr++] = i11;
      }
    }

    // Wireframe grid lattice (step by 2 on interior + full perimeter border for clean readability)
    const lineList: number[] = [];
    for (let r = 0; r < rows; r += 2) {
      for (let c = 0; c < cols - 1; c++) {
        const i0 = r * cols + c;
        lineList.push(i0, i0 + 1);
      }
    }
    if ((rows - 1) % 2 !== 0) {
      const r = rows - 1;
      for (let c = 0; c < cols - 1; c++) {
        lineList.push(r * cols + c, r * cols + c + 1);
      }
    }
    for (let c = 0; c < cols; c += 2) {
      for (let r = 0; r < rows - 1; r++) {
        const i0 = r * cols + c;
        lineList.push(i0, i0 + cols);
      }
    }
    if ((cols - 1) % 2 !== 0) {
      const c = cols - 1;
      for (let r = 0; r < rows - 1; r++) {
        lineList.push(r * cols + c, (r + 1) * cols + c);
      }
    }
    const lineIndices = new Uint32Array(lineList);

    uploadBatch(gl, this.envFill, envVerts, triIndices);
    uploadBatch(gl, this.envWire, envVerts, lineIndices);
    uploadBatch(gl, this.ceilFill, ceilVerts, triIndices);
    uploadBatch(gl, this.ceilWire, ceilVerts, lineIndices);

    // Build 3D Volumetric Building Safety-Buffer Prisms directly on the map
    const bVerts: number[] = [];
    const bTriIdx: number[] = [];
    const bLineIdx: number[] = [];
    const maxMapPrisms = Math.min(buildings.length, 280);

    for (let bIdx = 0; bIdx < maxMapPrisms; bIdx++) {
      const b = buildings[bIdx];
      if (b.ring.length < 3) continue;

      // Deduplicate closing vertex if equal to start
      const rawRing = b.ring;
      const count =
        rawRing.length > 3 &&
        Math.hypot(
          rawRing[0][0] - rawRing[rawRing.length - 1][0],
          rawRing[0][1] - rawRing[rawRing.length - 1][1],
        ) < 1e-7
          ? rawRing.length - 1
          : rawRing.length;
      if (count < 3 || count > 40) continue;

      let cBLon = 0;
      let cBLat = 0;
      for (let i = 0; i < count; i++) {
        cBLon += rawRing[i][0];
        cBLat += rawRing[i][1];
      }
      cBLon /= count;
      cBLat /= count;

      const groundElev = sampleTerrainBilinear(grid, cBLon, cBLat);
      const baseElev = groundElev * this.exaggeration + Math.max(0, b.minHeightMeters);
      const topElev = groundElev * this.exaggeration + b.heightMeters + vBuf + 1.5;

      const bCeiling =
        config.altitudeMode === 'agl' ? groundElev + config.ceilingMeters : config.ceilingMeters;
      const clr = bCeiling - (groundElev + b.heightMeters + vBuf);

      let pr = 0.03;
      let pg = 0.6;
      let pb = 0.72;
      if (clr < 0) {
        pr = 0.9;
        pg = 0.12;
        pb = 0.3;
      } else if (clr < 15) {
        pr = 0.88;
        pg = 0.49;
        pb = 0.04;
      }

      const startVert = bVerts.length / 6;
      for (let i = 0; i < count; i++) {
        const [lon, lat] = rawRing[i];
        // Expand polygon vertex radially outward by horizontalBufferMeters around building centroid
        const dxM = (lon - cBLon) * metersPerDegLon;
        const dyM = (lat - cBLat) * metersPerDegLat;
        const distM = Math.hypot(dxM, dyM);
        const expLon =
          distM > 0.2 ? lon + ((dxM / distM) * hBuf) / metersPerDegLon : lon;
        const expLat =
          distM > 0.2 ? lat + ((dyM / distM) * hBuf) / metersPerDegLat : lat;

        const merc = maplibregl.MercatorCoordinate.fromLngLat([expLon, expLat], 0);
        // Bottom vertex
        bVerts.push(merc.x, merc.y, baseElev, pr * 0.75, pg * 0.75, pb * 0.75);
        // Top vertex
        bVerts.push(merc.x, merc.y, topElev, pr, pg, pb);
      }

      // Roof centroid vertex (triangle fan for roof cap)
      const cMerc = maplibregl.MercatorCoordinate.fromLngLat([cBLon, cBLat], 0);
      const roofCenterIdx = bVerts.length / 6;
      bVerts.push(cMerc.x, cMerc.y, topElev, Math.min(1, pr + 0.08), Math.min(1, pg + 0.08), Math.min(1, pb + 0.08));

      for (let i = 0; i < count; i++) {
        const next = (i + 1) % count;
        const b0 = startVert + i * 2;
        const t0 = b0 + 1;
        const b1 = startVert + next * 2;
        const t1 = b1 + 1;

        // Side wall quad (2 triangles)
        bTriIdx.push(b0, b1, t0, t0, b1, t1);
        // Roof cap triangle
        bTriIdx.push(roofCenterIdx, t0, t1);
        // Crisp 3D prism outline edges (top rim + vertical pillar)
        bLineIdx.push(t0, t1, b0, t0);
      }
    }

    uploadBatch(gl, this.bldgFill, new Float32Array(bVerts), new Uint32Array(bTriIdx));
    uploadBatch(gl, this.bldgWire, new Float32Array(bVerts), new Uint32Array(bLineIdx));

    // Build 3D AOI Perimeter Airspace Curtains (connecting Terrain -> Ceiling along all 4 AOI borders)
    const curVerts: number[] = [];
    const curTris: number[] = [];
    const pushBoundaryEdge = (r0: number, c0: number, r1: number, c1: number) => {
      const idx0 = r0 * cols + c0;
      const idx1 = r1 * cols + c1;
      const b0 = idx0 * 6;
      const b1 = idx1 * 6;

      const tElev0 = terrainElev[idx0] * this.exaggeration;
      const tElev1 = terrainElev[idx1] * this.exaggeration;
      const topElev0 = config.showCeilingMesh ? ceilVerts[b0 + 2] : envVerts[b0 + 2];
      const topElev1 = config.showCeilingMesh ? ceilVerts[b1 + 2] : envVerts[b1 + 2];

      const cr = ceilVerts[b0 + 3];
      const cg = ceilVerts[b0 + 4];
      const cb = ceilVerts[b0 + 5];

      const sIdx = curVerts.length / 6;
      curVerts.push(ceilVerts[b0], ceilVerts[b0 + 1], tElev0, cr * 0.65, cg * 0.65, cb * 0.65);
      curVerts.push(ceilVerts[b0], ceilVerts[b0 + 1], topElev0, cr, cg, cb);
      curVerts.push(ceilVerts[b1], ceilVerts[b1 + 1], tElev1, cr * 0.65, cg * 0.65, cb * 0.65);
      curVerts.push(ceilVerts[b1], ceilVerts[b1 + 1], topElev1, cr, cg, cb);

      curTris.push(sIdx, sIdx + 2, sIdx + 1, sIdx + 1, sIdx + 2, sIdx + 3);
    };

    for (let c = 0; c < cols - 1; c++) {
      pushBoundaryEdge(0, c, 0, c + 1);
      pushBoundaryEdge(rows - 1, c, rows - 1, c + 1);
    }
    for (let r = 0; r < rows - 1; r++) {
      pushBoundaryEdge(r, 0, r + 1, 0);
      pushBoundaryEdge(r, cols - 1, r + 1, cols - 1);
    }
    uploadBatch(gl, this.curtainFill, new Float32Array(curVerts), new Uint32Array(curTris));

    // Build 3D Elevated Drone Flight Corridor Path + Obstacle-Aware Climb Path + Waypoint Pylons
    const corrVerts: number[] = [];
    const corrLines: number[] = [];
    if (this.corridorAnalysis && this.corridorAnalysis.samples.length >= 2) {
      const samples = this.corridorAnalysis.samples;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const merc = maplibregl.MercatorCoordinate.fromLngLat([s.lon, s.lat], 0);
        const zElev = s.terrainMeters * this.exaggeration + (s.ceilingMeters - s.terrainMeters) + 5.0;
        const [r, g, b] =
          s.status === 'VIOLATION'
            ? [0.92, 0.12, 0.3]
            : s.status === 'CAUTION'
              ? [0.92, 0.52, 0.05]
              : [0.04, 0.65, 0.45];
        corrVerts.push(merc.x, merc.y, zElev, r, g, b);
        if (i > 0) corrLines.push(i - 1, i);
      }

      if (config.autoClimbCorridor) {
        const safeStart = corrVerts.length / 6;
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i];
          const merc = maplibregl.MercatorCoordinate.fromLngLat([s.lon, s.lat], 0);
          const zSafe =
            s.terrainMeters * this.exaggeration + (s.safeFlightMeters - s.terrainMeters) + 6.5;
          corrVerts.push(merc.x, merc.y, zSafe, 0.02, 0.78, 0.55);
          if (i > 0) corrLines.push(safeStart + i - 1, safeStart + i);
        }
      }

      for (const [wLon, wLat] of this.corridorAnalysis.waypoints) {
        const gElev = sampleTerrainBilinear(grid, wLon, wLat);
        const envElev =
          gElev +
          (grid.buildings.length > 0
            ? Math.max(0, config.verticalBufferMeters)
            : config.verticalBufferMeters);
        const cElev =
          config.altitudeMode === 'agl' ? gElev + config.ceilingMeters : config.ceilingMeters;
        const topElev = config.autoClimbCorridor ? Math.max(cElev, envElev + 5) : cElev;
        const merc = maplibregl.MercatorCoordinate.fromLngLat([wLon, wLat], 0);
        const idx = corrVerts.length / 6;
        corrVerts.push(merc.x, merc.y, gElev * this.exaggeration, 0.06, 0.09, 0.16);
        corrVerts.push(
          merc.x,
          merc.y,
          gElev * this.exaggeration + (topElev - gElev) + 6.5,
          0.06,
          0.09,
          0.16,
        );
        corrLines.push(idx, idx + 1);
      }
    }
    uploadBatch(gl, this.corridorWire, new Float32Array(corrVerts), new Uint32Array(corrLines));

    // Debug logging once per buffer rebuild to verify MapLibre projection origin & grid elevations
    const originMerc = maplibregl.MercatorCoordinate.fromLngLat([cLon, cLat], 0);
    const centerIdx = Math.floor(rows / 2) * cols + Math.floor(cols / 2);
    const readSample = (idx: number) => {
      const b = idx * floatsPerVert;
      return {
        mercX: Number(envVerts[b].toFixed(6)),
        mercY: Number(envVerts[b + 1].toFixed(6)),
        envElevM: Number(envVerts[b + 2].toFixed(1)),
        ceilElevM: Number(ceilVerts[b + 2].toFixed(1)),
      };
    };

    console.info('[MapLibreDroneMeshLayer] Grid buffer vertices', {
      originLngLat: [Number(cLon.toFixed(5)), Number(cLat.toFixed(5))],
      originMercator: [Number(originMerc.x.toFixed(6)), Number(originMerc.y.toFixed(6))],
      exaggeration: this.exaggeration,
      gridVertexCount: vertCount,
      buildingPrismsRendered: Math.min(buildings.length, maxMapPrisms),
      envElevRenderRange: [Number(envElevMin.toFixed(1)), Number(envElevMax.toFixed(1))],
      ceilElevRenderRange: [Number(ceilElevMin.toFixed(1)), Number(ceilElevMax.toFixed(1))],
      sampleVertices: {
        nw: readSample(0),
        center: readSample(centerIdx),
        se: readSample(vertCount - 1),
      },
    });
  }

  render(gl: WebGL2RenderingContext, options: maplibregl.CustomRenderMethodInput): void {
    const config = this.config;
    if (!config || !config.enabled || !config.showMapOverlay || !this.grid) {
      return;
    }

    if (this.dirtyBuffers) {
      this.rebuildBuffers(gl);
    }

    const prog = this.getOrCompileProgram(gl, options.shaderData);
    if (!prog) return;

    gl.useProgram(prog.program);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const proj = options.defaultProjectionData;
    if (prog.uProjMatrix && proj.mainMatrix) {
      this.mainMat32.set(proj.mainMatrix);
      gl.uniformMatrix4fv(prog.uProjMatrix, false, this.mainMat32);
    }
    if (prog.uFallbackMatrix && proj.fallbackMatrix) {
      this.fallbackMat32.set(proj.fallbackMatrix);
      gl.uniformMatrix4fv(prog.uFallbackMatrix, false, this.fallbackMat32);
    }
    if (prog.uTileMercatorCoords && proj.tileMercatorCoords) {
      this.tileMerc32.set(proj.tileMercatorCoords);
      gl.uniform4fv(prog.uTileMercatorCoords, this.tileMerc32);
    }
    if (prog.uClippingPlane && proj.clippingPlane) {
      this.clipPlane32.set(proj.clippingPlane);
      gl.uniform4fv(prog.uClippingPlane, this.clipPlane32);
    }
    if (prog.uTransition) {
      gl.uniform1f(prog.uTransition, proj.projectionTransition ?? 0);
    }

    const drawBatch = (batch: GeometryBatch, mode: number, opacity: number) => {
      if (!batch.vao || batch.indexCount === 0 || opacity <= 0.01) return;
      if (prog.uOpacity) gl.uniform1f(prog.uOpacity, opacity);
      gl.bindVertexArray(batch.vao);
      gl.drawElements(mode, batch.indexCount, gl.UNSIGNED_INT, 0);
    };

    // 1. Translucent 3D Perimeter Airspace Curtains (anchors AOI volume to terrain)
    if (config.showEnvelopeMesh || config.showCeilingMesh) {
      drawBatch(this.curtainFill, gl.TRIANGLES, 0.16);
    }

    // 2. 3D Volumetric Building Safety-Buffer Prisms
    if (config.showEnvelopeMesh) {
      drawBatch(
        this.bldgFill,
        gl.TRIANGLES,
        Math.min(0.85, Math.max(0.32, config.envelopeOpacity * 0.88)),
      );
      drawBatch(this.bldgWire, gl.LINES, Math.min(0.96, config.envelopeOpacity + 0.35));
    }

    // 3. Composite Terrain + Building Obstacle Envelope Mesh
    if (config.showEnvelopeMesh) {
      drawBatch(this.envFill, gl.TRIANGLES, config.envelopeOpacity);
    }
    if (config.showWireframe && (config.showEnvelopeMesh || !config.showCeilingMesh)) {
      drawBatch(this.envWire, gl.LINES, Math.min(0.95, Math.max(0.55, config.envelopeOpacity + 0.35)));
    }

    // 4. Safe Flight Ceiling Mesh Canopy
    if (config.showCeilingMesh) {
      drawBatch(this.ceilFill, gl.TRIANGLES, config.ceilingOpacity);
      if (config.showWireframe) {
        drawBatch(this.ceilWire, gl.LINES, Math.min(0.95, Math.max(0.55, config.ceilingOpacity + 0.48)));
      }
    }

    // 5. Elevated 3D Flight Corridor Path & Waypoint Pylons
    drawBatch(this.corridorWire, gl.LINES, 0.96);

    gl.bindVertexArray(null);
    gl.depthMask(true);
  }

  private cleanupGlResources(gl: WebGL2RenderingContext): void {
    for (const p of this.programs.values()) {
      gl.deleteProgram(p.program);
    }
    this.programs.clear();

    disposeBatch(gl, this.envFill);
    disposeBatch(gl, this.envWire);
    disposeBatch(gl, this.bldgFill);
    disposeBatch(gl, this.bldgWire);
    disposeBatch(gl, this.ceilFill);
    disposeBatch(gl, this.ceilWire);
    disposeBatch(gl, this.curtainFill);
    disposeBatch(gl, this.corridorWire);
  }
}
