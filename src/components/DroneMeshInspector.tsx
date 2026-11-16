import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import * as maplibregl from 'maplibre-gl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  Box,
  ChevronDown,
  ChevronUp,
  Eye,
  Grid,
  Layers,
  RefreshCw,
  RotateCcw,
  Route,
  ShieldAlert,
  X,
} from 'lucide-react';
import { mapLibreOriginMetersToLngLat } from '../utils/droneAirspace';
import type {
  DroneAirspaceGrid,
  DroneCorridorAnalysis,
  DroneZoneConfig,
} from '../types/geospatial';

interface DroneMeshInspectorProps {
  grid: DroneAirspaceGrid | null;
  loading: boolean;
  config: DroneZoneConfig;
  exaggeration: number;
  corridorAnalysis: DroneCorridorAnalysis | null;
  onChangeConfig: (updater: (prev: DroneZoneConfig) => DroneZoneConfig) => void;
  onResampleAoi: () => void;
  onClose: () => void;
}

interface HoverInspectTelemetry {
  lon: number;
  lat: number;
  terrainMeters: number;
  rawBuildingMeters: number;
  buildingMeters: number;
  envelopeMeters: number;
  ceilingMeters: number;
  clearanceMeters: number;
}

const _raycaster = new THREE.Raycaster();
const _pointerNdc = new THREE.Vector2();

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh | THREE.LineSegments;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      mat.forEach((m) => m.dispose());
    } else if (mat) {
      mat.dispose();
    }
    if (obj instanceof THREE.InstancedMesh) {
      obj.dispose();
    }
  });
}

function createPlinthGridTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#F1F5F9';
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1;
    const step = 32;
    for (let i = 0; i <= 512; i += step) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, 512);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(512, i);
      ctx.stroke();
    }
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, 510, 510);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

export const DroneMeshInspector: React.FC<DroneMeshInspectorProps> = ({
  grid,
  loading,
  config,
  exaggeration,
  corridorAnalysis,
  onChangeConfig,
  onResampleAoi,
  onClose,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [showBlockedCells, setShowBlockedCells] = useState(true);
  const [hoverTelemetry, setHoverTelemetry] = useState<HoverInspectTelemetry | null>(null);

  const blockedCellStats = React.useMemo(() => {
    if (!grid) return { core: 0, buffer: 0, total: 0 };
    const { cols, rows, rawBuildingHeight, bufferedBuildingHeight } = grid;
    let core = 0;
    let buffer = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const i00 = r * cols + c;
        const i10 = i00 + 1;
        const i01 = (r + 1) * cols + c;
        const i11 = i01 + 1;
        const rawPeak = Math.max(
          rawBuildingHeight[i00],
          rawBuildingHeight[i10],
          rawBuildingHeight[i01],
          rawBuildingHeight[i11],
        );
        const bufPeak = Math.max(
          bufferedBuildingHeight[i00],
          bufferedBuildingHeight[i10],
          bufferedBuildingHeight[i01],
          bufferedBuildingHeight[i11],
        );
        if (rawPeak > 0.5) core++;
        else if (bufPeak > 0.5) buffer++;
      }
    }
    return { core, buffer, total: core + buffer };
  }, [grid]);

  const gridRef = useRef(grid);
  gridRef.current = grid;
  const configRef = useRef(config);
  configRef.current = config;
  const exaggerationRef = useRef(exaggeration);
  exaggerationRef.current = exaggeration;
  const prevGridRef = useRef<DroneAirspaceGrid | null>(null);
  const prevCapturedAtRef = useRef<string | null>(null);
  const hasFramedRef = useRef(false);

  const sceneCtxRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    dynamicGroup: THREE.Group;
    terrainPickMesh: THREE.Mesh | null;
    worldBounds: { width: number; depth: number; maxY: number; sceneScale: number };
    requestRender: () => void;
    resetCamera: () => void;
    startFadeIn: (
      entries: Array<{
        material: THREE.Material;
        targetOpacity: number;
        baseTransparent: boolean;
        baseDepthWrite: boolean;
        startFactor: number;
      }>,
      durationMs: number,
    ) => void;
    cancelFadeIn: () => void;
  } | null>(null);

  // Initialize Three.js renderer, environment, lighting rig, and controls once
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const isSoftwareGl = detectSoftwareWebGL();
    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const mountWidth = Math.max(1, mount.clientWidth || 800);
    const mountHeight = Math.max(1, mount.clientHeight || 560);
    renderer.setSize(mountWidth, mountHeight);
    renderer.domElement.style.display = 'block';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#F8FAFC');
    scene.fog = new THREE.Fog('#F8FAFC', 380, 1100);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTarget = pmremGenerator.fromScene(roomEnv, 0.04);
    scene.environment = envTarget.texture;
    roomEnv.dispose();
    pmremGenerator.dispose();

    const camera = new THREE.PerspectiveCamera(
      42,
      (mount.clientWidth || 800) / Math.max(1, mount.clientHeight || 560),
      0.5,
      1800,
    );
    camera.position.set(112, 84, 118);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.075;
    controls.maxPolarAngle = Math.PI * 0.485;
    controls.minDistance = 24;
    controls.maxDistance = 480;
    controls.target.set(0, 14, 0);
    controls.update();

    // 3-point scientific studio lighting rig (warm key, cool hemisphere fill, crisp rim)
    const hemiLight = new THREE.HemisphereLight('#E0F2FE', '#94A3B8', 0.95);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight('#FFFBEB', 1.65);
    keyLight.position.set(95, 145, 75);
    keyLight.castShadow = !isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 20;
    keyLight.shadow.camera.far = 420;
    keyLight.shadow.camera.left = -110;
    keyLight.shadow.camera.right = 110;
    keyLight.shadow.camera.top = 110;
    keyLight.shadow.camera.bottom = -110;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight('#BAE6FD', 0.65);
    rimLight.position.set(-100, 75, -90);
    scene.add(rimLight);

    // Subtle scientific calibration plinth plane grounded beneath the AOI
    const plinthTex = createPlinthGridTexture();
    plinthTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const plinthGeo = new THREE.PlaneGeometry(440, 440);
    const plinthMat = new THREE.MeshStandardMaterial({
      map: plinthTex,
      roughness: 0.92,
      metalness: 0.02,
      color: '#FFFFFF',
    });
    const plinth = new THREE.Mesh(plinthGeo, plinthMat);
    plinth.rotation.x = -Math.PI / 2;
    plinth.position.y = -0.05;
    plinth.receiveShadow = !isSoftwareGl;
    scene.add(plinth);

    const dynamicGroup = new THREE.Group();
    scene.add(dynamicGroup);

    let frameId = 0;
    let renderBusy = false;
    let renderDirty = false;
    let disposed = false;

    interface FadeEntry {
      material: THREE.Material;
      targetOpacity: number;
      baseTransparent: boolean;
      baseDepthWrite: boolean;
      startFactor: number;
    }

    const fadeState: {
      active: boolean;
      startMs: number;
      durationMs: number;
      entries: FadeEntry[];
    } = {
      active: false,
      startMs: 0,
      durationMs: 300,
      entries: [],
    };

    const afterDraw = (cb: () => void) => {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    };

    const requestRender = () => {
      if (disposed) return;
      if (renderBusy) {
        renderDirty = true;
        return;
      }
      renderBusy = true;
      frameId = window.requestAnimationFrame(() => {
        if (disposed) return;
        renderDirty = false;

        let transitionActive = false;
        if (fadeState.active && fadeState.entries.length > 0) {
          const elapsed = performance.now() - fadeState.startMs;
          const rawT = Math.min(1, Math.max(0, elapsed / Math.max(1, fadeState.durationMs)));
          const eased = 1 - Math.pow(1 - rawT, 3);
          for (const entry of fadeState.entries) {
            if (rawT >= 1) {
              entry.material.opacity = entry.targetOpacity;
              entry.material.transparent = entry.baseTransparent;
              entry.material.depthWrite = entry.baseDepthWrite;
            } else {
              const factor = entry.startFactor + (1 - entry.startFactor) * eased;
              entry.material.transparent = true;
              entry.material.opacity = entry.targetOpacity * factor;
            }
          }
          if (rawT >= 1) {
            fadeState.active = false;
            fadeState.entries = [];
          } else {
            transitionActive = true;
          }
        }

        controls.update();
        renderer.render(scene, camera);
        const done = () => {
          renderBusy = false;
          if ((renderDirty || transitionActive) && !disposed) requestRender();
        };
        if (isSoftwareGl) afterDraw(done);
        else done();
      });
    };

    const cancelFadeIn = () => {
      fadeState.active = false;
      fadeState.entries = [];
    };

    const startFadeIn = (entries: FadeEntry[], durationMs: number) => {
      if (entries.length === 0 || durationMs <= 0) {
        cancelFadeIn();
        requestRender();
        return;
      }
      fadeState.entries = entries;
      fadeState.startMs = performance.now() - 16;
      fadeState.durationMs = durationMs;
      fadeState.active = true;
      for (const entry of entries) {
        entry.material.transparent = true;
        entry.material.opacity = entry.targetOpacity * entry.startFactor;
      }
      requestRender();
    };

    controls.addEventListener('change', requestRender);

    const resetCamera = () => {
      const bounds = sceneCtxRef.current?.worldBounds || { width: 120, depth: 120, maxY: 28 };
      camera.position.set(bounds.width * 0.92, Math.max(58, bounds.maxY * 2.1 + 36), bounds.depth * 0.98);
      controls.target.set(0, Math.max(8, bounds.maxY * 0.35), 0);
      controls.update();
      requestRender();
    };

    sceneCtxRef.current = {
      renderer,
      scene,
      camera,
      controls,
      dynamicGroup,
      terrainPickMesh: null,
      worldBounds: { width: 120, depth: 120, maxY: 28, sceneScale: 0.05 },
      requestRender,
      resetCamera,
      startFadeIn,
      cancelFadeIn,
    };

    const resizeObserver = new ResizeObserver(() => {
      if (!mount || disposed) return;
      const w = Math.max(1, mount.clientWidth);
      const h = Math.max(1, mount.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      requestRender();
    });
    resizeObserver.observe(mount);

    let lastRaycastAt = 0;
    const handlePointerMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastRaycastAt < 45) return;
      lastRaycastAt = now;

      const ctx = sceneCtxRef.current;
      const g = gridRef.current;
      if (!ctx || !ctx.terrainPickMesh || !g) return;

      const rect = renderer.domElement.getBoundingClientRect();
      _pointerNdc.x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      _pointerNdc.y = -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;

      _raycaster.setFromCamera(_pointerNdc, camera);
      const hits = _raycaster.intersectObject(ctx.terrainPickMesh, false);
      if (hits.length === 0) {
        setHoverTelemetry(null);
        return;
      }

      const pt = hits[0].point;
      const safeScale = Math.max(1e-6, ctx.worldBounds.sceneScale);
      const eastMeters = pt.x / safeScale;
      const southMeters = pt.z / safeScale;
      const [lon, lat] = mapLibreOriginMetersToLngLat(eastMeters, southMeters, g.center);

      const [minLon, minLat, maxLon, maxLat] = g.bbox;
      const u = Math.max(0, Math.min(1, (lon - minLon) / Math.max(1e-9, maxLon - minLon)));
      const v = Math.max(0, Math.min(1, (maxLat - lat) / Math.max(1e-9, maxLat - minLat)));

      const col = Math.min(g.cols - 1, Math.max(0, Math.round(u * (g.cols - 1))));
      const row = Math.min(g.rows - 1, Math.max(0, Math.round(v * (g.rows - 1))));
      const idx = row * g.cols + col;

      setHoverTelemetry({
        lon,
        lat,
        terrainMeters: Math.round(g.terrainElev[idx] * 10) / 10,
        rawBuildingMeters: Math.round(g.rawBuildingHeight[idx] * 10) / 10,
        buildingMeters: Math.round(g.bufferedBuildingHeight[idx] * 10) / 10,
        envelopeMeters: Math.round(g.envelopeElev[idx] * 10) / 10,
        ceilingMeters: Math.round(g.ceilingElev[idx] * 10) / 10,
        clearanceMeters: Math.round(g.clearance[idx] * 10) / 10,
      });
    };

    const handlePointerLeave = () => setHoverTelemetry(null);
    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('pointerleave', handlePointerLeave);

    requestRender();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('pointerleave', handlePointerLeave);
      controls.removeEventListener('change', requestRender);
      controls.dispose();

      cancelFadeIn();
      disposeObject3D(dynamicGroup);
      plinthGeo.dispose();
      plinthMat.dispose();
      plinthTex.dispose();
      envTarget.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
      sceneCtxRef.current = null;
    };
  }, []);

  // Rebuild 3D terrain, Overture buildings, obstacle envelope, flight ceiling, and corridor geometries
  useEffect(() => {
    const ctx = sceneCtxRef.current;
    if (!ctx) return;

    ctx.cancelFadeIn();
    disposeObject3D(ctx.dynamicGroup);
    ctx.dynamicGroup.clear();
    ctx.terrainPickMesh = null;

    if (!grid) {
      prevGridRef.current = null;
      prevCapturedAtRef.current = null;
      ctx.requestRender();
      return;
    }

    const {
      cols,
      rows,
      bbox: [minLon, minLat, maxLon, maxLat],
      center: [cLon, cLat],
      terrainElev,
      envelopeElev,
      ceilingElev,
      clearance,
      rawBuildingHeight,
      bufferedBuildingHeight,
      minTerrainMeters,
      maxTerrainMeters,
      buildings,
    } = grid;

    // Project all Three.js scene coordinates using MapLibre's exact MercatorCoordinate origin
    const originMerc = maplibregl.MercatorCoordinate.fromLngLat([cLon, cLat], 0);
    const mercPerMeter = originMerc.meterInMercatorCoordinateUnits();
    const nwMerc = maplibregl.MercatorCoordinate.fromLngLat([minLon, maxLat], 0);
    const seMerc = maplibregl.MercatorCoordinate.fromLngLat([maxLon, minLat], 0);

    const mercWidthMeters = Math.max(100, (seMerc.x - nwMerc.x) / mercPerMeter);
    const mercDepthMeters = Math.max(100, (seMerc.y - nwMerc.y) / mercPerMeter);
    const maxSpanMeters = Math.max(mercWidthMeters, mercDepthMeters, 100);
    const sceneScale = 120 / maxSpanMeters;
    const worldW = mercWidthMeters * sceneScale;
    const worldD = mercDepthMeters * sceneScale;

    // Single unified vertical scale across terrain, buildings, envelope, ceiling, and corridor
    // guarantees strict elevation ordering with zero terrain-slope shearing
    const verticalScale = sceneScale * Math.max(1.8, exaggeration);
    const yBaseOffset = 2.5;

    const toSceneXZ = (lon: number, lat: number): [number, number] => {
      const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
      const eastMeters = (m.x - originMerc.x) / mercPerMeter;
      const southMeters = (m.y - originMerc.y) / mercPerMeter;
      return [eastMeters * sceneScale, southMeters * sceneScale];
    };

    const elevToY = (absElev: number): number => {
      return yBaseOffset + (absElev - minTerrainMeters) * verticalScale;
    };

    // Precompute exact MapLibre-origin-aligned XZ coordinates for every grid vertex
    const gridSceneX = new Float32Array(cols);
    const gridSceneZ = new Float32Array(rows);
    for (let c = 0; c < cols; c++) {
      const u = cols > 1 ? c / (cols - 1) : 0.5;
      const lon = minLon + u * (maxLon - minLon);
      const [sx] = toSceneXZ(lon, cLat);
      gridSceneX[c] = sx;
    }
    for (let r = 0; r < rows; r++) {
      const v = rows > 1 ? r / (rows - 1) : 0.5;
      const lat = maxLat - v * (maxLat - minLat);
      const [, sz] = toSceneXZ(cLon, lat);
      gridSceneZ[r] = sz;
    }

    let maxY = 14;

    // Helper for shared grid topology aligned to MapLibre Mercator coordinates
    const buildGridSurfaceGeo = (
      getY: (idx: number) => number,
      getColor: (idx: number) => [number, number, number],
    ): {
      fillGeo: THREE.BufferGeometry;
      lineGeo: THREE.BufferGeometry;
      positions: Float32Array;
      minY: number;
      maxSurfY: number;
    } => {
      const vertCount = cols * rows;
      const positions = new Float32Array(vertCount * 3);
      const colors = new Float32Array(vertCount * 3);
      let minY = Infinity;
      let maxSurfY = -Infinity;

      for (let r = 0; r < rows; r++) {
        const z = gridSceneZ[r];
        for (let c = 0; c < cols; c++) {
          const x = gridSceneX[c];
          const idx = r * cols + c;
          const y = getY(idx);
          if (y > maxY) maxY = y;
          if (y < minY) minY = y;
          if (y > maxSurfY) maxSurfY = y;
          const [cr, cg, cb] = getColor(idx);

          positions[idx * 3] = x;
          positions[idx * 3 + 1] = y;
          positions[idx * 3 + 2] = z;

          colors[idx * 3] = cr;
          colors[idx * 3 + 1] = cg;
          colors[idx * 3 + 2] = cb;
        }
      }

      const triIndices: number[] = [];
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const i00 = r * cols + c;
          const i10 = i00 + 1;
          const i01 = (r + 1) * cols + c;
          const i11 = i01 + 1;
          triIndices.push(i00, i01, i10, i10, i01, i11);
        }
      }

      const fillGeo = new THREE.BufferGeometry();
      fillGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      fillGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      fillGeo.setIndex(triIndices);
      fillGeo.computeVertexNormals();

      const lineIndices: number[] = [];
      for (let r = 0; r < rows; r += 2) {
        for (let c = 0; c < cols - 1; c++) {
          const i0 = r * cols + c;
          lineIndices.push(i0, i0 + 1);
        }
      }
      if ((rows - 1) % 2 !== 0) {
        const r = rows - 1;
        for (let c = 0; c < cols - 1; c++) {
          lineIndices.push(r * cols + c, r * cols + c + 1);
        }
      }
      for (let c = 0; c < cols; c += 2) {
        for (let r = 0; r < rows - 1; r++) {
          const i0 = r * cols + c;
          lineIndices.push(i0, i0 + cols);
        }
      }
      if ((cols - 1) % 2 !== 0) {
        const c = cols - 1;
        for (let r = 0; r < rows - 1; r++) {
          lineIndices.push(r * cols + c, (r + 1) * cols + c);
        }
      }

      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      lineGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      lineGeo.setIndex(lineIndices);

      return { fillGeo, lineGeo, positions, minY, maxSurfY };
    };

    // 1. Solid SRTM/ASTER Terrain Mesh
    const elevRange = Math.max(1, maxTerrainMeters - minTerrainMeters);
    const {
      fillGeo: terrainGeo,
      positions: terrainPositions,
      minY: terrainMinY,
      maxSurfY: terrainMaxY,
    } = buildGridSurfaceGeo(
      (idx) => elevToY(terrainElev[idx]),
      (idx) => {
        const t = Math.max(0, Math.min(1, (terrainElev[idx] - minTerrainMeters) / elevRange));
        // Clean hypsometric slate-emerald-ochre scientific ramp
        let r: number;
        let g: number;
        let b: number;
        if (t < 0.35) {
          const k = t / 0.35;
          r = 0.85 - k * 0.08;
          g = 0.89 + k * 0.02;
          b = 0.88 - k * 0.08;
        } else if (t < 0.72) {
          const k = (t - 0.35) / 0.37;
          r = 0.77 + k * 0.07;
          g = 0.91 - k * 0.14;
          b = 0.8 - k * 0.24;
        } else {
          const k = (t - 0.72) / 0.28;
          r = 0.84 - k * 0.18;
          g = 0.77 - k * 0.22;
          b = 0.56 - k * 0.12;
        }

        if (showBlockedCells) {
          if (rawBuildingHeight[idx] > 0.5) {
            // Vivid red tint directly on terrain grid vertices blocked by Overture buildings
            return [0.86, 0.22, 0.3];
          }
          if (bufferedBuildingHeight[idx] > 0.5) {
            // Warm coral/amber tint for building horizontal safety buffer zone
            return [r * 0.45 + 0.52, g * 0.45 + 0.24, b * 0.45 + 0.12];
          }
        }
        return [r, g, b];
      },
    );

    const terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.84,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });
    terrainMat.userData.isBaseGeo = true;
    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    terrainMesh.receiveShadow = !ctx.renderer.shadowMap.enabled ? false : true;
    terrainMesh.castShadow = false;
    ctx.dynamicGroup.add(terrainMesh);
    ctx.terrainPickMesh = terrainMesh;

    // 1b. Solid Skirt Box Wall around terrain specimen aligned to MapLibre XZ grid edges
    const skirtPositions: number[] = [];
    const pushSkirtQuad = (x0: number, z0: number, y0: number, x1: number, z1: number, y1: number) => {
      skirtPositions.push(
        x0, 0, z0, x0, y0, z0, x1, y1, z1,
        x0, 0, z0, x1, y1, z1, x1, 0, z1,
      );
    };
    const sampleY = (r: number, c: number) => elevToY(terrainElev[r * cols + c]);

    for (let c = 0; c < cols - 1; c++) {
      pushSkirtQuad(
        gridSceneX[c],
        gridSceneZ[0],
        sampleY(0, c),
        gridSceneX[c + 1],
        gridSceneZ[0],
        sampleY(0, c + 1),
      );
      pushSkirtQuad(
        gridSceneX[c + 1],
        gridSceneZ[rows - 1],
        sampleY(rows - 1, c + 1),
        gridSceneX[c],
        gridSceneZ[rows - 1],
        sampleY(rows - 1, c),
      );
    }
    for (let r = 0; r < rows - 1; r++) {
      pushSkirtQuad(
        gridSceneX[0],
        gridSceneZ[r + 1],
        sampleY(r + 1, 0),
        gridSceneX[0],
        gridSceneZ[r],
        sampleY(r, 0),
      );
      pushSkirtQuad(
        gridSceneX[cols - 1],
        gridSceneZ[r],
        sampleY(r, cols - 1),
        gridSceneX[cols - 1],
        gridSceneZ[r + 1],
        sampleY(r + 1, cols - 1),
      );
    }
    const skirtGeo = new THREE.BufferGeometry();
    skirtGeo.setAttribute('position', new THREE.Float32BufferAttribute(skirtPositions, 3));
    skirtGeo.computeVertexNormals();
    const skirtMat = new THREE.MeshStandardMaterial({
      color: '#CBD5E1',
      roughness: 0.75,
      metalness: 0.08,
      side: THREE.DoubleSide,
    });
    skirtMat.userData.isBaseGeo = true;
    ctx.dynamicGroup.add(new THREE.Mesh(skirtGeo, skirtMat));

    // Bilinear terrain lookup matching droneAirspace.ts and MapLibreDroneMeshLayer
    const sampleTerrainBilinear = (lon: number, lat: number): number => {
      const u = Math.max(0, Math.min(1, (lon - minLon) / Math.max(1e-9, maxLon - minLon)));
      const v = Math.max(0, Math.min(1, (maxLat - lat) / Math.max(1e-9, maxLat - minLat)));
      const fx = u * (cols - 1);
      const fy = v * (rows - 1);
      const c0 = Math.floor(fx);
      const r0 = Math.floor(fy);
      const c1 = Math.min(cols - 1, c0 + 1);
      const r1 = Math.min(rows - 1, r0 + 1);
      const tx = fx - c0;
      const ty = fy - r0;
      const v00 = terrainElev[r0 * cols + c0];
      const v10 = terrainElev[r0 * cols + c1];
      const v01 = terrainElev[r1 * cols + c0];
      const v11 = terrainElev[r1 * cols + c1];
      return (
        v00 * (1 - tx) * (1 - ty) +
        v10 * tx * (1 - ty) +
        v01 * (1 - tx) * ty +
        v11 * tx * ty
      );
    };

    // 2. Real Overture 3D Buildings seated on local DEM terrain with MapLibre origin XZ alignment
    const buildingGroup = new THREE.Group();
    const safeBuildingMat = new THREE.MeshStandardMaterial({
      color: '#475569',
      roughness: 0.52,
      metalness: 0.14,
    });
    safeBuildingMat.userData.isBaseGeo = true;
    const breachBuildingMat = new THREE.MeshStandardMaterial({
      color: '#BE123C',
      roughness: 0.42,
      metalness: 0.16,
    });
    breachBuildingMat.userData.isBaseGeo = true;

    const maxRenderBuildings = Math.min(buildings.length, 360);
    let debugSampleBuilding: {
      groundElevM: number;
      bTerrainMaxM: number;
      heightMeters: number;
      baseY: number;
      topY: number;
    } | null = null;

    for (let bIdx = 0; bIdx < maxRenderBuildings; bIdx++) {
      const b = buildings[bIdx];
      if (b.ring.length < 3) continue;

      let sumLon = 0;
      let sumLat = 0;
      let bTerrainMin = Infinity;
      let bTerrainMax = -Infinity;
      const shape = new THREE.Shape();

      for (let i = 0; i < b.ring.length; i++) {
        const [lon, lat] = b.ring[i];
        sumLon += lon;
        sumLat += lat;
        const vt = sampleTerrainBilinear(lon, lat);
        if (vt < bTerrainMin) bTerrainMin = vt;
        if (vt > bTerrainMax) bTerrainMax = vt;

        const [sx, sz] = toSceneXZ(lon, lat);
        // Shape lives in X-Y plane, later rotated -PI/2 around X so shape Y maps to -Z
        if (i === 0) shape.moveTo(sx, -sz);
        else shape.lineTo(sx, -sz);
      }

      const cBLon = sumLon / b.ring.length;
      const cBLat = sumLat / b.ring.length;
      const groundElev = sampleTerrainBilinear(cBLon, cBLat);
      if (groundElev > bTerrainMax) bTerrainMax = groundElev;
      if (groundElev < bTerrainMin) bTerrainMin = groundElev;

      const baseY = elevToY(bTerrainMin + b.minHeightMeters);
      const topY = elevToY(bTerrainMax + b.heightMeters);
      const extrudeDepth = Math.max(0.35, topY - baseY);

      if (baseY + extrudeDepth > maxY) maxY = baseY + extrudeDepth;
      if (!debugSampleBuilding) {
        debugSampleBuilding = {
          groundElevM: Number(groundElev.toFixed(1)),
          bTerrainMaxM: Number(bTerrainMax.toFixed(1)),
          heightMeters: Number(b.heightMeters.toFixed(1)),
          baseY: Number(baseY.toFixed(3)),
          topY: Number((baseY + extrudeDepth).toFixed(3)),
        };
      }

      const bCeiling =
        config.altitudeMode === 'agl'
          ? groundElev + config.ceilingMeters
          : config.ceilingMeters;
      const isViolating = bTerrainMax + b.heightMeters + config.verticalBufferMeters > bCeiling;

      try {
        const geo = new THREE.ExtrudeGeometry(shape, {
          depth: extrudeDepth,
          bevelEnabled: false,
          steps: 1,
        });
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geo, isViolating ? breachBuildingMat : safeBuildingMat);
        mesh.position.y = baseY;
        mesh.castShadow = ctx.renderer.shadowMap.enabled;
        mesh.receiveShadow = ctx.renderer.shadowMap.enabled;
        buildingGroup.add(mesh);
      } catch {
        // Ignore degenerate polygon rings
      }
    }
    ctx.dynamicGroup.add(buildingGroup);

    // 2b. Visual Indicator for Grid Cells Blocked by Overture Building Geometries:
    // Color-coded 3D InstancedMesh Voxels + Red-Tinted Cell Tiles & Border Frames
    let blockedCoreCells = 0;
    let blockedBufferCells = 0;
    let blockedBreachCells = 0;

    if (showBlockedCells) {
      interface BlockedCellSpec {
        cx: number;
        cz: number;
        cw: number;
        cd: number;
        yBot: number;
        yTop: number;
        x0: number;
        x1: number;
        z0: number;
        z1: number;
        y00: number;
        y10: number;
        y01: number;
        y11: number;
        isCore: boolean;
        isBreach: boolean;
      }

      const blockedCells: BlockedCellSpec[] = [];

      for (let r = 0; r < rows - 1; r++) {
        const z0 = gridSceneZ[r];
        const z1 = gridSceneZ[r + 1];
        const cz = (z0 + z1) * 0.5;
        const cd = Math.max(0.15, Math.abs(z1 - z0) * 0.9);

        for (let c = 0; c < cols - 1; c++) {
          const i00 = r * cols + c;
          const i10 = i00 + 1;
          const i01 = (r + 1) * cols + c;
          const i11 = i01 + 1;

          const rawPeak = Math.max(
            rawBuildingHeight[i00],
            rawBuildingHeight[i10],
            rawBuildingHeight[i01],
            rawBuildingHeight[i11],
          );
          const bufPeak = Math.max(
            bufferedBuildingHeight[i00],
            bufferedBuildingHeight[i10],
            bufferedBuildingHeight[i01],
            bufferedBuildingHeight[i11],
          );

          if (bufPeak <= 0.5) continue;

          const isCore = rawPeak > 0.5;
          const minClr = Math.min(clearance[i00], clearance[i10], clearance[i01], clearance[i11]);
          const isBreach = minClr < 0;

          if (isCore) blockedCoreCells++;
          else blockedBufferCells++;
          if (isBreach) blockedBreachCells++;

          const x0 = gridSceneX[c];
          const x1 = gridSceneX[c + 1];
          const cx = (x0 + x1) * 0.5;
          const cw = Math.max(0.15, Math.abs(x1 - x0) * 0.9);

          const minCellT = Math.min(
            terrainElev[i00],
            terrainElev[i10],
            terrainElev[i01],
            terrainElev[i11],
          );
          const maxCellEnv = Math.max(
            envelopeElev[i00],
            envelopeElev[i10],
            envelopeElev[i01],
            envelopeElev[i11],
          );

          blockedCells.push({
            cx,
            cz,
            cw,
            cd,
            yBot: elevToY(minCellT),
            yTop: elevToY(maxCellEnv),
            x0,
            x1,
            z0,
            z1,
            y00: elevToY(terrainElev[i00]) + 0.06,
            y10: elevToY(terrainElev[i10]) + 0.06,
            y01: elevToY(terrainElev[i01]) + 0.06,
            y11: elevToY(terrainElev[i11]) + 0.06,
            isCore,
            isBreach,
          });
        }
      }

      if (blockedCells.length > 0) {
        // Instanced 3D voxel columns showing exact obstructed airspace volume per grid cell
        const voxelGeo = new THREE.BoxGeometry(1, 1, 1);
        const voxelMat = new THREE.MeshStandardMaterial({
          color: '#FFFFFF',
          transparent: true,
          opacity: 0.34,
          roughness: 0.38,
          metalness: 0.05,
          depthWrite: false,
        });
        const voxelMesh = new THREE.InstancedMesh(voxelGeo, voxelMat, blockedCells.length);
        voxelMesh.renderOrder = 1;

        const dummy = new THREE.Object3D();
        const color = new THREE.Color();

        // Red-tinted cell tiles & crisp cell grid borders seated flush on terrain
        const tilePositions = new Float32Array(blockedCells.length * 6 * 3);
        const tileColors = new Float32Array(blockedCells.length * 6 * 3);
        const borderPositions: number[] = [];
        const borderColors: number[] = [];

        blockedCells.forEach((cell, idx) => {
          const vh = Math.max(0.4, cell.yTop - cell.yBot);
          dummy.position.set(cell.cx, cell.yBot + vh * 0.5, cell.cz);
          dummy.scale.set(cell.cw, vh, cell.cd);
          dummy.updateMatrix();
          voxelMesh.setMatrixAt(idx, dummy.matrix);

          if (cell.isCore && cell.isBreach) {
            color.set('#DC2626'); // Deep Crimson: building footprint breaching ceiling
          } else if (cell.isCore) {
            color.set('#EF4444'); // Vivid Red: direct building geometry obstruction
          } else {
            color.set('#F59E0B'); // Warm Amber: horizontal safety buffer blockage
          }
          voxelMesh.setColorAt(idx, color);

          // Red/amber tinted ground quad per blocked cell
          const [tr, tg, tb] = cell.isCore ? [0.94, 0.24, 0.28] : [0.96, 0.62, 0.12];
          const pOff = idx * 18;
          tilePositions[pOff] = cell.x0;
          tilePositions[pOff + 1] = cell.y00;
          tilePositions[pOff + 2] = cell.z0;
          tilePositions[pOff + 3] = cell.x0;
          tilePositions[pOff + 4] = cell.y01;
          tilePositions[pOff + 5] = cell.z1;
          tilePositions[pOff + 6] = cell.x1;
          tilePositions[pOff + 7] = cell.y10;
          tilePositions[pOff + 8] = cell.z0;

          tilePositions[pOff + 9] = cell.x1;
          tilePositions[pOff + 10] = cell.y10;
          tilePositions[pOff + 11] = cell.z0;
          tilePositions[pOff + 12] = cell.x0;
          tilePositions[pOff + 13] = cell.y01;
          tilePositions[pOff + 14] = cell.z1;
          tilePositions[pOff + 15] = cell.x1;
          tilePositions[pOff + 16] = cell.y11;
          tilePositions[pOff + 17] = cell.z1;

          for (let k = 0; k < 6; k++) {
            tileColors[pOff + k * 3] = tr;
            tileColors[pOff + k * 3 + 1] = tg;
            tileColors[pOff + k * 3 + 2] = tb;
          }

          const [br, bg, bb] = cell.isCore ? [0.85, 0.11, 0.2] : [0.85, 0.47, 0.04];
          borderPositions.push(
            cell.x0, cell.y00 + 0.02, cell.z0, cell.x1, cell.y10 + 0.02, cell.z0,
            cell.x1, cell.y10 + 0.02, cell.z0, cell.x1, cell.y11 + 0.02, cell.z1,
            cell.x1, cell.y11 + 0.02, cell.z1, cell.x0, cell.y01 + 0.02, cell.z1,
            cell.x0, cell.y01 + 0.02, cell.z1, cell.x0, cell.y00 + 0.02, cell.z0,
          );
          for (let k = 0; k < 8; k++) {
            borderColors.push(br, bg, bb);
          }
        });

        voxelMesh.instanceMatrix.needsUpdate = true;
        if (voxelMesh.instanceColor) voxelMesh.instanceColor.needsUpdate = true;
        ctx.dynamicGroup.add(voxelMesh);

        const tileGeo = new THREE.BufferGeometry();
        tileGeo.setAttribute('position', new THREE.BufferAttribute(tilePositions, 3));
        tileGeo.setAttribute('color', new THREE.BufferAttribute(tileColors, 3));
        const tileMat = new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const tileMesh = new THREE.Mesh(tileGeo, tileMat);
        tileMesh.renderOrder = 1;
        ctx.dynamicGroup.add(tileMesh);

        const borderGeo = new THREE.BufferGeometry();
        borderGeo.setAttribute('position', new THREE.Float32BufferAttribute(borderPositions, 3));
        borderGeo.setAttribute('color', new THREE.Float32BufferAttribute(borderColors, 3));
        const borderMat = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.85,
        });
        const borderLines = new THREE.LineSegments(borderGeo, borderMat);
        borderLines.renderOrder = 2;
        ctx.dynamicGroup.add(borderLines);
      }
    }

    // 3. Composite Obstacle Envelope Mesh (terrain + buffered building + vertical buffer)
    let envPositions: Float32Array | null = null;
    let envMinY = 0;
    let envMaxY = 0;
    if (config.showEnvelopeMesh || config.showWireframe) {
      const {
        fillGeo: envGeo,
        lineGeo: envLineGeo,
        positions: ePos,
        minY: eMinY,
        maxSurfY: eMaxY,
      } = buildGridSurfaceGeo(
        (idx) => elevToY(envelopeElev[idx]) + 0.08,
        (idx) => {
          const clr = clearance[idx];
          const rawB = rawBuildingHeight[idx];
          const bH = bufferedBuildingHeight[idx];
          if (clr < 0) return [0.88, 0.11, 0.28]; // Violation Rose
          if (rawB > 0.5) return [0.92, 0.28, 0.26]; // Blocked by Overture building footprint
          if (clr < 15) return [0.85, 0.47, 0.02]; // Caution Amber
          if (bH > 0.5) return [0.03, 0.57, 0.7]; // Urban obstacle buffer Teal
          return [0.05, 0.58, 0.53]; // Clear terrain buffer
        },
      );
      envPositions = ePos;
      envMinY = eMinY;
      envMaxY = eMaxY;

      if (config.showEnvelopeMesh) {
        const envMat = new THREE.MeshPhysicalMaterial({
          vertexColors: true,
          transparent: true,
          opacity: config.envelopeOpacity,
          roughness: 0.35,
          metalness: 0.05,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const envMesh = new THREE.Mesh(envGeo, envMat);
        envMesh.renderOrder = 2;
        ctx.dynamicGroup.add(envMesh);
      } else {
        envGeo.dispose();
      }

      if (config.showWireframe) {
        const wireMat = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: Math.min(0.92, config.envelopeOpacity + 0.35),
        });
        const wireLines = new THREE.LineSegments(envLineGeo, wireMat);
        wireLines.renderOrder = 3;
        ctx.dynamicGroup.add(wireLines);
      } else {
        envLineGeo.dispose();
      }
    }

    // 4. Safe Flight Ceiling Mesh (AGL terrain-following or MSL flat datum)
    let ceilMinY = 0;
    let ceilMaxY = 0;
    if (config.showCeilingMesh) {
      const {
        fillGeo: ceilGeo,
        lineGeo: ceilLineGeo,
        minY: cMinY,
        maxSurfY: cMaxY,
      } = buildGridSurfaceGeo(
        (idx) => elevToY(ceilingElev[idx]) + 0.14,
        (idx) => {
          const clr = clearance[idx];
          if (clr < 0) return [0.96, 0.22, 0.35];
          if (clr < 15) return [0.96, 0.62, 0.04];
          return [0.02, 0.71, 0.83];
        },
      );
      ceilMinY = cMinY;
      ceilMaxY = cMaxY;

      const ceilMat = new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        transparent: true,
        opacity: config.ceilingOpacity,
        roughness: 0.22,
        metalness: 0.08,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const ceilMesh = new THREE.Mesh(ceilGeo, ceilMat);
      ceilMesh.renderOrder = 4;
      ctx.dynamicGroup.add(ceilMesh);

      if (config.showWireframe) {
        const ceilWireMat = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: Math.min(0.9, config.ceilingOpacity + 0.4),
        });
        const ceilWire = new THREE.LineSegments(ceilLineGeo, ceilWireMat);
        ceilWire.renderOrder = 5;
        ctx.dynamicGroup.add(ceilWire);
      } else {
        ceilLineGeo.dispose();
      }
    }

    // 5. Optional 3D Flight Corridor Path + Obstacle-Aware Climb Path + Waypoint Pylons
    if (corridorAnalysis && corridorAnalysis.samples.length >= 2) {
      const pts: THREE.Vector3[] = corridorAnalysis.samples.map((s) => {
        const [sx, sz] = toSceneXZ(s.lon, s.lat);
        const sy = elevToY(s.ceilingMeters) + 0.22;
        return new THREE.Vector3(sx, sy, sz);
      });

      const curve = new THREE.CatmullRomCurve3(pts);
      const tubeGeo = new THREE.TubeGeometry(curve, 72, 0.42, 8, false);
      const pathColor =
        corridorAnalysis.summary.status === 'VIOLATION'
          ? '#E11D48'
          : corridorAnalysis.summary.status === 'CAUTION'
            ? '#D97706'
            : '#059669';
      const tubeMat = new THREE.MeshStandardMaterial({
        color: pathColor,
        roughness: 0.3,
        metalness: 0.2,
      });
      ctx.dynamicGroup.add(new THREE.Mesh(tubeGeo, tubeMat));

      if (config.autoClimbCorridor) {
        const safePts: THREE.Vector3[] = corridorAnalysis.samples.map((s) => {
          const [sx, sz] = toSceneXZ(s.lon, s.lat);
          const sy = elevToY(s.safeFlightMeters) + 0.34;
          return new THREE.Vector3(sx, sy, sz);
        });
        const safeCurve = new THREE.CatmullRomCurve3(safePts);
        const safeTubeGeo = new THREE.TubeGeometry(safeCurve, 72, 0.46, 8, false);
        const safeTubeMat = new THREE.MeshStandardMaterial({
          color: '#10B981',
          roughness: 0.25,
          metalness: 0.18,
        });
        ctx.dynamicGroup.add(new THREE.Mesh(safeTubeGeo, safeTubeMat));
      }

      const pylonMat = new THREE.MeshStandardMaterial({
        color: '#0F172A',
        roughness: 0.35,
        metalness: 0.4,
      });

      corridorAnalysis.waypoints.forEach(([lon, lat]) => {
        const [sx, sz] = toSceneXZ(lon, lat);
        const gElev = sampleTerrainBilinear(lon, lat);
        const cElev =
          config.altitudeMode === 'agl' ? gElev + config.ceilingMeters : config.ceilingMeters;
        const envElev = gElev + config.verticalBufferMeters;
        const topElev = config.autoClimbCorridor ? Math.max(cElev, envElev + 5) : cElev;
        const yBot = elevToY(gElev);
        const yTop = elevToY(topElev) + 0.34;
        const h = Math.max(1, yTop - yBot);

        const pylonGeo = new THREE.CylinderGeometry(0.42, 0.42, h, 10);
        const pylon = new THREE.Mesh(pylonGeo, pylonMat);
        pylon.position.set(sx, yBot + h / 2, sz);
        ctx.dynamicGroup.add(pylon);
      });
    }

    // 6. Crisp AOI Corner Bounding Pillars connecting Terrain Cut -> Flight Ceiling
    const cornerIndices = [
      { r: 0, c: 0 },
      { r: 0, c: cols - 1 },
      { r: rows - 1, c: 0 },
      { r: rows - 1, c: cols - 1 },
    ];
    const cornerLinePos: number[] = [];
    for (const { r, c } of cornerIndices) {
      const idx = r * cols + c;
      const x = gridSceneX[c];
      const z = gridSceneZ[r];
      const yBot = elevToY(terrainElev[idx]);
      const yTop = elevToY(ceilingElev[idx]) + 0.14;
      cornerLinePos.push(x, yBot, z, x, yTop, z);
    }
    const cornerGeo = new THREE.BufferGeometry();
    cornerGeo.setAttribute('position', new THREE.Float32BufferAttribute(cornerLinePos, 3));
    const cornerMat = new THREE.LineBasicMaterial({
      color: '#0E7490',
      transparent: true,
      opacity: 0.65,
    });
    ctx.dynamicGroup.add(new THREE.LineSegments(cornerGeo, cornerMat));

    // Structured Three.js scene coordinate & buffer vertex debug log
    const centerIdx = Math.floor(rows / 2) * cols + Math.floor(cols / 2);
    const readPos = (arr: Float32Array, idx: number) => [
      Number(arr[idx * 3].toFixed(2)),
      Number(arr[idx * 3 + 1].toFixed(2)),
      Number(arr[idx * 3 + 2].toFixed(2)),
    ];
    console.info('[DroneMeshInspector] Three.js buffer vertices', {
      originCenterLngLat: [Number(cLon.toFixed(5)), Number(cLat.toFixed(5))],
      originMercator: [Number(originMerc.x.toFixed(6)), Number(originMerc.y.toFixed(6))],
      mercPerMeter: Number(mercPerMeter.toExponential(4)),
      sceneScale: Number(sceneScale.toFixed(5)),
      verticalScale: Number(verticalScale.toFixed(5)),
      terrainPositionStats: {
        vertexCount: cols * rows,
        minY: Number(terrainMinY.toFixed(2)),
        maxY: Number(terrainMaxY.toFixed(2)),
        sampleXYZ: {
          nw: readPos(terrainPositions, 0),
          center: readPos(terrainPositions, centerIdx),
          se: readPos(terrainPositions, cols * rows - 1),
        },
      },
      envelopePositionStats: envPositions
        ? {
            minY: Number(envMinY.toFixed(2)),
            maxY: Number(envMaxY.toFixed(2)),
            sampleXYZ: {
              nw: readPos(envPositions, 0),
              center: readPos(envPositions, centerIdx),
              se: readPos(envPositions, cols * rows - 1),
            },
          }
        : null,
      ceilingPositionStats: config.showCeilingMesh
        ? { minY: Number(ceilMinY.toFixed(2)), maxY: Number(ceilMaxY.toFixed(2)) }
        : null,
      blockedCellsStats: {
        visible: showBlockedCells,
        coreBuildingCells: blockedCoreCells,
        bufferCells: blockedBufferCells,
        breachCells: blockedBreachCells,
      },
      sampleBuilding: debugSampleBuilding,
    });

    const isResampledGrid = grid.capturedAt !== prevCapturedAtRef.current;
    const isUpdatedGrid = grid !== prevGridRef.current;
    prevGridRef.current = grid;
    prevCapturedAtRef.current = grid.capturedAt;

    ctx.worldBounds = { width: worldW, depth: worldD, maxY, sceneScale };
    if (!hasFramedRef.current) {
      hasFramedRef.current = true;
      ctx.resetCamera();
    }

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if ((isResampledGrid || isUpdatedGrid) && !prefersReducedMotion) {
      const seenMaterials = new Set<THREE.Material>();
      const fadeEntries: Array<{
        material: THREE.Material;
        targetOpacity: number;
        baseTransparent: boolean;
        baseDepthWrite: boolean;
        startFactor: number;
      }> = [];

      ctx.dynamicGroup.traverse((obj) => {
        const renderable = obj as THREE.Mesh | THREE.LineSegments;
        const mat = renderable.material;
        const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
        for (const m of mats) {
          if (seenMaterials.has(m)) continue;
          seenMaterials.add(m);
          if (!isResampledGrid && m.userData?.isBaseGeo) continue;
          fadeEntries.push({
            material: m,
            targetOpacity: m.opacity,
            baseTransparent: m.transparent,
            baseDepthWrite: m.depthWrite,
            startFactor: isResampledGrid ? 0.08 : 0.55,
          });
        }
      });

      ctx.startFadeIn(fadeEntries, isResampledGrid ? 300 : 180);
    } else {
      ctx.requestRender();
    }
  }, [grid, config, corridorAnalysis, exaggeration, showBlockedCells]);

  const statusBadge = (() => {
    if (!grid) return { label: 'NO GRID', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
    if (grid.violationCellCount > 0) {
      return { label: 'ENVELOPE BREACH', cls: 'bg-rose-50 text-rose-700 border-rose-200' };
    }
    if (grid.cautionCellCount > 0) {
      return { label: 'CAUTION MARGIN', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
    }
    return { label: 'AIRSPACE CLEAR', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  })();

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/45 flex items-center justify-center p-4">
      <div className="relative w-full h-full max-w-[1440px] max-h-[92vh] bg-[#F8FAFC] border border-slate-300 rounded-lg shadow-xl flex flex-col overflow-hidden">
        {/* Top Scientific Telemetry & Action Bar */}
        <header className="shrink-0 bg-white border-b border-slate-200 px-4 py-2.5 flex items-center justify-between gap-4 z-10">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-7 h-7 rounded-md bg-cyan-50 border border-cyan-200 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-4 h-4 text-cyan-700" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-semibold text-slate-900 tracking-tight truncate">
                  3D Drone Airspace Mesh Inspector
                </h2>
                <span
                  className={`px-2 py-0.5 text-[10px] font-mono font-semibold rounded border ${statusBadge.cls}`}
                >
                  {statusBadge.label}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-mono tabular-nums truncate">
                {grid
                  ? `AOI ${(grid.widthMeters / 1000).toFixed(2)} × ${(grid.depthMeters / 1000).toFixed(2)} km · ${grid.buildingCount} Overture footprints · ${blockedCellStats.core} blocked cells (${blockedCellStats.buffer} buffer)`
                  : 'Sampling SRTM terrain & Overture structures...'}
              </p>
            </div>
          </div>

          {/* KPI Strip */}
          {grid && (
            <div className="hidden lg:flex items-center gap-4 text-[11px] font-mono tabular-nums border-x border-slate-200 px-4">
              <div>
                <div className="text-[9px] uppercase tracking-wider text-slate-400">Ceiling</div>
                <div className="font-semibold text-slate-900">
                  {config.ceilingMeters}m {config.altitudeMode.toUpperCase()}
                </div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider text-slate-400">Min Clearance</div>
                <div
                  className={`font-semibold ${
                    grid.minClearanceMeters < 0
                      ? 'text-rose-600'
                      : grid.minClearanceMeters < 15
                        ? 'text-amber-600'
                        : 'text-emerald-700'
                  }`}
                >
                  {grid.minClearanceMeters > 0 ? `+${grid.minClearanceMeters}` : grid.minClearanceMeters}m
                </div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider text-slate-400">Blocked Cells</div>
                <div className="font-semibold text-red-600">{blockedCellStats.core}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider text-slate-400">Max Obstacle</div>
                <div className="font-semibold text-slate-900">{grid.maxObstacleElevMeters}m</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider text-slate-400">AOI Breach</div>
                <div
                  className={`font-semibold ${
                    grid.violationPct > 0 ? 'text-rose-600' : 'text-slate-900'
                  }`}
                >
                  {grid.violationPct}%
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onResampleAoi}
              disabled={loading}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium bg-[#F8FAFC] border border-slate-200 rounded-md text-slate-700 hover:bg-slate-100 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Resample AOI
            </button>
            <button
              type="button"
              onClick={() => sceneCtxRef.current?.resetCamera()}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium bg-[#F8FAFC] border border-slate-200 rounded-md text-slate-700 hover:bg-slate-100 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Camera
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close 3D Mesh Inspector"
              className="w-7 h-7 flex items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Central Unobstructed Three.js Viewport */}
        <div className="relative flex-1 min-h-0 bg-[#F8FAFC]">
          <div ref={mountRef} className="w-full h-full" />

          {!grid && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
              <div className="bg-white border border-slate-200 rounded-lg px-4 py-3 shadow-sm text-xs font-mono text-slate-700 flex items-center gap-2.5">
                <RefreshCw className={`w-4 h-4 text-cyan-700 ${loading ? 'animate-spin' : ''}`} />
                <span>
                  {loading
                    ? 'Synthesizing 3D terrain DEM & Overture airspace mesh...'
                    : 'No AOI airspace mesh captured yet. Click Resample AOI.'}
                </span>
              </div>
            </div>
          )}

          {/* Top-Left Compact Color Key & Hover Readout (Solid opaque surface, zero backdrop-blur) */}
          <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-2 z-10">
            <div className="bg-white/95 border border-slate-200 rounded-md px-3 py-2 text-[10px] font-mono text-slate-700 flex flex-wrap items-center gap-3 shadow-xs">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-red-500 inline-block" />
                Blocked Cell (Bldg)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-amber-400 inline-block" />
                Buffer Voxel
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-teal-600 inline-block" />
                Buffer Envelope
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-cyan-500 inline-block" />
                Safe Ceiling
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-rose-600 inline-block" />
                Breach (&lt;0m)
              </span>
            </div>

            {hoverTelemetry && (
              <div className="bg-white/95 border border-slate-200 rounded-md px-3 py-2 text-[11px] font-mono tabular-nums text-slate-700 shadow-xs space-y-0.5 max-w-[300px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-slate-400">
                    {hoverTelemetry.lat.toFixed(5)}°, {hoverTelemetry.lon.toFixed(5)}°
                  </span>
                  <span
                    className={`px-1.5 py-0.5 text-[9px] font-semibold rounded border ${
                      hoverTelemetry.rawBuildingMeters > 0.5
                        ? 'bg-red-50 text-red-700 border-red-200'
                        : hoverTelemetry.buildingMeters > 0.5
                          ? 'bg-amber-50 text-amber-700 border-amber-200'
                          : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    }`}
                  >
                    {hoverTelemetry.rawBuildingMeters > 0.5
                      ? 'BLOCKED CELL'
                      : hoverTelemetry.buildingMeters > 0.5
                        ? 'BUFFER ZONE'
                        : 'CLEAR CELL'}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span>Terrain DEM:</span>
                  <strong className="text-slate-900">{hoverTelemetry.terrainMeters} m</strong>
                </div>
                <div className="flex justify-between gap-4">
                  <span>Building (Raw / Buf):</span>
                  <strong
                    className={
                      hoverTelemetry.rawBuildingMeters > 0.5 ? 'text-red-600' : 'text-slate-900'
                    }
                  >
                    {hoverTelemetry.rawBuildingMeters} / {hoverTelemetry.buildingMeters} m
                  </strong>
                </div>
                <div className="flex justify-between gap-4">
                  <span>Obstacle Envelope:</span>
                  <strong className="text-teal-700">{hoverTelemetry.envelopeMeters} m MSL</strong>
                </div>
                <div className="flex justify-between gap-4">
                  <span>Target Ceiling:</span>
                  <strong className="text-cyan-700">{hoverTelemetry.ceilingMeters} m MSL</strong>
                </div>
                <div className="flex justify-between gap-4 pt-1 border-t border-slate-100">
                  <span>Net Clearance:</span>
                  <strong
                    className={
                      hoverTelemetry.clearanceMeters < 0
                        ? 'text-rose-600'
                        : hoverTelemetry.clearanceMeters < 15
                          ? 'text-amber-600'
                          : 'text-emerald-700'
                    }
                  >
                    {hoverTelemetry.clearanceMeters > 0
                      ? `+${hoverTelemetry.clearanceMeters}`
                      : hoverTelemetry.clearanceMeters}{' '}
                    m
                  </strong>
                </div>
              </div>
            )}
          </div>

          {/* Collapsible Unified Bottom Control Dock */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center max-w-[94vw]">
            <button
              type="button"
              onClick={() => setDockCollapsed((v) => !v)}
              className="mb-1.5 px-3 py-1 bg-white border border-slate-200 rounded-md shadow-xs text-[11px] font-medium text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 cursor-pointer"
            >
              {dockCollapsed ? (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  Show Mesh Controls
                </>
              ) : (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  Hide Controls
                </>
              )}
            </button>

            {!dockCollapsed && (
              <div className="bg-white border border-slate-200 rounded-lg shadow-md px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2.5 text-xs">
                {/* Layer Toggles */}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      onChangeConfig((p) => ({ ...p, showEnvelopeMesh: !p.showEnvelopeMesh }))
                    }
                    className={`px-2.5 py-1 rounded border text-[11px] font-medium flex items-center gap-1 cursor-pointer ${
                      config.showEnvelopeMesh
                        ? 'bg-teal-50 border-teal-200 text-teal-800'
                        : 'bg-[#F8FAFC] border-slate-200 text-slate-600'
                    }`}
                  >
                    <Layers className="w-3 h-3" />
                    Envelope
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onChangeConfig((p) => ({ ...p, showCeilingMesh: !p.showCeilingMesh }))
                    }
                    className={`px-2.5 py-1 rounded border text-[11px] font-medium flex items-center gap-1 cursor-pointer ${
                      config.showCeilingMesh
                        ? 'bg-cyan-50 border-cyan-200 text-cyan-800'
                        : 'bg-[#F8FAFC] border-slate-200 text-slate-600'
                    }`}
                  >
                    <Eye className="w-3 h-3" />
                    Ceiling
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onChangeConfig((p) => ({ ...p, showWireframe: !p.showWireframe }))
                    }
                    className={`px-2.5 py-1 rounded border text-[11px] font-medium flex items-center gap-1 cursor-pointer ${
                      config.showWireframe
                        ? 'bg-blue-50 border-blue-200 text-blue-800'
                        : 'bg-[#F8FAFC] border-slate-200 text-slate-600'
                    }`}
                  >
                    <Grid className="w-3 h-3" />
                    Wireframe
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onChangeConfig((p) => ({ ...p, autoClimbCorridor: !p.autoClimbCorridor }))
                    }
                    className={`px-2.5 py-1 rounded border text-[11px] font-medium flex items-center gap-1 cursor-pointer ${
                      config.autoClimbCorridor
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : 'bg-[#F8FAFC] border-slate-200 text-slate-600'
                    }`}
                  >
                    <Route className="w-3 h-3" />
                    Safe Climb
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowBlockedCells((v) => !v)}
                    className={`px-2.5 py-1 rounded border text-[11px] font-medium flex items-center gap-1 cursor-pointer ${
                      showBlockedCells
                        ? 'bg-red-50 border-red-200 text-red-800'
                        : 'bg-[#F8FAFC] border-slate-200 text-slate-600'
                    }`}
                  >
                    <Box className="w-3 h-3" />
                    Blocked Voxels
                  </button>
                </div>

                {/* AGL / MSL Selector & Flight Ceiling */}
                <div className="flex items-center gap-2.5 border-l border-slate-200 pl-4">
                  <div className="flex bg-slate-100 p-0.5 rounded">
                    {(['agl', 'msl'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() =>
                          onChangeConfig((p) => {
                            if (p.altitudeMode === mode) return p;
                            const baseElev = Math.round(grid?.minTerrainMeters ?? 0);
                            const nextCeiling =
                              mode === 'msl'
                                ? Math.min(4500, Math.max(40, p.ceilingMeters + baseElev))
                                : Math.min(500, Math.max(20, p.ceilingMeters - baseElev));
                            return { ...p, altitudeMode: mode, ceilingMeters: nextCeiling };
                          })
                        }
                        className={`px-2 py-0.5 text-[10px] font-mono font-semibold uppercase rounded cursor-pointer ${
                          config.altitudeMode === mode
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-500'
                        }`}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                  <div className="w-32 space-y-0.5">
                    <div className="flex justify-between text-[10px] font-mono">
                      <span className="text-slate-500">Ceiling</span>
                      <span className="font-semibold text-slate-900">{config.ceilingMeters}m</span>
                    </div>
                    <input
                      type="range"
                      min={config.altitudeMode === 'agl' ? 20 : Math.max(20, Math.floor(grid?.minTerrainMeters ?? 0))}
                      max={config.altitudeMode === 'agl' ? 500 : Math.max(600, Math.ceil((grid?.maxTerrainMeters ?? 500) + 500))}
                      step={5}
                      value={config.ceilingMeters}
                      onChange={(e) =>
                        onChangeConfig((p) => ({ ...p, ceilingMeters: Number(e.target.value) }))
                      }
                      className="w-full sci-slider"
                    />
                  </div>
                </div>

                {/* Vertical & Horizontal Safety Buffers */}
                <div className="flex items-center gap-3 border-l border-slate-200 pl-4">
                  <div className="w-24 space-y-0.5">
                    <div className="flex justify-between text-[10px] font-mono">
                      <span className="text-slate-500">V-Buf</span>
                      <span className="font-semibold text-slate-900">{config.verticalBufferMeters}m</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={60}
                      step={1}
                      value={config.verticalBufferMeters}
                      onChange={(e) =>
                        onChangeConfig((p) => ({
                          ...p,
                          verticalBufferMeters: Number(e.target.value),
                        }))
                      }
                      className="w-full sci-slider"
                    />
                  </div>
                  <div className="w-24 space-y-0.5">
                    <div className="flex justify-between text-[10px] font-mono">
                      <span className="text-slate-500">H-Buf</span>
                      <span className="font-semibold text-slate-900">{config.horizontalBufferMeters}m</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={50}
                      step={1}
                      value={config.horizontalBufferMeters}
                      onChange={(e) =>
                        onChangeConfig((p) => ({
                          ...p,
                          horizontalBufferMeters: Number(e.target.value),
                        }))
                      }
                      className="w-full sci-slider"
                    />
                  </div>
                </div>

                {/* Translucent Mesh Opacity Controls */}
                <div className="flex items-center gap-3 border-l border-slate-200 pl-4">
                  <div className="w-24 space-y-0.5">
                    <div className="flex justify-between text-[10px] font-mono">
                      <span className="text-slate-500">Env α</span>
                      <span className="font-semibold text-slate-900">
                        {Math.round(config.envelopeOpacity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.1}
                      max={0.9}
                      step={0.05}
                      value={config.envelopeOpacity}
                      onChange={(e) =>
                        onChangeConfig((p) => ({ ...p, envelopeOpacity: Number(e.target.value) }))
                      }
                      className="w-full sci-slider"
                    />
                  </div>
                  <div className="w-24 space-y-0.5">
                    <div className="flex justify-between text-[10px] font-mono">
                      <span className="text-slate-500">Ceil α</span>
                      <span className="font-semibold text-slate-900">
                        {Math.round(config.ceilingOpacity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.05}
                      max={0.85}
                      step={0.05}
                      value={config.ceilingOpacity}
                      onChange={(e) =>
                        onChangeConfig((p) => ({ ...p, ceilingOpacity: Number(e.target.value) }))
                      }
                      className="w-full sci-slider"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
