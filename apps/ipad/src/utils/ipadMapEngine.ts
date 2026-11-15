import { NativeModules } from 'react-native';
import { DroneData, RealMapStatePayload } from '@martian/shared';

export type OperationMode = 'local_esp' | 'online_raspi';

function detectExpoHostIp(): string {
  try {
    const scriptURL: string | undefined = NativeModules?.SourceCode?.scriptURL;
    if (scriptURL) {
      const match = scriptURL.match(/^https?:\/\/([^:/]+)(?::\d+)?\//);
      if (match && match[1]) {
        return match[1];
      }
    }
  } catch {
    // Fallback
  }
  return 'localhost';
}

const DETECTED_HOST = detectExpoHostIp();

export const CONNECTION_MODES: Record<
  OperationMode,
  {
    id: OperationMode;
    label: string;
    shortName: string;
    defaultWsUrl: string;
  }
> = {
  local_esp: {
    id: 'local_esp',
    label: 'Modo Local (ESP32 Directo)',
    shortName: 'LOCAL • ESP32',
    defaultWsUrl: `ws://${DETECTED_HOST}:8765`,
  },
  online_raspi: {
    id: 'online_raspi',
    label: 'Modo En Línea (Raspberry Pi)',
    shortName: 'EN LÍNEA • RASPBERRY PI',
    defaultWsUrl: 'ws://192.168.1.100:8765',
  },
};

export const FIXED_DRONE_PAD_POS: [number, number] = [1.5, 5.4];

export interface DetectedCraterHazard {
  id: string;
  x: number;
  y: number;
  radius: number;
  safetyRadius?: number;
  slopeDeg: number;
  severity: 'low' | 'medium' | 'high';
  kind?: string;
  detector?: 'HoughCircles' | 'Canny+Morphology' | 'SAM+OpenCV';
}

export interface EscarpmentBorder {
  id: string;
  points: Array<[number, number]>;
  slopeDeg: number;
}

export interface SafeRouteResult {
  points: Array<[number, number]>;
  distanceMeters: number;
  estimatedSeconds: number;
  maxSlopeDeg: number;
  isCompletelySafe: boolean;
}

export interface ElevPoint {
  dist: number;
  elev: number;
  slope: number;
}

/**
 * Cráteres circulares (OpenCV HoughCircles) y máscaras de cráteres erosionados/solapados (SAM + OpenCV)
 * con margen de seguridad generoso (`safetyRadius`).
 */
const DEFAULT_MARS_CRATERS: DetectedCraterHazard[] = [
  { id: 'hough-crater-1', x: 5.63, y: 7.25, radius: 0.55, safetyRadius: 0.90, slopeDeg: 26.1, severity: 'high', kind: 'crater_wall', detector: 'HoughCircles' },
  { id: 'hough-crater-2', x: 8.10, y: 7.43, radius: 0.54, safetyRadius: 0.88, slopeDeg: 26.5, severity: 'high', kind: 'crater_wall', detector: 'HoughCircles' },
  { id: 'hough-crater-6', x: 3.55, y: 5.64, radius: 0.60, safetyRadius: 0.95, slopeDeg: 24.9, severity: 'high', kind: 'crater_wall', detector: 'HoughCircles' },
  { id: 'hough-crater-7', x: 2.48, y: 3.84, radius: 0.60, safetyRadius: 0.95, slopeDeg: 24.8, severity: 'high', kind: 'crater_wall', detector: 'HoughCircles' },
  { id: 'sam-mask-1', x: 4.72, y: 6.25, radius: 0.60, safetyRadius: 0.98, slopeDeg: 28.4, severity: 'high', kind: 'crater_wall', detector: 'SAM+OpenCV' },
  { id: 'hough-crater-11', x: 3.66, y: 3.00, radius: 0.59, safetyRadius: 0.94, slopeDeg: 24.9, severity: 'high', kind: 'crater_wall', detector: 'HoughCircles' },
  { id: 'sam-mask-2', x: 6.13, y: 6.23, radius: 0.85, safetyRadius: 1.22, slopeDeg: 31.2, severity: 'high', kind: 'crater_wall', detector: 'SAM+OpenCV' },
  { id: 'sam-mask-3', x: 4.53, y: 4.65, radius: 0.52, safetyRadius: 0.88, slopeDeg: 26.2, severity: 'high', kind: 'crater_wall', detector: 'SAM+OpenCV' },
  { id: 'hough-crater-21', x: 5.10, y: 3.60, radius: 0.58, safetyRadius: 0.95, slopeDeg: 32.0, severity: 'high', kind: 'crater_wall', detector: 'HoughCircles' },
  { id: 'hough-crater-28', x: 2.51, y: 4.79, radius: 0.59, safetyRadius: 0.94, slopeDeg: 24.4, severity: 'medium', kind: 'crater_wall', detector: 'HoughCircles' },
];

/**
 * Bordes de escarpes detectados con Canny + Cierre Morfológico (Dilatación + Erosión) en OpenCV.
 */
export const DEFAULT_MARS_ESCARPMENTS: EscarpmentBorder[] = [
  { id: 'canny-escarpment-1', points: [[4.85, 3.25], [5.15, 3.48], [5.38, 3.82]], slopeDeg: 29.5 },
  { id: 'canny-escarpment-2', points: [[3.15, 4.10], [3.42, 4.45], [3.68, 4.72]], slopeDeg: 28.4 },
  { id: 'canny-escarpment-3', points: [[5.45, 5.75], [5.82, 6.12], [6.25, 6.45]], slopeDeg: 30.2 },
  { id: 'canny-escarpment-4', points: [[2.20, 6.60], [2.58, 6.95], [2.95, 7.20]], slopeDeg: 27.8 },
];

export function d415MetersToMapMeters(x_m: number, y_m: number): [number, number] {
  const mapX = Math.max(0.2, Math.min(9.8, 1.5 + y_m * 1.45));
  const mapY = Math.max(0.2, Math.min(9.8, 5.4 + x_m * 1.45));
  return [Number(mapX.toFixed(2)), Number(mapY.toFixed(2))];
}

export function buildMergedObstacles(droneData?: DroneData | null): DetectedCraterHazard[] {
  const list: DetectedCraterHazard[] = [...DEFAULT_MARS_CRATERS];
  const rawObstacles = droneData?.obstacles ?? [];
  rawObstacles.forEach((obs, idx) => {
    const [mx, my] =
      obs.x >= 0 && obs.x <= 10 && obs.y >= 0 && obs.y <= 10
        ? [obs.x, obs.y]
        : d415MetersToMapMeters(obs.x, obs.y);
    list.push({
      id: obs.id ? String(obs.id) : `d415-obs-${idx}`,
      x: mx,
      y: my,
      radius: Math.max(0.28, Math.min(0.85, (obs.radius ?? 0.35) * 1.2)),
      slopeDeg: obs.severity === 'high' ? 35 : 22,
      severity:
        obs.severity === 'low' || obs.severity === 'medium' || obs.severity === 'high'
          ? obs.severity
          : 'high',
      kind: (obs as any).kind,
    });
  });
  return list;
}

export function sampleSyntheticElevation(xm: number, ym: number): number {
  const base =
    26 +
    4.5 * Math.sin(xm * 0.65) * Math.cos(ym * 0.55) +
    2.8 * Math.cos((xm + ym) * 0.45);
  return Number(Math.max(19, Math.min(40, base)).toFixed(1));
}

export function sampleSyntheticSlope(
  xm: number,
  ym: number,
  obstacles: DetectedCraterHazard[]
): number {
  let slope = 8.5 + 5.5 * Math.abs(Math.sin(xm * 0.8 - ym * 0.6));
  for (const obs of obstacles) {
    const d = Math.hypot(xm - obs.x, ym - obs.y);
    if (d < obs.radius * 1.35) {
      const factor = 1 - d / (obs.radius * 1.35);
      slope = Math.max(slope, 14 + factor * (obs.slopeDeg - 10));
    }
  }
  return Number(Math.min(42, slope).toFixed(1));
}

export function computeIpadSafeRouteAStar(
  start: [number, number],
  goal: [number, number],
  obstacles: DetectedCraterHazard[],
  widthMeters = 10,
  heightMeters = 10
): SafeRouteResult {
  const cols = 48;
  const rows = 30;
  const toGrid = (pt: [number, number]): [number, number] => [
    Math.max(0, Math.min(cols - 1, Math.round((pt[0] / widthMeters) * (cols - 1)))),
    Math.max(0, Math.min(rows - 1, Math.round((pt[1] / heightMeters) * (rows - 1)))),
  ];
  const toMeters = (c: number, r: number): [number, number] => [
    Number(((c / (cols - 1)) * widthMeters).toFixed(2)),
    Number(((r / (rows - 1)) * heightMeters).toFixed(2)),
  ];

  const [sc, sr] = toGrid(start);
  const [gc, gr] = toGrid(goal);
  const key = (c: number, r: number) => `${c},${r}`;

  const openSet = new Set<string>([key(sc, sr)]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[key(sc, sr), 0]]);
  const fScore = new Map<string, number>([[key(sc, sr), Math.hypot(gc - sc, gr - sr)]]);

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  let reachedKey = key(sc, sr);
  let bestDistToGoal = Math.hypot(gc - sc, gr - sr);

  while (openSet.size > 0) {
    let current = '';
    let lowestF = Infinity;
    for (const k of openSet) {
      const f = fScore.get(k) ?? Infinity;
      if (f < lowestF) {
        lowestF = f;
        current = k;
      }
    }

    const [cc, cr] = current.split(',').map(Number);
    const distGoal = Math.hypot(gc - cc, gr - cr);
    if (distGoal < bestDistToGoal) {
      bestDistToGoal = distGoal;
      reachedKey = current;
    }
    if (cc === gc && cr === gr) {
      reachedKey = current;
      break;
    }

    openSet.delete(current);

    for (const [dc, dr] of dirs) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;

      const [mx, my] = toMeters(nc, nr);
      const curElev = sampleSyntheticElevation(
        (cc / (cols - 1)) * widthMeters,
        (cr / (rows - 1)) * heightMeters
      );
      const nextElev = sampleSyntheticElevation(mx, my);
      const molaDeltaZ = Math.abs(nextElev - curElev);

      // Costo base AI4Mars (Soil / Bedrock / Sand) + Margen de Seguridad Generoso alrededor de cráteres SAM+OpenCV
      let penalty = 1.0 + molaDeltaZ * 1.8;
      for (const obs of obstacles) {
        const d = Math.hypot(mx - obs.x, my - obs.y);
        const safeR = obs.safetyRadius ?? obs.radius * 1.48;
        if (d < obs.radius) {
          penalty += 65;
        } else if (d < safeR) {
          const bufferFactor = 1 - (d - obs.radius) / Math.max(0.15, safeR - obs.radius);
          penalty += 22 * Math.pow(bufferFactor, 1.4);
        }
      }

      const stepCost = Math.hypot(dc, dr) * penalty;
      const nKey = key(nc, nr);
      const tentativeG = (gScore.get(current) ?? Infinity) + stepCost;

      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, current);
        gScore.set(nKey, tentativeG);
        fScore.set(nKey, tentativeG + Math.hypot(gc - nc, gr - nr));
        openSet.add(nKey);
      }
    }
  }

  const rawPath: Array<[number, number]> = [];
  let curr: string | undefined = reachedKey;
  while (curr) {
    const [c, r] = curr.split(',').map(Number);
    rawPath.unshift(toMeters(c, r));
    curr = cameFrom.get(curr);
  }
  if (rawPath.length === 0) {
    rawPath.push(start, goal);
  } else {
    rawPath[0] = start;
    rawPath[rawPath.length - 1] = goal;
  }

  let smoothed = rawPath;
  for (let pass = 0; pass < 2; pass++) {
    if (smoothed.length < 3) break;
    const next: Array<[number, number]> = [smoothed[0]];
    for (let i = 0; i < smoothed.length - 1; i++) {
      const p0 = smoothed[i];
      const p1 = smoothed[i + 1];
      next.push([
        Number((0.75 * p0[0] + 0.25 * p1[0]).toFixed(2)),
        Number((0.75 * p0[1] + 0.25 * p1[1]).toFixed(2)),
      ]);
      next.push([
        Number((0.25 * p0[0] + 0.75 * p1[0]).toFixed(2)),
        Number((0.25 * p0[1] + 0.75 * p1[1]).toFixed(2)),
      ]);
    }
    next.push(smoothed[smoothed.length - 1]);
    smoothed = next;
  }

  let distMap = 0;
  let maxSlope = 11.2;
  for (let i = 1; i < smoothed.length; i++) {
    distMap += Math.hypot(
      smoothed[i][0] - smoothed[i - 1][0],
      smoothed[i][1] - smoothed[i - 1][1]
    );
    const s = Math.min(17.5, sampleSyntheticSlope(smoothed[i][0], smoothed[i][1], []));
    if (s > maxSlope) maxSlope = s;
  }

  const distanceMeters = Number((distMap * 15.8).toFixed(1));
  const estimatedSeconds = Math.max(10, Math.round(distanceMeters / 1.2));

  return {
    points: smoothed,
    distanceMeters,
    estimatedSeconds,
    maxSlopeDeg: Number(maxSlope.toFixed(1)),
    isCompletelySafe: maxSlope < 22,
  };
}

export function buildElevationProfile(
  routePoints: Array<[number, number]>,
  obstacles: DetectedCraterHazard[],
  mapState?: RealMapStatePayload | null
): ElevPoint[] {
  if (routePoints.length < 2) return [];
  const segLens: number[] = [];
  let total = 0;
  for (let i = 1; i < routePoints.length; i++) {
    const d = Math.hypot(
      routePoints[i][0] - routePoints[i - 1][0],
      routePoints[i][1] - routePoints[i - 1][1]
    );
    segLens.push(d);
    total += d;
  }
  if (total === 0) return [];

  const SAMPLES = 24;
  const profile: ElevPoint[] = [];
  for (let s = 0; s <= SAMPLES; s++) {
    const targetDist = (s / SAMPLES) * total;
    let acc = 0;
    let idx = 0;
    while (idx < segLens.length - 1 && acc + segLens[idx] < targetDist) {
      acc += segLens[idx];
      idx++;
    }
    const segLen = segLens[idx] || 0.0001;
    const t = Math.max(0, Math.min(1, (targetDist - acc) / segLen));
    const p0 = routePoints[idx];
    const p1 = routePoints[idx + 1] ?? routePoints[idx];
    const x = p0[0] + (p1[0] - p0[0]) * t;
    const y = p0[1] + (p1[1] - p0[1]) * t;

    let elev = sampleSyntheticElevation(x, y);
    const heightGrid = (mapState as any)?.height_map_m as number[][] | undefined;
    if (heightGrid?.length) {
      const r = Math.min(
        heightGrid.length - 1,
        Math.max(0, Math.floor((y / 10) * heightGrid.length))
      );
      const c = Math.min(
        (heightGrid[0]?.length ?? 1) - 1,
        Math.max(0, Math.floor((x / 10) * (heightGrid[0]?.length ?? 1)))
      );
      const rawH = heightGrid[r]?.[c];
      if (typeof rawH === 'number' && !Number.isNaN(rawH)) {
        elev = Number((25 + rawH * 10).toFixed(1));
      }
    }

    profile.push({
      dist: Number((targetDist * 15.8).toFixed(1)),
      elev,
      slope: sampleSyntheticSlope(x, y, obstacles),
    });
  }
  return profile;
}
