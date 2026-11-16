import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  ChevronDown,
  ChevronUp,
  Eye,
  Grid,
  Layers,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react';
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
  const [hoverTelemetry, setHoverTelemetry] = useState<HoverInspectTelemetry | null>(null);

  const gridRef = useRef(grid);
  gridRef.current = grid;
  const configRef = useRef(config);
  configRef.current = config;
  const exaggerationRef = useRef(exaggeration);
  exaggerationRef.current = exaggeration;

  const sceneCtxRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    dynamicGroup: THREE.Group;
    terrainPickMesh: THREE.Mesh | null;
    worldBounds: { width: number; depth: number; maxY: number };
    requestRender: () => void;
    resetCamera: () => void;
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
        controls.update();
        renderer.render(scene, camera);
        const done = () => {
          renderBusy = false;
          if (renderDirty && !disposed) requestRender();
        };
        if (isSoftwareGl) afterDraw(done);
        else done();
      });
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
      worldBounds: { width: 120, depth: 120, maxY: 28 },
      requestRender,
      resetCamera,
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
      const w = ctx.worldBounds.width;
      const d = ctx.worldBounds.depth;
      const u = Math.max(0, Math.min(1, (pt.x + w / 2) / w));
      const v = Math.max(0, Math.min(1, (pt.z + d / 2) / d));

      const col = Math.min(g.cols - 1, Math.max(0, Math.round(u * (g.cols - 1))));
      const row = Math.min(g.rows - 1, Math.max(0, Math.round(v * (g.rows - 1))));
      const idx = row * g.cols + col;

      const [minLon, minLat, maxLon, maxLat] = g.bbox;
      const lon = minLon + u * (maxLon - minLon);
      const lat = maxLat - v * (maxLat - minLat);

      setHoverTelemetry({
        lon,
        lat,
        terrainMeters: Math.round(g.terrainElev[idx] * 10) / 10,
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

    disposeObject3D(ctx.dynamicGroup);
    ctx.dynamicGroup.clear();
    ctx.terrainPickMesh = null;

    if (!grid) {
      ctx.requestRender();
      return;
    }

    const {
      cols,
      rows,
      bbox: [minLon, minLat, maxLon, maxLat],
      center: [cLon, cLat],
      widthMeters,
      depthMeters,
      terrainElev,
      envelopeElev,
      ceilingElev,
      clearance,
      bufferedBuildingHeight,
      minTerrainMeters,
      maxTerrainMeters,
      buildings,
    } = grid;

    // Normalize AOI footprint to ~120 scene units along largest horizontal dimension
    const maxSpanMeters = Math.max(widthMeters, depthMeters, 100);
    const sceneScale = 120 / maxSpanMeters;
    const worldW = widthMeters * sceneScale;
    const worldD = depthMeters * sceneScale;

    const cosLat = Math.max(0.15, Math.cos((cLat * Math.PI) / 180));
    const metersPerDegLat = 111319.9;
    const metersPerDegLon = 111319.9 * cosLat;

    // Map geographic lon/lat + absolute elevation (meters) into Three.js local metric scene coordinates.
    // Apply a calibrated vertical airspace scale so 15m safety buffers, Overture towers, and 120m ceilings
    // have crisp 3D vertical separation rather than flattening against a 2km+ terrain cut.
    const terrainReliefScale = Math.max(1.2, Math.min(2.8, exaggeration * 1.1));
    const airspaceVerticalScale = sceneScale * Math.max(2.2, exaggeration * 1.55);
    const yBaseOffset = 2.5;

    const toSceneXZ = (lon: number, lat: number): [number, number] => {
      const x = (lon - cLon) * metersPerDegLon * sceneScale;
      const z = -(lat - cLat) * metersPerDegLat * sceneScale;
      return [x, z];
    };

    const elevToY = (absElev: number, localTerrainElev: number): number => {
      return (
        yBaseOffset +
        (localTerrainElev - minTerrainMeters) * sceneScale * terrainReliefScale +
        (absElev - localTerrainElev) * airspaceVerticalScale
      );
    };

    let maxY = 14;

    // Helper for shared grid topology
    const buildGridSurfaceGeo = (
      getY: (idx: number) => number,
      getColor: (idx: number) => [number, number, number],
    ): { fillGeo: THREE.BufferGeometry; lineGeo: THREE.BufferGeometry } => {
      const vertCount = cols * rows;
      const positions = new Float32Array(vertCount * 3);
      const colors = new Float32Array(vertCount * 3);

      for (let r = 0; r < rows; r++) {
        const v = rows > 1 ? r / (rows - 1) : 0.5;
        const z = -worldD / 2 + v * worldD;
        for (let c = 0; c < cols; c++) {
          const u = cols > 1 ? c / (cols - 1) : 0.5;
          const x = -worldW / 2 + u * worldW;
          const idx = r * cols + c;
          const y = getY(idx);
          if (y > maxY) maxY = y;
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
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const i0 = r * cols + c;
          lineIndices.push(i0, i0 + 1);
        }
      }
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols; c++) {
          const i0 = r * cols + c;
          lineIndices.push(i0, i0 + cols);
        }
      }

      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      lineGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      lineGeo.setIndex(lineIndices);

      return { fillGeo, lineGeo };
    };

    // 1. Solid SRTM/ASTER Terrain Mesh
    const elevRange = Math.max(1, maxTerrainMeters - minTerrainMeters);
    const { fillGeo: terrainGeo } = buildGridSurfaceGeo(
      (idx) => elevToY(terrainElev[idx], terrainElev[idx]),
      (idx) => {
        const t = Math.max(0, Math.min(1, (terrainElev[idx] - minTerrainMeters) / elevRange));
        // Clean hypsometric slate-emerald-ochre scientific ramp
        if (t < 0.35) {
          const k = t / 0.35;
          return [0.85 - k * 0.08, 0.89 + k * 0.02, 0.88 - k * 0.08];
        }
        if (t < 0.72) {
          const k = (t - 0.35) / 0.37;
          return [0.77 + k * 0.07, 0.91 - k * 0.14, 0.8 - k * 0.24];
        }
        const k = (t - 0.72) / 0.28;
        return [0.84 - k * 0.18, 0.77 - k * 0.22, 0.56 - k * 0.12];
      },
    );

    const terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.84,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });
    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    terrainMesh.receiveShadow = !ctx.renderer.shadowMap.enabled ? false : true;
    terrainMesh.castShadow = false;
    ctx.dynamicGroup.add(terrainMesh);
    ctx.terrainPickMesh = terrainMesh;

    // 1b. Solid Skirt Box Wall around terrain specimen so it reads like a physical terrain cut
    const skirtPositions: number[] = [];
    const pushSkirtQuad = (x0: number, z0: number, y0: number, x1: number, z1: number, y1: number) => {
      skirtPositions.push(
        x0, 0, z0, x0, y0, z0, x1, y1, z1,
        x0, 0, z0, x1, y1, z1, x1, 0, z1,
      );
    };
    const sampleY = (r: number, c: number) => elevToY(terrainElev[r * cols + c], terrainElev[r * cols + c]);
    const gridX = (c: number) => -worldW / 2 + (c / Math.max(1, cols - 1)) * worldW;
    const gridZ = (r: number) => -worldD / 2 + (r / Math.max(1, rows - 1)) * worldD;

    for (let c = 0; c < cols - 1; c++) {
      pushSkirtQuad(gridX(c), gridZ(0), sampleY(0, c), gridX(c + 1), gridZ(0), sampleY(0, c + 1));
      pushSkirtQuad(
        gridX(c + 1),
        gridZ(rows - 1),
        sampleY(rows - 1, c + 1),
        gridX(c),
        gridZ(rows - 1),
        sampleY(rows - 1, c),
      );
    }
    for (let r = 0; r < rows - 1; r++) {
      pushSkirtQuad(gridX(0), gridZ(r + 1), sampleY(r + 1, 0), gridX(0), gridZ(r), sampleY(r, 0));
      pushSkirtQuad(
        gridX(cols - 1),
        gridZ(r),
        sampleY(r, cols - 1),
        gridX(cols - 1),
        gridZ(r + 1),
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
    ctx.dynamicGroup.add(new THREE.Mesh(skirtGeo, skirtMat));

    // 2. Real Overture 3D Buildings seated on local DEM terrain
    const sampleTerrainLocal = (lon: number, lat: number): number => {
      const u = Math.max(0, Math.min(1, (lon - minLon) / Math.max(1e-9, maxLon - minLon)));
      const v = Math.max(0, Math.min(1, (maxLat - lat) / Math.max(1e-9, maxLat - minLat)));
      const c = Math.min(cols - 1, Math.max(0, Math.round(u * (cols - 1))));
      const r = Math.min(rows - 1, Math.max(0, Math.round(v * (rows - 1))));
      return terrainElev[r * cols + c];
    };

    const buildingGroup = new THREE.Group();
    const safeBuildingMat = new THREE.MeshStandardMaterial({
      color: '#475569',
      roughness: 0.52,
      metalness: 0.14,
    });
    const breachBuildingMat = new THREE.MeshStandardMaterial({
      color: '#BE123C',
      roughness: 0.42,
      metalness: 0.16,
    });

    const maxRenderBuildings = Math.min(buildings.length, 320);
    for (let bIdx = 0; bIdx < maxRenderBuildings; bIdx++) {
      const b = buildings[bIdx];
      if (b.ring.length < 3) continue;

      let sumLon = 0;
      let sumLat = 0;
      const shape = new THREE.Shape();

      for (let i = 0; i < b.ring.length; i++) {
        const [lon, lat] = b.ring[i];
        sumLon += lon;
        sumLat += lat;
        const [sx, sz] = toSceneXZ(lon, lat);
        // Shape lives in X-Y plane, later rotated -PI/2 around X so shape Y maps to -Z
        if (i === 0) shape.moveTo(sx, -sz);
        else shape.lineTo(sx, -sz);
      }

      const cBLon = sumLon / b.ring.length;
      const cBLat = sumLat / b.ring.length;
      const groundElev = sampleTerrainLocal(cBLon, cBLat);
      const baseY = elevToY(groundElev + b.minHeightMeters, groundElev);
      const extrudeDepth = Math.max(
        0.4,
        (b.heightMeters - b.minHeightMeters) * airspaceVerticalScale,
      );

      if (baseY + extrudeDepth > maxY) maxY = baseY + extrudeDepth;

      const bCeiling =
        config.altitudeMode === 'agl'
          ? groundElev + config.ceilingMeters
          : config.ceilingMeters;
      const isViolating = groundElev + b.heightMeters + config.verticalBufferMeters > bCeiling;

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

    // 3. Composite Obstacle Envelope Mesh (terrain + buffered building + vertical buffer)
    if (config.showEnvelopeMesh || config.showWireframe) {
      const { fillGeo: envGeo, lineGeo: envLineGeo } = buildGridSurfaceGeo(
        (idx) => elevToY(envelopeElev[idx], terrainElev[idx]) + 0.04,
        (idx) => {
          const clr = clearance[idx];
          const bH = bufferedBuildingHeight[idx];
          if (clr < 0) return [0.88, 0.11, 0.28]; // Violation Rose
          if (clr < 15) return [0.85, 0.47, 0.02]; // Caution Amber
          if (bH > 0.5) return [0.03, 0.57, 0.7]; // Urban obstacle Teal
          return [0.05, 0.58, 0.53]; // Clear terrain buffer
        },
      );

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
    if (config.showCeilingMesh) {
      const { fillGeo: ceilGeo, lineGeo: ceilLineGeo } = buildGridSurfaceGeo(
        (idx) => elevToY(ceilingElev[idx], terrainElev[idx]) + 0.08,
        (idx) => {
          const clr = clearance[idx];
          if (clr < 0) return [0.96, 0.22, 0.35];
          if (clr < 15) return [0.96, 0.62, 0.04];
          return [0.02, 0.71, 0.83];
        },
      );

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

    // 5. Optional 3D Flight Corridor Path + Waypoint Pylons
    if (corridorAnalysis && corridorAnalysis.samples.length >= 2) {
      const pts: THREE.Vector3[] = corridorAnalysis.samples.map((s) => {
        const [sx, sz] = toSceneXZ(s.lon, s.lat);
        const sy = elevToY(s.ceilingMeters, s.terrainMeters) + 0.16;
        return new THREE.Vector3(sx, sy, sz);
      });

      const curve = new THREE.CatmullRomCurve3(pts);
      const tubeGeo = new THREE.TubeGeometry(curve, 72, 0.45, 8, false);
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

      const pylonMat = new THREE.MeshStandardMaterial({
        color: '#0F172A',
        roughness: 0.35,
        metalness: 0.4,
      });

      corridorAnalysis.waypoints.forEach(([lon, lat]) => {
        const [sx, sz] = toSceneXZ(lon, lat);
        const gElev = sampleTerrainLocal(lon, lat);
        const cElev =
          config.altitudeMode === 'agl' ? gElev + config.ceilingMeters : config.ceilingMeters;
        const yBot = elevToY(gElev, gElev);
        const yTop = elevToY(cElev, gElev);
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
      const x = gridX(c);
      const z = gridZ(r);
      const yBot = elevToY(terrainElev[idx], terrainElev[idx]);
      const yTop = elevToY(ceilingElev[idx], terrainElev[idx]) + 0.08;
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

    const hadPrevBounds = ctx.terrainPickMesh !== null;
    ctx.worldBounds = { width: worldW, depth: worldD, maxY };
    if (!hadPrevBounds) {
      ctx.resetCamera();
    } else {
      ctx.requestRender();
    }
  }, [grid, config, corridorAnalysis, exaggeration]);

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
                  ? `AOI ${(grid.widthMeters / 1000).toFixed(2)} × ${(grid.depthMeters / 1000).toFixed(2)} km · ${grid.buildingCount} Overture footprints · Drag to orbit, Scroll to zoom`
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
            <div className="bg-white/95 border border-slate-200 rounded-md px-3 py-2 text-[10px] font-mono text-slate-700 flex items-center gap-3 shadow-xs">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-teal-600 inline-block" />
                Buffer Envelope
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-cyan-500 inline-block" />
                Safe Ceiling
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-amber-500 inline-block" />
                Caution (&lt;15m)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-rose-600 inline-block" />
                Breach (&lt;0m)
              </span>
            </div>

            {hoverTelemetry && (
              <div className="bg-white/95 border border-slate-200 rounded-md px-3 py-2 text-[11px] font-mono tabular-nums text-slate-700 shadow-xs space-y-0.5 max-w-[290px]">
                <div className="text-[10px] text-slate-400">
                  {hoverTelemetry.lat.toFixed(5)}°, {hoverTelemetry.lon.toFixed(5)}°
                </div>
                <div className="flex justify-between gap-4">
                  <span>Terrain DEM:</span>
                  <strong className="text-slate-900">{hoverTelemetry.terrainMeters} m</strong>
                </div>
                <div className="flex justify-between gap-4">
                  <span>Building Height:</span>
                  <strong className="text-slate-900">{hoverTelemetry.buildingMeters} m</strong>
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
