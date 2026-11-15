# ARES-IV Martian Map & Rover Telemetry Dashboard (Full-Stack)

**NASA Space Apps Challenge 2026 — *Interplanetary Survival Guide: Martian Map*** (Team **Astroyans**).

Tactical surface telemetry, planetary terrain visualization, and autonomous safe-route planning platform for human Marswalks in **Dollfus Crater (`21.8° S, 4.3° W`)**. Integrates orbital NASA imagery, real-time RGB-D computer vision, elevation/slope hazard grids, unexplored-quadrant scout drone dispatch, and bidirectional route planning across Mission Control Web (`apps/web`) and Astronaut iPad (`apps/ipad`) interfaces.

---

## 1. NASA Data & Planetary Integration

* **NASA JPL Mars Trek WMTS (`trek.nasa.gov`):**
  * **Viking Color Mosaic** (`Mars_Viking_MDIM21_ClrMosaic_global_232m`, equirectangular up to native zoom `z=7`) for wide orbital context (up to 250 km span).
  * **THEMIS Day IR Controlled Mosaic** (`THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018`, equirectangular up to native zoom `z=9`) blended smoothly at closer tactical zoom levels.
* **NASA JPL AI4Mars Terrain Taxonomy:** Semantic traversability cost weighting across `soil`, `bedrock`, `sand`, and `big_rock` surface classes.
* **MGS MOLA & MRO HiRISE Topographic Modeling:** Crater rim/escarpment hazard detection (`OpenCV` HoughCircles, Canny + morphological closing, and SAM masks), slope calculations (`slopeDeg` / `max_incline_deg`), and route elevation profiles.

---

## 2. Dual-Port Communication Architecture

The system isolates telemetry broadcast from sensor ingestion so high-rate RGB-D/vision packets never block tactical map updates:

* **Outbound Port (Read / Dashboards) — `:8765`**
  * **Protocols:** WebSocket (`ws://<IP>:8765`) and HTTP `GET`.
  * **Consumers:** Web Mission Control (`apps/web`) and Astronaut iPad app (`apps/ipad`).
  * **Role:** Continuous broadcast of global state, telemetry metrics, route waypoints, and base64 visual feeds (`rgb`, `depth`, `route_map`).

* **Inbound Port (Sensor Ingestion & External Route Computation) — `:8766`**
  * **Protocols:** WebSocket (`ws://<IP>:8766`) and HTTP `POST` (`http://<IP>:8766/api/ingest`).
  * **Producers:** Raspberry Pi 3 + Intel RealSense D415 (`sturdy-couscous` / `Dron`), ESP32 mesh gateway (`Config-ESP32`), and vision pipelines.
  * **Role:** High-frequency ingestion of JSON telemetry payloads, base64 sensor images, and interactive route computation requests.

---

## 3. Incoming Data Specification (External Telemetry Payload)

Payloads consumed by the dashboard follow the validated schema in `apps/web/public/data/latest_drone_cv.json` and `latest_expo_payload.json`:

```json
{
  "node": "drone_cv",
  "timestamp": 1794684046,
  "data": {
    "altitude_m": 0.24,
    "imu": {
      "yaw": 0.0,
      "pitch": 31.3,
      "roll": -3.7
    },
    "max_incline_deg": 32.2,
    "safe_corridor": false,
    "edge_fps": 2.4,
    "obstacles": [
      {
        "id": 1,
        "type": "BOULDER",
        "distance_m": 0.39,
        "bearing_deg": -29.0,
        "height_m": 0.48
      },
      {
        "id": 2,
        "type": "CREVICE",
        "distance_m": 0.48,
        "bearing_deg": 1.1,
        "depth_m": 0.39
      }
    ],
    "navigation": {
      "mode": "EXPLORE_FORWARD",
      "active_planner": "astar",
      "recommended_heading_deg": 0.0,
      "rover_pose": {
        "x_m": 0.25,
        "y_m": -0.05,
        "yaw_deg": 0.0,
        "traversed_distance_m": 1.08
      },
      "explored_area_m2": 4.12,
      "grid_shape": [120, 80],
      "route_waypoints_xy_m": [
        [0.02, 0.03],
        [0.08, 0.03],
        [0.12, 0.08]
      ]
    }
  },
  "images": {
    "format": "jpeg_base64",
    "width": 640,
    "height": 480,
    "rgb": "data:image/jpeg;base64,...",
    "depth": "data:image/jpeg;base64,...",
    "route_map": "data:image/jpeg;base64,..."
  }
}
```

### Key Field Reference

#### A. Visual Feeds (`images`)
1. **`rgb`**: Live RGB snapshot from the aerial tactical camera encoded as JPEG Base64 (`data:image/jpeg;base64,...`).
2. **`depth`**: Processed topographic depth matrix in colorized/grayscale form.
3. **`route_map`**: Persistent global occupancy and A* / Dijkstra planned path visualization.

#### B. Telemetry & Spatial Navigation (`data`)
* **`altitude_m`**: Drone/sensor altitude above the Martian surface in **meters**.
* **`imu`**: Angular orientation in degrees (`yaw`, `pitch`, `roll`).
* **`max_incline_deg`**: Maximum detected terrain slope angle in degrees.
* **`safe_corridor`**: Boolean indicating whether the immediate forward path is safe (`true`) or requires obstacle avoidance (`false`).
* **`obstacles`**: Detected 3D hazards (`BOULDER`, `CREVICE`) with `distance_m`, `bearing_deg`, `height_m`, and `depth_m` in **meters**.
* **`rover_pose`**: Estimated explorer/rover position in **meters** (`x_m`, `y_m`, `traversed_distance_m`).

---

## 4. Interactive Route Planning Protocol (Metric Coordinates)

> **Coordinate Rule:**
> **All route planning requests and responses strictly use metric Cartesian coordinates (`x_m`, `y_m`)** referenced to the rover/mission local coordinate frame.

### Interaction Flow
1. **Destination Selection:** The astronaut or operator clicks a target point on the tactical 2D map (or dispatches the drone to an unexplored quadrant such as `Q-NE` or `Q-SE`).
2. **Coordinate Projection:** The dashboard converts the click location into mission metric coordinates:
   $$\text{target\_x\_m} = \text{relX} \times \text{widthMeters}$$
   $$\text{target\_y\_m} = \text{relY} \times \text{heightMeters}$$
3. **Route Request (`Dashboard -> Backend`):**

   ```json
   {
     "action": "request_route",
     "unit": "meters",
     "target": {
       "x_m": 1.25,
       "y_m": 3.40
     },
     "origin": {
       "x_m": 0.25,
       "y_m": -0.05
     }
   }
   ```

4. **Route Response (`Backend -> Dashboard`):** The path planner (`sturdy-couscous`) runs A* / Dijkstra over the persistent terrain grid and returns obstacle-free waypoints in **meters**:

   ```json
   {
     "status": "ok",
     "navigation": {
       "active_planner": "astar",
       "unit": "meters",
       "route_waypoints_xy_m": [
         [0.25, -0.05],
         [0.38, 0.45],
         [0.72, 1.20],
         [1.05, 2.30],
         [1.25, 3.40]
       ],
       "total_distance_m": 3.65,
       "estimated_time_s": 24.5
     }
   }
   ```

5. **Real-Time Rendering:** The dashboard draws `route_waypoints_xy_m`, updates the safety corridor and elevation profile graph, tracks live drone recon sweeps, and persists scientific stops.

---

## 5. Running the Project

### Prerequisites
* Node.js 18+ with `npm` or `pnpm`
* Python 3.10+ (for live telemetry via [`sturdy-couscous`](https://github.com/Astroyans/sturdy-couscous) or `mock_backbone.py`)

### Steps

1. **Install dependencies:**
   ```bash
   npm install
   # or: pnpm install
   ```

2. **Start the telemetry & pathfinding backend:**
   * Using the full real-time pipeline (`sturdy-couscous`):
     ```bash
     python main_expo.py --source raspi3 --raspi-port 8766
     ```
   * Or using the local mock server:
     ```bash
     python mock_backbone.py
     ```
   * *Port `8765`:* Outbound HTTP/WebSocket server for Web & iPad clients.
   * *Port `8766`:* Inbound ingestion port for Raspberry Pi 3 / RealSense D415 streams.

3. **Start the Web Dashboard:**
   ```bash
   npm --prefix apps/web run dev -- --host 0.0.0.0
   # or: pnpm --filter @martian/web dev
   ```
   Open `http://localhost:3000/` (or `http://localhost:5173/` depending on Vite config).

---

## 6. Related Astroyans Repositories

* **Computer Vision, Log-Odds Mapping & Path Planning:** [Astroyans/sturdy-couscous](https://github.com/Astroyans/sturdy-couscous)
* **Rust Telemetry & ToF Streaming Link (`nodo_dron` / `estacion_tierra`):** [Astroyans/Dron](https://github.com/Astroyans/Dron)
* **ESP32 Mesh & MicroSD Route Backup Firmware:** [Astroyans/Config-ESP32](https://github.com/Astroyans/Config-ESP32)
