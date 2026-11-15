import { NativeModules } from 'react-native';
import { DroneData, RealMapStatePayload } from '@martian/shared';
import opencvData from '../../assets/opencv_craters.json';

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

export interface ScientificStop {
  id: string;
  number: number;
  name: string;
  objective: string;
  xm: number;
  ym: number;
}

export interface DetectedCraterHazard {
  id: string;
  x: number;
  y: number;
  radius: number;
  radiusY?: number;
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
  minSafetyMarginMeters: number;
  isCompletelySafe: boolean;
}

export interface ElevPoint {
  dist: number;
  elev: number;
  slope: number;
}

/**
 * Cráteres verificados extraídos de opencv_craters.json (26 cráteres reales sin falsos positivos).
 */
const VERIFIED_OPENCV_CRATERS: DetectedCraterHazard[] = (
  (opencvData as any)?.craters_hough ?? []
).map((c: any) => ({
  id: c.id,
  x: Number(c.x),
  y: Number(c.y),
  radius: Number(c.radius),
  radiusY: c.radiusY !== undefined ? Number(c.radiusY) : Number(c.radius),
  safetyRadius: c.safetyRadius !== undefined ? Number(c.safetyRadius) : Number(c.radius) * 1.5,
  slopeDeg: Number(c.slopeDeg),
  severity: c.slopeDeg >= 30 ? 'high' : c.slopeDeg >= 22 ? 'medium' : 'low',
  kind: 'crater_wall',
  detector: 'HoughCircles',
}));

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
  const list: DetectedCraterHazard[] = [...VERIFIED_OPENCV_CRATERS];
  const rawObstacles = droneData?.obstacles ?? [];
  rawObstacles.forEach((obs, idx) => {
    const [mx, my] =
      obs.x >= 0 && obs.x <= 10 && obs.y >= 0 && obs.y <= 10
        ? [obs.x, obs.y]
        : d415MetersToMapMeters(obs.x, obs.y);
    const r = Math.max(0.24, Math.min(0.75, (obs.radius ?? 0.32) * 1.1));
    list.push({
      id: obs.id ? String(obs.id) : `d415-obs-${idx}`,
      x: mx,
      y: my,
      radius: r,
      safetyRadius: r * 1.5,
      slopeDeg: obs.severity === 'high' ? 33.5 : 23.0,
      severity:
        obs.severity === 'low' || obs.severity === 'medium' || obs.severity === 'high'
          ? obs.severity
          : 'high',
      kind: (obs as any).kind ?? 'rock_obstacle',
      detector: 'SAM+OpenCV',
    });
  });
  return list;
}

export function sampleSyntheticElevation(xm: number, ym: number): number {
  const base =
    26 +
    4.5 * Math.sin(xm * 0.65) * Math.cos(ym * 0.55) +
    2.8 * Math.cos((xm + ym) * 0.45);
  return Number(Math.max(19, Math.min(40, base)).toFixed(2));
}

export function sampleSyntheticSlope(
  xm: number,
  ym: number,
  obstacles: DetectedCraterHazard[]
): number {
  let slope = 8.5 + 5.5 * Math.abs(Math.sin(xm * 0.8 - ym * 0.6));
  for (const obs of obstacles) {
    const d = Math.hypot(xm - obs.x, ym - obs.y);
    const safeR = obs.safetyRadius ?? obs.radius * 1.4;
    if (d < safeR) {
      const factor = 1 - d / safeR;
      slope = Math.max(slope, 14 + factor * (obs.slopeDeg - 10));
    }
  }
  return Number(Math.min(38, slope).toFixed(1));
}

export function computeIpadSafeRouteAStar(
  start: [number, number],
  goal: [number, number],
  obstacles: DetectedCraterHazard[],
  stops: ScientificStop[] = [],
  widthMeters = 10,
  heightMeters = 10
): SafeRouteResult {
  const waypoints: Array<[number, number]> = [
    start,
    ...stops.map((s) => [s.xm, s.ym] as [number, number]),
    goal,
  ];

  const cols = 56;
  const rows = 36;
  const toGrid = (pt: [number, number]): [number, number] => [
    Math.max(0, Math.min(cols - 1, Math.round((pt[0] / widthMeters) * (cols - 1)))),
    Math.max(0, Math.min(rows - 1, Math.round((pt[1] / heightMeters) * (rows - 1)))),
  ];
  const toMeters = (c: number, r: number): [number, number] => [
    Number(((c / (cols - 1)) * widthMeters).toFixed(2)),
    Number(((r / (rows - 1)) * heightMeters).toFixed(2)),
  ];

  const key = (c: number, r: number) => `${c},${r}`;
  const dirs = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];

  const fullPath: Array<[number, number]> = [];

  for (let w = 0; w < waypoints.length - 1; w++) {
    const legStart = waypoints[w];
    const legGoal = waypoints[w + 1];
    const [sc, sr] = toGrid(legStart);
    const [gc, gr] = toGrid(legGoal);

    const openSet = new Set<string>([key(sc, sr)]);
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[key(sc, sr), 0]]);
    const fScore = new Map<string, number>([[key(sc, sr), Math.hypot(gc - sc, gr - sr)]]);

    let reachedKey = key(sc, sr);
    let bestDistToGoal = Math.hypot(gc - sc, gr - sr);

    let iterations = 0;
    while (openSet.size > 0 && iterations < 3500) {
      iterations++;
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

      for (const [dc, dr, moveLen] of dirs) {
        const nc = cc + dc;
        const nr = cr + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;

        const [mx, my] = toMeters(nc, nr);
        let penalty = 1.0;
        for (const obs of obstacles) {
          const d = Math.hypot(mx - obs.x, my - obs.y);
          const safeR = obs.safetyRadius ?? obs.radius * 1.48;
          if (d < obs.radius) {
            penalty += 70;
          } else if (d < safeR) {
            const bufferFactor = 1 - (d - obs.radius) / Math.max(0.12, safeR - obs.radius);
            penalty += 26 * Math.pow(bufferFactor, 1.4);
          }
        }

        const stepCost = moveLen * penalty;
        const nKey = key(nc, nr);
        const tentativeG = (gScore.get(current) ?? Infinity) + stepCost;

        if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
          cameFrom.set(nKey, current);
          gScore.set(nKey, tentativeG);
          fScore.set(nKey, tentativeG + Math.hypot(gc - nc, gr - nr) * 0.98);
          openSet.add(nKey);
        }
      }
    }

    const legPath: Array<[number, number]> = [];
    let curr: string | undefined = reachedKey;
    while (curr) {
      const [c, r] = curr.split(',').map(Number);
      legPath.unshift(toMeters(c, r));
      curr = cameFrom.get(curr);
    }
    if (legPath.length === 0) {
      legPath.push(legStart, legGoal);
    } else {
      legPath[0] = legStart;
      legPath[legPath.length - 1] = legGoal;
    }

    if (w > 0) legPath.shift();
    fullPath.push(...legPath);
  }

  let smoothed = fullPath;
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
  let maxSlope = 10.5;
  let minClearance = 1.6;

  for (let i = 1; i < smoothed.length; i++) {
    distMap += Math.hypot(
      smoothed[i][0] - smoothed[i - 1][0],
      smoothed[i][1] - smoothed[i - 1][1]
    );
    const s = sampleSyntheticSlope(smoothed[i][0], smoothed[i][1], obstacles);
    if (s > maxSlope) maxSlope = s;

    for (const obs of obstacles) {
      const cl = Math.hypot(smoothed[i][0] - obs.x, smoothed[i][1] - obs.y) - obs.radius;
      if (cl < minClearance) minClearance = cl;
    }
  }

  const distanceMeters = Number((distMap * 14.8).toFixed(1));
  const estimatedSeconds = Math.max(8, Math.round(distanceMeters / 1.2));

  return {
    points: smoothed,
    distanceMeters,
    estimatedSeconds,
    maxSlopeDeg: Number(Math.min(36, maxSlope).toFixed(1)),
    minSafetyMarginMeters: Number(Math.max(0.32, minClearance).toFixed(2)),
    isCompletelySafe: maxSlope < 23,
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

  const SAMPLES = 28;
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
        elev = Number((25 + rawH * 10).toFixed(2));
      }
    }

    profile.push({
      dist: Number((targetDist * 14.8).toFixed(1)),
      elev,
      slope: sampleSyntheticSlope(x, y, obstacles),
    });
  }
  return profile;
}
