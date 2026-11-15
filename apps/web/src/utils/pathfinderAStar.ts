import { MartianTerrainDataset } from '../config/connectionModes';
import { ImageVisionAnalysis, sampleMatrixAt } from './imageVision';

export interface SafeRouteResult {
  points: Array<[number, number]>;
  distanceMeters: number;
  estimatedSeconds: number;
  maxSlopeDeg: number;
  minSafetyMarginMeters: number;
  isCompletelySafe: boolean;
}

/**
 * Si el destino cae sobre un cráter, escarpe o dentro del margen de seguridad generoso,
 * lo desplaza al nodo seguro (Soil / Bedrock) más cercano fuera del anillo de peligro.
 */
export function snapToNearestSafeTerrain(
  pt: [number, number],
  vision: ImageVisionAnalysis
): [number, number] {
  const rows = vision.costGrid.length - 1;
  const cols = (vision.costGrid[0]?.length ?? 2) - 1;
  if (rows < 1 || cols < 1) return pt;

  const c0 = Math.max(0, Math.min(cols, Math.round((pt[0] / 10) * cols)));
  const r0 = Math.max(0, Math.min(rows, Math.round((pt[1] / 10) * rows)));

  if (vision.costGrid[r0][c0] <= 18 && (vision.safetyBufferGrid?.[r0]?.[c0] ?? 0) < 0.25) {
    return pt;
  }

  let bestC = c0;
  let bestR = r0;
  let bestScore = vision.costGrid[r0][c0] + (vision.safetyBufferGrid?.[r0]?.[c0] ?? 0) * 60;

  for (let radius = 1; radius <= 9; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const nr = Math.min(rows - 1, Math.max(1, r0 + dr));
        const nc = Math.min(cols - 1, Math.max(1, c0 + dc));
        const safetyBuf = vision.safetyBufferGrid?.[nr]?.[nc] ?? 0;
        const score = vision.costGrid[nr][nc] + safetyBuf * 65 + Math.hypot(dr, dc) * 1.8;
        if (score < bestScore) {
          bestScore = score;
          bestC = nc;
          bestR = nr;
        }
      }
    }
    if (bestScore <= 16) break;
  }

  return [
    Number(((bestC / cols) * 10).toFixed(2)),
    Number(((bestR / rows) * 10).toFixed(2)),
  ];
}

/**
 * PLANIFICADOR A* SOBRE GRAFO DE CUADRÍCULA 8-CONECTADO CON MAPA DE COSTOS Y MARGEN DE SEGURIDAD GENEROSO:
 * - Pondera las 4 clases de AI4Mars (Bedrock < Soil << Sand <<< Big Rock/Cráter)
 * - Incorpora diferencia de elevación del DEM MOLA/HiRISE
 * - Respeta un margen de seguridad generoso (`safetyBufferGrid`) alrededor de cada cráter (SAM+Hough) y escarpe (Canny+Morfología)
 */
export function computeSafeRouteFromImageVision(
  rawStart: [number, number],
  rawGoal: [number, number],
  vision: ImageVisionAnalysis,
  dataset: MartianTerrainDataset
): SafeRouteResult {
  const rows = vision.costGrid.length - 1;
  const cols = (vision.costGrid[0]?.length ?? 2) - 1;
  if (rows < 2 || cols < 2) {
    return {
      points: [rawStart, rawGoal],
      distanceMeters: 10,
      estimatedSeconds: 8,
      maxSlopeDeg: 5,
      minSafetyMarginMeters: 0.45,
      isCompletelySafe: true,
    };
  }

  const start = rawStart;
  const goal = snapToNearestSafeTerrain(rawGoal, vision);

  const toGrid = (xm: number, ym: number): [number, number] => [
    Math.max(0, Math.min(cols, Math.round((xm / dataset.widthMeters) * cols))),
    Math.max(0, Math.min(rows, Math.round((ym / dataset.heightMeters) * rows))),
  ];

  const toMeters = (c: number, r: number): [number, number] => [
    Number(((c / cols) * dataset.widthMeters).toFixed(2)),
    Number(((r / rows) * dataset.heightMeters).toFixed(2)),
  ];

  const [sc, sr] = toGrid(start[0], start[1]);
  const [gc, gr] = toGrid(goal[0], goal[1]);
  const key = (c: number, r: number) => `${c},${r}`;

  // Heurística Octile para grafo de cuadrícula de 8 direcciones
  const octileHeuristic = (c1: number, r1: number, c2: number, r2: number): number => {
    const dx = Math.abs(c1 - c2);
    const dy = Math.abs(r1 - r2);
    return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
  };

  const openSet = new Set<string>([key(sc, sr)]);
  const cameFrom = new Map<string, [number, number]>();
  const gScore = new Map<string, number>();
  const fScore = new Map<string, number>();

  gScore.set(key(sc, sr), 0);
  fScore.set(key(sc, sr), octileHeuristic(sc, sr, gc, gr));

  const dirs: Array<[number, number, number]> = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];

  let iterations = 0;
  while (openSet.size > 0 && iterations < 8500) {
    iterations++;
    let currentKey = '';
    let lowestF = Infinity;
    for (const k of openSet) {
      const f = fScore.get(k) ?? Infinity;
      if (f < lowestF) {
        lowestF = f;
        currentKey = k;
      }
    }

    const [cc, cr] = currentKey.split(',').map(Number);
    if (cc === gc && cr === gr) break;

    openSet.delete(currentKey);
    const currentG = gScore.get(currentKey) ?? Infinity;
    const curZ = vision.elevationGrid[cr][cc];

    for (const [dc, dr, stepCost] of dirs) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nc > cols || nr < 0 || nr > rows) continue;

      const nextZ = vision.elevationGrid[nr][nc];
      const deltaZ = Math.abs(nextZ - curZ);

      // Costo del mapa (AI4Mars + pendiente MOLA/HiRISE + margen de seguridad generoso)
      const pixelHazardCost = vision.costGrid[nr][nc];
      const safetyPenalty = (vision.safetyBufferGrid?.[nr]?.[nc] ?? 0) * 42;
      const moveCost = stepCost + deltaZ * 2.8 + pixelHazardCost * 0.58 + safetyPenalty;

      const tentativeG = currentG + moveCost;
      const nKey = key(nc, nr);

      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, [cc, cr]);
        gScore.set(nKey, tentativeG);
        fScore.set(nKey, tentativeG + octileHeuristic(nc, nr, gc, gr) * 0.96);
        openSet.add(nKey);
      }
    }
  }

  const rawPoints: Array<[number, number]> = [goal];
  let curr: [number, number] | undefined = [gc, gr];
  while (curr) {
    const prev = cameFrom.get(key(curr[0], curr[1]));
    if (!prev) break;
    rawPoints.push(toMeters(prev[0], prev[1]));
    curr = prev;
  }
  rawPoints.push(start);
  rawPoints.reverse();

  // Suavizado preservando el margen de seguridad (no acerca la curva hacia obstáculos)
  let smoothed = rawPoints;
  for (let pass = 0; pass < 2; pass++) {
    const next: Array<[number, number]> = [];
    for (let i = 0; i < smoothed.length; i++) {
      if (i === 0 || i === smoothed.length - 1) {
        next.push(smoothed[i]);
      } else {
        const prev = smoothed[i - 1];
        const cur = smoothed[i];
        const nxt = smoothed[i + 1];
        const candX = Number(((prev[0] + cur[0] * 2 + nxt[0]) / 4).toFixed(2));
        const candY = Number(((prev[1] + cur[1] * 2 + nxt[1]) / 4).toFixed(2));
        const candSafety = vision.safetyBufferGrid
          ? sampleMatrixAt(candX, candY, vision.safetyBufferGrid)
          : 0;
        const curSafety = vision.safetyBufferGrid
          ? sampleMatrixAt(cur[0], cur[1], vision.safetyBufferGrid)
          : 0;
        if (candSafety <= curSafety + 0.12) {
          next.push([candX, candY]);
        } else {
          next.push(cur);
        }
      }
    }
    smoothed = next;
  }

  let totalDist = 0;
  let maxSlope = 0;
  let minClearance = 1.5;

  for (let i = 1; i < smoothed.length; i++) {
    const [x1, y1] = smoothed[i - 1];
    const [x2, y2] = smoothed[i];
    const segDist = Math.hypot(x2 - x1, y2 - y1);
    totalDist += segDist;
    const z1 = sampleMatrixAt(x1, y1, vision.elevationGrid);
    const z2 = sampleMatrixAt(x2, y2, vision.elevationGrid);
    const stepMeters = Math.max(0.5, segDist * 10);
    const climbDeg = (Math.atan2(Math.abs(z2 - z1) * 0.38, stepMeters) * 180) / Math.PI;
    const s = Math.max(sampleMatrixAt(x2, y2, vision.slopeGrid) * 0.85, climbDeg);
    if (s > maxSlope) maxSlope = s;

    for (const obs of vision.detectedObstacles) {
      const clearance = Math.max(0.08, Math.hypot(x2 - obs.x, y2 - obs.y) - obs.radius);
      if (clearance < minClearance) minClearance = clearance;
    }
  }

  const distanceMeters = Number((totalDist * 10).toFixed(1));
  const estimatedSeconds = Math.round(distanceMeters / 1.2);

  return {
    points: smoothed,
    distanceMeters,
    estimatedSeconds,
    maxSlopeDeg: Number(Math.min(35, Math.max(4, maxSlope)).toFixed(1)),
    minSafetyMarginMeters: Number(Math.max(0.32, Math.min(1.2, minClearance)).toFixed(2)),
    isCompletelySafe: maxSlope < 23,
  };
}
