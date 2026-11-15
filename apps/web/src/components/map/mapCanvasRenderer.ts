import { DroneData, RealMapStatePayload } from '@martian/shared';
import { MartianTerrainDataset } from '../../config/connectionModes';
import { d415MetersToMapMeters, ImageVisionAnalysis } from '../../utils/imageVision';
import { SafeRouteResult } from '../../utils/pathfinderAStar';
import { ScientificStop } from '../../data/stops';
import { projectFrac } from '../../utils/marsTiles';

export type MapLayerMode =
  | 'fusion_mars_d415'
  | 'pure_d415_grid'
  | 'live_server_cam'
  | 'live_route_map'
  | 'live_rgb'
  | 'live_depth'
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
  liveImg?: HTMLImageElement | null;
  mapLayerMode: MapLayerMode;
  // Capas independientes del panel "CAPAS DEL MAPA" (antes todo dependía de un único
  // botón de "Ojo" que las mezclaba).
  showCraters: boolean;
  showEscarpments: boolean;
  showContourLines: boolean;
  showMetricGrid: boolean;
  showD415GridOverlay: boolean;
  showServerPaths: boolean;
  safeRoute: SafeRouteResult;
  targetPoint: [number, number];
  basePos: [number, number];
  dronePadPos: [number, number];
  evaPos: [number, number];
  stops?: ScientificStop[];
  // Zoom libre (tipo Google Maps, sin pan): zoomScale aleja del centro del canvas
  // a los marcadores/obstáculos/ruta según el zoom actual (1 = sin zoom, como antes
  // de tener esta función). bgCropFraction recorta la imagen de fondo ya cargada
  // para que se vea exactamente ese mismo zoom mientras llega un tile más detallado.
  zoomScale: number;
  bgCropFraction: number;
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

function drawRegionLabels(
  ctx: CanvasRenderingContext2D,
  projX: (xm: number) => number,
  projY: (ym: number) => number
): void {
  // Posiciones en el mismo espacio sintético 0..10 que todo lo demás (no fracciones
  // fijas del canvas), para que se muevan con el zoom igual que el resto del mapa.
  const labels = [
    { text: 'Dollfus', x: projX(2.1), y: projY(5.5) },
    { text: "Ma'adim Vallis", x: projX(5.5), y: projY(4.1) },
    { text: 'Nervoorn', x: projX(4.3), y: projY(6.9) },
    { text: 'Bachtiaus Vallis', x: projX(2.8), y: projY(7.4) },
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
    showCraters,
    showEscarpments,
    showContourLines,
    showMetricGrid,
    showD415GridOverlay,
    safeRoute,
    targetPoint,
    evaPos,
    stops,
    zoomScale,
    bgCropFraction,
    liveImg,
  } = params;

  // Cuando se muestra la cuadrícula métrica, el mapa se dibuja un poco más chico
  // (MARGIN_LEFT/MARGIN_TOP) para dejar un margen propio donde sobresalen los
  // números de los ejes — como una regla pegada al mapa, no encima de la imagen.
  const MARGIN_TOP = showMetricGrid ? 24 : 0;
  const MARGIN_LEFT = showMetricGrid ? 42 : 0;
  const mapW = width - MARGIN_LEFT;
  const mapH = height - MARGIN_TOP;

  // Reproyecta un punto del espacio sintético 0..dataset.widthMeters/heightMeters
  // hacia el canvas, alejándolo del centro según el zoom actual (sin pan: el centro
  // de la vista es siempre el centro del área de mapa, no del canvas completo). A
  // zoomScale=1 es idéntico a la fórmula de siempre (v/ancho)*width, sólo que ahora
  // "ancho"/"alto" son los del área de mapa (dentro del margen de la regla).
  const projX = (xm: number) => MARGIN_LEFT + projectFrac(xm, dataset.widthMeters, zoomScale) * mapW;
  const projY = (ym: number) => MARGIN_TOP + projectFrac(ym, dataset.heightMeters, zoomScale) * mapH;
  const projRx = (vm: number) => (vm / dataset.widthMeters) * mapW * zoomScale;
  const projRy = (vm: number) => (vm / dataset.heightMeters) * mapH * zoomScale;

  // 1. Dibujar el fondo activo (recortado al zoom actual: bgCropFraction<1 ⇒ zoom
  // más cercano que el escalón de detalle ya cargado, igual que sobre-acercar un
  // tile real). Todo el contenido del mapa queda recortado (clip) al área dentro
  // del margen de la regla, para que nada se dibuje encima de los números de eje.
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  if (showMetricGrid) {
    ctx.beginPath();
    ctx.rect(MARGIN_LEFT, MARGIN_TOP, mapW, mapH);
    ctx.clip();
  }

  const isLiveMode =
    mapLayerMode === 'live_route_map' ||
    mapLayerMode === 'live_rgb' ||
    mapLayerMode === 'live_depth' ||
    mapLayerMode === 'live_server_cam';

  if (mapLayerMode === 'pure_d415_grid') {
    ctx.fillStyle = '#090d16';
    ctx.fillRect(MARGIN_LEFT, MARGIN_TOP, mapW, mapH);
  } else if (isLiveMode) {
    if (liveImg) {
      ctx.drawImage(liveImg, MARGIN_LEFT, MARGIN_TOP, mapW, mapH);
      ctx.fillStyle = 'rgba(7, 11, 20, 0.12)';
      ctx.fillRect(MARGIN_LEFT, MARGIN_TOP, mapW, mapH);
    } else {
      ctx.fillStyle = '#060a12';
      ctx.fillRect(MARGIN_LEFT, MARGIN_TOP, mapW, mapH);
      ctx.fillStyle = '#38bdf8';
      ctx.font = '600 12px "SF Mono", "JetBrains Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('STANDBY // ESPERANDO STREAM EN VIVO DE D415...', MARGIN_LEFT + mapW / 2, MARGIN_TOP + mapH / 2);
    }
  } else if (loadedImg) {
    const iw = loadedImg.naturalWidth || loadedImg.width;
    const ih = loadedImg.naturalHeight || loadedImg.height;
    const cropW = iw * bgCropFraction;
    const cropH = ih * bgCropFraction;
    const sx = (iw - cropW) / 2;
    const sy = (ih - cropH) / 2;
    ctx.drawImage(loadedImg, sx, sy, cropW, cropH, MARGIN_LEFT, MARGIN_TOP, mapW, mapH);
    ctx.fillStyle = visionData.isLineMap
      ? 'rgba(15, 23, 42, 0.08)'
      : 'rgba(8, 12, 22, 0.14)';
    ctx.fillRect(MARGIN_LEFT, MARGIN_TOP, mapW, mapH);
  } else {
    ctx.fillStyle = '#080d18';
    ctx.fillRect(MARGIN_LEFT, MARGIN_TOP, mapW, mapH);
  }

  const cellW = mapW / gridCols;
  const cellH = mapH / gridRows;

  // 1.5 Capa "Cuadrícula métrica": sólo las líneas de la rejilla aquí (recortadas al
  // área de mapa); los números de eje se dibujan al final, fuera del clip, en el
  // margen — ver "12. Regla de la cuadrícula métrica" más abajo.
  if (showMetricGrid) {
    ctx.save();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const vx = projX(i);
      ctx.beginPath();
      ctx.moveTo(vx, MARGIN_TOP);
      ctx.lineTo(vx, height);
      ctx.stroke();

      const hy = projY(i);
      ctx.beginPath();
      ctx.moveTo(MARGIN_LEFT, hy);
      ctx.lineTo(width, hy);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 2. Grid de Ocupación Real D415 (si se activa explícitamente)
  if ((showD415GridOverlay || mapLayerMode === 'pure_d415_grid') && activeMapState?.occupancy_grid) {
    const occ = activeMapState.occupancy_grid;
    const rows = occ.length;
    const cols = occ[0]?.length ?? 80;
    const step = mapLayerMode === 'pure_d415_grid' ? 1 : 2;
    const blockW = Math.max(3, projRx(0.05 * 1.45 * step) + 1);
    const blockH = Math.max(3, projRy(0.05 * 1.45 * step) + 1);

    ctx.save();
    for (let r = 0; r < rows; r += step) {
      for (let c = 0; c < cols; c += step) {
        const val = occ[r][c];
        if (val === 255) continue;

        const x_m = -2.0 + c * 0.05;
        const y_m = r * 0.05;
        const [mapX, mapY] = d415MetersToMapMeters(x_m, y_m);
        const px = projX(mapX);
        const py = projY(mapY);

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

  // 3. Capa "Curvas de nivel" del panel CAPAS DEL MAPA: Curvas de Nivel del DEM
  // MOLA / HiRISE (Marching Squares), en gris/blanco pálido como en la referencia
  // (sin el tinte de colores por clase de terreno, que no aparece ahí).
  if (showContourLines && mapLayerMode !== 'pure_d415_grid') {
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

    ctx.save();
    levels.forEach((level, levelIdx) => {
      const isMajorContour = Math.round(level) % 5 === 0 || levelIdx % 3 === 0;

      ctx.beginPath();
      ctx.strokeStyle = isMajorContour
        ? 'rgba(226, 232, 240, 0.45)'
        : 'rgba(226, 232, 240, 0.2)';
      ctx.lineWidth = isMajorContour ? 1.2 : 0.7;

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

          const x0 = MARGIN_LEFT + c * cellW;
          const y0 = MARGIN_TOP + r * cellH;

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
    ctx.restore();
  }

  // 4. Gran círculo morado de escaneo en el centro del mapa + pin morado central
  // Posición en el espacio sintético 0..10 (no una fracción fija del canvas), para
  // que se mueva con el zoom igual que EVA-01/Destino/obstáculos en vez de quedarse
  // pegada a la pantalla. El radio escala de forma uniforme (sin deformarse a elipse)
  // para que siga viéndose como un círculo.
  const scanCenterX = projX(4.2);
  const scanCenterY = projY(4.9);
  const scanRadiusPx = Math.min(mapW, mapH) * 0.34 * zoomScale;

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

  // 5. Capa "Cráteres detectados": círculo + mira central + anillo punteado de
  //    seguridad + etiqueta con id y pendiente (p.ej. "HC-01  26.1°").
  if (showCraters) {
    ctx.save();

    const houghObstacles = visionData.detectedObstacles.filter((o) => o.detector === 'HoughCircles');
    houghObstacles.forEach((obs, idx) => {
      const cx = projX(obs.x);
      const cy = projY(obs.y);
      // Elipse en coordenadas de canvas: así el contorno coincide con el cráter
      // aunque el canvas no tenga la misma proporción que la imagen. El radio
      // también escala con el zoom, igual que la posición.
      const rx = projRx(obs.radius);
      const ry = projRy(obs.radiusY ?? obs.radius);

      // Cráter (depresión oscura)
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20, 8, 8, 0.65)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Anillo punteado de margen de seguridad
      const k = (obs.safetyRadius ?? obs.radius * 1.5) / obs.radius;
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.ellipse(cx, cy, rx * k, ry * k, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.85)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);

      // Mira central
      const crossR = 5;
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.95)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx - crossR, cy);
      ctx.lineTo(cx + crossR, cy);
      ctx.moveTo(cx, cy - crossR);
      ctx.lineTo(cx, cy + crossR);
      ctx.stroke();

      // Etiqueta: id corto + pendiente
      const label = `${obs.kind === 'crater_wall' ? 'HC' : 'SAM'}-${String(idx + 1).padStart(2, '0')}`;
      ctx.font = 'bold 10px "Inter", "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowBlur = 3;
      ctx.fillStyle = '#f87171';
      ctx.fillText(label, cx + rx * k + 5, cy - 2);
      ctx.font = '9px "Inter", "Segoe UI", sans-serif';
      ctx.fillText(`${obs.slopeDeg.toFixed(1)}°`, cx + rx * k + 5, cy + 10);
      ctx.shadowBlur = 0;
    });
    ctx.restore();
  }

  // 5.5 Capa "Escarpes geológicos": máscaras SAM + segmentos de escarpe, en naranja.
  if (showEscarpments) {
    ctx.save();

    if (visionData.samMasks) {
      visionData.samMasks.forEach((mask) => {
        if (mask.polygon.length < 3) return;
        ctx.beginPath();
        mask.polygon.forEach(([mx, my], idx) => {
          const px = projX(mx);
          const py = projY(my);
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

    if (visionData.escarpmentSegments) {
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(251, 146, 60, 0.85)';
      ctx.lineWidth = 1.6;
      visionData.escarpmentSegments.forEach((seg, idx) => {
        if (seg.points.length < 2) return;
        ctx.beginPath();
        seg.points.forEach(([sx, sy], pIdx) => {
          const px = projX(sx);
          const py = projY(sy);
          if (pIdx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();

        const [lastX, lastY] = seg.points[seg.points.length - 1];
        ctx.setLineDash([]);
        ctx.font = 'bold 10px "Inter", "Segoe UI", sans-serif';
        ctx.fillStyle = '#fb923c';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
        ctx.shadowBlur = 3;
        ctx.textAlign = 'left';
        ctx.fillText(`ESCARPE ${seg.slopeDeg.toFixed(1)}°`, projX(lastX) + 6, projY(lastY));
        ctx.shadowBlur = 0;
        ctx.setLineDash([5, 4]);
      });
    }

    ctx.restore();
  }

  const endPt = safeRoute.points[safeRoute.points.length - 1] ?? targetPoint;

  // 7. Nombres geográficos del mapa marciano
  drawRegionLabels(ctx, projX, projY);

  // 8. Ruta A*: trazo sólido azul, como en la referencia (antes era verde punteado
  // con una banda ancha de margen de seguridad).
  if (safeRoute.points.length > 1) {
    ctx.save();

    // Sombra de contraste para que se lea bien sobre cualquier fondo
    ctx.beginPath();
    safeRoute.points.forEach(([rx, ry], idx) => {
      const px = projX(rx);
      const py = projY(ry);
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 4.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.stroke();

    // Trazo sólido azul de la Ruta A*
    ctx.beginPath();
    safeRoute.points.forEach(([rx, ry], idx) => {
      const px = projX(rx);
      const py = projY(ry);
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // Puntos intermedios (waypoints) a lo largo de la ruta
    for (let i = 1; i < safeRoute.points.length - 1; i++) {
      const [wx, wy] = safeRoute.points[i];
      ctx.beginPath();
      ctx.arc(projX(wx), projY(wy), 3, 0, Math.PI * 2);
      ctx.fillStyle = '#38bdf8';
      ctx.fill();
      ctx.strokeStyle = '#0b192c';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  // 9. Marcador EVA_01 (baliza táctica con 4 muescas cardinales y núcleo activo)
  const startPt = safeRoute.points[0] ?? evaPos;
  const evaPx = projX(startPt[0]);
  const evaPy = projY(startPt[1]);

  ctx.save();
  ctx.beginPath();
  ctx.arc(evaPx, evaPy, 10.5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.38)';
  ctx.lineWidth = 1.1;
  ctx.stroke();

  const evaTicks: Array<[number, number, number, number]> = [
    [evaPx, evaPy - 12.5, evaPx, evaPy - 9],
    [evaPx, evaPy + 9, evaPx, evaPy + 12.5],
    [evaPx - 12.5, evaPy, evaPx - 9, evaPy],
    [evaPx + 9, evaPy, evaPx + 12.5, evaPy],
  ];
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.5;
  evaTicks.forEach(([x1, y1, x2, y2]) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  });

  // Núcleo sólido en el azul primario de toda la app (antes era azul marino oscuro
  // con sólo el borde en azul claro, lo que se veía más oscuro que el resto de la UI).
  ctx.beginPath();
  ctx.arc(evaPx, evaPy, 6.2, 0, Math.PI * 2);
  ctx.fillStyle = '#38bdf8';
  ctx.fill();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = '#0b192c';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(evaPx, evaPy, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = '#0b192c';
  ctx.fill();

  ctx.font = 'bold 13px "Inter", "Segoe UI", sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
  ctx.shadowBlur = 5;
  ctx.textBaseline = 'middle';
  ctx.fillText('EVA-01', evaPx + 15, evaPy + 1);
  ctx.restore();

  // 10. Marcador Destino (retícula romboidal con mira central)
  const targetPx = projX(endPt[0]);
  const targetPy = projY(endPt[1]);
  const diamondR = 9.5;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(targetPx, targetPy - diamondR);
  ctx.lineTo(targetPx + diamondR, targetPy);
  ctx.lineTo(targetPx, targetPy + diamondR);
  ctx.lineTo(targetPx - diamondR, targetPy);
  ctx.closePath();
  ctx.fillStyle = 'rgba(28, 25, 23, 0.85)';
  ctx.fill();
  ctx.lineWidth = 2.0;
  ctx.strokeStyle = '#f59e0b';
  ctx.stroke();

  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(targetPx, targetPy - 5.2);
  ctx.lineTo(targetPx, targetPy - 2.8);
  ctx.moveTo(targetPx, targetPy + 2.8);
  ctx.lineTo(targetPx, targetPy + 5.2);
  ctx.moveTo(targetPx - 5.2, targetPy);
  ctx.lineTo(targetPx - 2.8, targetPy);
  ctx.moveTo(targetPx + 2.8, targetPy);
  ctx.lineTo(targetPx + 5.2, targetPy);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(targetPx, targetPy, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = '#fbbf24';
  ctx.fill();

  ctx.font = 'bold 13px "Inter", "Segoe UI", sans-serif';
  ctx.fillStyle = '#fbbf24';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
  ctx.shadowBlur = 5;
  ctx.textBaseline = 'middle';
  ctx.fillText('Destino', targetPx + 13, targetPy + 1);
  ctx.restore();

  // 10.5 Paradas científicas (estación hexagonal con índice tabular)
  if (stops && stops.length > 0) {
    for (const stop of stops) {
      const px = projX(stop.xm);
      const py = projY(stop.ym);
      const hexR = 9.2;

      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 2;
        const hx = px + Math.cos(angle) * hexR;
        const hy = py + Math.sin(angle) * hexR;
        if (i === 0) ctx.moveTo(hx, hy);
        else ctx.lineTo(hx, hy);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(11, 27, 46, 0.94)';
      ctx.fill();
      ctx.lineWidth = 2.0;
      ctx.strokeStyle = '#38bdf8';
      ctx.stroke();

      ctx.font = 'bold 10px "Inter", "Segoe UI", sans-serif';
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(stop.number), px, py + 0.5);
      ctx.restore();
    }
  }

  // Se quita aquí el recorte (clip) al área de mapa: lo que sigue (regla de la
  // cuadrícula, cinta de rumbo) vive en el margen o por encima de todo el mapa.
  ctx.restore();

  // 11. Cinta superior de rumbo (la brújula circular se quitó por pedido del usuario)
  drawHeadingTape(ctx, width);

  // 12. Regla de la cuadrícula métrica: números de eje 0.0..10.0 sobresaliendo en su
  // propio margen (no encima de la imagen del mapa), con una marquita que conecta
  // cada número con su línea de rejilla correspondiente.
  if (showMetricGrid) {
    ctx.save();
    ctx.fillStyle = '#0a1420';
    ctx.fillRect(0, 0, width, MARGIN_TOP);
    ctx.fillRect(0, 0, MARGIN_LEFT, height);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, MARGIN_TOP + 0.5);
    ctx.lineTo(width, MARGIN_TOP + 0.5);
    ctx.moveTo(MARGIN_LEFT + 0.5, 0);
    ctx.lineTo(MARGIN_LEFT + 0.5, height);
    ctx.stroke();

    ctx.font = '700 10.5px "SF Mono", "JetBrains Mono", Consolas, monospace';
    ctx.fillStyle = 'rgba(226, 232, 240, 0.95)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.65)';

    for (let i = 0; i <= 10; i++) {
      const vx = projX(i);
      ctx.beginPath();
      ctx.moveTo(vx, MARGIN_TOP - 6);
      ctx.lineTo(vx, MARGIN_TOP);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(i.toFixed(1), vx, 5);

      const hy = projY(i);
      ctx.beginPath();
      ctx.moveTo(MARGIN_LEFT - 6, hy);
      ctx.lineTo(MARGIN_LEFT, hy);
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(i.toFixed(1), 5, hy);
    }
    ctx.restore();
  }
}
