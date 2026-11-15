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
  - Streams global 24-bit Terrarium elevation PNGs from AWS `elevation-tiles-prod` via `/api/tiles/terrarium/:z/:x/:y.png` (LRU-cached in Express to avoid CORS canvas tainting).
  - Supports vertical exaggeration (`0.5×`–`3.0×`), sky atmosphere blending, and PNG canvas snapshot export (`preserveDrawingBuffer: true`).
- **Overture Maps Vector Streaming (`ControlSidebar` + `FeatureInspector`)**:
  - Express dynamically resolves the latest monthly Overture release from `https://stac.overturemaps.org/catalog.json` (with `2026-10-21.0` fallback) via `GET /api/overture/config`.
  - Streams `buildings.pmtiles`, `transportation.pmtiles`, and `base.pmtiles` directly from AWS S3 via the `pmtiles://` protocol.
  - Extrudes `building` and `building_part` layers in 3D (supporting Architectural Slate and Height Spectrum coloring) alongside roads, rail, hydrology, and civil infrastructure.
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
  - Renders a dual-series SVG chart (`SRTM 30m` solid cobalt vs. `ASTER 30m` dashed amber), synchronized 3D transect hover marker, RMSE, Mean Bias, Max `|Δh|`, total gain, and CSV download.
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

---

## 3. System Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Browser Client (React 19 + Vite)                     │
│                                                                              │
│  TopBar (Presets & Snapshot)                                                 │
│  ├── ControlSidebar (Geocode Search · Projection · 1° Graticule · DEM Modes  │
│  │                   Solar Azimuth · Overture Layers · Profile & Δh Grid)    │
│  ├── MapViewport (MapLibre GL JS 3D Globe/Terrain · PMTiles · dem-analysis://│
│  │                3D Orientation Compass · 1° Graticule · Corner HUDs)       │
│  ├── FeatureInspector (Overture GERS ID · Schema Attributes · Provenance)    │
│  └── TelemetryTray (SRTM vs ASTER SVG Profile · Δh Histogram · CSV Export)   │
└───────────────────────────────────────┬──────────────────────────────────────┘
                                        │ /api/*
                                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Express Server (server.ts on Port 3000)                  │
│  · GET  /api/overture/config         ──► Overture STAC latest release lookup │
│  · GET  /api/tiles/terrarium/:z/:x/:y.png ──► AWS elevation-tiles-prod proxy │
│  · POST /api/elevation/profile       ──► OpenTopoData srtm30m + aster30m     │
│  · POST /api/elevation/diff-grid     ──► OpenTopoData 9×9 bbox grid          │
│  · GET  /api/geocode                 ──► Open-Meteo Geocoding proxy          │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Visual & UX Design Tokens
- **Theme**: Clean minimalist scientific explorer (`#F8FAFC` / `#FFFFFF` clinical canvas, `#E2E8F0` `1px` hairline borders, `#0F172A` slate ink).
- **Accents**: Cobalt `#2563EB` (primary actions, NASA SRTM series, North needle, Equator/PM), Amber `#D97706` (ASTER GDEM series, solar controls), Cyan `#0891B2` (Overture structures & selection).
- **Typography**: `Plus Jakarta Sans` for UI labels + `IBM Plex Mono` (`tabular-nums`) for coordinates, heading/pitch, elevation, slope, and GERS IDs.
