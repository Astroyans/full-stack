import { DroneData, DroneObstacle } from '@martian/shared';

export type OperationMode = 'local_esp' | 'online_raspi';

export interface ModeEndpointConfig {
  id: OperationMode;
  label: string;
  shortName: string;
  description: string;
  defaultWsUrl: string;
  sourceLabel: string;
}

export const CONNECTION_MODES: Record<OperationMode, ModeEndpointConfig> = {
  local_esp: {
    id: 'local_esp',
    label: 'Modo Local (ESP32 Directo)',
    shortName: 'LOCAL • ESP32',
    description:
      'Lectura directa desde red local AP del ESP32 o emulador local sin pasar por servidor central.',
    defaultWsUrl: 'ws://localhost:8765',
    sourceLabel: 'ESP32 Serial / Local WS',
  },
  online_raspi: {
    id: 'online_raspi',
    label: 'Modo En Línea (Raspberry Pi - Centro de Mando)',
    shortName: 'EN LÍNEA • RASPBERRY PI',
    description:
      'Telemetría y topografía fusionadas por la Raspberry Pi (Centro de Mando y visión de Berni).',
    defaultWsUrl: 'ws://192.168.1.100:8765',
    sourceLabel: 'Raspberry Pi 4 (Centro de Mando)',
  },
};

export interface BerniTopographyInput {
  drone_pos: [number, number, number];
  safe_path: boolean;
  max_slope_deg: number;
  obstacles: DroneObstacle[];
  elevation_points?: Array<{ x: number; y: number; z: number }>;
  waypoints?: Array<[number, number]>;
}

export interface MartianTerrainDataset {
  widthMeters: number;
  heightMeters: number;
  minElevation: number;
  maxElevation: number;
  contourStep: number;
  obstacles: DroneObstacle[];
  dronePos: [number, number, number];
  droneScanRadius: number;
  droneFlightPhase:
    | 'EN TIERRA'
    | 'ASCENDIENDO'
    | 'ESCANEANDO (ALTURA MÁX)'
    | 'DESCENDIENDO';
  safePath: boolean;
  maxSlopeDeg: number;
}

/**
 * Posición fija de la plataforma del Dron de Berni.
 * El dron NO se desplaza en X/Y; únicamente sube en Z, escanea el terreno con la cámara y baja.
 */
export const FIXED_DRONE_PAD_POS: [number, number] = [1.5, 5.4];

export function buildTopographicDataset(
  droneData?: DroneData | BerniTopographyInput | null,
  // Antes 1.5: con fotos reales de Mars Trek (más ruido de textura que la imagen
  // estática original) generaba demasiados niveles y las curvas se veían como
  // manchas desconectadas en vez de líneas. 3.0 reduce la cantidad de niveles.
  contourStep: number = 3
): MartianTerrainDataset {
  const obstacles = droneData?.obstacles ?? [];
  const rawZ = (droneData as any)?.altitude_m ?? droneData?.drone_pos?.[2] ?? 1.8;
  const altitudeZ = Math.max(0, Number(Number(rawZ).toFixed(2)));
  const dronePos: [number, number, number] = [
    FIXED_DRONE_PAD_POS[0],
    FIXED_DRONE_PAD_POS[1],
    altitudeZ,
  ];

  const droneScanRadius = Number(Math.min(9.2, Math.max(1.2, altitudeZ * 3.1)).toFixed(2));
  const droneFlightPhase =
    altitudeZ <= 0.3
      ? 'EN TIERRA'
      : altitudeZ >= 2.2
      ? 'ESCANEANDO (ALTURA MÁX)'
      : 'ASCENDIENDO';

  const safePath =
    typeof droneData?.safe_path === 'boolean'
      ? droneData.safe_path
      : typeof (droneData as any)?.safe_corridor === 'boolean'
      ? (droneData as any).safe_corridor
      : true;

  const maxSlopeDeg =
    typeof droneData?.max_slope_deg === 'number'
      ? droneData.max_slope_deg
      : typeof (droneData as any)?.max_incline_deg === 'number'
      ? (droneData as any).max_incline_deg
      : 12.0;

  return {
    widthMeters: 10,
    heightMeters: 10,
    minElevation: 19,
    maxElevation: 40,
    contourStep,
    obstacles,
    dronePos,
    droneScanRadius,
    droneFlightPhase,
    safePath,
    maxSlopeDeg,
  };
}

