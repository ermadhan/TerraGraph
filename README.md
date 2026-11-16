# TerraGraph

An interactive 3D scientific geospatial explorer combining **NASA SRTM 30m** and **NASA/METI ASTER GDEM 30m** global elevation models with **Overture Maps** man-made structures (3D extruded buildings, roads, rail, hydrology, and civil infrastructure).

## Key Features
- **3D Globe & Terrain Mesh**: Switch seamlessly between 3D Globe and Mercator projections with adjustable vertical terrain exaggeration (`0.5×`–`4.0×`, default `1.8×`), live cursor elevation/slope/aspect telemetry, and PNG snapshot export.
- **Real-Time Terrain Shaders**: Client-side Terrarium elevation decoder rendering **Hypsometric Elevation Bands**, **Slope Steepness (`0°–70°`)**, **Aspect Compass Bearing (`0°–360°`)**, and **Natural Relief** alongside interactive **Solar Azimuth & Hillshade** controls.
- **Overture Maps Vector Streaming**: Streams official Overture Maps PMTiles (`buildings`, `transportation`, `base`) directly from AWS S3 — draping `land_cover`, `land_use`, `water`, `infrastructure`, and `segment` roads onto the 3D terrain mesh and seating 3D extruded buildings at true ground elevation with an interactive **Attribute & Provenance Inspector**.
- **SRTM 30m vs. ASTER 30m Analysis**:
  - **Cross-Section Profiler**: Draw multi-point transects across terrain to plot an interactive **Recharts** terrain elevation profile (`SRTM 30m` area + `ASTER 30m` comparison curve, series toggles, coordinate tooltip), synchronized 3D cursor scrubbing, RMSE/mean bias stats, and CSV export.
  - **3D Geodesic & Terrain Distance**: Click two points (`A` & `B`) to compute the WGS84 ellipsoidal geodesic distance, initial bearing, SRTM 30m & ASTER 30m terrain-integrated 3D surface distances (`+relief %`), endpoint elevations, ascent/descent, and max grade.
  - **Viewport Discrepancy Grid**: Compute a `9×9` `ASTER − SRTM` elevation residual grid rendered as a diverging Coolwarm heatmap overlay with a 7-bin residual histogram.
- **3D Navigation & Spatial Orientation Instruments**: Includes full 3D orbit/rotation controls (**Pan/Orbit** left-drag mode toggle, `Shift`/`Alt`+drag, right-click drag, `±45°` rotate buttons), a draggable **3D Orientation Compass** (tilting and rotating with live camera pitch and bearing), and a togglable **1° Geographic Graticule** with projected edge coordinate tick labels.
- **Opt-In 3D Drone Flight Zone Mesh**: Toggleable 3D airspace modeling (`72×72` conservative obstacle envelope anchored to bilinear Terrarium DEM terrain + Overture 3D building footprints + horizontal/vertical safety buffers) with 3D AOI perimeter curtains, selectable **AGL / MSL** flight ceiling meshes, wireframe & opacity controls, MapLibre Mercator-origin-aligned WebGL2 overlay + **Three.js 3D Airspace Mesh Inspector** featuring switchable **Structure** and **Clearance Heatmap** visualization modes, toggleable color-coded 3D blocked-cell voxels, red-tinted terrain grid cells/borders for Overture building obstructions, and smooth fade-in transitions on grid updates, plus clickable multi-waypoint flight corridors with obstacle-aware safe climb trajectories and violation analysis.

---

## Windows Setup Instructions

### 1. Prerequisites
1. **Node.js (v22.14.0 or newer recommended)**:
   - Download and install the **LTS / v22+** Windows Installer (`.msi`) from [https://nodejs.org/](https://nodejs.org/).
   - Node.js v22+ is required so `node server.ts` can execute TypeScript directly in production mode, and `npm` is included automatically.
2. **Git for Windows** *(optional, if cloning)*:
   - Download from [https://git-scm.com/download/win](https://git-scm.com/download/win).
3. **Internet Access & WebGL2 Browser**:
   - Required to stream live AWS Terrarium DEM tiles, Overture Maps PMTiles, OpenTopoData elevation endpoints, and Open-Meteo geocoding results.
   - Use an up-to-date Chromium-based browser (Edge, Chrome) or Firefox with hardware acceleration / WebGL2 enabled.

Verify your installation in **PowerShell** or **Command Prompt (`cmd.exe`)**:
```powershell
node -v
npm -v
```

---

### 2. Install Dependencies
Open **PowerShell** in the project root folder (`terragraph`) and run:
```powershell
npm install
```

---

### 3. Environment Configuration
Create a `.env` file in the project root by copying `.env.example`:

**PowerShell:**
```powershell
Copy-Item .env.example .env
```

**Command Prompt (`cmd.exe`):**
```bat
copy .env.example .env
```

*(Note: Core geospatial features—AWS Terrarium elevation tiles, Overture Maps PMTiles, OpenTopoData SRTM/ASTER queries, and Open-Meteo geocoding—use public open endpoints and do **not** require a paid map API key. `PORT` defaults to `3000` if omitted.)*

---

### 4. Run in Development Mode (Windows)
Start the Express backend + Vite dev middleware on port `3000`:
```powershell
npm run dev
```
Then open your browser to:
```text
http://localhost:3000
```

---

### 5. Build & Run in Production Mode (Windows)
1. **Type-check and build the frontend bundle (`dist/`)**:
   ```powershell
   npm run lint
   npm run build
   ```
2. **Start the production server**:

   **In PowerShell:**
   ```powershell
   $env:NODE_ENV="production"
   npm start
   ```

   **In Command Prompt (`cmd.exe`):**
   ```bat
   set NODE_ENV=production && npm start
   ```

   *(If your Windows Node.js build predates native `.ts` stripping, run `npx tsx server.ts` instead of `npm start`.)*

---

## Windows Troubleshooting
- **PowerShell Execution Policy Error (`npm.ps1 cannot be loaded because running scripts is disabled`)**:
  Run the following once in PowerShell for your user account, or use `cmd.exe`:
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
  ```
- **Port `3000` Already in Use**:
  Set a different port before starting:
  ```powershell
  $env:PORT=3005; npm run dev
  ```
- **Windows Defender / Corporate Proxy**:
  Ensure outbound HTTPS (`443`) is allowed to `s3.amazonaws.com`, `overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com`, `stac.overturemaps.org`, `api.opentopodata.org`, and `geocoding-api.open-meteo.com`.
- **OpenTopoData Rate Limits**:
  The free public OpenTopoData API allows 1 request/second and 1,000 calls/day. TerraGraph's Express backend automatically paces requests (`1.08s` interval) and caches responses in memory.

---

## Project Scripts & API Endpoints

### NPM Scripts
| Script | Purpose |
| :--- | :--- |
| `npm run dev` | Starts Express + Vite dev middleware via `tsx server.ts` on port `3000` |
| `npm run build` | Builds the production Vite bundle into `dist/` |
| `npm start` | Runs `node server.ts` (serves `dist/` when `NODE_ENV=production`) |
| `npm run lint` | Runs TypeScript static type-checking (`tsc --noEmit`) |

### Backend Routes (`server.ts`)
| Method & Path | Purpose |
| :--- | :--- |
| `GET /api/health` | Service health check |
| `GET /api/overture/config` | Resolves latest Overture Maps PMTiles release from STAC |
| `GET /api/tiles/terrarium/:z/:x/:y.png` | Cached proxy for AWS `elevation-tiles-prod` Terrarium DEM tiles |
| `POST /api/elevation/profile` | Samples `srtm30m` and `aster30m` along a transect polyline |
| `POST /api/elevation/distance` | Computes WGS84 geodesic and SRTM/ASTER 3D terrain surface distances between two points |
| `POST /api/elevation/diff-grid` | Computes a `9×9` `ASTER − SRTM` elevation difference grid |
| `GET /api/geocode?q=...` | Geocoding place search proxy via Open-Meteo |
