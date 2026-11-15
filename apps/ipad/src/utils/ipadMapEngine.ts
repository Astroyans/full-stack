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
  slopeDeg: number;
  severity: 'low' | 'medium' | 'high';
  kind?: string;
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

const DEFAULT_MARS_CRATERS: DetectedCraterHazard[] = [
  { id: 'crater-1', x: 2.0, y: 5.0, radius: 0.48, slopeDeg: 34.2, severity: 'high' },
  { id: 'crater-2', x: 2.7, y: 5.1, radius: 0.44, slopeDeg: 31.8, severity: 'high' },
  { id: 'crater-3', x: 3.9, y: 4.8, radius: 0.55, slopeDeg: 28.4, severity: 'high' },
  { id: 'crater-4', x: 5.2, y: 5.5, radius: 0.62, slopeDeg: 33.0, severity: 'high' },
  { id: 'crater-5', x: 6.1, y: 3.8, radius: 0.50, slopeDeg: 26.5, severity: 'medium' },
  { id: 'crater-6', x: 4.5, y: 6.9, radius: 0.52, slopeDeg: 29.1, severity: 'high' },
  { id: 'crater-7', x: 8.2, y: 6.8, radius: 0.85, slopeDeg: 36.0, severity: 'high' },
  { id: 'crater-8', x: 1.7, y: 3.7, radius: 0.42, slopeDeg: 24.5, severity: 'medium' },
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
      let penalty = 1;
      for (const obs of obstacles) {
        const d = Math.hypot(mx - obs.x, my - obs.y);
        if (d < obs.radius * 0.95) {
          penalty += 38;
        } else if (d < obs.radius * 1.35) {
          penalty += 8 * (1 - d / (obs.radius * 1.35));
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
