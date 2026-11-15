import { DroneData, RealMapStatePayload } from '@martian/shared';
import { MartianTerrainDataset } from '../../config/connectionModes';
import { d415MetersToMapMeters, ImageVisionAnalysis } from '../../utils/imageVision';
import { SafeRouteResult } from '../../utils/pathfinderAStar';

export type MapLayerMode =
  | 'fusion_mars_d415'
  | 'pure_d415_grid'
  | 'live_server_cam'
  | 'topo_lines';

export interface MapCanvasRenderParams {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  gridCols: number;
  gridRows: number;
  dataset: MartianTerrainDataset;
  visionData: ImageVisionAnalysis;
  activeMapState: RealMapStatePayload | null;
  droneData?: DroneData | null;
  loadedImg: HTMLImageElement | null;
  mapLayerMode: MapLayerMode;
  showContours: boolean;
  showDetectedZones: boolean;
  showD415GridOverlay: boolean;
  showServerPaths: boolean;
  safeRoute: SafeRouteResult;
  targetPoint: [number, number];
  basePos: [number, number];
  dronePadPos: [number, number];
  evaPos: [number, number];
}

function drawHeadingTape(ctx: CanvasRenderingContext2D, width: number): void {
  const centerX = width * 0.5;
  const tapeW = 240;
  const startX = centerX - tapeW / 2;
  const topY = 12;

  ctx.save();
  ctx.strokeStyle = 'rgba(226, 232, 240, 0.55)';
  ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
  ctx.lineWidth = 1;
  ctx.font = '600 10px "Inter", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';

  const numTicks = 24;
  for (let i = 0; i <= numTicks; i++) {
    const x = startX + (i / numTicks) * tapeW;
    const isMajor = i % 6 === 0;
    const isMid = i % 3 === 0;
    const tickH = isMajor ? 8 : isMid ? 5 : 3;
    ctx.beginPath();
    ctx.moveTo(x, topY);
    ctx.lineTo(x, topY + tickH);
    ctx.stroke();
  }

  const labels: Array<{ pos: number; text: string }> = [
    { pos: 0.16, text: 'S' },
    { pos: 0.42, text: '00' },
    { pos: 0.64, text: '09' },
    { pos: 0.86, text: 'E' },
  ];
  labels.forEach(({ pos, text }) => {
    ctx.fillText(text, startX + pos * tapeW, topY + 19);
  });

  // Triángulo indicador central en verde/cian
  ctx.beginPath();
  ctx.moveTo(centerX - 4.5, topY - 3);
  ctx.lineTo(centerX + 4.5, topY - 3);
  ctx.lineTo(centerX, topY + 4);
  ctx.closePath();
  ctx.fillStyle = '#34d399';
  ctx.fill();
  ctx.restore();
}

function drawCompassRose(ctx: CanvasRenderingContext2D, width: number): void {
  const cx = width - 44;
  const cy = 44;
  const r = 28;

  ctx.save();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10, 20, 35, 0.68)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  for (let a = 0; a < 360; a += 15) {
    const rad = (a * Math.PI) / 180;
    const inner = a % 90 === 0 ? r - 6 : r - 3.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(rad) * inner, cy + Math.sin(rad) * inner);
    ctx.lineTo(cx + Math.cos(rad) * r, cy + Math.sin(rad) * r);
    ctx.strokeStyle = 'rgba(203, 213, 225, 0.45)';
    ctx.lineWidth = a % 90 === 0 ? 1.2 : 0.8;
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(cx - r + 8, cy);
  ctx.lineTo(cx + r - 8, cy);
  ctx.moveTo(cx, cy - r + 8);
  ctx.lineTo(cx, cy + r - 8);
  ctx.stroke();

  // Aguja Norte (Roja)
  ctx.beginPath();
  ctx.moveTo(cx, cy - 13);
  ctx.lineTo(cx - 4, cy);
  ctx.lineTo(cx + 4, cy);
  ctx.closePath();
  ctx.fillStyle = '#ef4444';
  ctx.fill();

  // Aguja Sur (Azul)
  ctx.beginPath();
  ctx.moveTo(cx, cy + 13);
  ctx.lineTo(cx - 4, cy);
  ctx.lineTo(cx + 4, cy);
  ctx.closePath();
  ctx.fillStyle = '#38bdf8';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fillStyle = '#e2e8f0';
  ctx.fill();

  ctx.font = 'bold 9px "Inter", "Segoe UI", sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - r + 8);
  ctx.fillText('S', cx, cy + r - 8);
  ctx.fillText('W', cx - r + 9, cy);
  ctx.fillText('E', cx + r - 8, cy);

  ctx.restore();
}

function drawRegionLabels(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const labels = [
    { text: 'Dollfus', x: width * 0.21, y: height * 0.55 },
    { text: "Ma'adim Vallis", x: width * 0.55, y: height * 0.41 },
    { text: 'Nervoorn', x: width * 0.43, y: height * 0.69 },
    { text: 'Bachtiaus Vallis', x: width * 0.28, y: height * 0.74 },
  ];

  ctx.save();
  ctx.font = '500 12px "Inter", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = 4;
  ctx.fillStyle = 'rgba(241, 245, 249, 0.88)';
  labels.forEach((l) => {
    ctx.fillText(l.text, l.x, l.y);
  });
  ctx.restore();
}

export function renderTopographicMapCanvas(params: MapCanvasRenderParams): void {
  const {
    ctx,
    width,
    height,
    gridCols,
    gridRows,
    dataset,
    visionData,
    activeMapState,
    loadedImg,
    mapLayerMode,
    showContours,
    showDetectedZones,
    showD415GridOverlay,
    safeRoute,
    targetPoint,
    evaPos,
  } = params;

  // 1. Dibujar el fondo activo
  ctx.clearRect(0, 0, width, height);
  if (mapLayerMode === 'pure_d415_grid') {
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, width, height);
  } else if (loadedImg) {
    ctx.drawImage(loadedImg, 0, 0, width, height);
    ctx.fillStyle = visionData.isLineMap
      ? 'rgba(15, 23, 42, 0.08)'
      : 'rgba(8, 12, 22, 0.14)';
    ctx.fillRect(0, 0, width, height);
  }

  const cellW = width / gridCols;
  const cellH = height / gridRows;

  // 2. Grid de Ocupación Real D415 (si se activa explícitamente)
  if ((showD415GridOverlay || mapLayerMode === 'pure_d415_grid') && activeMapState?.occupancy_grid) {
    const occ = activeMapState.occupancy_grid;
    const rows = occ.length;
    const cols = occ[0]?.length ?? 80;
    const step = mapLayerMode === 'pure_d415_grid' ? 1 : 2;
    const blockW = Math.max(3, ((0.05 * 1.45 * step) / dataset.widthMeters) * width + 1);
    const blockH = Math.max(3, ((0.05 * 1.45 * step) / dataset.heightMeters) * height + 1);

    ctx.save();
    for (let r = 0; r < rows; r += step) {
      for (let c = 0; c < cols; c += step) {
        const val = occ[r][c];
        if (val === 255) continue;

        const x_m = -2.0 + c * 0.05;
        const y_m = r * 0.05;
        const [mapX, mapY] = d415MetersToMapMeters(x_m, y_m);
        const px = (mapX / dataset.widthMeters) * width;
        const py = (mapY / dataset.heightMeters) * height;

        if (val === 0) {
          ctx.fillStyle = 'rgba(34, 197, 94, 0.09)';
        } else if (val === 1) {
          ctx.fillStyle = 'rgba(217, 119, 6, 0.26)';
        } else if (val === 2) {
          ctx.fillStyle = 'rgba(249, 115, 22, 0.65)';
        } else if (val === 3) {
          ctx.fillStyle = 'rgba(56, 189, 248, 0.65)';
        }
        ctx.fillRect(px - blockW / 2, py - blockH / 2, blockW, blockH);
      }
    }
    ctx.restore();
  }

  // 3. Al activar el botón del Ojo (showContours):
  //    - Segmentación AI4Mars (Bedrock, Soil, Sand, Big Rock) + Mapa de Costos de Cuadrícula
  //    - Curvas de Nivel del DEM MOLA / HiRISE (Marching Squares)
  if (showContours && mapLayerMode !== 'pure_d415_grid') {
    ctx.save();
    for (let r = 0; r < gridRows; r++) {
      for (let c = 0; c < gridCols; c++) {
        const cls = visionData.ai4marsGrid?.[r]?.[c] ?? 0;
        const x0 = c * cellW;
        const y0 = r * cellH;
        if (cls === 3) {
          // Big Rock / Pared de cráter / Escarpe
          ctx.fillStyle = 'rgba(239, 68, 68, 0.22)';
          ctx.fillRect(x0, y0, cellW + 0.5, cellH + 0.5);
        } else if (cls === 2) {
          // Sand / Duna deslizante
          ctx.fillStyle = 'rgba(245, 158, 11, 0.19)';
          ctx.fillRect(x0, y0, cellW + 0.5, cellH + 0.5);
        } else if (cls === 1) {
          // Bedrock (Roca madre estable)
          ctx.fillStyle = 'rgba(16, 185, 129, 0.12)';
          ctx.fillRect(x0, y0, cellW + 0.5, cellH + 0.5);
        }
      }
    }
    ctx.restore();

    // Curvas de nivel MOLA / HiRISE
    const levels: number[] = [];
    for (
      let lvl = Math.ceil(dataset.minElevation);
      lvl <= Math.floor(dataset.maxElevation);
      lvl += dataset.contourStep
    ) {
      levels.push(Number(lvl.toFixed(1)));
    }

    const interpolate = (val1: number, val2: number, target: number) => {
      if (Math.abs(val2 - val1) < 1e-5) return 0.5;
      return (target - val1) / (val2 - val1);
    };

    levels.forEach((level, levelIdx) => {
      const isMajorContour = Math.round(level) % 5 === 0 || levelIdx % 3 === 0;

      ctx.beginPath();
      ctx.strokeStyle = isMajorContour
        ? 'rgba(253, 186, 116, 0.72)'
        : 'rgba(254, 215, 170, 0.35)';
      ctx.lineWidth = isMajorContour ? 1.4 : 0.8;

      for (let r = 0; r < gridRows; r++) {
        for (let c = 0; c < gridCols; c++) {
          const zTL = visionData.elevationGrid[r][c];
          const zTR = visionData.elevationGrid[r][c + 1];
          const zBR = visionData.elevationGrid[r + 1][c + 1];
          const zBL = visionData.elevationGrid[r + 1][c];

          let mask = 0;
          if (zTL >= level) mask |= 8;
          if (zTR >= level) mask |= 4;
          if (zBR >= level) mask |= 2;
          if (zBL >= level) mask |= 1;

          if (mask === 0 || mask === 15) continue;

          const x0 = c * cellW;
          const y0 = r * cellH;

          const top = { x: x0 + interpolate(zTL, zTR, level) * cellW, y: y0 };
          const right = { x: x0 + cellW, y: y0 + interpolate(zTR, zBR, level) * cellH };
          const bottom = { x: x0 + interpolate(zBL, zBR, level) * cellW, y: y0 + cellH };
          const left = { x: x0, y: y0 + interpolate(zTL, zBL, level) * cellH };

          const drawSeg = (p1: { x: number; y: number }, p2: { x: number; y: number }) => {
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
          };

          switch (mask) {
            case 1:
            case 14:
              drawSeg(left, bottom);
              break;
            case 2:
            case 13:
              drawSeg(bottom, right);
              break;
            case 3:
            case 12:
              drawSeg(left, right);
              break;
            case 4:
            case 11:
              drawSeg(top, right);
              break;
            case 5:
              drawSeg(left, top);
              drawSeg(bottom, right);
              break;
            case 6:
            case 9:
              drawSeg(top, bottom);
              break;
            case 7:
            case 8:
              drawSeg(left, top);
              break;
            case 10:
              drawSeg(left, bottom);
              drawSeg(top, right);
              break;
          }
        }
      }
      ctx.stroke();
    });
  }

  // 4. Gran círculo morado de escaneo en el centro del mapa + pin morado central
  const scanCenterX = width * 0.42;
  const scanCenterY = height * 0.49;
  const scanRadiusPx = Math.min(width, height) * 0.34;

  ctx.save();
  ctx.beginPath();
  ctx.arc(scanCenterX, scanCenterY, scanRadiusPx, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(168, 85, 247, 0.25)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(192, 132, 252, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const pinX = scanCenterX;
  const pinY = scanCenterY;
  const pinR = 7.5;
  const pinCy = pinY - pinR * 1.8;
  ctx.beginPath();
  ctx.moveTo(pinX - pinR * 0.85, pinCy + pinR * 0.45);
  ctx.lineTo(pinX, pinY);
  ctx.lineTo(pinX + pinR * 0.85, pinCy + pinR * 0.45);
  ctx.closePath();
  ctx.fillStyle = '#c084fc';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(pinX, pinCy, pinR, 0, Math.PI * 2);
  ctx.fillStyle = '#c084fc';
  ctx.fill();
  ctx.strokeStyle = '#3b0764';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(pinX, pinCy, pinR * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = '#2e1065';
  ctx.fill();
  ctx.restore();

  // 5. Cráteres verificados (siempre visibles, sólo el contorno exacto del cráter).
  //    Máscaras SAM, escarpes y anillos de margen de seguridad sólo con el botón del Ojo.
  if (showDetectedZones || showContours) {
    ctx.save();

    if (showContours && visionData.samMasks) {
      visionData.samMasks.forEach((mask) => {
        if (mask.polygon.length < 3) return;
        ctx.beginPath();
        mask.polygon.forEach(([mx, my], idx) => {
          const px = (mx / dataset.widthMeters) * width;
          const py = (my / dataset.heightMeters) * height;
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fillStyle = 'rgba(245, 158, 11, 0.16)';
        ctx.fill();
        ctx.setLineDash([3, 2]);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.78)';
        ctx.lineWidth = 1.3;
        ctx.stroke();
      });
    }

    visionData.detectedObstacles.forEach((obs) => {
      if (obs.detector !== 'HoughCircles') return;
      const cx = (obs.x / dataset.widthMeters) * width;
      const cy = (obs.y / dataset.heightMeters) * height;
      // Elipse en coordenadas de canvas: así el contorno coincide con el cráter
      // aunque el canvas no tenga la misma proporción que la imagen.
      const rx = (obs.radius / dataset.widthMeters) * width;
      const ry = ((obs.radiusY ?? obs.radius) / dataset.heightMeters) * height;

      if (showContours) {
        const k = (obs.safetyRadius ?? obs.radius * 1.5) / obs.radius;
        ctx.beginPath();
        ctx.setLineDash([2, 4]);
        ctx.ellipse(cx, cy, rx * k, ry * k, 0, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.45)';
        ctx.lineWidth = 1.0;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.85)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    });

    if (showContours && visionData.escarpmentSegments) {
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.78)';
      ctx.lineWidth = 1.6;
      visionData.escarpmentSegments.forEach((seg) => {
        if (seg.points.length < 2) return;
        ctx.beginPath();
        seg.points.forEach(([sx, sy], idx) => {
          const px = (sx / dataset.widthMeters) * width;
          const py = (sy / dataset.heightMeters) * height;
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      });
    }

    ctx.restore();
  }

  // 6. Zona roja principal de riesgo junto a Ma'adim Vallis
  const endPt = safeRoute.points[safeRoute.points.length - 1] ?? targetPoint;
  const hazardPx = width * 0.51;
  const hazardPy = height * 0.36;
  const hazardR = Math.min(width, height) * 0.068;

  ctx.save();
  ctx.beginPath();
  ctx.arc(hazardPx, hazardPy, hazardR, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(220, 38, 38, 0.36)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(248, 113, 113, 0.72)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(hazardPx, hazardPy, hazardR * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(239, 68, 68, 0.48)';
  ctx.fill();
  ctx.restore();

  // 7. Nombres geográficos del mapa marciano
  drawRegionLabels(ctx, width, height);

  // 8. Ruta Segura con A* + Corredor de Margen de Seguridad Generoso
  if (safeRoute.points.length > 1) {
    ctx.save();

    // Banda translúcida que representa el margen de seguridad generoso a lo largo de la ruta A*
    ctx.beginPath();
    safeRoute.points.forEach(([rx, ry], idx) => {
      const px = (rx / dataset.widthMeters) * width;
      const py = (ry / dataset.heightMeters) * height;
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.16)';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.stroke();

    // Sombra de contraste de la línea central A*
    ctx.beginPath();
    safeRoute.points.forEach(([rx, ry], idx) => {
      const px = (rx / dataset.widthMeters) * width;
      const py = (ry / dataset.heightMeters) * height;
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.48)';
    ctx.lineWidth = 4.5;
    ctx.setLineDash([6, 6]);
    ctx.stroke();

    // Trazo verde punteado de la Ruta A*
    ctx.beginPath();
    safeRoute.points.forEach(([rx, ry], idx) => {
      const px = (rx / dataset.widthMeters) * width;
      const py = (ry / dataset.heightMeters) * height;
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 2.4;
    ctx.setLineDash([6, 6]);
    ctx.stroke();
    ctx.restore();
  }

  // 9. Marcador EVA_01
  const startPt = safeRoute.points[0] ?? evaPos;
  const evaPx = (startPt[0] / dataset.widthMeters) * width;
  const evaPy = (startPt[1] / dataset.heightMeters) * height;

  ctx.save();
  ctx.beginPath();
  ctx.arc(evaPx, evaPy, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#0b192c';
  ctx.fill();
  ctx.lineWidth = 2.8;
  ctx.strokeStyle = '#38bdf8';
  ctx.stroke();

  ctx.font = 'bold 13px "Inter", "Segoe UI", sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
  ctx.shadowBlur = 5;
  ctx.textBaseline = 'middle';
  ctx.fillText('EVA_01', evaPx + 11, evaPy + 1);
  ctx.restore();

  // 10. Marcador Destino
  const targetPx = (endPt[0] / dataset.widthMeters) * width;
  const targetPy = (endPt[1] / dataset.heightMeters) * height;

  ctx.save();
  ctx.beginPath();
  ctx.arc(targetPx, targetPy, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#1c1917';
  ctx.fill();
  ctx.lineWidth = 2.8;
  ctx.strokeStyle = '#f59e0b';
  ctx.stroke();

  ctx.font = 'bold 13px "Inter", "Segoe UI", sans-serif';
  ctx.fillStyle = '#fbbf24';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
  ctx.shadowBlur = 5;
  ctx.textBaseline = 'middle';
  ctx.fillText('Destino', targetPx + 11, targetPy + 1);
  ctx.restore();

  // 11. Cinta superior de rumbo y brújula superior derecha
  drawHeadingTape(ctx, width);
  drawCompassRose(ctx, width);
}
