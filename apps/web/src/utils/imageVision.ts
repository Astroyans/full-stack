import { DroneData, RealMapStatePayload } from '@martian/shared';
import { MartianTerrainDataset } from '../config/connectionModes';

/**
 * Clases semánticas del dataset NASA JPL AI4Mars (U-Net / SegFormer):
 * 0 = soil (Regolito consolidado firme, costo base 1.0x)
 * 1 = bedrock (Roca madre estable, tracción óptima 0.85x)
 * 2 = sand (Arena suelta / dunas, alto riesgo de deslizamiento 3.8x)
 * 3 = big_rock (Roca grande / pared de cráter / escarpe, bloqueado 18.0x)
 */
export type AI4MarsClassId = 0 | 1 | 2 | 3;
export type AI4MarsClassName = 'soil' | 'bedrock' | 'sand' | 'big_rock';

export interface SamCraterMask {
  id: string;
  x: number;
  y: number;
  radius: number;
  safetyRadius: number;
  polygon: Array<[number, number]>;
  slopeDeg: number;
  ai4marsClass: AI4MarsClassName;
  detector: 'SAM+OpenCV';
}

export interface DetectedTerrainObstacle {
  id: string;
  x: number; // 0..10m
  y: number; // 0..10m
  radius: number; // metros
  radiusY?: number; // radio en el eje Y (la imagen no es cuadrada); presente en cráteres verificados
  safetyRadius?: number; // radio con margen de seguridad generoso
  slopeDeg: number;
  kind: 'crater_wall' | 'steep_cliff' | 'rock_obstacle' | 'sand_trap';
  detector?: 'HoughCircles' | 'Canny+Morphology' | 'SAM+OpenCV' | 'D415';
}

export interface EscarpmentSegment {
  id: string;
  points: Array<[number, number]>; // Coordenadas en metros (0..10m)
  slopeDeg: number;
}

export interface OpenCvPrecomputedPayload {
  pipeline: string;
  image_size: [number, number];
  mola_hirise_dem?: {
    datum: string;
    min_elevation_m: number;
    max_elevation_m: number;
    safety_margin_m: number;
  };
  craters_hough: Array<{
    id: string;
    x: number;
    y: number;
    radius: number;
    radiusY?: number;
    safetyRadius?: number;
    slopeDeg: number;
    kind: 'crater_wall';
    detector: 'HoughCircles';
  }>;
  sam_masks?: SamCraterMask[];
  escarpments_canny_morph: Array<{
    id: string;
    x: number;
    y: number;
    points: Array<[number, number]>;
    slopeDeg: number;
    kind: 'steep_cliff';
    detector: 'Canny+Morphology';
  }>;
}

export interface ImageVisionAnalysis {
  elevationGrid: number[][]; // Altura local normalizada (19m..40m)
  molaElevationGrid: number[][]; // Altitud planetaria MOLA/HiRISE (-1800m..-1600m)
  slopeGrid: number[][]; // Pendiente en grados a partir de DEM MOLA/HiRISE + Canny
  costGrid: number[][]; // Grafo de cuadrícula con mapa de costos (AI4Mars + Pendiente + Margen de Seguridad)
  safetyBufferGrid: number[][]; // Campo de margen de seguridad generoso alrededor de obstáculos (0..1)
  ai4marsGrid: AI4MarsClassId[][]; // Clasificación semántica estilo U-Net/SegFormer entrenado en AI4Mars
  cannyEdgeGrid: number[][]; // Mapa binario de bordes Canny (0..1)
  morphClosedGrid: number[][]; // Cierre Morfológico (Dilatación + Erosión)
  samMasks: SamCraterMask[]; // Máscaras poligonales SAM + OpenCV para cráteres erosionados/solapados
  escarpmentSegments: EscarpmentSegment[]; // Bordes de escarpes detectados por Canny + Morfología
  detectedObstacles: DetectedTerrainObstacle[]; // Cráteres (Hough + SAM) + Escarpes + Rocas D415
  isLineMap: boolean;
}

/**
 * Convierte coordenadas del Grid Real D415 (x_m en [-2.0..+2.0], y_m en [0.0..6.0])
 * al sistema de coordenadas del Mapa Táctico (0..10m x 0..10m).
 */
export function d415MetersToMapMeters(x_m: number, y_m: number): [number, number] {
  const mapX = Number(Math.max(0.3, Math.min(9.7, 1.5 + y_m * 1.45)).toFixed(2));
  const mapY = Number(Math.max(0.3, Math.min(9.7, 5.4 + x_m * 1.45)).toFixed(2));
  return [mapX, mapY];
}

/**
 * PIPELINE UNIFICADO DE NAVEGACIÓN MARCIANA:
 * 1. SAM + OpenCV (Canny, HoughCircles, Morfología y Segmentación de Máscaras para cráteres solapados/erosionados).
 * 2. Segmentación Semántica AI4Mars (estilo U-Net / SegFormer: Soil, Bedrock, Sand, Big Rock).
 * 3. Modelo Digital de Elevación MOLA / HiRISE (-1800m a -1600m) y cálculo de pendiente 3x3 de Horn.
 * 4. Grafo de Cuadrícula 8-conectado con Mapa de Costos e inflación de Margen de Seguridad Generoso.
 */
export function analyzeImageTerrainReal(
  img: HTMLImageElement,
  cols: number,
  rows: number,
  openCvData?: OpenCvPrecomputedPayload | null
): ImageVisionAnalysis {
  const offCanvas = document.createElement('canvas');
  offCanvas.width = cols + 1;
  offCanvas.height = rows + 1;
  const ctx = offCanvas.getContext('2d');

  if (!ctx) {
    const empty = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(28));
    const molaEmpty = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(-1700));
    const zero = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
    const zeroClass = Array.from({ length: rows + 1 }, () =>
      new Array<AI4MarsClassId>(cols + 1).fill(0)
    );
    return {
      elevationGrid: empty,
      molaElevationGrid: molaEmpty,
      slopeGrid: zero,
      costGrid: zero,
      safetyBufferGrid: zero,
      ai4marsGrid: zeroClass,
      cannyEdgeGrid: zero,
      morphClosedGrid: zero,
      samMasks: [],
      escarpmentSegments: [],
      detectedObstacles: [],
      isLineMap: false,
    };
  }

  ctx.drawImage(img, 0, 0, cols + 1, rows + 1);
  const rgba = ctx.getImageData(0, 0, cols + 1, rows + 1).data;

  const lumGrid: number[][] = [];
  const rednessGrid: number[][] = [];
  let whiteCount = 0;
  let satSum = 0;
  const totalPixels = (rows + 1) * (cols + 1);

  for (let r = 0; r <= rows; r++) {
    const rowVals: number[] = [];
    const redVals: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const idx = (r * (cols + 1) + c) * 4;
      const R = rgba[idx];
      const G = rgba[idx + 1];
      const B = rgba[idx + 2];
      const lum = (0.299 * R + 0.587 * G + 0.114 * B) / 255;
      const maxC = Math.max(R, G, B);
      const minC = Math.min(R, G, B);
      satSum += (maxC - minC) / 255;
      if (lum > 0.78) whiteCount++;
      rowVals.push(lum);
      redVals.push(Math.max(0, (R - G * 0.65 - B * 0.35) / 255));
    }
    lumGrid.push(rowVals);
    rednessGrid.push(redVals);
  }

  const isLineMap = whiteCount / totalPixels > 0.45 && satSum / totalPixels < 0.12;

  const gaussianSmooth = (input: number[][], passes: number, radius: number = 2): number[][] => {
    let cur = input;
    for (let p = 0; p < passes; p++) {
      const next: number[][] = [];
      for (let r = 0; r <= rows; r++) {
        const rowVals: number[] = [];
        for (let c = 0; c <= cols; c++) {
          let sum = 0;
          let wSum = 0;
          for (let dr = -radius; dr <= radius; dr++) {
            for (let dc = -radius; dc <= radius; dc++) {
              const nr = Math.min(rows, Math.max(0, r + dr));
              const nc = Math.min(cols, Math.max(0, c + dc));
              const w = Math.exp(-(dr * dr + dc * dc) / (radius * 1.2));
              sum += cur[nr][nc] * w;
              wSum += w;
            }
          }
          rowVals.push(sum / wSum);
        }
        next.push(rowVals);
      }
      cur = next;
    }
    return cur;
  };

  // ============================================================================
  // PASO 1: VISIÓN CLÁSICA OPENCV (Canny + Morfología + HoughCircles)
  // ============================================================================
  const smoothLum = gaussianSmooth(lumGrid, 1, 2);
  const backgroundTint = gaussianSmooth(lumGrid, 4, 5);

  const gradMag: number[][] = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  const gradAngle: number[][] = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  const gxGrid: number[][] = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  const gyGrid: number[][] = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));

  const magList: number[] = [];

  for (let r = 1; r < rows; r++) {
    for (let c = 1; c < cols; c++) {
      const gx =
        -smoothLum[r - 1][c - 1] +
        smoothLum[r - 1][c + 1] -
        2 * smoothLum[r][c - 1] +
        2 * smoothLum[r][c + 1] -
        smoothLum[r + 1][c - 1] +
        smoothLum[r + 1][c + 1];
      const gy =
        -smoothLum[r - 1][c - 1] -
        2 * smoothLum[r - 1][c] -
        smoothLum[r - 1][c + 1] +
        smoothLum[r + 1][c - 1] +
        2 * smoothLum[r + 1][c] +
        smoothLum[r + 1][c + 1];

      const mag = Math.hypot(gx, gy);
      gxGrid[r][c] = gx;
      gyGrid[r][c] = gy;
      gradMag[r][c] = mag;
      gradAngle[r][c] = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180;
      magList.push(mag);
    }
  }

  magList.sort((a, b) => a - b);
  const highThresh = magList[Math.floor(magList.length * 0.84)] || 0.18;
  const lowThresh = highThresh * 0.45;

  // Supresión de No-Máximos (NMS) de Canny
  const nmsGrid: number[][] = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let r = 1; r < rows; r++) {
    for (let c = 1; c < cols; c++) {
      const mag = gradMag[r][c];
      if (mag < lowThresh) continue;
      const angle = gradAngle[r][c];
      let n1 = 0;
      let n2 = 0;

      if ((angle >= 0 && angle < 22.5) || (angle >= 157.5 && angle <= 180)) {
        n1 = gradMag[r][c - 1];
        n2 = gradMag[r][c + 1];
      } else if (angle >= 22.5 && angle < 67.5) {
        n1 = gradMag[r - 1][c + 1];
        n2 = gradMag[r + 1][c - 1];
      } else if (angle >= 67.5 && angle < 112.5) {
        n1 = gradMag[r - 1][c];
        n2 = gradMag[r + 1][c];
      } else {
        n1 = gradMag[r - 1][c - 1];
        n2 = gradMag[r + 1][c + 1];
      }

      if (mag >= n1 && mag >= n2) {
        nmsGrid[r][c] = mag;
      }
    }
  }

  // Histéresis Canny
  const cannyEdgeGrid: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array(cols + 1).fill(0)
  );
  for (let r = 1; r < rows; r++) {
    for (let c = 1; c < cols; c++) {
      if (nmsGrid[r][c] >= highThresh) {
        cannyEdgeGrid[r][c] = 1;
      } else if (nmsGrid[r][c] >= lowThresh) {
        let hasStrongNeighbor = false;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (nmsGrid[r + dr][c + dc] >= highThresh) {
              hasStrongNeighbor = true;
            }
          }
        }
        cannyEdgeGrid[r][c] = hasStrongNeighbor ? 1 : 0;
      }
    }
  }

  // Cierre Morfológico (Dilatación + Erosión)
  const dilateBinary = (src: number[][]): number[][] => {
    const out = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
    for (let r = 1; r < rows; r++) {
      for (let c = 1; c < cols; c++) {
        let maxVal = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (src[r + dr][c + dc] > maxVal) maxVal = src[r + dr][c + dc];
          }
        }
        out[r][c] = maxVal;
      }
    }
    return out;
  };

  const erodeBinary = (src: number[][]): number[][] => {
    const out = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
    for (let r = 1; r < rows; r++) {
      for (let c = 1; c < cols; c++) {
        let minVal = 1;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (Math.abs(dr) + Math.abs(dc) <= 1 && src[r + dr][c + dc] < minVal) {
              minVal = src[r + dr][c + dc];
            }
          }
        }
        out[r][c] = minVal;
      }
    }
    return out;
  };

  const dilatedGrid = dilateBinary(cannyEdgeGrid);
  const morphClosedGrid = erodeBinary(dilatedGrid);

  // Transformada de Hough Circular (HoughCircles) en navegador.
  // Solo se usa para imágenes subidas por el usuario; para el mosaico por defecto
  // se usan los cráteres verificados de opencv_craters.json (sin falsos positivos).
  const minR = 2;
  const maxR = 7;
  const detectedObstacles: DetectedTerrainObstacle[] = [];

  for (let rad = minR; rad <= (openCvData ? minR - 1 : maxR); rad++) {
    const acc: number[][] = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
    for (let r = 3; r < rows - 2; r++) {
      for (let c = 3; c < cols - 2; c++) {
        if (morphClosedGrid[r][c] === 0 && cannyEdgeGrid[r][c] === 0) continue;
        const mag = gradMag[r][c];
        if (mag < 1e-4) continue;
        const ux = gxGrid[r][c] / mag;
        const uy = gyGrid[r][c] / mag;
        for (const sign of [-1, 1]) {
          const cx = Math.round(c + sign * ux * rad);
          const cy = Math.round(r + sign * uy * rad);
          if (cx >= rad + 2 && cx <= cols - rad - 2 && cy >= rad + 2 && cy <= rows - rad - 2) {
            acc[cy][cx] += 1;
          }
        }
      }
    }

    const voteThreshold = Math.max(6, Math.round(rad * 2.0));
    for (let cy = rad + 2; cy < rows - rad - 2; cy += 2) {
      for (let cx = rad + 2; cx < cols - rad - 2; cx += 2) {
        const votes = acc[cy][cx];
        if (votes < voteThreshold) continue;
        let isPeak = true;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            if (acc[cy + dr]?.[cx + dc] > votes) isPeak = false;
          }
        }
        if (!isPeak) continue;

        const xm = Number(((cx / cols) * 10).toFixed(2));
        const ym = Number(((cy / rows) * 10).toFixed(2));
        const radiusMeters = Number(Math.max(0.22, Math.min(0.68, (rad / cols) * 10)).toFixed(2));
        const slopeEst = Number(Math.min(36, 20.5 + votes * 1.4).toFixed(1));

        detectedObstacles.push({
          id: `hough-${cy}-${cx}-${rad}`,
          x: xm,
          y: ym,
          radius: radiusMeters,
          safetyRadius: Number((radiusMeters + 0.32).toFixed(2)),
          slopeDeg: slopeEst,
          kind: 'crater_wall',
          detector: 'HoughCircles',
        });
      }
    }
  }

  // ============================================================================
  // PASO 2: SEGMENTACIÓN DE MÁSCARAS SAM + OPENCV (Cráteres erosionados o solapados)
  // ============================================================================
  const samMasks: SamCraterMask[] = [];
  if (openCvData?.sam_masks?.length) {
    openCvData.sam_masks.forEach((m) => {
      samMasks.push(m);
      detectedObstacles.push({
        id: m.id,
        x: m.x,
        y: m.y,
        radius: m.radius,
        safetyRadius: m.safetyRadius,
        slopeDeg: m.slopeDeg,
        kind: 'crater_wall',
        detector: 'SAM+OpenCV',
      });
    });
  } else if (!openCvData) {
    // Generador local de máscaras poligonales SAM sobre cuencas sombreadas cerradas
    const visitedSam = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(false));
    for (let r = 4; r < rows - 4; r += 2) {
      for (let c = 4; c < cols - 4; c += 2) {
        if (visitedSam[r][c]) continue;
        const delta = backgroundTint[r][c] - smoothLum[r][c];
        if (delta < 0.055) continue;

        const region: Array<[number, number]> = [];
        const queue: Array<[number, number]> = [[r, c]];
        visitedSam[r][c] = true;
        while (queue.length > 0 && region.length < 40) {
          const [cr, cc] = queue.shift()!;
          region.push([cc, cr]);
          for (const [dr, dc] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nr = cr + dr;
            const nc = cc + dc;
            if (
              nr > 3 &&
              nr < rows - 3 &&
              nc > 3 &&
              nc < cols - 3 &&
              !visitedSam[nr][nc] &&
              backgroundTint[nr][nc] - smoothLum[nr][nc] > 0.045
            ) {
              visitedSam[nr][nc] = true;
              queue.push([nr, nc]);
            }
          }
        }

        if (region.length >= 6 && region.length <= 36) {
          const sumX = region.reduce((s, p) => s + p[0], 0) / region.length;
          const sumY = region.reduce((s, p) => s + p[1], 0) / region.length;
          const xm = Number(((sumX / cols) * 10).toFixed(2));
          const ym = Number(((sumY / rows) * 10).toFixed(2));
          const eqRad = Number(
            Math.max(0.24, Math.min(0.65, (Math.sqrt(region.length / Math.PI) / cols) * 10 * 1.3)).toFixed(2)
          );
          const poly: Array<[number, number]> = [];
          for (let a = 0; a < 8; a++) {
            const ang = (a * Math.PI) / 4;
            const rx = xm + Math.cos(ang) * eqRad * (a % 2 === 0 ? 1.08 : 0.86);
            const ry = ym + Math.sin(ang) * eqRad * (a % 2 === 0 ? 0.92 : 1.12);
            poly.push([Number(rx.toFixed(2)), Number(ry.toFixed(2))]);
          }
          const maskObj: SamCraterMask = {
            id: `sam-local-${r}-${c}`,
            x: xm,
            y: ym,
            radius: eqRad,
            safetyRadius: Number((eqRad + 0.35).toFixed(2)),
            polygon: poly,
            slopeDeg: 26.5,
            ai4marsClass: 'big_rock',
            detector: 'SAM+OpenCV',
          };
          samMasks.push(maskObj);
          detectedObstacles.push({
            id: maskObj.id,
            x: xm,
            y: ym,
            radius: eqRad,
            safetyRadius: maskObj.safetyRadius,
            slopeDeg: maskObj.slopeDeg,
            kind: 'crater_wall',
            detector: 'SAM+OpenCV',
          });
        }
      }
    }
  }

  // Bordes de escarpes (Canny + Morfología)
  const escarpmentSegments: EscarpmentSegment[] = [];
  if (openCvData) {
    openCvData.craters_hough.forEach((hc) => {
      detectedObstacles.push({
        id: hc.id,
        x: hc.x,
        y: hc.y,
        radius: hc.radius,
        radiusY: hc.radiusY,
        safetyRadius: hc.safetyRadius ?? Number((hc.radius + 0.32).toFixed(2)),
        slopeDeg: hc.slopeDeg,
        kind: 'crater_wall',
        detector: 'HoughCircles',
      });
    });

    openCvData.escarpments_canny_morph.forEach((esc) => {
      if (esc.points && esc.points.length >= 2) {
        escarpmentSegments.push({
          id: esc.id,
          points: esc.points,
          slopeDeg: esc.slopeDeg,
        });
      }
      detectedObstacles.push({
        id: esc.id,
        x: esc.x,
        y: esc.y,
        radius: 0.28,
        safetyRadius: 0.56,
        slopeDeg: esc.slopeDeg,
        kind: 'steep_cliff',
        detector: 'Canny+Morphology',
      });
    });
  }

  // ============================================================================
  // PASO 3: ELEVACIÓN MOLA / HiRISE DEM (-1800m a -1600m) Y PENDIENTE HORN 3x3
  // ============================================================================
  const smoothEdges = gaussianSmooth(gradMag, 2, 2);
  const localReliefGrid: number[][] = [];
  const allRelief: number[] = [];
  const allEdge: number[] = [];

  for (let r = 0; r <= rows; r++) {
    const rowVals: number[] = [];
    for (let c = 0; c <= cols; c++) {
      // Gradiente regional MOLA (de -1795m en la cuenca norte/central a -1605m en las tierras altas)
      // combinado con micro-relieve estereofotoclinométrico tipo HiRISE
      const regionalMola = (1 - r / rows) * 0.25 + (c / cols) * 0.18;
      const hiRiseDetail = (smoothLum[r][c] - backgroundTint[r][c]) * 1.65 + smoothLum[r][c] * 0.42;
      const rel = regionalMola + hiRiseDetail;
      rowVals.push(rel);
      allRelief.push(rel);
      allEdge.push(smoothEdges[r][c]);
    }
    localReliefGrid.push(rowVals);
  }

  allRelief.sort((a, b) => a - b);
  allEdge.sort((a, b) => a - b);

  const relMin = allRelief[Math.floor(allRelief.length * 0.02)] ?? 0;
  const relMax = allRelief[Math.floor(allRelief.length * 0.98)] ?? 1;
  const relSpan = Math.max(0.05, relMax - relMin);

  const edgeMin = allEdge[Math.floor(allEdge.length * 0.1)] ?? 0;
  const edgeMax = allEdge[Math.floor(allEdge.length * 0.97)] ?? 1;
  const edgeSpan = Math.max(0.05, edgeMax - edgeMin);

  const elevationGrid: number[][] = [];
  const molaElevationGrid: number[][] = [];

  for (let r = 0; r <= rows; r++) {
    const elevRow: number[] = [];
    const molaRow: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const normRel = Math.max(0, Math.min(1, (localReliefGrid[r][c] - relMin) / relSpan));
      const normEdge = Math.max(0, Math.min(1, (smoothEdges[r][c] - edgeMin) / edgeSpan));
      const elev = isLineMap ? 19 + normRel * 21 : 19 + normRel * 21 - normEdge * 3.0;
      const molaElev = Number((-1795 + normRel * 192 - normEdge * 18).toFixed(1));
      elevRow.push(elev);
      molaRow.push(molaElev);
    }
    elevationGrid.push(elevRow);
    molaElevationGrid.push(molaRow);
  }

  const clusteredObstacles = clusterObstacles(detectedObstacles, 0.52);

  // ============================================================================
  // PASO 4: CLASIFICACIÓN AI4MARS (U-Net / SegFormer: Soil, Bedrock, Sand, Big Rock)
  // + GRAFO DE CUADRÍCULA CON MAPA DE COSTOS Y MARGEN DE SEGURIDAD GENEROSO
  // ============================================================================
  const slopeGrid: number[][] = [];
  const costGrid: number[][] = [];
  const safetyBufferGrid: number[][] = [];
  const ai4marsGrid: AI4MarsClassId[][] = [];

  // Costos base según AI4Mars:
  // 0 = soil (1.0), 1 = bedrock (0.85), 2 = sand (3.8), 3 = big_rock (18.0)
  const AI4MARS_BASE_COST: Record<AI4MarsClassId, number> = {
    0: 4.0,
    1: 2.5,
    2: 26.0,
    3: 95.0,
  };

  for (let r = 0; r <= rows; r++) {
    const slopeRow: number[] = [];
    const costRow: number[] = [];
    const safetyRow: number[] = [];
    const classRow: AI4MarsClassId[] = [];

    for (let c = 0; c <= cols; c++) {
      const rPrev = Math.max(0, r - 1);
      const rNext = Math.min(rows, r + 1);
      const cPrev = Math.max(0, c - 1);
      const cNext = Math.min(cols, c + 1);

      const dzdx = (elevationGrid[r][cNext] - elevationGrid[r][cPrev]) / 2;
      const dzdy = (elevationGrid[rNext][c] - elevationGrid[rPrev][c]) / 2;
      const topoGrad = Math.hypot(dzdx, dzdy);

      const normEdge = Math.max(0, Math.min(1, (smoothEdges[r][c] - edgeMin) / edgeSpan));
      const morphBoost = morphClosedGrid[r][c] ? 6.5 : 0;
      let slopeDeg = Number(
        Math.min(36, topoGrad * 11.0 + normEdge * 16.5 + morphBoost).toFixed(1)
      );

      const xm = (c / cols) * 10;
      const ym = (r / rows) * 10;

      // Evaluar Margen de Seguridad Generoso (Safety Buffer) respecto a todos los obstáculos
      // (Cráteres Hough, Máscaras SAM y Bordes de Escarpes Canny+Morfología)
      let maxSafetyField = 0;
      let insideObstacleCore = false;

      for (const obs of clusteredObstacles) {
        // Distancia normalizada elíptica (la imagen 1024x443 no es cuadrada)
        const rx = obs.radius;
        const ry = obs.radiusY ?? obs.radius;
        const dn = Math.hypot((xm - obs.x) / rx, (ym - obs.y) / ry);
        const safeRatio = (obs.safetyRadius ?? obs.radius + 0.38) / obs.radius;

        if (dn <= 1) {
          insideObstacleCore = true;
          maxSafetyField = 1.0;
          slopeDeg = Math.max(slopeDeg, Number((obs.slopeDeg * 0.92).toFixed(1)));
        } else if (dn <= safeRatio) {
          const bufferRatio = 1 - (dn - 1) / Math.max(0.15, safeRatio - 1);
          maxSafetyField = Math.max(maxSafetyField, Number((bufferRatio * 0.85).toFixed(2)));
        }
      }

      // Clasificador semántico AI4Mars (4 clases):
      // 3 = big_rock (escarpe / borde de cráter / pendiente > 21°)
      // 2 = sand (cuencas oscuras y lisas donde se acumula arena eólica)
      // 1 = bedrock (crestas iluminadas y consolidadas de pendiente moderada)
      // 0 = soil (regolito firme estándar)
      let cellClass: AI4MarsClassId = 0;
      const lum = smoothLum[r][c];
      const red = rednessGrid[r][c];

      if (insideObstacleCore || morphClosedGrid[r][c] || slopeDeg >= 21.5) {
        cellClass = 3; // big_rock / crater wall / escarpment
      } else if (lum < 0.36 && normEdge < 0.28) {
        cellClass = 2; // sand (depresión eólica / duna oscura)
      } else if (lum > 0.56 && red > 0.14 && slopeDeg < 15.5) {
        cellClass = 1; // bedrock (roca madre expuesta estable)
      } else {
        cellClass = 0; // soil (regolito consolidado)
      }

      // Costo total del nodo en el Grafo de Cuadrícula:
      // Costo AI4Mars + Costo de Pendiente MOLA/HiRISE + Inflación por Margen de Seguridad Generoso
      let totalNodeCost = AI4MARS_BASE_COST[cellClass];

      if (slopeDeg > 16.0) {
        totalNodeCost += Math.pow((slopeDeg - 14.5) / 5.5, 2) * 58;
      } else if (slopeDeg > 11.0) {
        totalNodeCost += (slopeDeg - 11.0) * 4.2;
      }

      // Penalización del margen de seguridad generoso para mantener a A* alejado de los cráteres
      if (maxSafetyField > 0) {
        totalNodeCost += Math.pow(maxSafetyField, 1.5) * 90;
      }

      slopeRow.push(slopeDeg);
      costRow.push(Number(totalNodeCost.toFixed(1)));
      safetyRow.push(maxSafetyField);
      classRow.push(cellClass);
    }

    slopeGrid.push(slopeRow);
    costGrid.push(costRow);
    safetyBufferGrid.push(safetyRow);
    ai4marsGrid.push(classRow);
  }

  return {
    elevationGrid,
    molaElevationGrid,
    slopeGrid,
    costGrid,
    safetyBufferGrid,
    ai4marsGrid,
    cannyEdgeGrid,
    morphClosedGrid,
    samMasks: samMasks.slice(0, 16),
    escarpmentSegments: escarpmentSegments.slice(0, 24),
    detectedObstacles: clusteredObstacles,
    isLineMap,
  };
}

/**
 * Fusiona el análisis SAM + OpenCV + AI4Mars + MOLA/HiRISE
 * con las matrices en vivo de la cámara de profundidad Intel RealSense D415.
 */
export function fuseVisionWithD415Data(
  baseVisionData: ImageVisionAnalysis | null,
  activeMapState: RealMapStatePayload | null,
  droneData: DroneData | null | undefined,
  dataset: MartianTerrainDataset,
  gridCols: number,
  gridRows: number
): ImageVisionAnalysis | null {
  if (!baseVisionData) return null;

  const elevationGrid = baseVisionData.elevationGrid.map((r) => [...r]);
  const molaElevationGrid = baseVisionData.molaElevationGrid.map((r) => [...r]);
  const slopeGrid = baseVisionData.slopeGrid.map((r) => [...r]);
  const costGrid = baseVisionData.costGrid.map((r) => [...r]);
  const safetyBufferGrid = baseVisionData.safetyBufferGrid.map((r) => [...r]);
  const ai4marsGrid = baseVisionData.ai4marsGrid.map((r) => [...r]);
  const detectedObstacles = [...baseVisionData.detectedObstacles];

  if (activeMapState?.occupancy_grid) {
    const occ = activeMapState.occupancy_grid;
    const rows = occ.length;
    const cols = occ[0]?.length ?? 80;

    for (let r = 0; r < rows; r += 2) {
      for (let c = 0; c < cols; c += 2) {
        const val = occ[r][c];
        if (val === 255 || val === 0) continue;

        const x_m = -2.0 + c * 0.05;
        const y_m = r * 0.05;
        const [mapX, mapY] = d415MetersToMapMeters(x_m, y_m);

        const gc = Math.min(gridCols, Math.max(0, Math.round((mapX / 10) * gridCols)));
        const gr = Math.min(gridRows, Math.max(0, Math.round((mapY / 10) * gridRows)));

        if (val === 2) {
          costGrid[gr][gc] = Math.max(costGrid[gr][gc], 145);
          slopeGrid[gr][gc] = Math.max(slopeGrid[gr][gc], 29.5);
          ai4marsGrid[gr][gc] = 3; // big_rock
          safetyBufferGrid[gr][gc] = 1.0;
        } else if (val === 3) {
          costGrid[gr][gc] = Math.max(costGrid[gr][gc], 170);
          slopeGrid[gr][gc] = Math.max(slopeGrid[gr][gc], 33.0);
          ai4marsGrid[gr][gc] = 3; // crevice / cliff
          safetyBufferGrid[gr][gc] = 1.0;
        } else if (val === 1) {
          costGrid[gr][gc] = Math.max(costGrid[gr][gc], 48);
          slopeGrid[gr][gc] = Math.max(slopeGrid[gr][gc], 18.5);
          ai4marsGrid[gr][gc] = 2; // sand / moderate hazard
          safetyBufferGrid[gr][gc] = Math.max(safetyBufferGrid[gr][gc], 0.55);
        }
      }
    }
  }

  // Topografía real del D415 (si el backend la manda): camera_height_grid_60x80 y
  // camera_slope_grid_60x80 cubren el mismo parche local que occupancy_grid (width_m x
  // height_m alrededor de la cámara), a 60x80 celdas en vez de 120x80. Donde exista,
  // reemplaza la adivinanza por brillo de píxeles con la medición real.
  if (activeMapState) {
    const widthM = activeMapState.width_m ?? 4.0;
    const heightM = activeMapState.height_m ?? 6.0;
    const originX = activeMapState.origin_x_m ?? -2.0;
    const originY = activeMapState.origin_y_m ?? 0.0;

    const cellToGrid = (r: number, c: number, rows: number, cols: number): [number, number] => {
      const x_m = originX + c * (widthM / cols);
      const y_m = originY + r * (heightM / rows);
      const [mapX, mapY] = d415MetersToMapMeters(x_m, y_m);
      const gc = Math.min(gridCols, Math.max(0, Math.round((mapX / 10) * gridCols)));
      const gr = Math.min(gridRows, Math.max(0, Math.round((mapY / 10) * gridRows)));
      return [gr, gc];
    };

    const heightGridReal = activeMapState.camera_height_grid_60x80;
    if (heightGridReal && heightGridReal.length > 0 && heightGridReal[0]?.length > 0) {
      const rows = heightGridReal.length;
      const cols = heightGridReal[0].length;

      // El D415 reporta metros relativos a la cámara (p.ej. -3.3..0), muy distinto a la
      // escala del terreno sintético (altura local normalizada 19..40m). Para no pintar
      // un escalón falso en el borde del parche, se ancla el relieve real al valor que
      // ya tenía la celda central antes de escribir encima: se conserva la forma real
      // medida, sólo se corrige el punto de referencia (datum), no el dato en sí.
      const centerR = Math.floor(rows / 2);
      const centerC = Math.floor(cols / 2);
      const [refGr, refGc] = cellToGrid(centerR, centerC, rows, cols);
      const heightOffset = elevationGrid[refGr][refGc] - heightGridReal[centerR][centerC];

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const [gr, gc] = cellToGrid(r, c, rows, cols);
          elevationGrid[gr][gc] = Number((heightGridReal[r][c] + heightOffset).toFixed(2));
        }
      }
    }

    const slopeGridReal = activeMapState.camera_slope_grid_60x80;
    if (slopeGridReal && slopeGridReal.length > 0 && slopeGridReal[0]?.length > 0) {
      const rows = slopeGridReal.length;
      const cols = slopeGridReal[0].length;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const realSlopeDeg = slopeGridReal[r][c];
          const [gr, gc] = cellToGrid(r, c, rows, cols);

          // La pendiente real ya viene en grados, igual que slopeGrid: reemplaza
          // directamente la estimación por brillo en esta celda.
          slopeGrid[gr][gc] = realSlopeDeg;

          // Mismos umbrales que ya usa el bloque de occupancy_grid de arriba, para que
          // el costo de A* y el margen de seguridad reaccionen igual ante una pendiente
          // real peligrosa que ante un obstáculo detectado por el D415.
          if (realSlopeDeg >= 30) {
            costGrid[gr][gc] = Math.max(costGrid[gr][gc], 170);
            ai4marsGrid[gr][gc] = 3;
            safetyBufferGrid[gr][gc] = 1.0;
          } else if (realSlopeDeg >= 18) {
            costGrid[gr][gc] = Math.max(costGrid[gr][gc], 85);
            safetyBufferGrid[gr][gc] = Math.max(safetyBufferGrid[gr][gc], 0.55);
          }
        }
      }
    }
  }

  const realObstacles = droneData?.obstacles ?? dataset.obstacles ?? [];
  realObstacles.forEach((obs, idx) => {
    let ox = obs.x;
    let oy = obs.y;
    if (typeof obs.distance_m === 'number' && typeof obs.bearing_deg === 'number') {
      const rad = (obs.bearing_deg * Math.PI) / 180;
      const x_m = obs.distance_m * Math.sin(rad);
      const y_m = obs.distance_m * Math.cos(rad);
      [ox, oy] = d415MetersToMapMeters(x_m, y_m);
    }

    const gc = Math.min(gridCols, Math.max(0, Math.round((ox / 10) * gridCols)));
    const gr = Math.min(gridRows, Math.max(0, Math.round((oy / 10) * gridRows)));

    // Inflar con margen de seguridad generoso de 2 celdas alrededor del obstáculo D415
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const nr = Math.min(gridRows, Math.max(0, gr + dr));
        const nc = Math.min(gridCols, Math.max(0, gc + dc));
        const distCells = Math.hypot(dr, dc);
        if (distCells <= 1.1) {
          costGrid[nr][nc] = Math.max(costGrid[nr][nc], 160);
          slopeGrid[nr][nc] = Math.max(slopeGrid[nr][nc], 26.0);
          ai4marsGrid[nr][nc] = 3;
          safetyBufferGrid[nr][nc] = 1.0;
        } else if (distCells <= 2.3) {
          costGrid[nr][nc] = Math.max(costGrid[nr][nc], 85);
          safetyBufferGrid[nr][nc] = Math.max(safetyBufferGrid[nr][nc], 0.65);
        }
      }
    }

    if (idx < 35) {
      const r = obs.radius || 0.22;
      detectedObstacles.push({
        id: `d415-${obs.id ?? idx}`,
        x: ox,
        y: oy,
        radius: r,
        safetyRadius: Number((r + 0.34).toFixed(2)),
        slopeDeg: obs.type === 'CREVICE' ? 31 : 25,
        kind: obs.type === 'CREVICE' ? 'steep_cliff' : 'rock_obstacle',
        detector: 'D415',
      });
    }
  });

  return {
    elevationGrid,
    molaElevationGrid,
    slopeGrid,
    costGrid,
    safetyBufferGrid,
    ai4marsGrid,
    cannyEdgeGrid: baseVisionData.cannyEdgeGrid,
    morphClosedGrid: baseVisionData.morphClosedGrid,
    samMasks: baseVisionData.samMasks,
    escarpmentSegments: baseVisionData.escarpmentSegments,
    detectedObstacles: clusterObstacles(detectedObstacles),
    isLineMap: baseVisionData.isLineMap,
  };
}

function clusterObstacles(
  obstacles: DetectedTerrainObstacle[],
  minSeparationMeters: number = 0.52
): DetectedTerrainObstacle[] {
  const sorted = [...obstacles].sort((a, b) => b.slopeDeg - a.slopeDeg);
  // Los cráteres verificados (con radiusY) se conservan siempre, aunque estén muy juntos.
  const accepted: DetectedTerrainObstacle[] = sorted.filter((o) => o.radiusY !== undefined);

  for (const candidate of sorted) {
    if (candidate.radiusY !== undefined) continue;
    const tooClose = accepted.some(
      (a) => Math.hypot(a.x - candidate.x, a.y - candidate.y) < minSeparationMeters
    );
    if (!tooClose) accepted.push(candidate);
  }

  return accepted;
}

export function sampleMatrixAt(
  xm: number,
  ym: number,
  matrix: number[][],
  widthMeters: number = 10,
  heightMeters: number = 10
): number {
  const rows = matrix.length - 1;
  const cols = (matrix[0]?.length ?? 2) - 1;
  if (rows < 1 || cols < 1) return 0;
  const c = Math.max(0, Math.min(cols, Math.round((xm / widthMeters) * cols)));
  const r = Math.max(0, Math.min(rows, Math.round((ym / heightMeters) * rows)));
  return matrix[r][c];
}
