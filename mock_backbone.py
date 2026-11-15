#!/usr/bin/env python3
"""
Mock Backbone Server - NASA Space Apps: Martian Map (Dual-Port Architecture)
Separa el tráfico en dos puertos dedicados para evitar congestión de datos:
  - PUERTO DE SALIDA  (8765): Exclusivo para clientes de lectura (Dashboard Web / iPad) vía WS y HTTP GET.
  - PUERTO DE ENTRADA (8766): Exclusivo para ingesta de sensores (ESP32 / Raspberry Pi / D415) vía WS y HTTP POST.
"""

import asyncio
import base64
import hashlib
import json
import math
import os
import random
import struct
import time
import zipfile

OUTBOUND_PORT = 8765  # SALIDA: Servidor -> Clientes (Web / iPad)
INBOUND_PORT = 8766   # ENTRADA: Sensores (ESP32 / Raspberry Pi / D415) -> Servidor
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

outbound_clients = set()
inbound_sensors = set()
inbound_queue: asyncio.Queue = None  # Inicializada en main()


# Modo limpio: Sin carga inicial de frames simulados; solo se reciben y difunden paquetes reales
REAL_D415_FRAMES = []
CURRENT_FRAME_INDEX = 0
CURRENT_FRAME_INDEX = 0


def load_real_map_state():
    """
    Carga las matrices del mapa global (occupancy_grid, cost_grid, height_map_m, slope_map_deg)
    desde apps/web/public/data/real_map_state.json para servirlas por el puerto de SALIDA (8765).
    """
    base_dir = os.path.dirname(os.path.abspath(__file__))
    precomputed_path = os.path.join(base_dir, "apps", "web", "public", "data", "real_map_state.json")
    if os.path.exists(precomputed_path):
        try:
            with open(precomputed_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            print("[Map Server] Matrices reales (120x80 occupancy_grid + cost_grid) listas para servir")
            return data
        except Exception as e:
            print(f"[WARN] Error leyendo real_map_state.json: {e}")
    return None


def load_or_compute_opencv_craters():
    """
    Visión clásica (OpenCV): Canny + Morfología Matemática (Closing) + Transformada de Hough Circular.
    Detecta cráteres como círculos (cv2.HoughCircles) y bordes de escarpes (cv2.Canny + cv2.morphologyEx).
    Prototipo rápido sin entrenamiento previo.
    """
    base_dir = os.path.dirname(os.path.abspath(__file__))
    json_path = os.path.join(base_dir, "apps", "web", "public", "data", "opencv_craters.json")
    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            craters_n = len(data.get("craters_hough", []))
            escarp_n = len(data.get("escarpments_canny_morph", []))
            print(
                f"[OpenCV Classical Vision] Cargados {craters_n} cráteres (HoughCircles) y "
                f"{escarp_n} bordes de escarpes (Canny + Morfología)"
            )
            return data
        except Exception as e:
            print(f"[WARN] Error leyendo opencv_craters.json: {e}")
    return {"pipeline": "OpenCV Classical Vision", "craters_hough": [], "escarpments_canny_morph": []}


REAL_MAP_STATE = load_real_map_state()
OPENCV_CRATERS_DATA = load_or_compute_opencv_craters()
LATEST_INGESTED_PACKETS = {}


def send_http_json(writer, obj, status="200 OK"):
    body = json.dumps(obj).encode("utf-8")
    headers = (
        f"HTTP/1.1 {status}\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: *\r\n"
        "Connection: close\r\n\r\n"
    ).encode("latin1")
    writer.write(headers + body)


def create_ws_frame(message: str) -> bytes:
    payload = message.encode("utf-8")
    length = len(payload)
    if length <= 125:
        header = struct.pack("!BB", 0x81, length)
    elif length <= 65535:
        header = struct.pack("!BBH", 0x81, 126, length)
    else:
        header = struct.pack("!BBQ", 0x81, 127, length)
    return header + payload


async def read_ws_frame(reader):
    """Lee y desenmascara un frame WebSocket entrante según RFC 6455."""
    header = await reader.readexactly(2)
    b1, b2 = header[0], header[1]
    opcode = b1 & 0x0F
    masked = (b2 & 0x80) != 0
    payload_len = b2 & 0x7F

    if payload_len == 126:
        ext = await reader.readexactly(2)
        payload_len = struct.unpack("!H", ext)[0]
    elif payload_len == 127:
        ext = await reader.readexactly(8)
        payload_len = struct.unpack("!Q", ext)[0]

    mask_key = await reader.readexactly(4) if masked else None
    raw_payload = await reader.readexactly(payload_len) if payload_len > 0 else b""

    if masked and mask_key:
        unmasked = bytearray(payload_len)
        for i in range(payload_len):
            unmasked[i] = raw_payload[i] ^ mask_key[i % 4]
        raw_payload = bytes(unmasked)

    return opcode, raw_payload


def broadcast_to_outbound(packet: dict):
    """Envía un paquete inmediatamente por el PUERTO DE SALIDA (8765) a todos los clientes Web/iPad."""
    if not outbound_clients:
        return
    frame = create_ws_frame(json.dumps(packet))
    for client in list(outbound_clients):
        try:
            client.write(frame)
        except Exception:
            outbound_clients.discard(client)


def compute_route_waypoints(start_x: float, start_y: float, target_x: float, target_y: float, steps: int = 18):
    """
    Genera waypoints estrictamente en METROS [ [x_m, y_m], ... ]
    simulando la respuesta de un planificador A* con curvatura de evasión.
    """
    waypoints = []
    dx = target_x - start_x
    dy = target_y - start_y
    dist = math.hypot(dx, dy)
    for i in range(steps + 1):
        ratio = i / float(steps)
        base_x = start_x + dx * ratio
        base_y = start_y + dy * ratio
        arc = math.sin(ratio * math.pi) * 0.35
        if dist > 0.01:
            perp_x = -dy / dist * arc
            perp_y = dx / dist * arc
        else:
            perp_x = 0.0
            perp_y = 0.0
        waypoints.append([round(base_x + perp_x, 2), round(base_y + perp_y, 2)])
    return waypoints


ACTIVE_ROUTE_WAYPOINTS = None
HAS_EXTERNAL_SENSOR_CONNECTED = False


def save_received_packet_and_images(packet: dict):
    """
    Guarda automáticamente en data/recibidos/:
    - payload_<timestamp>.json y latest_received.json
    - rgb_<timestamp>.jpg y latest_rgb.jpg (si viene images.rgb)
    - depth_<timestamp>.jpg y latest_depth.jpg (si viene images.depth)
    - route_map_<timestamp>.jpg y latest_route_map.jpg (si viene images.route_map)
    """
    base_dir = os.path.dirname(os.path.abspath(__file__))
    recibidos_dir = os.path.join(base_dir, "data", "recibidos")
    os.makedirs(recibidos_dir, exist_ok=True)
    ts = int(time.time())

    # 1. Guardar JSON
    try:
        json_path = os.path.join(recibidos_dir, f"payload_{ts}.json")
        latest_json = os.path.join(recibidos_dir, "latest_received.json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(packet, f, indent=2)
        with open(latest_json, "w", encoding="utf-8") as f:
            json.dump(packet, f, indent=2)
    except Exception as e:
        print(f"[WARN] Error guardando JSON recibido: {e}")

    # 2. Guardar Imágenes Base64
    images = packet.get("images", {})
    saved_imgs = []
    if isinstance(images, dict):
        for img_key in ["rgb", "depth", "route_map"]:
            raw_b64 = images.get(img_key)
            if raw_b64 and isinstance(raw_b64, str):
                try:
                    if "," in raw_b64:
                        raw_b64 = raw_b64.split(",", 1)[1]
                    img_bytes = base64.b64decode(raw_b64)
                    fname = os.path.join(recibidos_dir, f"{img_key}_{ts}.jpg")
                    latest_fname = os.path.join(recibidos_dir, f"latest_{img_key}.jpg")
                    with open(fname, "wb") as f:
                        f.write(img_bytes)
                    with open(latest_fname, "wb") as f:
                        f.write(img_bytes)
                    saved_imgs.append(f"{img_key}.jpg")
                except Exception as e:
                    print(f"[WARN] Error guardando imagen {img_key}: {e}")

    imgs_info = f", imágenes: {', '.join(saved_imgs)}" if saved_imgs else ""
    print(f"\n>>> [ARCHIVOS GUARDADOS EN DISCO] en 'data/recibidos/' (JSON{imgs_info}) <<<")


# =====================================================================
# 1. SERVIDOR DE SALIDA (PUERTO 8765) -> Hacia Dashboard Web / iPad
# =====================================================================
async def handle_outbound_client(reader, writer):
    global ACTIVE_ROUTE_WAYPOINTS
    request = b""
    while True:
        line = await reader.readline()
        request += line
        if line == b"\r\n" or not line:
            break

    req_text = request.decode("latin1", errors="ignore")
    lines = req_text.split("\r\n")
    first_line = lines[0] if lines else ""
    parts = first_line.split(" ")
    method = parts[0] if len(parts) > 0 else "GET"
    path = parts[1].split("?")[0] if len(parts) > 1 else "/"

    headers = {}
    for line in lines[1:]:
        if ": " in line:
            k, v = line.split(": ", 1)
            headers[k.lower()] = v.strip()

    key = headers.get("sec-websocket-key")
    if not key:
        if method == "OPTIONS":
            send_http_json(writer, {"ok": True})
        elif path in ("/map_state.json", "/data/real_map_state.json", "/api/map-state"):
            send_http_json(writer, REAL_MAP_STATE or {})
        elif path in ("/opencv_craters.json", "/data/opencv_craters.json", "/api/opencv-craters"):
            send_http_json(writer, OPENCV_CRATERS_DATA or {})
        elif path in ("/latest_expo_payload.json", "/latest_drone_cv.json", "/api/d415-latest", "/"):
            if "drone_cv" in LATEST_INGESTED_PACKETS:
                payload_out = dict(LATEST_INGESTED_PACKETS["drone_cv"])
                send_http_json(writer, payload_out)
            else:
                send_http_json(writer, {"status": "waiting_for_sensor_data", "connected": False})
        else:
            send_http_json(
                writer,
                {
                    "status": "online",
                    "role": "OUTBOUND_STREAM_SERVER",
                    "outbound_port": OUTBOUND_PORT,
                    "inbound_port": INBOUND_PORT,
                    "connected_Viewers": len(outbound_clients),
                    "connected_Sensors": len(inbound_sensors),
                },
            )
        await writer.drain()
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return

    accept_val = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_val}\r\n\r\n"
    )
    writer.write(response.encode("latin1"))
    await writer.drain()

    addr = writer.get_extra_info("peername")
    print(f"[SALIDA :{OUTBOUND_PORT}] Cliente (Web/iPad) conectado desde: {addr}")
    outbound_clients.add(writer)

    if "drone_cv" in LATEST_INGESTED_PACKETS:
        init_packet = dict(LATEST_INGESTED_PACKETS["drone_cv"])
        try:
            writer.write(create_ws_frame(json.dumps(init_packet)))
            await writer.drain()
        except Exception:
            pass

    try:
        while True:
            opcode, payload_bytes = await read_ws_frame(reader)
            if opcode == 0x08:  # Close
                break
            if opcode == 0x09:  # Ping -> Pong
                writer.write(struct.pack("!BB", 0x8A, 0))
                await writer.drain()
                continue
            if opcode == 0x01 and payload_bytes:  # Mensaje entrante desde el Dashboard Web
                try:
                    msg = json.loads(payload_bytes.decode("utf-8"))
                    if msg.get("action") == "request_route" or "target" in msg:
                        target = msg.get("target", {})
                        tx = float(target.get("x_m", target.get("x", 0.0)))
                        ty = float(target.get("y_m", target.get("y", 0.0)))
                        print(f"[DASHBOARD LOCAL] Hiciste clic en destino ({tx}m, {ty}m). Esperando que el host externo calcule y envíe la ruta.")
                except Exception:
                    pass
    except Exception:
        pass
    finally:
        outbound_clients.discard(writer)
        print(f"[SALIDA :{OUTBOUND_PORT}] Cliente desconectado: {addr}")
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


# =====================================================================
# 2. SERVIDOR DE ENTRADA (PUERTO 8766) <- Desde ESP32 / Raspi / D415
# =====================================================================
async def handle_inbound_sensor(reader, writer):
    global REAL_MAP_STATE, ACTIVE_ROUTE_WAYPOINTS, HAS_EXTERNAL_SENSOR_CONNECTED
    request = b""
    while True:
        line = await reader.readline()
        request += line
        if line == b"\r\n" or not line:
            break

    req_text = request.decode("latin1", errors="ignore")
    lines = req_text.split("\r\n")
    first_line = lines[0] if lines else ""
    parts = first_line.split(" ")
    method = parts[0] if len(parts) > 0 else "GET"

    headers = {}
    for line in lines[1:]:
        if ": " in line:
            k, v = line.split(": ", 1)
            headers[k.lower()] = v.strip()

    key = headers.get("sec-websocket-key")
    if not key:
        if method == "OPTIONS":
            send_http_json(writer, {"ok": True})
        elif method == "POST":
            content_len = int(headers.get("content-length", "0") or "0")
            raw_body = await reader.readexactly(content_len) if content_len > 0 else b"{}"
            try:
                packet = json.loads(raw_body.decode("utf-8"))
                if packet.get("action") == "request_route" or "target" in packet:
                    target = packet.get("target", {})
                    tx = float(target.get("x_m", target.get("x", 1.5)))
                    ty = float(target.get("y_m", target.get("y", 3.0)))
                    origin = packet.get("origin", {})
                    ox = float(origin.get("x_m", origin.get("x", 0.25)))
                    oy = float(origin.get("y_m", origin.get("y", -0.05)))
                    waypoints = compute_route_waypoints(ox, oy, tx, ty)
                    ACTIVE_ROUTE_WAYPOINTS = waypoints

                    base_dp = LATEST_INGESTED_PACKETS.get("drone_cv")
                    if not base_dp:
                        if REAL_D415_FRAMES:
                            base_dp = dict(REAL_D415_FRAMES[CURRENT_FRAME_INDEX % len(REAL_D415_FRAMES)])
                        else:
                            base_dp = {"node": "drone_cv", "timestamp": int(time.time()), "data": {}}

                    dp = dict(base_dp)
                    if "data" not in dp or not isinstance(dp["data"], dict):
                        dp["data"] = {}
                    dp["data"] = dict(dp["data"])
                    nav = dict(dp["data"].get("navigation", {})) if isinstance(dp["data"].get("navigation"), dict) else {}
                    nav["route_waypoints_xy_m"] = waypoints
                    nav["active_planner"] = "astar"
                    dp["data"]["navigation"] = nav
                    dp["node"] = "drone_cv"
                    dp["node_id"] = "drone_cv"
                    dp["timestamp"] = int(time.time())
                    LATEST_INGESTED_PACKETS["drone_cv"] = dp
                    broadcast_to_outbound(dp)

                    send_http_json(
                        writer,
                        {"ok": True, "status": "ok", "unit": "meters", "waypoints": waypoints},
                    )
                    await writer.drain()
                    writer.close()
                    try:
                        await writer.wait_closed()
                    except Exception:
                        pass
                    return

                node_id = packet.get("node_id") or packet.get("node") or "external_sensor"
                LATEST_INGESTED_PACKETS[node_id] = packet
                HAS_EXTERNAL_SENSOR_CONNECTED = True
                save_received_packet_and_images(packet)
                if "map_state" in packet and isinstance(packet["map_state"], dict):
                    REAL_MAP_STATE = packet["map_state"]
                if inbound_queue is not None:
                    inbound_queue.put_nowait(packet)
                send_http_json(
                    writer,
                    {"ok": True, "ingested_node": node_id, "forwarded_to_port": OUTBOUND_PORT},
                )
            except Exception as e:
                send_http_json(writer, {"ok": False, "error": str(e)}, status="400 Bad Request")
        else:
            send_http_json(
                writer,
                {
                    "status": "online",
                    "role": "INBOUND_SENSOR_INGEST",
                    "inbound_port": INBOUND_PORT,
                    "forwards_to_outbound_port": OUTBOUND_PORT,
                    "usage": "Conecta tu ESP32/Raspi por WS a ws://<IP>:8766 o envía HTTP POST a http://<IP>:8766/api/ingest",
                },
            )
        await writer.drain()
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return

    accept_val = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_val}\r\n\r\n"
    )
    writer.write(response.encode("latin1"))
    await writer.drain()

    addr = writer.get_extra_info("peername")
    print(f"[ENTRADA :{INBOUND_PORT}] Sensor (ESP32/Raspi/D415) conectado desde: {addr}")
    inbound_sensors.add(writer)

    try:
        while True:
            opcode, payload_bytes = await read_ws_frame(reader)
            if opcode == 0x08:  # Close
                break
            if opcode == 0x09:  # Ping -> Pong
                writer.write(struct.pack("!BB", 0x8A, 0))
                await writer.drain()
                continue
            if opcode == 0x01 and payload_bytes:  # Text Frame JSON
                try:
                    packet = json.loads(payload_bytes.decode("utf-8"))
                    node_id = packet.get("node_id") or packet.get("node") or "external_sensor"
                    LATEST_INGESTED_PACKETS[node_id] = packet
                    HAS_EXTERNAL_SENSOR_CONNECTED = True
                    save_received_packet_and_images(packet)
                    if "map_state" in packet and isinstance(packet["map_state"], dict):
                        REAL_MAP_STATE = packet["map_state"]
                    if inbound_queue is not None:
                        inbound_queue.put_nowait(packet)
                except Exception as e:
                    print(f"[WARN] [ENTRADA :{INBOUND_PORT}] JSON inválido desde {addr}: {e}")
    except Exception:
        pass
    finally:
        inbound_sensors.discard(writer)
        print(f"[ENTRADA :{INBOUND_PORT}] Sensor desconectado: {addr}")
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


async def inbound_relay_worker():
    """Consume los paquetes que llegan al puerto 8766 y los retransmite al puerto 8765 sin bloqueo."""
    while True:
        packet = await inbound_queue.get()
        broadcast_to_outbound(packet)
        inbound_queue.task_done()


async def telemetry_broadcaster():
    global CURRENT_FRAME_INDEX
    step = 0
    while True:
        await asyncio.sleep(1.0)
        step += 1
        CURRENT_FRAME_INDEX = step - 1
        now_sec = int(time.time())
        t = step * 0.1

        # 1. Satélite (ESP32 #1)
        sat_packet = {
            "node_id": "satellite_esp32",
            "timestamp": now_sec,
            "payload": {
                "satellite_esp32": {
                    "orbit_pos": [
                        round(12.5 + 2.0 * math.cos(t * 0.05), 2),
                        round(45.0 + 2.0 * math.sin(t * 0.05), 2),
                        round(250.0 + 5.0 * math.sin(t * 0.1), 1),
                    ],
                    "signal_dbm": int(-62 + random.randint(-3, 3)),
                    "latency_ms": int(18 + random.randint(-4, 6)),
                }
            },
        }

        # 2. Estación Base (ESP32 #2)
        station_packet = {
            "node_id": "station_esp32",
            "timestamp": now_sec,
            "payload": {
                "station_esp32": {
                    "habitat_o2": round(98.4 - (step * 0.01) % 5, 1),
                    "habitat_power": round(87.0 - (step * 0.02) % 10, 1),
                    "mesh_nodes_active": 4,
                }
            },
        }

        # 3. Traje EVA Astronauta Alan (ESP32 #3)
        eva_packet = {
            "node_id": "eva_esp32",
            "timestamp": now_sec,
            "payload": {
                "eva_esp32": {
                    "suit_o2": round(max(65.0, 94.2 - (step * 0.08) % 35), 1),
                    "heart_rate": int(78 + 12 * math.sin(t * 0.3) + random.uniform(-2, 2)),
                    "radiation_msv": round(0.14 + (0.32 if (step % 30 > 22) else 0.02 * math.sin(t)), 2),
                    "battery": round(max(12.0, 89.5 - (step * 0.05) % 80), 1),
                    "imu": {
                        "yaw": 12.4,
                        "pitch": round(-1.2 + 8 * math.cos(t * 0.25), 1),
                        "roll": round(0.5 + 4 * math.sin(t * 0.3), 1),
                        "accel_mag": round(3.72 + 0.5 * math.sin(t), 2),
                    },
                }
            },
        }

        # 4. Dron Real CV (Raspberry Pi 4 + RealSense D415 desde carpeta data/)
        if HAS_EXTERNAL_SENSOR_CONNECTED and "drone_cv" in LATEST_INGESTED_PACKETS:
            drone_packet = LATEST_INGESTED_PACKETS["drone_cv"]
        elif REAL_D415_FRAMES:
            raw_frame = REAL_D415_FRAMES[(step - 1) % len(REAL_D415_FRAMES)]
            d_data = dict(raw_frame.get("data", {}))
            if ACTIVE_ROUTE_WAYPOINTS:
                if "navigation" not in d_data or not isinstance(d_data["navigation"], dict):
                    d_data["navigation"] = {}
                else:
                    d_data["navigation"] = dict(d_data["navigation"])
                d_data["navigation"]["route_waypoints_xy_m"] = ACTIVE_ROUTE_WAYPOINTS
            drone_packet = {
                "node": "drone_cv",
                "node_id": "drone_cv",
                "timestamp": now_sec,
                "data": d_data,
                "images": raw_frame.get("images"),
            }
        else:
            is_safe = False if (step % 20 > 14) else True
            drone_z = round(max(0.1, 1.3 + 1.3 * math.sin(t * 0.35)), 2)
            drone_packet = {
                "node": "drone_cv",
                "node_id": "drone_cv",
                "timestamp": now_sec,
                "payload": {
                    "drone_cv": {
                        "drone_pos": [1.8, 5.4, drone_z],
                        "safe_path": is_safe,
                        "max_slope_deg": round(12.5 + (10.0 if not is_safe else 2.5 * math.sin(t * 0.3)), 1),
                        "imu": {
                            "yaw": round(0.4 + 2 * math.sin(t * 0.1), 1),
                            "pitch": round(1.1 + 1.5 * math.cos(t * 0.2), 1),
                            "roll": round(-0.2 + 1.0 * math.sin(t * 0.3), 1),
                        },
                        "obstacles": [
                            {"x": 1.7, "y": 2.0, "radius": 0.30, "severity": "high" if not is_safe else "medium"},
                            {"x": 2.3, "y": 1.4, "radius": 0.25, "severity": "low"},
                        ],
                    }
                },
            }

        for packet in [sat_packet, station_packet, eva_packet, drone_packet]:
            broadcast_to_outbound(packet)


async def main():
    global inbound_queue
    inbound_queue = asyncio.Queue()

    outbound_server = await asyncio.start_server(handle_outbound_client, "0.0.0.0", OUTBOUND_PORT)
    inbound_server = await asyncio.start_server(handle_inbound_sensor, "0.0.0.0", INBOUND_PORT)

    print("=========================================================================")
    print("NASA Space Apps - BACKBONE DUAL-PORT SERVER (Sin Congestión)")
    print(f"PUERTO DE SALIDA  (Web / iPad)      : ws://0.0.0.0:{OUTBOUND_PORT}  | http://0.0.0.0:{OUTBOUND_PORT}")
    print(f"PUERTO DE ENTRADA (Sensores / Raspi): ws://0.0.0.0:{INBOUND_PORT}  | http://0.0.0.0:{INBOUND_PORT}/api/ingest")
    print("=========================================================================")

    asyncio.create_task(inbound_relay_worker())
    # telemetry_broadcaster() desactivado: el servidor espera datos reales del host externo por el puerto 8766
    # asyncio.create_task(telemetry_broadcaster())

    async with outbound_server, inbound_server:
        await asyncio.gather(
            outbound_server.serve_forever(),
            inbound_server.serve_forever(),
        )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServidor detenido.")
