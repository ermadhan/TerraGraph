# TerraGraph — Architecture & Implementation Plan (Through Current Milestone)

## 1. Project Overview
**TerraGraph** is a minimalist scientific 3D geospatial explorer that combines **NASA SRTM 30m** and **NASA/METI ASTER GDEM 30m** elevation data with **Overture Maps** global man-made structures (3D extruded buildings, transportation networks, hydrology, and civil infrastructure).

### Target Audience & Value
- **Audience**: Geospatial analysts, earth scientists, cartographers, and urban researchers studying the interplay between terrain relief and built infrastructure or comparing radar-derived (SRTM) vs. optical-stereo (ASTER) elevation models.
- **Core Value**: Zero-setup global streaming of Overture PMTiles and Terrarium elevation tiles in a unified 3D WebGL viewport, backed by an empirical SRTM-vs-ASTER comparison proxy.

---

## 2. Implemented Capabilities & Milestones

### Milestone 1 — Core 3D Engine & Data Pipeline
- **3D Globe & Terrain Mesh (`MapViewport`)**:
  - Uses MapLibre GL JS (`v6.18.0`) with switchable **3D Globe** and **Mercator** projections.
  - Streams global 24-bit Terrarium elevation PNGs from AWS `elevation-tiles-prod` via `/api/tiles/terrarium/:z/:x/:y.png` (LRU-cached in Express to avoid CORS canvas tainting), using dedicated `terrarium-dem` (3D mesh displacement) and `terrarium-shading-dem` (`color-relief` / `hillshade`) sources to prevent MapLibre tile-LOD contention.
  - Supports vertical exaggeration (`0.5×`–`4.0×`, default `1.8×` with quick presets), sky atmosphere blending, and PNG canvas snapshot export (`preserveDrawingBuffer: true`).
- **Overture Maps Vector Streaming (`ControlSidebar` + `FeatureInspector`)**:
  - Express dynamically resolves the latest monthly Overture release from `https://stac.overturemaps.org/catalog.json` (with `2026-10-21.0` fallback) via `GET /api/overture/config`.
  - Streams `buildings.pmtiles`, `transportation.pmtiles`, and `base.pmtiles` directly from AWS S3 via the `pmtiles://` protocol.
  - Extrudes `building` (`minzoom: 9`) and `building_part` (`minzoom: 12`) layers in 3D seated directly onto terrain elevation (supporting Architectural Slate and Height Spectrum coloring), alongside terrain-draped `segment` roads (`minzoom: 7`), `land_cover`, `land_use`, `water`, and civil `infrastructure`.
  - Clicking any Overture feature opens the right-hand **Feature Inspector** showing its GERS ID, physical dimensions (`height`, `num_floors`, `roof_shape`, `surface`), schema properties, and contributor `sources`.

### Milestone 2 — Terrain Shaders & Solar Simulation
- **Client-Side `dem-analysis://` Tile Protocol (`src/utils/demProtocol.ts`)**:
  - Decodes Terrarium RGB channels `(R*256 + G + B/256) - 32768` into `Float32Array` elevation grids per tile.
  - Computes real-time Horn 3×3 finite-difference **Slope Steepness (`0°–70°`)** and **Aspect Compass Bearing (`0°–360°`)** layers draped directly on the 3D terrain.
  - Provides instant cursor hover telemetry (`Lat`, `Lon`, `Elevation m`, `Slope °`, `Aspect °`) in the bottom-left HUD.
- **Hypsometric Bands & Solar Hillshade**:
  - Native MapLibre `color-relief` layer with three selectable ramps (`Standard`, `Slate`, `Thermal`).
  - Interactive `hillshade` illumination azimuth (`0°–355°` + `NW`, `NE`, `SE`, `SW` presets) and hillshade intensity controls.

### Milestone 3 — Empirical SRTM 30m vs. ASTER 30m Analysis
- **Rate-Paced Express Proxy (`server.ts`)**:
  - Serializes requests to OpenTopoData (`api.opentopodata.org/v1/srtm30m` and `/v1/aster30m`) with `1.08s` pacing and LRU caching to stay cleanly within public tier rate limits (100 points/req, 1 req/sec).
- **Elevation Cross-Section Profiler (`TelemetryTray`)**:
  - `Draw Elevation Profile` mode lets users click 2+ vertices on the 3D terrain and compute up to 95 evenly spaced samples via `POST /api/elevation/profile`.
  - Renders a responsive **Recharts** terrain profile chart (`ComposedChart` with gradient `Area` for `SRTM 30m` solid cobalt and `Line` for `ASTER 30m` dashed amber, `0m MSL` reference datum when crossing sea level, interactive series visibility toggles, floating coordinate/elevation crosshair tooltip), synchronized 3D transect hover marker, RMSE, Mean Bias, Max `|Δh|`, total gain, and CSV download.
- **Viewport Discrepancy Heatmap (`POST /api/elevation/diff-grid`)**:
  - Samples a 9×9 grid across the active viewport, bilinearly interpolates a diverging Coolwarm `Δh = ASTER − SRTM` raster overlay onto the 3D terrain, renders interactive sample nodes with hover tooltips, and plots a 7-bin residual histogram in `TelemetryTray`.

### Milestone 4 — Stability, 3D Orientation Compass & 1° Graticule
- **Vite Worker & Pre-Style Query Fixes**:
  - Configured explicit ES module worker URL loading (`maplibre-gl/dist/maplibre-gl-worker.mjs?url` + `maplibregl.setWorkerUrl(...)`) for Vite pre-bundling and production builds.
  - Guarded `mousemove` feature queries with `map.getLayer('discrepancy-points')`.
- **Floating Minimalist 3D Orientation Compass**:
  - Added a top-left HUD instrument in `MapViewport` using CSS 3D perspective (`rotateX` linked to camera pitch and `rotateZ` linked to camera bearing) plus tabular `HDG` and `PITCH` readouts.
  - Single-click aligns True North (`bearing: 0`); double-click toggles between top-down (`0°`) and oblique 3D (`56°`) tilt.
- **Togglable 1-Degree Geographic Graticule**:
  - Added a global `1°` latitude/longitude GeoJSON graticule (`-179°..180°`, `-85°..85°`, `5°` subdivision for spherical curvature) with emphasized `10°` intervals and `0°` Equator/Prime Meridian lines.
  - Dynamically projects edge coordinate tick labels (`38°N`, `122°W`, `0° EQ`, etc.) in `IBM Plex Mono`.
  - Accessible via both the **1° Graticule Grid (Lat/Lon)** checkbox in `ControlSidebar` and the **Grid** button in the top-right `MapViewport` toolbar.

### Milestone 5 — 3D View Rotation & Geodesic Terrain Distance
- **Full 3D Camera Orbit & Rotation Controls (`MapViewport`)**:
  - Enabled native MapLibre rotation/tilt interactions (`dragRotate`, `pitchWithRotate`, `touchZoomRotate`, `touchPitch`, `keyboard`).
  - Added a **Pan / Orbit Drag Mode** toggle in the top-right toolbar (`Orbit` mode enables single left-click drag to rotate bearing and pitch without modifier keys; `Shift`/`Alt` + left-drag and right-click drag also work at any time).
  - Made the **3D Orientation Compass** directly draggable to smoothly orbit bearing and tilt pitch, alongside dedicated **Rotate Counter-Clockwise 45°**, **Rotate Clockwise 45°**, **Align North**, **Toggle 2D / 3D Tilt**, and **Reset Region (`RST`)** controls.
- **3D Geodesic & Terrain-Aware Distance Tool (`src/utils/geodesic.ts` + `POST /api/elevation/distance`)**:
  - Added `activeTool: 'measure-distance'`, triggered from either **Measure 3D Distance** in `ControlSidebar` or the top-right viewport toolbar.
  - Clicking **Point A** and **Point B** draws a live great-circle preview arc, computes the WGS84 ellipsoidal geodesic distance and initial bearing (`A → B`) via Vincenty's inverse formula (`sampleGreatCircle` with spherical slerp), and queries OpenTopoData `srtm30m` and `aster30m` elevations (`12–80` samples) to integrate $\sum \sqrt{\Delta d^2 + \Delta h^2}$ terrain surface distances.
  - Displays a floating **Geodesic & Terrain Distance** HUD card showing WGS84 Geodesic, Initial Bearing, 3D Surface (SRTM & ASTER) with `+relief %`, Endpoint Elevations (`A → B`), cumulative Ascent / Descent, and Max Grade `%`.

### Milestone 6 — Opt-In 3D Drone Flight Zone Mesh & Airspace Inspector
- **Shared Airspace Modeling Engine (`src/utils/droneAirspace.ts`)**:
  - Samples a `72×72` bilinearly interpolated grid centered on the camera's true focal point (`map.getCenter()`) directly from decoded AWS Terrarium DEM tiles (`fetchDecodedDemTile`, with lower-zoom fallback) and captures Overture 3D building footprints (`querySourceFeatures` on `overture-buildings` `building`/`building_part` combined with `queryRenderedFeatures` + `idle` fallback, sorted tallest-first).
  - Synthesizes a **Composite Obstacle Envelope** using conservative half-cell-diagonal + 4-corner quad-cell expansion anchored to the maximum terrain elevation beneath each footprint (`bTerrainMax + heightMeters + verticalBufferMeters`, with Euclidean `horizontalBufferMeters` dilation) so no buildings protrude through the lower obstacle mesh even across dense urban blocks or sloped terrain.
  - Renders a **Safe Flight Ceiling Surface** selectable in **AGL** (terrain-following) or **MSL** (flat datum) meters, evaluates net vertical clearance (`ceilingElev − envelopeElev`) and AOI breach percentages, and computes obstacle-aware clickable multi-waypoint flight corridors (`analyzeDroneCorridor` returning `safeFlightMeters = max(ceilingMeters, envelopeMeters + 5)`, `maxSafeFlightMeters`, and `'CLEAR' | 'CAUTION' | 'VIOLATION'` telemetry).
- **Strictly Opt-In Dual Rendering Architecture**:
  - Disabled by default (`DEFAULT_DRONE_ZONE_CONFIG.enabled = false`) and controllable via TopBar button, sidebar switch, top-right viewport toggle button, and independent checkboxes/selectors for **Live Map 3D Mesh Overlay**, **Obstacle Envelope Surface**, **Safe Flight Ceiling Surface**, **3D Wireframe Grid**, **Obstacle-Aware Corridor Climb** (`autoClimbCorridor`), **AGL/MSL** mode, buffer/opacity sliders, and **Plan Flight Corridor** (`activeTool: 'drone-corridor'`).
  - **Live MapLibre WebGL2 Overlay (`src/utils/maplibreDroneMeshLayer.ts`)**: `MapLibreDroneMeshLayer` (`CustomLayerInterface`, `renderingMode: '3d'`) attaches on `style.load`, uses `Uint32Array` index batches and dedicated VAOs with `Float32Array` projection uniforms (`projectTileFor3D`) for **3D Globe** and **Mercator** projections, clamps envelope vertices above exaggerated building roofs across slopes, logs buffer vertex coordinates/ranges, and renders 3D extruded building safety-buffer prisms, 3D perimeter airspace curtains, composite obstacle envelope mesh, safe flight ceiling canopy, and elevated 3D flight corridor + safe climb paths (`Teal` Safe, `Amber` Caution `<15m`, `Rose` Breach `<0m`, `Emerald` Safe Climb).
  - **Dedicated Three.js 3D Airspace Mesh Inspector (`src/components/DroneMeshInspector.tsx`)**: Interactive Three.js scene projected directly from MapLibre's `MercatorCoordinate` origin (`grid.center`) with a single unified vertical scale (`sceneScale * max(1.8, exaggeration)`), bilinear terrain seating for Overture buildings, `RoomEnvironment` IBL, 3-point studio lighting, terrain skirt specimen, switchable **Structure** vs. **Clearance Heatmap** visualization mode (continuous 5-stop proximity-to-obstacle color ramp across terrain vertices, extruded buildings, obstacle envelope, and blocked voxels with calibrated gradient scale key), **color-coded 3D blocked-cell visual indicators** (`THREE.InstancedMesh` obstructed airspace voxels + red/amber-tinted terrain grid cells, borders, and vertex tinting distinguishing direct Overture building footprints, ceiling breaches, and horizontal buffer zones, toggleable via **Blocked Voxels** with header/KPI counts), translucent obstacle envelope + wireframe, translucent flight ceiling + wireframe, AOI corner boundary pillars, 3D flight corridor & safe-climb tubes + waypoint pylons, subtle cubic ease-out opacity fade-in transitions when the grid is resampled, updated, or mode-switched (`prefers-reduced-motion` and software-WebGL paced), inverse-Mercator raycaster cursor inspection (with `BLOCKED CELL` / `BUFFER ZONE` / `CLEAR CELL` status badge), structured vertex buffer debug logging, and a collapsible bottom control dock.

---

## 3. System Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Browser Client (React 19 + Vite)                     │
│                                                                              │
│  TopBar (Presets · Opt-In 3D Drone Mesh Toggle · 3D Inspector · Snapshot)     │
│  ├── ControlSidebar (Geocode Search · Projection · 1° Graticule · DEM Modes  │
│  │                   Solar Azimuth · Overture Layers · Profile · 3D Distance │
│  │                   Viewport Δh Discrepancy · Opt-In Drone 3D Mesh Controls)│
│  ├── MapViewport (MapLibre GL JS 3D Globe/Terrain · PMTiles · dem-analysis://│
│  │                MapLibreDroneMeshLayer · Drone Corridor GeoJSON & HUD      │
│  │                geodesic.ts · Draggable 3D Compass · Orbit/Rotate Controls)│
│  ├── DroneMeshInspector (Three.js 3D Terrain/Building/Envelope/Ceiling View) │
│  ├── FeatureInspector (Overture GERS ID · Schema Attributes · Provenance)    │
│  └── TelemetryTray (Recharts SRTM/ASTER Terrain Profile · Δh Histogram · CSV)│
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        │ /api/*
                                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Express Server (server.ts on Port 3000)                  │
│  · GET  /api/health                  ──► Service health check                │
│  · GET  /api/overture/config         ──► Overture STAC latest release lookup │
│  · GET  /api/tiles/terrarium/:z/:x/:y.png ──► AWS elevation-tiles-prod proxy │
│  · POST /api/elevation/profile       ──► OpenTopoData srtm30m + aster30m     │
│  · POST /api/elevation/distance      ──► WGS84 + SRTM/ASTER 3D surface dist  │
│  · POST /api/elevation/diff-grid     ──► OpenTopoData 9×9 bbox grid          │
│  · GET  /api/geocode                 ──► Open-Meteo Geocoding proxy          │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Implemented Data Types & Design Tokens
- **Core State Types (`src/types/geospatial.ts`)**:
  - `TerrainMode`: `'hypsometric' | 'slope' | 'aspect' | 'natural'`
  - `ElevationRampPreset`: `'scientific-terrain' | 'alpine-monochrome' | 'high-contrast'`
  - `ActiveTool`: `'inspect' | 'profile-draw' | 'measure-distance' | 'drone-corridor'`
  - `ProjectionMode`: `'globe' | 'mercator'`
  - `DroneZoneConfig`: `{ enabled, showMapOverlay, showInspectorModal, showEnvelopeMesh, showCeilingMesh, showWireframe, autoClimbCorridor, altitudeMode: 'agl' | 'msl', ceilingMeters, verticalBufferMeters, horizontalBufferMeters, envelopeOpacity, ceilingOpacity }`
  - `DroneAirspaceGrid` & `DroneCorridorAnalysis`: `72×72` bilinear Float32Array terrain/envelope/ceiling/clearance matrices and waypoint segment clearance + `safeFlightMeters` obstacle-aware climb telemetry
  - `DistanceMeasurementResult`: `{ pointA, pointB, geodesicMeters, initialBearingDeg, surfaceSrtmMeters, surfaceAsterMeters, elevASrtm, elevBSrtm, elevAAster, elevBAster, ascentSrtmMeters, descentSrtmMeters, maxGradePct, sampleCount, loading, error }`
- **Theme**: Clean minimalist scientific explorer (`#F8FAFC` / `#FFFFFF` clinical canvas, `#E2E8F0` `1px` hairline borders, `#0F172A` slate ink).
- **Accents**: Cobalt `#2563EB` (primary actions, NASA SRTM series, North needle, Equator/PM), Amber `#D97706` (ASTER GDEM series, solar controls), Cyan `#0891B2` (Overture structures & 3D distance arc).
- **Typography**: `Plus Jakarta Sans` for UI labels + `IBM Plex Mono` (`tabular-nums`) for coordinates, heading/pitch, distances, elevation, slope, and GERS IDs.

