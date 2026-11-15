import { create } from 'zustand';
import {
  DroneData,
  EvaData,
  NodeRecord,
  SatelliteData,
  StationData,
  TelemetryEnvelope,
} from './types';
import { extractDataFromEnvelope, isStale, STALE_TIMEOUT_MS } from './normalizers';
import { resolveServerEndpoints, pushToInboundPort } from './networkClient';

declare const process: any;
declare const window: any;

export { isStale, STALE_TIMEOUT_MS, resolveServerEndpoints };

export interface BackboneStoreState {
  nodes: Record<string, NodeRecord>;
  isConnected: boolean;
  lastConnected: number | null;
  error: string | null;

  // Acciones
  ingestEnvelope: (envelope: TelemetryEnvelope) => void;
  setConnectionStatus: (connected: boolean, error?: string | null) => void;
  clearNodes: () => void;

  // Selectores tipados de conveniencia
  getNode: <T = any>(node_id: string) => NodeRecord<T> | undefined;
  getEva: () => NodeRecord<EvaData> | undefined;
  getDrone: () => NodeRecord<DroneData> | undefined;
  getStation: () => NodeRecord<StationData> | undefined;
  getSatellite: () => NodeRecord<SatelliteData> | undefined;
}

export const useBackboneStore = create<BackboneStoreState>((set, get) => ({
  nodes: {},
  isConnected: false,
  lastConnected: null,
  error: null,

  ingestEnvelope: (envelope: TelemetryEnvelope) => {
    const resolvedNodeId = envelope?.node_id ?? envelope?.node;
    if (!envelope || !resolvedNodeId) return;
    const now = Date.now();
    const existingMapState = get().nodes['drone_cv']?.data?.map_state;
    const data = extractDataFromEnvelope(envelope, existingMapState);

    set((state) => ({
      nodes: {
        ...state.nodes,
        [resolvedNodeId]: {
          node_id: resolvedNodeId,
          lastSeen: now,
          data,
          raw: envelope,
        },
      },
    }));
  },

  setConnectionStatus: (connected: boolean, error: string | null = null) => {
    set({
      isConnected: connected,
      lastConnected: connected ? Date.now() : get().lastConnected,
      error,
    });
  },

  clearNodes: () => set({ nodes: {} }),

  getNode: <T = any>(node_id: string) => {
    return get().nodes[node_id] as NodeRecord<T> | undefined;
  },

  getEva: () => {
    return get().nodes['eva_esp32'] as NodeRecord<EvaData> | undefined;
  },

  getDrone: () => {
    return get().nodes['drone_cv'] as NodeRecord<DroneData> | undefined;
  },

  getStation: () => {
    return get().nodes['station_esp32'] as NodeRecord<StationData> | undefined;
  },

  getSatellite: () => {
    return get().nodes['satellite_esp32'] as NodeRecord<SatelliteData> | undefined;
  },
}));

let activeSocket: WebSocket | null = null;
let reconnectTimer: any = null;
let httpPollTimer: any = null;
let currentDelay = 1000;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10000;
const BACKOFF_MULTIPLIER = 1.5;

let configuredUrl: string = 'ws://localhost:8765';

export function getBackboneUrl(): string {
  if (configuredUrl) return configuredUrl;

  if (typeof process !== 'undefined' && process.env) {
    if (process.env.EXPO_PUBLIC_BACKBONE_URL) return process.env.EXPO_PUBLIC_BACKBONE_URL;
    if (process.env.VITE_BACKBONE_URL) return process.env.VITE_BACKBONE_URL;
    if (process.env.BACKBONE_URL) return process.env.BACKBONE_URL;
  }

  if (typeof window !== 'undefined') {
    const host = window.location.hostname || 'localhost';
    return `ws://${host}:8765`;
  }

  return 'ws://localhost:8765';
}

export function getBackboneHttpUrl(): string {
  return resolveServerEndpoints(getBackboneUrl()).httpBaseUrl;
}

/**
 * Descarga las matrices del mapa (occupancy_grid, cost_grid, height, slope) y el último payload
 * desde el servidor HTTP de la IP externa (o desde /data/ local como respaldo).
 */
export async function fetchMapStateFromServer(customInputUrl?: string): Promise<boolean> {
  const { httpBaseUrl } = resolveServerEndpoints(customInputUrl || getBackboneUrl());
  let success = false;

  if (typeof fetch === 'undefined') return false;

  const mapUrls = [
    `${httpBaseUrl}/map_state.json`,
    `${httpBaseUrl}/data/real_map_state.json`,
    '/data/real_map_state.json',
  ];
  let loadedMapState: any = null;
  for (const mUrl of mapUrls) {
    try {
      const res = await fetch(mUrl);
      if (res.ok) {
        loadedMapState = await res.json();
        break;
      }
    } catch {
      // Continuar con el siguiente endpoint
    }
  }

  const payloadUrls = [
    `${httpBaseUrl}/latest_expo_payload.json`,
    `${httpBaseUrl}/latest_drone_cv.json`,
  ];
  for (const pUrl of payloadUrls) {
    try {
      const res = await fetch(pUrl);
      if (res.ok) {
        const payload = await res.json();
        if (payload && (payload.node || payload.node_id)) {
          if (loadedMapState) {
            payload.map_state = loadedMapState;
          }
          useBackboneStore.getState().ingestEnvelope(payload);
          useBackboneStore.getState().setConnectionStatus(true, null);
          success = true;
          break;
        }
      }
    } catch {
      // Ignorar si el servidor externo solo usa WS
    }
  }

  if (loadedMapState) {
    const currentDrone = useBackboneStore.getState().getDrone();
    if (currentDrone) {
      useBackboneStore.getState().ingestEnvelope({
        node: 'drone_cv',
        timestamp: Math.floor(Date.now() / 1000),
        data: {
          ...currentDrone.data,
          map_state: loadedMapState,
        },
        images: currentDrone.data.images,
        map_state: loadedMapState,
      });
    }
  }

  return success;
}

export function setBackboneUrl(url: string) {
  const { wsUrl } = resolveServerEndpoints(url);
  configuredUrl = wsUrl;
  disconnectBackbone();
  connectBackbone(wsUrl);
}

export function connectBackbone(customUrl?: string) {
  if (customUrl) {
    configuredUrl = resolveServerEndpoints(customUrl).wsUrl;
  }
  const { wsUrl, httpBaseUrl } = resolveServerEndpoints(getBackboneUrl());

  if (
    activeSocket &&
    (activeSocket.readyState === WebSocket.OPEN ||
      activeSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  fetchMapStateFromServer(wsUrl).catch(() => {});

  try {
    const ws = new WebSocket(wsUrl);
    activeSocket = ws;

    ws.onopen = () => {
      currentDelay = INITIAL_RECONNECT_DELAY_MS;
      useBackboneStore.getState().setConnectionStatus(true, null);
      if (httpPollTimer) {
        clearInterval(httpPollTimer);
        httpPollTimer = null;
      }
      console.log(`[Backbone WS] Enlace establecido con éxito en ${wsUrl}`);
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            useBackboneStore.getState().ingestEnvelope(item as TelemetryEnvelope);
          }
        } else if (parsed && (parsed.node_id || parsed.node)) {
          useBackboneStore.getState().ingestEnvelope(parsed as TelemetryEnvelope);
        }
      } catch (err) {
        console.warn('[Backbone WS] Error procesando paquete:', err, event.data);
      }
    };

    ws.onerror = () => {
      startHttpFallbackPolling(httpBaseUrl);
    };

    ws.onclose = () => {
      activeSocket = null;
      scheduleReconnect();
    };
  } catch (error: any) {
    useBackboneStore.getState().setConnectionStatus(false, error?.message || 'Error de conexión');
    startHttpFallbackPolling(httpBaseUrl);
    scheduleReconnect();
  }
}

function startHttpFallbackPolling(httpBaseUrl: string) {
  if (httpPollTimer) return;
  httpPollTimer = setInterval(async () => {
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      clearInterval(httpPollTimer);
      httpPollTimer = null;
      return;
    }
    const ok = await fetchMapStateFromServer(httpBaseUrl);
    if (!ok) {
      useBackboneStore.getState().setConnectionStatus(false, 'Desconectado');
    }
  }, 1000);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    currentDelay = Math.min(currentDelay * BACKOFF_MULTIPLIER, MAX_RECONNECT_DELAY_MS);
    connectBackbone();
  }, currentDelay);
}

export function disconnectBackbone() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (httpPollTimer) {
    clearInterval(httpPollTimer);
    httpPollTimer = null;
  }
  if (activeSocket) {
    activeSocket.onclose = null;
    activeSocket.close();
    activeSocket = null;
  }
  useBackboneStore.getState().setConnectionStatus(false, null);
}

export function useBackbone() {
  return useBackboneStore();
}

/**
 * Envía un mensaje JSON a través del WebSocket de Backbone activo (Puerto 8765).
 */
export function sendBackboneMessage(payload: Record<string, any>): boolean {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    try {
      activeSocket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Solicita una ruta al servicio externo enviando el punto objetivo estrictamente en METROS.
 * Intenta primero vía WebSocket directo (8765) y como respaldo vía HTTP POST (8766).
 */
export async function sendRouteRequest(
  target: { x_m: number; y_m: number; [key: string]: any },
  origin?: { x_m: number; y_m: number; [key: string]: any },
  serverUrl?: string
): Promise<boolean> {
  const payload = {
    action: 'request_route',
    unit: 'meters',
    target,
    origin,
    timestamp: Date.now(),
  };

  const sentWs = sendBackboneMessage(payload);
  if (sentWs) return true;

  return pushToInboundPort(payload, serverUrl || getBackboneUrl());
}

