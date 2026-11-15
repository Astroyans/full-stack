# Martian Map & Rover Telemetry Dashboard (Full-Stack)

Plataforma táctica de telemetría, visualización de terreno y cálculo de rutas seguras para operaciones en Marte. Integra visión por computadora, matrices topográficas de profundidad y trazado de rutas en tiempo real mediante comunicación bidireccional.

---

## 1. Arquitectura de Comunicación Dual-Port

El sistema separa el tráfico en dos puertos dedicados para garantizar baja latencia y evitar la saturación de los canales de control:

* **Puerto de Salida (Lectura / Dashboard) — `:8765`**:
  * Protocolo: WebSocket (`ws://<IP>:8765`) y HTTP GET.
  * Consumidores: Dashboard Web (`apps/web`) y aplicación iPad (`apps/ipad`).
  * Función: Difusión continua (*broadcast*) del estado global, imágenes tácticas y telemetría hacia las interfaces visuales.

* **Puerto de Entrada (Ingesta / Sensores y Cálculo Externo) — `:8766`**:
  * Protocolo: WebSocket (`ws://<IP>:8766`) y HTTP POST (`http://<IP>:8766/api/ingest`).
  * Emisores: Sensores periféricos (Raspberry Pi, RealSense D415, ESP32, Algoritmos de visión externos).
  * Función: Ingesta de paquetes JSON, transmisión de imágenes base64 y recepción de solicitudes de ruta.

---

## 2. Especificación de Datos Entrantes (Desde el Lado Externo)

La carga útil recibida por el Dashboard sigue el estándar validado en `latest_drone_cv.json` y `latest_expo_payload.json`:

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

### Detalle de Campos Clave:

### A. Imágenes Requeridas (`images`)
1. **`rgb`**: Stream o snapshot RGB de la cámara táctica en formato JPEG Base64 (`data:image/jpeg;base64,...`).
2. **`depth`**: Matriz de distancias / mapa de profundidad topográfico procesado en escala de color o niveles de gris.
3. **`route_map`**: Mapa general / global persistente del terreno y área de operación.

### B. Información de Telemetría y Altura (`data`)
* **`altitude_m`**: Altura actual del dron / sensor sobre el terreno expresada en **METROS** (ej. `0.24` m).
* **`imu`**: Orientación angular en grados (`yaw`, `pitch`, `roll`).
* **`max_incline_deg`**: Inclinación / pendiente máxima detectada en el terreno en grados.
* **`safe_corridor`**: Booleano que indica si el corredor de avance inmediato es seguro (`true`) o requiere evasión (`false`).
* **`obstacles`**: Lista de obstáculos detectados con distancias (`distance_m`), alturas (`height_m`) y profundidades (`depth_m`) en **METROS**.
* **`rover_pose`**: Posición estimada del rover en **METROS** (`x_m`, `y_m`, `traversed_distance_m`).

---

## 3. Protocolo de Marcado de Ruta Interactivo (En METROS)

> **Regla de Coordenadas:**  
> **Todas las coordenadas enviadas y recibidas para el trazado de rutas se expresan estrictamente en METROS (`x_m`, `y_m`)**, referenciadas al sistema de coordenadas métrico cartesiano del rover/misión (donde el eje X representa desplazamiento lateral y el eje Y representa avance longitudinal).

### Flujo de Interacción:
1. **Selección del objetivo**: El usuario hace clic en el mapa táctico o en la vista del sensor.
2. **Cálculo de coordenadas**: El Dashboard convierte la posición del clic a coordenadas reales en **metros**:
   $$\text{target\_x\_m} = \text{relX} \times \text{widthMeters}$$
   $$\text{target\_y\_m} = \text{relY} \times \text{heightMeters}$$
3. **Petición al servicio externo**: El Dashboard envía el punto de destino solicitado al servicio externo:

   **Payload de Solicitud (Dashboard $\rightarrow$ Servicio Externo):**
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

4. **Respuesta del servicio externo**: El servicio externo calcula la ruta (mediante A*, Dijkstra u optimizador de trayectorias) evitando obstáculos y responde con la lista de waypoints en **metros**:

   **Payload de Respuesta (Servicio Externo $\rightarrow$ Dashboard):**
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

5. **Visualización en el Dashboard**: El Dashboard dibuja de inmediato los waypoints `route_waypoints_xy_m` sobre el canvas del mapa, traza el corredor de seguridad, actualiza la gráfica de elevación y muestra las métricas de navegación.

---

## 4. Ejecución del Proyecto

### Requisitos Previos:
* Node.js v18+ y `pnpm`
* Python 3.9+ (para el servidor `mock_backbone.py`)

### Pasos:

1. **Instalar dependencias:**
   ```bash
   pnpm install
   ```

2. **Iniciar el servidor Backbone / Mock:**
   ```bash
   python3 mock_backbone.py
   ```
   * *Puerto 8765:* Servidor de salida hacia el Dashboard Web.
   * *Puerto 8766:* Servidor de ingesta para sensores y cálculo de rutas.

3. **Iniciar el Dashboard Web:**
   ```bash
   pnpm --filter @martian/web dev
   ```
   Abre tu navegador en `http://localhost:5173`.
