import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, Crosshair, Layers, Mountain, Radio, RefreshCw, Server, Settings, Upload } from 'lucide-react';
import {
  DroneData,
  EvaData,
  fetchMapStateFromServer,
  RealMapStatePayload,
  RiskAssessment,
} from '@martian/shared';
import {
  analyzeImageTerrainReal,
  computeSafeRouteFromImageVision,
  FIXED_DRONE_PAD_POS,
  fuseVisionWithD415Data,
  ImageVisionAnalysis,
  MartianTerrainDataset,
  OpenCvPrecomputedPayload,
  OperationMode,
  sampleMatrixAt,
} from '../config/connectionConfig';
import { MapLayerMode, renderTopographicMapCanvas } from './map/mapCanvasRenderer';
import { d415MetersToMapMeters } from '../utils/imageVision';
import { MAX_STOPS, ScientificStop } from '../data/stops';
import {
  activeTierForSpan,
  bgCropFractionFor,
  buildMarsMosaic,
  DEFAULT_SPAN_KM,
  degSpansForSpanKm,
  DOLLFUS_CENTER,
  MAX_SPAN_KM,
  MIN_SPAN_KM,
  projectFrac,
  REFERENCE_SPAN_KM,
  unprojectFrac,
  ZOOM_STEP_FACTOR,
  zoomScaleFor,
} from '../utils/marsTiles';

interface TopographicMap2DProps {
  dataset: MartianTerrainDataset;
  droneData?: DroneData | null;
  mode: OperationMode;
  evaYaw?: number;
  eva?: EvaData | null;
  risk: RiskAssessment;
  utcTime?: string;
  isConnected?: boolean;
  customUrls?: Record<OperationMode, string>;
  onSwitchMode?: (newMode: OperationMode) => void;
  onChangeUrl?: (newUrl: string) => void;
  onApplyUrl?: () => void;
  onTargetSelect?: (targetMeters: [number, number]) => void;
}

const GRID_COLS = 96;
const GRID_ROWS = 60;
const UI_FONT = '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif';

const ECG_POINTS =
  '0,14 18,14 23,11 27,14 33,14 36,18 40,3 44,23 48,10 53,14 75,14 93,14 98,11 102,14 108,14 111,18 115,3 119,23 123,10 128,14 150,14 168,14 173,11 177,14 183,14 186,18 190,3 194,23 198,10 203,14 220,14';

interface ElevPoint {
  dist: number;
  elev: number;
  slope: number;
}

function buildSmoothPath(pts: Array<[number, number]>): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

// Proyecta un punto sobre la polilínea de la ruta y devuelve la distancia recorrida
// desde el inicio (EVA-01) hasta esa proyección, en las mismas unidades de "metros"
// que ya usa safeRoute.distanceMeters (hypot directo sobre los puntos mapeados).
function distanceAlongRoute(route: Array<[number, number]>, point: [number, number]): number {
  if (route.length < 2) return 0;
  let cumulative = 0;
  let bestCumAtProjection = 0;
  let bestPerpDist = Infinity;

  for (let i = 0; i < route.length - 1; i++) {
    const [ax, ay] = route[i];
    const [bx, by] = route[i + 1];
    const segLen = Math.hypot(bx - ax, by - ay);
    const dirX = segLen ? (bx - ax) / segLen : 0;
    const dirY = segLen ? (by - ay) / segLen : 0;
    const t = Math.max(0, Math.min(segLen, (point[0] - ax) * dirX + (point[1] - ay) * dirY));
    const projX = ax + dirX * t;
    const projY = ay + dirY * t;
    const perp = Math.hypot(point[0] - projX, point[1] - projY);
    if (perp < bestPerpDist) {
      bestPerpDist = perp;
      bestCumAtProjection = cumulative + t;
    }
    cumulative += segLen;
  }

  return Number(bestCumAtProjection.toFixed(1));
}

const AstronautIcon: React.FC<{ size?: number; color: string }> = ({ size = 20, color }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke={color}
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="8.2" r="4.6" />
    <ellipse cx="12" cy="8.5" rx="2.7" ry="2.1" fill={color} fillOpacity="0.25" stroke={color} strokeWidth="1.2" />
    <path d="M6.4 14.3c0-1.1.9-1.8 2-2.1a9 9 0 0 1 7.2 0c1.1.3 2 1 2 2.1V19.5H6.4v-5.2Z" />
  </svg>
);

const ElevationChart: React.FC<{ profile: ElevPoint[]; maxSlopeDeg: number }> = ({
  profile,
  maxSlopeDeg,
}) => {
  if (profile.length < 2) return null;

  const W = 260;
  const H = 132;
  const padL = 38;
  const padR = 12;
  const padT = 18;
  const padB = 20;

  const maxDist = profile[profile.length - 1].dist || 1;
  const elevs = profile.map((p) => p.elev);
  const minE = Math.min(...elevs);
  const maxE = Math.max(...elevs);
  const span = Math.max(0.5, maxE - minE);

  const toX = (d: number) => padL + (d / maxDist) * (W - padL - padR);
  const toY = (e: number) => H - padB - ((e - minE) / span) * (H - padT - padB);

  const points: Array<[number, number]> = profile.map((p) => [toX(p.dist), toY(p.elev)]);
  const linePath = buildSmoothPath(points);
  const last = points[points.length - 1];
  const first = points[0];
  const areaPath = `${linePath} L${last[0]},${H - padB} L${first[0]},${H - padB} Z`;

  // Punto de pendiente máxima con el puntito rojo
  let peakIdx = Math.min(1, profile.length - 1);
  for (let i = 1; i < profile.length - 1; i++) {
    if (
      profile[i].slope > profile[peakIdx].slope ||
      (profile[i].slope === profile[peakIdx].slope && profile[i].elev > profile[peakIdx].elev)
    ) {
      peakIdx = i;
    }
  }
  const peakPt = points[peakIdx];
  const peakLabelX = Math.min(W - padR - 22, Math.max(padL + 22, peakPt[0]));
  const peakLabelY = Math.max(10, peakPt[1] - 6);

  // Punto de referencia "Posición Actual (EVA-01)" con línea punteada vertical (como en el boceto)
  const evaRefIdx = Math.min(profile.length - 2, Math.max(2, Math.round(profile.length * 0.42)));
  const evaRefPt = points[evaRefIdx];

  // Punto naranja de "Destino" hacia el tramo final del perfil (como en el boceto)
  let destIdx = Math.max(peakIdx + 1, Math.round(profile.length * 0.78));
  if (destIdx >= profile.length) destIdx = profile.length - 1;
  const destPt = points[destIdx];

  const yLabels = [
    { y: padT + 4, text: '-1600 m' },
    { y: (padT + (H - padB)) / 2 + 2, text: '-1700 m' },
    { y: H - padB - 2, text: '-1800 m' },
  ];

  // Etiquetas reales del eje X a partir de la distancia total del perfil (nada inventado):
  // el perfil ya trae su distancia acumulada en profile[i].dist.
  const formatDist = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`);
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => formatDist(maxDist * f));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: '132px', display: 'block' }}>
      <defs>
        <linearGradient id="elevFillSketch" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.52" />
          <stop offset="100%" stopColor="#0e7490" stopOpacity="0.14" />
        </linearGradient>
      </defs>

      {/* Eje vertical izquierdo y eje horizontal inferior */}
      <line x1={padL} y1={padT - 4} x2={padL} y2={H - padB} stroke="rgba(148, 163, 184, 0.5)" strokeWidth="1" />
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="rgba(148, 163, 184, 0.5)" strokeWidth="1" />

      {yLabels.map((yl, i) => (
        <g key={i}>
          <line x1={padL - 3} y1={yl.y} x2={padL} y2={yl.y} stroke="rgba(148, 163, 184, 0.5)" strokeWidth="1" />
          <text x={padL - 5} y={yl.y + 2.5} fontSize="7.2" fill="#cbd5e1" textAnchor="end" fontFamily={UI_FONT}>
            {yl.text}
          </text>
        </g>
      ))}

      {/* Curva rellena de elevación */}
      <path d={areaPath} fill="url(#elevFillSketch)" stroke="none" />
      <path d={linePath} fill="none" stroke="#38bdf8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />

      {/* Línea punteada vertical desde la curva hasta la base: Posición Actual (EVA-01) */}
      <line
        x1={evaRefPt[0]}
        y1={evaRefPt[1]}
        x2={evaRefPt[0]}
        y2={H - padB}
        stroke="rgba(226, 232, 240, 0.7)"
        strokeWidth="1"
        strokeDasharray="2.5,2.5"
      />
      <text
        x={ Math.min(W - padR - 45, Math.max(padL + 45, evaRefPt[0] + 10)) }
        y={ Math.min(H - padB - 26, Math.max(padT + 26, (evaRefPt[1] + (H - padB)) / 2)) }
        fontSize="7.5"
        fill="#f1f5f9"
        textAnchor="middle"
        fontFamily={UI_FONT}
      >
        Posición Actual (EVA-01)
      </text>

      {/* Punto naranja de Destino (como en el boceto) */}
      <circle cx={destPt[0]} cy={destPt[1]} r="3" fill="#f59e0b" stroke="#0f172a" strokeWidth="1" />
      <text
        x={Math.min(W - padR - 4, destPt[0] + 14)}
        y={destPt[1] + 9}
        fontSize="7.5"
        fill="#f8fafc"
        textAnchor="middle"
        fontFamily={UI_FONT}
      >
        Destino
      </text>

      {/* Puntito rojo de la Pendiente Máxima */}
      <circle cx={peakPt[0]} cy={peakPt[1]} r="5.5" fill="rgba(239, 68, 68, 0.28)" />
      <circle cx={peakPt[0]} cy={peakPt[1]} r="3.4" fill="#ef4444" stroke="#0b1220" strokeWidth="1" />
      <text
        x={peakLabelX}
        y={peakLabelY}
        fontSize="7.8"
        fontWeight="bold"
        fill="#ef4444"
        textAnchor="middle"
        fontFamily={UI_FONT}
      >
        Pendiente máx: {maxSlopeDeg}°
      </text>

      {/* Texto inferior derecho dentro de la gráfica (tal cual el boceto) */}
      <text
        x={W - padR - 4}
        y={H - padB - 13}
        fontSize="7.2"
        fill="#e2e8f0"
        textAnchor="end"
        fontFamily={UI_FONT}
      >
        Pendiente máx: {maxSlopeDeg}°
      </text>
      <text
        x={W - padR - 4}
        y={H - padB - 4}
        fontSize="7.2"
        fill="#cbd5e1"
        textAnchor="end"
        fontFamily={UI_FONT}
      >
        Altitud actual: -1,640 m
      </text>

      {/* Etiquetas del eje X */}
      {xLabels.map((xl, idx) => {
        const x = padL + (idx / (xLabels.length - 1)) * (W - padL - padR);
        return (
          <g key={idx}>
            <line x1={x} y1={H - padB} x2={x} y2={H - padB + 3} stroke="rgba(148, 163, 184, 0.5)" strokeWidth="1" />
            <text
              x={x}
              y={H - 5}
              fontSize="7.2"
              fill="#cbd5e1"
              textAnchor={idx === 0 ? 'start' : idx === xLabels.length - 1 ? 'end' : 'middle'}
              fontFamily={UI_FONT}
            >
              {xl}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

const MONO_READOUT_FONT =
  '"JetBrains Mono", "Cascadia Mono", "Fira Code", "SFMono-Regular", Consolas, monospace';

const ClinicalEcgTrace: React.FC<{ isElevated?: boolean; bpm?: number; live?: boolean }> = ({
  isElevated = false,
  bpm = 75,
  live = true,
}) => {
  const strokeColor = isElevated ? '#e5a024' : '#6ca696';
  const clampedBpm = Math.max(40, Math.min(180, bpm));
  // Dos complejos P-QRS-T por trazo completo, sincronizados con los BPM reales
  const traceDurationSec = Number(((60 / clampedBpm) * 2).toFixed(2));
  const wavePath =
    'M 0,14 L 10,14 L 13,11.8 L 16,14 L 21,14 L 23.5,17.2 L 27,3.2 L 30.5,18.2 L 33.5,10.5 L 37,14 L 54,14 L 64,14 L 67,11.8 L 70,14 L 75,14 L 77.5,17.2 L 81,3.2 L 84.5,18.2 L 87.5,10.5 L 91,14 L 108,14';

  return (
    <div style={{ width: '100%', height: '20px' }}>
      <style>{`
        @keyframes ecgTraceDraw {
          0% {
            stroke-dashoffset: 200;
          }
          80%, 100% {
            stroke-dashoffset: 0;
          }
        }
        @keyframes plssHeartPulse {
          0%, 100% {
            transform: scale(1);
            stroke: #7d899b;
          }
          14% {
            transform: scale(1.18);
            stroke: ${strokeColor};
          }
          28% {
            transform: scale(1);
            stroke: #7d899b;
          }
          42% {
            transform: scale(1.1);
            stroke: ${strokeColor};
          }
          58% {
            transform: scale(1);
            stroke: #7d899b;
          }
        }
        /* Respeta la preferencia de movimiento reducido */
        @media (prefers-reduced-motion: reduce) {
          .ecg-trace-path {
            animation: none !important;
          }
        }
      `}</style>

      {/* Trazo ECG que se dibuja de nuevo en cada latido, sincronizado con los BPM reales */}
      <svg
        viewBox="0 0 108 20"
        preserveAspectRatio="none"
        style={{ width: '100%', height: '20px', display: 'block' }}
        aria-label="Onda ECG sintética"
      >
        <path
          className="ecg-trace-path"
          d={wavePath}
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.45"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="200"
          style={{
            animationName: 'ecgTraceDraw',
            animationDuration: `${traceDurationSec}s`,
            animationTimingFunction: 'linear',
            animationIterationCount: 'infinite',
            animationPlayState: live ? 'running' : 'paused',
            opacity: live ? 1 : 0.4,
          }}
        />
      </svg>
    </div>
  );
};

/**
 * Medidor lineal tipo píldora con marca vertical de umbral (25% / 30%).
 */
const PlssLinearGauge: React.FC<{
  valuePct: number;
  minThresholdPct: number;
  fillColor: string;
}> = ({ valuePct, minThresholdPct, fillColor }) => {
  const clamped = Math.max(0, Math.min(100, valuePct));

  return (
    <div style={{ position: 'relative', height: '12px', display: 'flex', alignItems: 'center' }}>
      {/* Pista en píldora */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '5.5px',
          background: '#232936',
          borderRadius: '999px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.max(2, clamped)}%`,
            height: '100%',
            background: fillColor,
            borderRadius: '999px',
            transition: 'width 240ms ease-out, background-color 200ms ease',
          }}
        />
      </div>

      {/* Marca vertical de umbral que cruza la barra */}
      <div
        title={`Umbral: ${minThresholdPct}%`}
        style={{
          position: 'absolute',
          left: `${minThresholdPct}%`,
          top: '0px',
          width: '1.5px',
          height: '12px',
          background: '#94a3b8',
          transform: 'translateX(-0.75px)',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
};

// Fila de la leyenda: celda de muestra cartográfica uniforme + etiqueta y nota concisa.
const LegendRow: React.FC<{
  swatch: React.ReactNode;
  label: string;
  desc: string;
  isLast?: boolean;
}> = ({ swatch, label, desc, isLast = false }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '7.5px 12px',
      borderBottom: isLast ? 'none' : '1px solid #142338',
    }}
  >
    <div
      style={{
        width: '32px',
        height: '24px',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#060d18',
        border: '1px solid #182b44',
        borderRadius: '4px',
        boxShadow: 'inset 0 1px 3px rgba(0, 0, 0, 0.6)',
      }}
    >
      {swatch}
    </div>
    <div style={{ lineHeight: 1.25, minWidth: 0 }}>
      <div style={{ fontSize: '11.5px', fontWeight: 600, color: '#f1f5f9' }}>{label}</div>
      <div style={{ fontSize: '10.5px', color: '#8a9bb2', marginTop: '1.5px' }}>{desc}</div>
    </div>
  </div>
);

// Panel de Leyenda: clave cartográfica estructurada con simbología aeroespacial/USGS.
const MapLegend: React.FC<{ open: boolean; onToggle: () => void }> = ({ open, onToggle }) => (
  <div style={{ position: 'absolute', left: '14px', top: '14px', zIndex: 7 }}>
    {!open ? (
      <button
        onClick={onToggle}
        title="Mostrar simbología del mapa"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '7px',
          background: 'rgba(8, 10, 15, 0.92)',
          border: '1px solid #262830',
          borderRadius: '5px',
          color: '#f1f5f9',
          fontSize: '11.5px',
          fontWeight: 500,
          padding: '6px 11px',
          cursor: 'pointer',
          boxShadow: '0 4px 14px rgba(2, 6, 14, 0.55)',
        }}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon
            points="8,1.8 14.2,5.2 8,8.6 1.8,5.2"
            stroke="#38bdf8"
            strokeWidth="1.25"
            fill="rgba(56, 189, 248, 0.14)"
          />
          <polyline points="1.8,8.5 8,11.9 14.2,8.5" stroke="#8a9bb2" strokeWidth="1.2" />
          <polyline points="1.8,11.4 8,14.6 14.2,11.4" stroke="#64748b" strokeWidth="1.1" />
        </svg>
        Leyenda
      </button>
    ) : (
      <section
        aria-label="Simbología del mapa"
        style={{
          width: '248px',
          background: 'rgba(8, 10, 15, 0.96)',
          border: '1px solid #262830',
          borderRadius: '6px',
          overflow: 'hidden',
          boxShadow: '0 10px 28px rgba(2, 6, 14, 0.72)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 12px',
            background: '#0c0e13',
            borderBottom: '1px solid #23252b',
          }}
        >
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#f1f5f9' }}>
            Simbología del mapa
          </span>
          <button
            onClick={onToggle}
            title="Ocultar leyenda"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#8a9bb2',
              cursor: 'pointer',
              fontSize: '12px',
              lineHeight: 1,
              padding: '2px 4px',
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* 1. Ruta segura: corredor de seguridad + traza curva punteada + vector de avance */}
          <LegendRow
            label="Ruta segura"
            desc="Corredor y traza calculada por el host"
            swatch={
              <svg viewBox="0 0 28 18" width="26" height="17" fill="none">
                <path
                  d="M3 13.5 C9 13.5, 11 4.5, 22 4.5"
                  stroke="#38bdf8"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <polyline
                  points="19.5,2.2 23.5,4.5 19.5,6.8"
                  stroke="#38bdf8"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            }
          />

          {/* 2. EVA-01: baliza táctica con 4 muescas cardinales y núcleo activo */}
          <LegendRow
            label="EVA-01"
            desc="Posición actual en superficie"
            swatch={
              <svg viewBox="0 0 22 22" width="19" height="19" fill="none">
                <circle
                  cx="11"
                  cy="11"
                  r="8.2"
                  stroke="rgba(56, 189, 248, 0.35)"
                  strokeWidth="1"
                />
                <line x1="11" y1="1.2" x2="11" y2="3.6" stroke="#38bdf8" strokeWidth="1.3" strokeLinecap="round" />
                <line x1="11" y1="18.4" x2="11" y2="20.8" stroke="#38bdf8" strokeWidth="1.3" strokeLinecap="round" />
                <line x1="1.2" y1="11" x2="3.6" y2="11" stroke="#38bdf8" strokeWidth="1.3" strokeLinecap="round" />
                <line x1="18.4" y1="11" x2="20.8" y2="11" stroke="#38bdf8" strokeWidth="1.3" strokeLinecap="round" />
                <circle cx="11" cy="11" r="5" fill="#38bdf8" stroke="#0b192c" strokeWidth="1.8" />
                <circle cx="11" cy="11" r="2" fill="#0b192c" />
              </svg>
            }
          />

          {/* 3. Destino: retícula romboidal de objetivo con mira central */}
          <LegendRow
            label="Destino"
            desc="Objetivo de caminata (clic izq.)"
            swatch={
              <svg viewBox="0 0 22 22" width="19" height="19" fill="none">
                <polygon
                  points="11,2.2 19.8,11 11,19.8 2.2,11"
                  fill="rgba(245, 158, 11, 0.14)"
                  stroke="#f59e0b"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <line x1="11" y1="5.8" x2="11" y2="8.2" stroke="#fbbf24" strokeWidth="1.2" strokeLinecap="round" />
                <line x1="11" y1="13.8" x2="11" y2="16.2" stroke="#fbbf24" strokeWidth="1.2" strokeLinecap="round" />
                <line x1="5.8" y1="11" x2="8.2" y2="11" stroke="#fbbf24" strokeWidth="1.2" strokeLinecap="round" />
                <line x1="13.8" y1="11" x2="16.2" y2="11" stroke="#fbbf24" strokeWidth="1.2" strokeLinecap="round" />
                <circle cx="11" cy="11" r="2" fill="#fbbf24" />
              </svg>
            }
          />

          {/* 4. Parada científica: estación geológica hexagonal con índice tabular */}
          <LegendRow
            label="Parada científica"
            desc="Clic der. agrega o borra (máx. 4)"
            swatch={
              <svg viewBox="0 0 22 22" width="19" height="19" fill="none">
                <polygon
                  points="11,2 18.8,6.5 18.8,15.5 11,20 3.2,15.5 3.2,6.5"
                  fill="#0b1b2e"
                  stroke="#38bdf8"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <polygon
                  points="11,4.2 16.8,7.6 16.8,14.4 11,17.8 5.2,14.4 5.2,7.6"
                  stroke="rgba(248, 250, 252, 0.25)"
                  strokeWidth="0.8"
                />
                <text
                  x="11"
                  y="11.6"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize="8.5"
                  fontWeight="700"
                  fill="#f8fafc"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  1
                </text>
              </svg>
            }
          />

          {/* 5. Dron y cobertura: barrido cónico de radar + silueta aérea */}
          <LegendRow
            label="Dron y cobertura"
            desc="Posición aérea y radio de escaneo"
            swatch={
              <svg viewBox="0 0 22 22" width="19" height="19" fill="none">
                <circle
                  cx="11"
                  cy="11"
                  r="8.8"
                  fill="rgba(168, 85, 247, 0.16)"
                  stroke="rgba(192, 132, 252, 0.72)"
                  strokeWidth="1.2"
                  strokeDasharray="2.5,2"
                />
                <path
                  d="M11,11 L17.2,4.8 A8.8,8.8 0 0,1 19.8,11 Z"
                  fill="rgba(192, 132, 252, 0.34)"
                />
                <line x1="8.2" y1="8.2" x2="13.8" y2="13.8" stroke="#e9d5ff" strokeWidth="1.2" strokeLinecap="round" />
                <line x1="13.8" y1="8.2" x2="8.2" y2="13.8" stroke="#e9d5ff" strokeWidth="1.2" strokeLinecap="round" />
                <circle cx="11" cy="11" r="2.2" fill="#c084fc" stroke="#2e1065" strokeWidth="0.9" />
              </svg>
            }
          />

          {/* 6. Obstáculo o cráter: contorno planetario USGS con muescas interiores (hachures) */}
          <LegendRow
            isLast
            label="Obstáculo o cráter"
            desc="Depresión o terreno de riesgo"
            swatch={
              <svg viewBox="0 0 24 18" width="22" height="16" fill="none">
                <ellipse
                  cx="12"
                  cy="9"
                  rx="9.2"
                  ry="6.2"
                  fill="rgba(239, 68, 68, 0.16)"
                  stroke="#f87171"
                  strokeWidth="1.4"
                />
                {/* Muescas topográficas hacia el interior de la depresión */}
                <line x1="12" y1="2.8" x2="12" y2="5.1" stroke="#f87171" strokeWidth="1.2" strokeLinecap="round" />
                <line x1="12" y1="15.2" x2="12" y2="12.9" stroke="#f87171" strokeWidth="1.2" strokeLinecap="round" />
                <line x1="2.8" y1="9" x2="5.2" y2="9" stroke="#f87171" strokeWidth="1.2" strokeLinecap="round" />
                <line x1="21.2" y1="9" x2="18.8" y2="9" stroke="#f87171" strokeWidth="1.2" strokeLinecap="round" />
                <line x1="5.6" y1="4.6" x2="7.3" y2="6.1" stroke="#f87171" strokeWidth="1.1" strokeLinecap="round" />
                <line x1="18.4" y1="4.6" x2="16.7" y2="6.1" stroke="#f87171" strokeWidth="1.1" strokeLinecap="round" />
                <line x1="5.6" y1="13.4" x2="7.3" y2="11.9" stroke="#f87171" strokeWidth="1.1" strokeLinecap="round" />
                <line x1="18.4" y1="13.4" x2="16.7" y2="11.9" stroke="#f87171" strokeWidth="1.1" strokeLinecap="round" />
              </svg>
            }
          />
        </div>
      </section>
    )}
  </div>
);

export const TopographicMap2D: React.FC<TopographicMap2DProps> = ({
  dataset,
  droneData,
  mode,
  evaYaw = 0,
  eva = null,
  risk,
  utcTime = '10:46:22',
  isConnected = false,
  customUrls,
  onSwitchMode,
  onChangeUrl,
  onApplyUrl,
  onTargetSelect,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadedImgRef = useRef<HTMLImageElement | null>(null);

  const [mapLayerMode, setMapLayerMode] = useState<MapLayerMode>('fusion_mars_d415');
  const [imageSrc, setImageSrc] = useState<string>('/mars-terrain.jpg');
  const liveImgRef = useRef<HTMLImageElement | null>(null);
  const [liveImageVersion, setLiveImageVersion] = useState<number>(0);

  // Cargar dinámicamente imágenes Base64 de la cámara D415 (route_map / rgb / depth)
  // para proyectarlas como fondo en el lienzo principal cuando el operador activa la capa en vivo.
  useEffect(() => {
    let srcToLoad: string | null = null;
    if (mapLayerMode === 'live_route_map' || mapLayerMode === 'live_server_cam') {
      srcToLoad = droneData?.images?.route_map ?? null;
    } else if (mapLayerMode === 'live_rgb') {
      srcToLoad = droneData?.images?.rgb ?? null;
    } else if (mapLayerMode === 'live_depth') {
      srcToLoad = droneData?.images?.depth ?? null;
    }

    if (!srcToLoad) {
      liveImgRef.current = null;
      setLiveImageVersion((v) => v + 1);
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = srcToLoad.startsWith('data:') ? srcToLoad : `data:image/jpeg;base64,${srcToLoad}`;
    img.onload = () => {
      liveImgRef.current = img;
      setLiveImageVersion((v) => v + 1);
    };
  }, [
    mapLayerMode,
    droneData?.images?.route_map,
    droneData?.images?.rgb,
    droneData?.images?.depth,
  ]);

  const [baseVisionData, setBaseVisionData] = useState<ImageVisionAnalysis | null>(null);
  const [localMapState, setLocalMapState] = useState<RealMapStatePayload | null>(null);
  const [openCvPayload, setOpenCvPayload] = useState<OpenCvPrecomputedPayload | null>(null);

  // Capas del mapa (panel "CAPAS DEL MAPA"): cada una se puede prender/apagar por
  // separado, en vez del único botón de "Ojo" que las mezclaba todas antes.
  const [showCraters, setShowCraters] = useState<boolean>(true);
  const [showEscarpments, setShowEscarpments] = useState<boolean>(true);
  const [showContourLines, setShowContourLines] = useState<boolean>(true);
  const [showMetricGrid, setShowMetricGrid] = useState<boolean>(true);
  const [showLayersPanel, setShowLayersPanel] = useState<boolean>(false);
  const showD415GridOverlay = false;
  const showServerPaths = false;

  // Ubicaciones iniciales alineadas con la composición del boceto (EVA_01 y Destino dentro del círculo morado)
  const [targetPoint, setTargetPoint] = useState<[number, number]>([4.45, 2.75]);
  const [hasUserSelectedTarget, setHasUserSelectedTarget] = useState<boolean>(false);
  const [showTelemetry, setShowTelemetry] = useState<boolean>(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState<boolean>(false);
  const [showLegend, setShowLegend] = useState<boolean>(false);

  // Paradas científicas: se agregan con clic derecho (hasta MAX_STOPS) y se quitan
  // con clic derecho sobre una ya puesta.
  const [stops, setStops] = useState<ScientificStop[]>([]);
  const [pendingStopPos, setPendingStopPos] = useState<[number, number] | null>(null);
  const [pendingStopName, setPendingStopName] = useState<string>('');
  const [pendingStopObjective, setPendingStopObjective] = useState<string>('');
  const [maxStopsNotice, setMaxStopsNotice] = useState<boolean>(false);
  const [selectedStop, setSelectedStop] = useState<ScientificStop | null>(null);

  // Arranca centrado en el cráter Dollfus (21.8°S, 4.3°W); se actualiza con el mouse.
  const [hoverCoords, setHoverCoords] = useState<{ lat: string; lon: string }>({
    lat: DOLLFUS_CENTER.lat.toFixed(5),
    lon: `${DOLLFUS_CENTER.lon.toFixed(5)}°`,
  });

  // Zoom libre y continuo (tipo Google Maps, sin arrastrar/pan): rueda del mouse o
  // los botones +/- acercan/alejan hacia el centro del mapa, con tiles reales de
  // Mars Trek (cráter Dollfus) de fondo. No hay niveles con nombre: currentSpanKm es
  // el ancho/alto real (en km) que cubre la vista en este momento. Los marcadores
  // (EVA-01, Destino, obstáculos, paradas, ruta) se reproyectan con el mismo zoom,
  // así que se mueven con el terreno en vez de quedarse pegados a la pantalla.
  const [currentSpanKm, setCurrentSpanKm] = useState<number>(DEFAULT_SPAN_KM);
  const [loadedTierSpanKm, setLoadedTierSpanKm] = useState<number>(REFERENCE_SPAN_KM);
  const [zoomTilesLoading, setZoomTilesLoading] = useState<boolean>(false);
  const [zoomTilesFailed, setZoomTilesFailed] = useState<boolean>(false);
  const lastRequestedTierRef = useRef<number | null>(null);

  const zoomScale = zoomScaleFor(currentSpanKm);
  const bgCropFraction = bgCropFractionFor(currentSpanKm, loadedTierSpanKm);

  const changeZoom = (dir: 1 | -1) => {
    setCurrentSpanKm((prev) => {
      const next = dir === 1 ? prev / ZOOM_STEP_FACTOR : prev * ZOOM_STEP_FACTOR;
      return Math.min(MAX_SPAN_KM, Math.max(MIN_SPAN_KM, next));
    });
  };

  const resetZoom = () => setCurrentSpanKm(DEFAULT_SPAN_KM);

  // Sólo recarga tiles reales cuando el zoom cruza a un escalón de detalle distinto
  // (TIERS_KM); entre medio, el zoom se ve recortando/escalando el mismo mosaico ya
  // cargado (sin red), igual que un visor de mapas real mientras llega más detalle.
  useEffect(() => {
    const neededTier = activeTierForSpan(currentSpanKm);
    if (lastRequestedTierRef.current === neededTier) return;
    lastRequestedTierRef.current = neededTier;

    let cancelled = false;
    setZoomTilesLoading(true);
    setZoomTilesFailed(false);
    buildMarsMosaic(neededTier)
      .then((res) => {
        if (cancelled) return;
        setImageSrc(res.dataUrl);
        setLoadedTierSpanKm(res.spanKm);
      })
      .catch(() => {
        if (cancelled) return;
        setZoomTilesFailed(true);
        setImageSrc('/mars-terrain.jpg');
        setLoadedTierSpanKm(REFERENCE_SPAN_KM);
      })
      .finally(() => {
        if (!cancelled) setZoomTilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentSpanKm]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      changeZoom(e.deltaY < 0 ? 1 : -1);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    fetch('/data/real_map_state.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.occupancy_grid) {
          setLocalMapState(d);
        }
      })
      .catch(() => {});

    fetch('/data/opencv_craters.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((cv) => {
        if (cv && Array.isArray(cv.craters_hough)) {
          setOpenCvPayload(cv);
        }
      })
      .catch(() => {});
  }, []);

  const activeMapState: RealMapStatePayload | null = droneData?.map_state ?? localMapState;

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageSrc;
    img.onload = () => {
      loadedImgRef.current = img;
      const isDefaultMars = imageSrc.includes('mars-terrain');
      const analysis = analyzeImageTerrainReal(
        img,
        GRID_COLS,
        GRID_ROWS,
        isDefaultMars ? openCvPayload : null
      );
      setBaseVisionData(analysis);
    };
  }, [imageSrc, openCvPayload]);

  const visionData = useMemo(
    () =>
      fuseVisionWithD415Data(
        baseVisionData,
        activeMapState,
        droneData,
        dataset,
        GRID_COLS,
        GRID_ROWS
      ),
    [baseVisionData, activeMapState, droneData, dataset]
  );

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setImageSrc(objectUrl);
  };

  const basePos: [number, number] = [1.1, 5.8];
  const dronePadPos: [number, number] = FIXED_DRONE_PAD_POS;
  // Posición de inicio fija y estable para evitar que la línea tiemble o se mueva sola
  const evaPos: [number, number] = [3.62, 5.55];
  const startPoint: [number, number] = evaPos;

  const safeRoute = useMemo(() => {
    // Si NO hay host conectado, no trazamos ninguna línea falsa ni recta; indicamos NO HOST
    if (!isConnected) {
      return {
        points: [],
        distanceMeters: 0,
        estimatedSeconds: 0,
        maxSlopeDeg: 0,
        minSafetyMarginMeters: 0,
        isCompletelySafe: false,
      };
    }

    // Si el usuario seleccionó un punto, buscamos la ruta devuelta por el host para ese punto
    const serverWaypoints = droneData?.navigation?.route_waypoints_xy_m;
    if (serverWaypoints && serverWaypoints.length > 1) {
      if (hasUserSelectedTarget) {
        const lastPt = serverWaypoints[serverWaypoints.length - 1];
        const mappedLast = d415MetersToMapMeters(lastPt[0], lastPt[1]);
        const distToTarget = Math.hypot(mappedLast[0] - targetPoint[0], mappedLast[1] - targetPoint[1]);
        // Solo la dibujamos si los waypoints del host corresponden a la zona solicitada
        if (distToTarget < 2.0) {
          const mappedPts: [number, number][] = serverWaypoints.map(([xm, ym]) =>
            d415MetersToMapMeters(xm, ym)
          );
          let dist = 0;
          for (let i = 1; i < mappedPts.length; i++) {
            dist += Math.hypot(mappedPts[i][0] - mappedPts[i - 1][0], mappedPts[i][1] - mappedPts[i - 1][1]);
          }
          return {
            points: mappedPts,
            distanceMeters: Number(dist.toFixed(1)),
            estimatedSeconds: Math.round(dist / 0.8),
            maxSlopeDeg: droneData.max_slope_deg || 12.0,
            minSafetyMarginMeters: 0.5,
            isCompletelySafe: droneData.safe_path ?? true,
          };
        }
        // Si aún no responde el host con los waypoints de este objetivo, no pintamos línea recta
        return {
          points: [],
          distanceMeters: 0,
          estimatedSeconds: 0,
          maxSlopeDeg: 0,
          minSafetyMarginMeters: 0,
          isCompletelySafe: false,
        };
      }

      // Si no hay clic pero hay ruta inicial del host
      const mappedPts: [number, number][] = serverWaypoints.map(([xm, ym]) =>
        d415MetersToMapMeters(xm, ym)
      );
      let dist = 0;
      for (let i = 1; i < mappedPts.length; i++) {
        dist += Math.hypot(mappedPts[i][0] - mappedPts[i - 1][0], mappedPts[i][1] - mappedPts[i - 1][1]);
      }
      return {
        points: mappedPts,
        distanceMeters: Number(dist.toFixed(1)),
        estimatedSeconds: Math.round(dist / 0.8),
        maxSlopeDeg: droneData.max_slope_deg || 12.0,
        minSafetyMarginMeters: 0.5,
        isCompletelySafe: droneData.safe_path ?? true,
      };
    }

    // Sin waypoints del host: no pintar línea recta
    return {
      points: [],
      distanceMeters: 0,
      estimatedSeconds: 0,
      maxSlopeDeg: 0,
      minSafetyMarginMeters: 0,
      isCompletelySafe: false,
    };
  }, [
    isConnected,
    hasUserSelectedTarget,
    targetPoint,
    droneData?.navigation?.route_waypoints_xy_m,
    droneData?.max_slope_deg,
    droneData?.safe_path,
  ]);

  const elevationProfile = useMemo(() => {
    if (!visionData || safeRoute.points.length < 2) return [];
    const pts = safeRoute.points;
    const segLens: number[] = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      segLens.push(d);
      total += d;
    }
    if (total === 0) return [];

    const SAMPLES = 28;
    const rawSamples: Array<{ dist: number; elev: number; gridSlope: number }> = [];
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
      const p0 = pts[idx];
      const p1 = pts[idx + 1] ?? pts[idx];
      const x = p0[0] + (p1[0] - p0[0]) * t;
      const y = p0[1] + (p1[1] - p0[1]) * t;
      rawSamples.push({
        dist: Number((targetDist * 10).toFixed(1)),
        elev: sampleMatrixAt(x, y, visionData.elevationGrid),
        gridSlope: sampleMatrixAt(x, y, visionData.slopeGrid),
      });
    }

    const pointSlopes = new Array(rawSamples.length).fill(0);
    for (let i = 1; i < rawSamples.length; i++) {
      const prev = rawSamples[i - 1];
      const cur = rawSamples[i];
      const stepDist = Math.max(1, cur.dist - prev.dist);
      const deltaElev = Math.abs(cur.elev - prev.elev);
      const climbDeg = (Math.atan2(deltaElev * 0.38, stepDist) * 180) / Math.PI;
      const upperIdx = cur.elev >= prev.elev ? i : i - 1;
      if (upperIdx >= 1 && upperIdx < rawSamples.length - 1) {
        const terrainSlope = rawSamples[upperIdx].gridSlope * 0.85;
        const segSlope = Number(
          Math.min(35, Math.max(climbDeg, terrainSlope * 0.65 + climbDeg * 0.5)).toFixed(1)
        );
        if (segSlope > pointSlopes[upperIdx]) {
          pointSlopes[upperIdx] = segSlope;
        }
      }
    }

    for (let i = 1; i < rawSamples.length - 1; i++) {
      if (pointSlopes[i] === 0) {
        pointSlopes[i] = Number((rawSamples[i].gridSlope * 0.75).toFixed(1));
      }
    }

    return rawSamples.map((pt, i) => ({
      dist: pt.dist,
      elev: pt.elev,
      slope: pointSlopes[i],
    }));
  }, [visionData, safeRoute]);

  const maxRouteSlopeDeg = useMemo(() => {
    if (elevationProfile.length < 3) return safeRoute.maxSlopeDeg;
    let maxS = 0;
    for (let i = 1; i < elevationProfile.length - 1; i++) {
      if (elevationProfile[i].slope > maxS) {
        maxS = elevationProfile[i].slope;
      }
    }
    return Number((maxS || safeRoute.maxSlopeDeg).toFixed(1));
  }, [elevationProfile, safeRoute.maxSlopeDeg]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !visionData) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    renderTopographicMapCanvas({
      ctx,
      width: canvas.width,
      height: canvas.height,
      gridCols: GRID_COLS,
      gridRows: GRID_ROWS,
      dataset,
      visionData,
      activeMapState,
      droneData,
      loadedImg: loadedImgRef.current,
      liveImg: liveImgRef.current,
      mapLayerMode,
      showCraters,
      showEscarpments,
      showContourLines,
      showMetricGrid,
      showD415GridOverlay,
      showServerPaths,
      safeRoute,
      targetPoint,
      basePos,
      dronePadPos,
      evaPos,
      stops,
      zoomScale,
      bgCropFraction,
    });
  }, [
    dataset,
    visionData,
    activeMapState,
    droneData,
    mapLayerMode,
    showCraters,
    showEscarpments,
    showContourLines,
    showMetricGrid,
    showD415GridOverlay,
    showServerPaths,
    evaYaw,
    targetPoint,
    safeRoute,
    stops,
    zoomScale,
    bgCropFraction,
    liveImageVersion,
  ]);

  // Convierte la posición del mouse/clic en el canvas a las mismas "unidades" (0..10)
  // que usa el resto del mapa para EVA-01, Destino, el Dron y ahora las paradas —
  // deshaciendo el mismo zoom (centrado, sin pan) con el que se dibujan.
  const eventToMeters = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const relX = Math.max(0.04, Math.min(0.96, (e.clientX - rect.left) / rect.width));
    const relY = Math.max(0.05, Math.min(0.95, (e.clientY - rect.top) / rect.height));
    return [
      Number(unprojectFrac(relX, dataset.widthMeters, zoomScale).toFixed(2)),
      Number(unprojectFrac(relY, dataset.heightMeters, zoomScale).toFixed(2)),
    ];
  };

  const STOP_HIT_RADIUS_M = dataset.widthMeters * 0.04;

  const findStopNear = (xm: number, ym: number): ScientificStop | null => {
    let closest: ScientificStop | null = null;
    let bestDist = Infinity;
    for (const s of stops) {
      const d = Math.hypot(s.xm - xm, s.ym - ym);
      if (d < STOP_HIT_RADIUS_M && d < bestDist) {
        bestDist = d;
        closest = s;
      }
    }
    return closest;
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pt = eventToMeters(e);
    if (!pt) return;
    const [xm, ym] = pt;

    const hit = findStopNear(xm, ym);
    if (hit) {
      setSelectedStop(hit);
      return;
    }

    setSelectedStop(null);
    setTargetPoint([xm, ym]);
    setHasUserSelectedTarget(true);
    if (onTargetSelect) {
      onTargetSelect([xm, ym]);
    }
  };

  // Clic derecho: sobre una parada existente la borra; sobre vacío abre el
  // formulario para agregar una nueva (hasta MAX_STOPS).
  const handleCanvasContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const pt = eventToMeters(e);
    if (!pt) return;
    const [xm, ym] = pt;

    const hit = findStopNear(xm, ym);
    if (hit) {
      setStops((prev) =>
        prev.filter((s) => s.id !== hit.id).map((s, i) => ({ ...s, number: i + 1 }))
      );
      if (selectedStop?.id === hit.id) setSelectedStop(null);
      return;
    }

    if (stops.length >= MAX_STOPS) {
      setMaxStopsNotice(true);
      window.setTimeout(() => setMaxStopsNotice(false), 2200);
      return;
    }

    setPendingStopName('');
    setPendingStopObjective('');
    setPendingStopPos([xm, ym]);
  };

  const confirmAddStop = () => {
    if (!pendingStopPos) return;
    const number = stops.length + 1;
    const newStop: ScientificStop = {
      id: `stop-${Date.now()}`,
      number,
      name: pendingStopName.trim() || `Parada ${number}`,
      objective: pendingStopObjective.trim() || 'Objetivo científico por definir',
      xm: pendingStopPos[0],
      ym: pendingStopPos[1],
    };
    setStops((prev) => [...prev, newStop]);
    setPendingStopPos(null);
  };

  const cancelAddStop = () => setPendingStopPos(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    // Lat/Lon reales según el zoom libre activo, centradas en el cráter Dollfus
    // (no un desplazamiento inventado): la vista cubre currentSpanKm de lado real.
    const { latSpanDeg, lonSpanDeg } = degSpansForSpanKm(currentSpanKm);
    const lat = (DOLLFUS_CENTER.lat + latSpanDeg * (0.5 - relY)).toFixed(5);
    const lon = (DOLLFUS_CENTER.lon + lonSpanDeg * (relX - 0.5)).toFixed(5) + '°';
    setHoverCoords({ lat, lon });
  };

  // Registros tácticos de Obstáculos y Pendientes: uno por cada hallazgo real
  // (visionData.detectedObstacles) más un renglón de pendiente general de la ruta —
  // nada fabricado, cada tarjeta corresponde a un dato que el frontend ya tiene.
  const KIND_TITLE: Record<string, string> = {
    crater_wall: 'Cráter segmentado',
    steep_cliff: 'Escarpe pronunciado',
    rock_obstacle: 'Roca / obstáculo',
    sand_trap: 'Terreno irregular',
  };
  const levelForSlope = (slope: number): 'red' | 'yellow' | 'green' =>
    slope >= 30 ? 'red' : slope >= 15 ? 'yellow' : 'green';
  const LEVEL_META = {
    red: { severityLabel: 'Crítico', accent: '#e5484d', badgeBg: 'rgba(229, 72, 77, 0.12)', badgeBorder: 'rgba(229, 72, 77, 0.38)', badgeText: '#f87171' },
    yellow: { severityLabel: 'Precaución', accent: '#e5a024', badgeBg: 'rgba(229, 160, 36, 0.12)', badgeBorder: 'rgba(229, 160, 36, 0.38)', badgeText: '#fbbf24' },
    green: { severityLabel: 'Despejado', accent: '#2fb380', badgeBg: 'rgba(47, 179, 128, 0.12)', badgeBorder: 'rgba(47, 179, 128, 0.35)', badgeText: '#6ee7b7' },
  } as const;

  const riskCards = useMemo(() => {
    const overallLevel = levelForSlope(maxRouteSlopeDeg);
    const overall = {
      level: overallLevel,
      ...LEVEL_META[overallLevel],
      title: 'Pendiente de terreno',
      metric: `${maxRouteSlopeDeg.toFixed(1)}°`,
      source: 'Elevación sintética',
      value: '0.00 m',
    };

    const obstacleCards = (visionData?.detectedObstacles ?? []).map((obs) => {
      const level = levelForSlope(obs.slopeDeg);
      return {
        level,
        ...LEVEL_META[level],
        title: KIND_TITLE[obs.kind] ?? 'Obstáculo detectado',
        metric: `${obs.slopeDeg.toFixed(1)}°`,
        source: obs.detector ?? 'Sin clasificar',
        value: `${obs.radius.toFixed(2)} m`,
      };
    });

    return [overall, ...obstacleCards].sort(
      (a, b) => parseFloat(b.metric) - parseFloat(a.metric)
    );
  }, [visionData?.detectedObstacles, maxRouteSlopeDeg]);

  // Sólo se listan los hallazgos que de verdad son una alerta (crítico/precaución),
  // igual que en la referencia — el terreno despejado no genera tarjeta.
  const alertCards = riskCards.filter((c) => c.level !== 'green');
  const criticalCount = alertCards.filter((c) => c.level === 'red').length;
  const cautionCount = alertCards.filter((c) => c.level === 'yellow').length;
  const detectorList = Array.from(
    new Set((visionData?.detectedObstacles ?? []).map((o) => o.detector).filter(Boolean))
  ).join(' · ');


  // Valores de telemetría del traje (usa datos reales si están presentes, o los valores de referencia)
  const o2Level = eva ? eva.suit_o2 : 87.0;
  const heartRate = eva ? eva.heart_rate : 75;
  const suitPressurePct = eva ? eva.battery : 96.1;
  const isO2Critical = o2Level <= 25;
  const isO2Warn = !isO2Critical && o2Level <= 40;
  const isHrElevated = heartRate >= 135 || heartRate <= 50;

  return (
    <div
      style={{
        fontFamily: UI_FONT,
        color: '#f8fafc',
        position: 'relative',
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileUpload}
        style={{ display: 'none' }}
      />

      {/* Encabezado Superior de Ancho Completo (ARES Flight Deck + Terminal táctica + Franja de contexto EVA) */}
      <header
        style={{
          background: '#080a0f',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        {/* Fila 1: Barra superior ARES FLIGHT DECK de extremo a extremo */}
        <div
          style={{
            borderBottom: '1px solid #151b26',
            background: '#080a0f',
          }}
        >
          <div
            style={{
              maxWidth: '1480px',
              margin: '0 auto',
              padding: '12px 24px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '16px',
              flexWrap: 'wrap',
            }}
          >
            {/* Marca izquierda: Icono orbital + ARES FLIGHT DECK */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '8px',
                  background: '#0c1018',
                  border: '1px solid #1c2434',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="19"
                  height="19"
                  fill="none"
                  stroke="#cbd5e1"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="8" strokeOpacity="0.85" />
                  <circle cx="12" cy="12" r="3.6" strokeOpacity="0.7" />
                  <circle cx="15.8" cy="6.2" r="1.3" fill="#080a0f" stroke="#cbd5e1" strokeWidth="1.2" />
                  <circle cx="8.2" cy="17.8" r="1.3" fill="#080a0f" stroke="#cbd5e1" strokeWidth="1.2" />
                </svg>
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px', lineHeight: 1.15 }}>
                  <span
                    style={{
                      fontSize: '16px',
                      fontWeight: 700,
                      color: '#f8fafc',
                      letterSpacing: '0.09em',
                    }}
                  >
                    ARES
                  </span>
                  <span
                    style={{
                      fontSize: '13px',
                      fontWeight: 400,
                      color: '#8b98a9',
                      letterSpacing: '0.14em',
                    }}
                  >
                    FLIGHT DECK
                  </span>
                </div>
                <div
                  style={{
                    fontFamily: MONO_READOUT_FONT,
                    fontSize: '8.5px',
                    color: '#525e70',
                    letterSpacing: '0.15em',
                    marginTop: '3px',
                  }}
                >
                  MARTIAN TACTICAL &amp; MISSION CONTROL
                </div>
              </div>
            </div>

            {/* Bloques derechos: IDENTIFICADOR DE MISIÓN | TIEMPO UNIVERSAL | ENLACE ACTIVO */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap' }}>
              <div style={{ width: '1px', height: '30px', background: '#171f2e' }} />

              {/* Identificador de misión */}
              <div style={{ lineHeight: 1.25 }}>
                <div
                  style={{
                    fontFamily: MONO_READOUT_FONT,
                    fontSize: '8.5px',
                    color: '#5c6878',
                    letterSpacing: '0.1em',
                    marginBottom: '5px',
                  }}
                >
                  IDENTIFICADOR DE MISIÓN
                </div>
                <div
                  style={{
                    fontFamily: MONO_READOUT_FONT,
                    fontSize: '11.5px',
                    fontWeight: 500,
                    letterSpacing: '0.05em',
                    color: '#e2e8f0',
                  }}
                >
                  MISIÓN: ARES-IV <span style={{ color: '#475569' }}>//</span> SECTOR DOLLFUS
                </div>
              </div>

              {/* Tiempo universal */}
              <div style={{ lineHeight: 1.15 }}>
                <div
                  style={{
                    fontFamily: MONO_READOUT_FONT,
                    fontSize: '8.5px',
                    color: '#5c6878',
                    letterSpacing: '0.1em',
                    marginBottom: '2px',
                  }}
                >
                  TIEMPO UNIVERSAL
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                  <span
                    style={{
                      fontFamily: MONO_READOUT_FONT,
                      fontVariantNumeric: 'tabular-nums slashed-zero',
                      fontSize: '18px',
                      fontWeight: 400,
                      color: '#f1f5f9',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {utcTime || '06:58:17'}
                  </span>
                  <span
                    style={{
                      fontFamily: MONO_READOUT_FONT,
                      fontSize: '9px',
                      color: '#64748b',
                      letterSpacing: '0.06em',
                    }}
                  >
                    UTC
                  </span>
                </div>
              </div>

              <div style={{ width: '1px', height: '30px', background: '#171f2e' }} />

              {/* Enlace activo + Selector de simulación telemétrica (abre el menú de conexión) */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <span
                    style={{
                      width: '5.5px',
                      height: '5.5px',
                      borderRadius: '50%',
                      background: '#10b981',
                    }}
                  />
                  <span
                    style={{
                      fontFamily: MONO_READOUT_FONT,
                      fontSize: '8.5px',
                      fontWeight: 500,
                      letterSpacing: '0.1em',
                      color: '#10b981',
                    }}
                  >
                    ENLACE ACTIVO
                  </span>
                </div>

                <button
                  onClick={() => setShowSettingsMenu(!showSettingsMenu)}
                  title="Configuración de enlace y fuente de mapa"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    fontFamily: MONO_READOUT_FONT,
                    fontSize: '9.5px',
                    color: '#8b98a9',
                    letterSpacing: '0.06em',
                  }}
                >
                  <svg
                    viewBox="0 0 16 14"
                    width="12"
                    height="11"
                    fill="none"
                    stroke="#64748b"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  >
                    <circle cx="8" cy="7" r="1.3" fill="#64748b" />
                    <path d="M5.2 4.4a4 4 0 0 0 0 5.2" />
                    <path d="M10.8 4.4a4 4 0 0 1 0 5.2" />
                    <path d="M3 2.4a7 7 0 0 0 0 9.2" />
                    <path d="M13 2.4a7 7 0 0 1 0 9.2" />
                  </svg>
                  <span>SIMULACIÓN TELEMÉTRICA</span>
                  <span style={{ fontSize: '10px', color: '#64748b' }}>⌄</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Contenedor centralizado para Fila 2 (Terminal táctica) y Fila 3 (Barra de contexto) */}
        <div style={{ maxWidth: '1480px', width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
          {/* Fila 2: Terminal táctica | CARTOGRAFÍA & NAVEGACIÓN EVA (excluyendo Entorno simulado, ayuda y Exportar ruta) */}
          <div
            style={{
              padding: '16px 24px 12px 24px',
              display: 'flex',
              alignItems: 'center',
              gap: '11px',
            }}
          >
            <svg
              viewBox="0 0 18 18"
              width="16"
              height="16"
              fill="none"
              stroke="#7d899b"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="1.5,4 6.5,2 11.5,4 16.5,2 16.5,14 11.5,16 6.5,14 1.5,16" />
              <line x1="6.5" y1="2" x2="6.5" y2="14" />
              <line x1="11.5" y1="4" x2="11.5" y2="16" />
            </svg>
            <h1
              style={{
                margin: 0,
                fontSize: '16px',
                fontWeight: 600,
                color: '#f1f5f9',
                lineHeight: 1.2,
              }}
            >
              Terminal táctica
            </h1>
            <span
              aria-hidden="true"
              style={{
                width: '1px',
                height: '14px',
                background: '#1e2838',
                display: 'inline-block',
              }}
            />
            <span
              style={{
                fontFamily: MONO_READOUT_FONT,
                fontSize: '9.5px',
                color: '#64748b',
                letterSpacing: '0.12em',
              }}
            >
              CARTOGRAFÍA &amp; NAVEGACIÓN EVA
            </span>
          </div>

          {/* Fila 3: Barra de contexto operativo de ancho completo */}
          <div
            style={{
              margin: '0 24px 14px 24px',
              padding: '9px 16px',
              background: '#0c1018',
              border: '1px solid #161e2c',
              borderRadius: '6px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
              <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: '8px' }}>
                <span
                  style={{
                    fontFamily: MONO_READOUT_FONT,
                    fontSize: '9px',
                    color: '#5c6878',
                    letterSpacing: '0.08em',
                  }}
                >
                  OPERACIÓN
                </span>
                <span style={{ fontSize: '11.5px', color: '#cbd5e1', fontWeight: 500 }}>
                  Reconocimiento de superficie
                </span>
              </div>

              <span style={{ width: '1px', height: '13px', background: '#1c2536', display: 'inline-block' }} />

              <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: '8px' }}>
                <span
                  style={{
                    fontFamily: MONO_READOUT_FONT,
                    fontSize: '9px',
                    color: '#5c6878',
                    letterSpacing: '0.08em',
                  }}
                >
                  UNIDAD EVA
                </span>
                <span
                  style={{
                    fontFamily: MONO_READOUT_FONT,
                    fontSize: '10.5px',
                    color: '#e2e8f0',
                    fontWeight: 600,
                    letterSpacing: '0.05em',
                  }}
                >
                  ASTRONAUTA 01
                </span>
              </div>

              <span style={{ width: '1px', height: '13px', background: '#1c2536', display: 'inline-block' }} />

              <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: '8px' }}>
                <span
                  style={{
                    fontFamily: MONO_READOUT_FONT,
                    fontSize: '9px',
                    color: '#5c6878',
                    letterSpacing: '0.08em',
                  }}
                >
                  ÁREA DE EXPLORACIÓN
                </span>
                <span
                  style={{
                    fontFamily: MONO_READOUT_FONT,
                    fontVariantNumeric: 'tabular-nums slashed-zero',
                    fontSize: '10.5px',
                    color: '#e2e8f0',
                    fontWeight: 600,
                  }}
                >
                  100.00 m²
                </span>
              </div>

              <span style={{ width: '1px', height: '13px', background: '#1c2536', display: 'inline-block' }} />
            </div>

            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  width: '5.5px',
                  height: '5.5px',
                  borderRadius: '50%',
                  background: '#10b981',
                }}
              />
              <span
                style={{
                  fontFamily: MONO_READOUT_FONT,
                  fontSize: '9px',
                  color: '#8b98a9',
                  letterSpacing: '0.09em',
                }}
              >
                PLANIFICADOR ACTIVO
              </span>
            </div>
          </div>
        </div>

        {/* Menú desplegable discreto con los controles de IP y Subir Imagen */}
        {showSettingsMenu && (
          <div
            style={{
              position: 'absolute',
              top: '56px',
              right: '24px',
              width: '310px',
              background: 'rgba(11, 15, 24, 0.98)',
              border: '1px solid #1e293b',
              borderRadius: '8px',
              padding: '12px',
              zIndex: 25,
              boxShadow: '0 12px 30px rgba(0, 0, 0, 0.8)',
              fontSize: '11px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <strong style={{ color: '#38bdf8' }}>Enlace y Fuente de Mapa</strong>
              <span style={{ color: isConnected ? '#4ade80' : '#f87171', fontWeight: 600 }}>
                {isConnected ? '● CONECTADO' : '○ SIN CONEXIÓN'}
              </span>
            </div>

            {onSwitchMode && (
              <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                <button
                  onClick={() => onSwitchMode('local_esp')}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px',
                    padding: '5px 8px',
                    borderRadius: '5px',
                    border: mode === 'local_esp' ? '1px solid #38bdf8' : '1px solid #334155',
                    background: mode === 'local_esp' ? '#0c4a6e' : '#1e293b',
                    color: '#f8fafc',
                    cursor: 'pointer',
                    fontSize: '11px',
                  }}
                >
                  <Radio size={12} /> ESP32
                </button>
                <button
                  onClick={() => onSwitchMode('online_raspi')}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px',
                    padding: '5px 8px',
                    borderRadius: '5px',
                    border: mode === 'online_raspi' ? '1px solid #a855f7' : '1px solid #334155',
                    background: mode === 'online_raspi' ? '#4c1d95' : '#1e293b',
                    color: '#f8fafc',
                    cursor: 'pointer',
                    fontSize: '11px',
                  }}
                >
                  <Server size={12} /> Raspi
                </button>
              </div>
            )}

            {customUrls && onChangeUrl && onApplyUrl && (
              <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                <input
                  type="text"
                  value={customUrls[mode]}
                  onChange={(e) => onChangeUrl(e.target.value)}
                  placeholder="ws://192.168.1.100:8765"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: '#020617',
                    border: '1px solid #334155',
                    borderRadius: '4px',
                    color: '#e2e8f0',
                    padding: '4px 7px',
                    fontSize: '11px',
                  }}
                />
                <button
                  onClick={onApplyUrl}
                  style={{
                    background: '#ea580c',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '4px',
                    padding: '4px 8px',
                    cursor: 'pointer',
                    fontWeight: 600,
                    fontSize: '11px',
                  }}
                >
                  Conectar
                </button>
              </div>
            )}

            <div style={{ display: 'flex', gap: '6px' }}>
              {customUrls && (
                <button
                  onClick={() => fetchMapStateFromServer(customUrls[mode])}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '5px',
                    background: '#1e3a8a',
                    color: '#dbeafe',
                    border: '1px solid #3b82f6',
                    borderRadius: '5px',
                    padding: '5px 8px',
                    cursor: 'pointer',
                    fontSize: '11px',
                  }}
                >
                  <RefreshCw size={12} /> Sync D415
                </button>
              )}
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '5px',
                  background: '#065f46',
                  color: '#d1fae5',
                  border: '1px solid #10b981',
                  borderRadius: '5px',
                  padding: '5px 8px',
                  cursor: 'pointer',
                  fontSize: '11px',
                }}
              >
                <Upload size={12} /> Subir Mapa
              </button>
            </div>
          </div>
        )}
      </header>

      {/* Área de trabajo en 2 columnas debajo del encabezado de ancho completo */}
      <div
        style={{
          maxWidth: '1480px',
          margin: '0 auto',
          padding: '0 24px 20px 24px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '14px',
          boxSizing: 'border-box',
        }}
      >
        {/* Columna Izquierda: Tarjeta de Cartografía de superficie + Mapa */}
        <div
          style={{
            flex: '2.5 1 620px',
            minWidth: '320px',
            display: 'flex',
            flexDirection: 'column',
            background: '#080a0f',
            border: '1px solid #161e2c',
            borderRadius: '8px',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {/* Barra superior de la tarjeta del mapa: Cartografía de superficie */}
          <div
            style={{
              padding: '9px 14px',
              background: '#0c1018',
              borderBottom: '1px solid #161e2c',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '10px',
            }}
          >
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <svg
                viewBox="0 0 16 16"
                width="13"
                height="13"
                fill="none"
                stroke="#64748b"
                strokeWidth="1.3"
                strokeLinecap="round"
              >
                <circle cx="8" cy="8" r="5" />
                <line x1="8" y1="1" x2="8" y2="3.5" />
                <line x1="8" y1="12.5" x2="8" y2="15" />
                <line x1="1" y1="8" x2="3.5" y2="8" />
                <line x1="12.5" y1="8" x2="15" y2="8" />
              </svg>
              <span style={{ fontSize: '12px', color: '#cbd5e1', fontWeight: 500 }}>
                Cartografía de superficie
              </span>
            </div>
          </div>

          {/* Área central del Mapa */}
          <div style={{ position: 'relative', flex: 1, background: '#080a0f' }}>
            {/* Leyenda plegable (arriba a la izquierda) */}
            <MapLegend
              open={showLegend}
              onToggle={() => {
                const next = !showLegend;
                setShowLegend(next);
                if (next) {
                  setShowTelemetry(false);
                }
              }}
            />

            {/* Aviso visual flotante de estado de Host y Ruta */}
            {!isConnected && (
              <div
                style={{
                  position: 'absolute',
                  top: '12px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'rgba(15, 23, 42, 0.94)',
                  border: '1.5px solid #ef4444',
                  borderRadius: '20px',
                  padding: '5px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  zIndex: 8,
                  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.75)',
                }}
              >
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444' }} />
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#fca5a5', letterSpacing: '0.4px' }}>
                  NO HOST — ESPERANDO CONEXIÓN Y DATOS
                </span>
              </div>
            )}

            {isConnected && hasUserSelectedTarget && safeRoute.points.length === 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: '12px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'rgba(15, 23, 42, 0.94)',
                  border: '1.5px solid #f59e0b',
                  borderRadius: '20px',
                  padding: '5px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  zIndex: 8,
                  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.75)',
                }}
              >
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#f59e0b' }} />
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#fde68a', letterSpacing: '0.4px' }}>
                  ESPERANDO RUTA CALCULADA POR EL HOST...
                </span>
              </div>
            )}

            <canvas
              ref={canvasRef}
              width={920}
              height={540}
              onClick={handleCanvasClick}
              onMouseMove={handleMouseMove}
              onContextMenu={handleCanvasContextMenu}
              style={{
                width: '100%',
                height: '100%',
                minHeight: '460px',
                cursor: 'crosshair',
                display: 'block',
                objectFit: 'cover',
              }}
            />

            {/* Formulario para agregar una parada científica (clic derecho en el mapa) */}
            {pendingStopPos && (
              <div
                style={{
                  position: 'absolute',
                  left: `${Math.min(78, projectFrac(pendingStopPos[0], dataset.widthMeters, zoomScale) * 100)}%`,
                  top: `${Math.min(80, projectFrac(pendingStopPos[1], dataset.heightMeters, zoomScale) * 100)}%`,
                  transform: 'translate(-10px, -10px)',
                  background: 'rgba(8, 17, 30, 0.97)',
                  border: '1.5px solid #38bdf8',
                  borderRadius: '10px',
                  padding: '10px 12px',
                  width: '210px',
                  zIndex: 20,
                  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.6)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                }}
              >
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8', letterSpacing: '0.3px' }}>
                  NUEVA PARADA CIENTÍFICA
                </span>
                <input
                  autoFocus
                  value={pendingStopName}
                  onChange={(e) => setPendingStopName(e.target.value)}
                  placeholder="Nombre"
                  style={{
                    background: '#0b1b2e',
                    border: '1px solid #1e3a52',
                    borderRadius: '6px',
                    color: '#e2e8f0',
                    fontSize: '11px',
                    padding: '5px 7px',
                    outline: 'none',
                  }}
                />
                <textarea
                  value={pendingStopObjective}
                  onChange={(e) => setPendingStopObjective(e.target.value)}
                  placeholder="Objetivo científico (una línea)"
                  rows={2}
                  style={{
                    background: '#0b1b2e',
                    border: '1px solid #1e3a52',
                    borderRadius: '6px',
                    color: '#e2e8f0',
                    fontSize: '11px',
                    padding: '5px 7px',
                    outline: 'none',
                    resize: 'none',
                    fontFamily: 'inherit',
                  }}
                />
                <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                  <button
                    onClick={confirmAddStop}
                    style={{
                      flex: 1,
                      background: '#0e7490',
                      border: '1px solid #38bdf8',
                      borderRadius: '6px',
                      color: '#e0f2fe',
                      fontSize: '11px',
                      fontWeight: 700,
                      padding: '5px 0',
                      cursor: 'pointer',
                    }}
                  >
                    Agregar
                  </button>
                  <button
                    onClick={cancelAddStop}
                    style={{
                      flex: 1,
                      background: 'transparent',
                      border: '1px solid #334155',
                      borderRadius: '6px',
                      color: '#94a3b8',
                      fontSize: '11px',
                      fontWeight: 600,
                      padding: '5px 0',
                      cursor: 'pointer',
                    }}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {/* Aviso: límite de paradas alcanzado */}
            {maxStopsNotice && (
              <div
                style={{
                  position: 'absolute',
                  top: '12px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'rgba(15, 23, 42, 0.94)',
                  border: '1.5px solid #f59e0b',
                  borderRadius: '20px',
                  padding: '5px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  zIndex: 22,
                  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.75)',
                }}
              >
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#f59e0b' }} />
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#fde68a', letterSpacing: '0.4px' }}>
                  MÁXIMO 4 PARADAS CIENTÍFICAS
                </span>
              </div>
            )}

            {/* Popup de información de la parada seleccionada (clic izquierdo sobre ella) */}
            {selectedStop && (
              <div
                style={{
                  position: 'absolute',
                  left: `${Math.min(76, projectFrac(selectedStop.xm, dataset.widthMeters, zoomScale) * 100)}%`,
                  top: `${Math.min(78, projectFrac(selectedStop.ym, dataset.heightMeters, zoomScale) * 100)}%`,
                  transform: 'translate(-10px, -10px)',
                  background: 'rgba(8, 17, 30, 0.97)',
                  border: '1.5px solid #38bdf8',
                  borderRadius: '10px',
                  padding: '10px 12px',
                  width: '200px',
                  zIndex: 20,
                  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.6)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: '#38bdf8' }}>
                    #{selectedStop.number} · {selectedStop.name}
                  </span>
                  <button
                    onClick={() => setSelectedStop(null)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#64748b',
                      fontSize: '13px',
                      cursor: 'pointer',
                      lineHeight: 1,
                    }}
                  >
                    ✕
                  </button>
                </div>
                <p style={{ fontSize: '11px', color: '#cbd5e1', margin: '6px 0 0', lineHeight: 1.4 }}>
                  {selectedStop.objective}
                </p>
                <p style={{ fontSize: '10px', color: '#64748b', margin: '6px 0 0' }}>
                  Distancia desde EVA-01 por la ruta:{' '}
                  {safeRoute.points.length < 2
                    ? 'sin ruta calculada'
                    : `${distanceAlongRoute(safeRoute.points, [selectedStop.xm, selectedStop.ym]).toFixed(1)} m`}
                </p>
                <p style={{ fontSize: '9.5px', color: '#475569', margin: '6px 0 0' }}>
                  Clic derecho sobre la parada para eliminarla
                </p>
              </div>
            )}

            {/* Control de zoom (derecha, vertical): acercar/alejar/centrar, como en la referencia */}
            <div
              style={{
                position: 'absolute',
                right: '14px',
                top: '50%',
                transform: 'translateY(-50%)',
                zIndex: 6,
                display: 'flex',
                flexDirection: 'column',
                background: 'rgba(10, 18, 30, 0.85)',
                border: '1px solid rgba(148, 163, 184, 0.35)',
                borderRadius: '8px',
                overflow: 'hidden',
                boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
              }}
            >
              <button
                onClick={() => changeZoom(1)}
                disabled={currentSpanKm <= MIN_SPAN_KM}
                title="Acercar"
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid rgba(148, 163, 184, 0.25)',
                  color: '#e2e8f0',
                  fontSize: '15px',
                  fontWeight: 700,
                  padding: '9px 11px',
                  cursor: currentSpanKm <= MIN_SPAN_KM ? 'default' : 'pointer',
                  opacity: currentSpanKm <= MIN_SPAN_KM ? 0.35 : 1,
                }}
              >
                +
              </button>
              <button
                onClick={() => changeZoom(-1)}
                disabled={currentSpanKm >= MAX_SPAN_KM}
                title="Alejar"
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid rgba(148, 163, 184, 0.25)',
                  color: '#e2e8f0',
                  fontSize: '15px',
                  fontWeight: 700,
                  padding: '9px 11px',
                  cursor: currentSpanKm >= MAX_SPAN_KM ? 'default' : 'pointer',
                  opacity: currentSpanKm >= MAX_SPAN_KM ? 0.35 : 1,
                }}
              >
                −
              </button>
              <button
                onClick={resetZoom}
                title="Centrar / restablecer zoom"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#38bdf8',
                  padding: '9px 11px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Crosshair size={14} />
              </button>
            </div>

            {(zoomTilesLoading || zoomTilesFailed) && (
              <div
                style={{
                  position: 'absolute',
                  left: '14px',
                  bottom: '58px',
                  zIndex: 6,
                  fontSize: '9px',
                  color: zoomTilesLoading ? '#38bdf8' : '#fbbf24',
                }}
                title={zoomTilesFailed ? 'Sin internet o Mars Trek no respondió: usando imagen de respaldo' : undefined}
              >
                {zoomTilesLoading ? 'Cargando tiles…' : 'Sin tiles reales (respaldo)'}
              </div>
            )}

            {/* Botón inferior izquierdo: Astronauta (abre/cierra Telemetría del traje EVA-01) */}
            <button
              onClick={() => {
                const next = !showTelemetry;
                setShowTelemetry(next);
                if (next) {
                  setShowLegend(false);
                }
              }}
              title={showTelemetry ? 'Ocultar telemetría del traje' : 'Ver telemetría del traje EVA-01'}
              style={{
                position: 'absolute',
                left: '14px',
                bottom: '14px',
                width: '38px',
                height: '38px',
                borderRadius: '8px',
                background: showTelemetry ? '#112238' : 'rgba(10, 20, 34, 0.92)',
                border: `1px solid ${showTelemetry ? '#38bdf8' : '#233854'}`,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 14px rgba(0, 0, 0, 0.55)',
                zIndex: 5,
                padding: 0,
                transition: 'border-color 160ms ease, background-color 160ms ease',
              }}
            >
              <AstronautIcon size={19} color="#f1f5f9" />
              <span
                style={{
                  position: 'absolute',
                  right: '-3px',
                  top: '-3px',
                  width: '9px',
                  height: '9px',
                  borderRadius: '50%',
                  background: isO2Critical ? '#e5484d' : isO2Warn ? '#e5a024' : '#2fb380',
                  border: '1.5px solid #081322',
                }}
              />
            </button>

            {/* Panel "CAPAS DEL MAPA" (arriba a la derecha): prende/apaga cada capa por separado */}
            <div style={{ position: 'absolute', top: '12px', right: '14px', zIndex: 9 }}>
              <button
                onClick={() => setShowLayersPanel(!showLayersPanel)}
                title="Capas del mapa"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'rgba(8, 10, 15, 0.92)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  cursor: 'pointer',
                  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.6)',
                  color: '#e2e8f0',
                  fontSize: '11px',
                  fontWeight: 600,
                }}
              >
                <Layers size={14} color="#38bdf8" />
                CAPAS DEL MAPA
                <span style={{ fontSize: '9px', color: '#64748b' }}>{showLayersPanel ? '▲' : '▼'}</span>
              </button>

              {showLayersPanel && (
                <div
                  style={{
                    marginTop: '6px',
                    width: '220px',
                    background: 'rgba(8, 10, 15, 0.96)',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                    borderRadius: '8px',
                    padding: '10px 12px',
                    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.6)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}
                >
                  {[
                    {
                      label: 'Cráteres detectados',
                      count: visionData?.detectedObstacles.filter((o) => o.detector === 'HoughCircles').length ?? 0,
                      checked: showCraters,
                      onChange: setShowCraters,
                    },
                    {
                      label: 'Escarpes geológicos',
                      count: visionData?.escarpmentSegments?.length ?? 0,
                      checked: showEscarpments,
                      onChange: setShowEscarpments,
                    },
                    {
                      label: 'Curvas de nivel',
                      count: null,
                      checked: showContourLines,
                      onChange: setShowContourLines,
                    },
                    {
                      label: 'Cuadrícula métrica',
                      count: null,
                      checked: showMetricGrid,
                      onChange: setShowMetricGrid,
                    },
                  ].map((row) => (
                    <label
                      key={row.label}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        cursor: 'pointer',
                        fontSize: '11.5px',
                        color: '#e2e8f0',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {/* Casilla propia en azul sólido: el checkbox nativo + accentColor se
                            renderiza gris/oscuro en varios navegadores, no el azul que se pide. */}
                        <span style={{ position: 'relative', display: 'inline-flex', width: '15px', height: '15px', flexShrink: 0 }}>
                          <input
                            type="checkbox"
                            checked={row.checked}
                            onChange={(e) => row.onChange(e.target.checked)}
                            style={{ position: 'absolute', inset: 0, opacity: 0, margin: 0, cursor: 'pointer' }}
                          />
                          <span
                            style={{
                              width: '15px',
                              height: '15px',
                              borderRadius: '3px',
                              border: `1px solid ${row.checked ? '#38bdf8' : '#475569'}`,
                              background: row.checked ? '#38bdf8' : 'transparent',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              pointerEvents: 'none',
                            }}
                          >
                            {row.checked && (
                              <svg viewBox="0 0 12 10" width="9" height="7" fill="none">
                                <path
                                  d="M1 5L4.5 8.5L11 1"
                                  stroke="#0a0f1a"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </span>
                        </span>
                        {row.label}
                      </span>
                      {row.count !== null && (
                        <span style={{ fontSize: '10px', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                          {String(row.count).padStart(2, '0')}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Recuadro inferior derecho de Escala + Lat/Lon (como en el boceto) */}
            <div
              style={{
                position: 'absolute',
                right: '14px',
                bottom: '10px',
                background: 'rgba(10, 18, 30, 0.78)',
                border: '1px solid rgba(148, 163, 184, 0.35)',
                borderRadius: '4px',
                padding: '4px 8px',
                fontSize: '10px',
                color: '#e2e8f0',
                zIndex: 4,
                minWidth: '150px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
                <div
                  style={{
                    flex: 1,
                    height: '4px',
                    borderLeft: '1.5px solid #cbd5e1',
                    borderRight: '1.5px solid #cbd5e1',
                    borderBottom: '1.5px solid #cbd5e1',
                    marginRight: '6px',
                  }}
                />
                <span style={{ fontSize: '9.5px', color: '#f1f5f9', fontWeight: 600 }}>
                  {currentSpanKm >= 1
                    ? `${currentSpanKm.toFixed(currentSpanKm >= 10 ? 0 : 1)} km`
                    : `${Math.round(currentSpanKm * 1000)} m`}
                </span>
              </div>
              <div style={{ fontSize: '9.5px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                Lat: {hoverCoords.lat} &nbsp;Lon: {hoverCoords.lon}
              </div>
              <div
                style={{
                  fontSize: '8.5px',
                  color: '#64748b',
                  marginTop: '2px',
                  letterSpacing: '0.4px',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                ESCALA TÁCTICA · {zoomScale.toFixed(2)}x
              </div>
            </div>

            {/* Módulo de soporte vital PLSS: Telemetría del traje EVA-01 (distribución asimétrica de 2 filas) */}
            {showTelemetry && (
              <section
                aria-label="Telemetría del traje EVA-01"
                style={{
                  position: 'absolute',
                  left: '14px',
                  bottom: '60px',
                  width: '286px',
                  background: 'rgba(13, 16, 23, 0.97)',
                  border: '1px solid #1e2433',
                  borderRadius: '8px',
                  padding: '18px 18px 16px 18px',
                  color: '#f1f5f9',
                  zIndex: 6,
                  boxShadow: '0 14px 34px rgba(0, 0, 0, 0.78)',
                }}
              >
                {/* Bloque superior: Oxígeno · O₂ a ancho completo */}
                <div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
                      {/* Icono de flujo de O2 */}
                      <svg
                        viewBox="0 0 16 14"
                        width="15"
                        height="13"
                        fill="none"
                        stroke="#7d899b"
                        strokeWidth="1.35"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M1.5 4.2h9.2a1.8 1.8 0 1 0-1.8-1.8" />
                        <path d="M1.5 7.2h11.5a1.8 1.8 0 1 1-1.8 1.8" />
                        <path d="M1.5 10.2h6.8a1.6 1.6 0 1 1-1.6 1.6" />
                      </svg>
                      <span style={{ fontSize: '12.5px', color: '#8e9bae', fontWeight: 400 }}>
                        Oxígeno · O₂
                      </span>
                    </div>

                    <span
                      style={{
                        fontFamily: MONO_READOUT_FONT,
                        fontSize: '10px',
                        fontWeight: 500,
                        letterSpacing: '0.06em',
                        color: isO2Critical ? '#ef4444' : isO2Warn ? '#f59e0b' : '#10b981',
                      }}
                    >
                      {isO2Critical ? 'CRÍTICO' : isO2Warn ? 'ATENCIÓN' : 'NOMINAL'}
                    </span>
                  </div>

                  {/* Lectura principal grande */}
                  <div
                    style={{
                      marginTop: '10px',
                      marginBottom: '12px',
                      display: 'flex',
                      alignItems: 'baseline',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: MONO_READOUT_FONT,
                        fontVariantNumeric: 'tabular-nums slashed-zero',
                        fontSize: '38px',
                        fontWeight: 400,
                        lineHeight: 1,
                        letterSpacing: '-0.02em',
                        color: isO2Critical ? '#f87171' : '#f1f5f9',
                      }}
                    >
                      {o2Level.toFixed(1)}
                    </span>
                    <span
                      style={{
                        fontFamily: MONO_READOUT_FONT,
                        fontSize: '15px',
                        color: '#7d899b',
                        marginLeft: '6px',
                      }}
                    >
                      %
                    </span>
                  </div>

                  {/* Barra lineal azul con muesca de umbral al 25 % */}
                  <PlssLinearGauge
                    valuePct={o2Level}
                    minThresholdPct={25}
                    fillColor={isO2Critical ? '#ef4444' : isO2Warn ? '#f59e0b' : '#29b6f6'}
                  />

                  {/* Escala inferior 0 — UMBRAL CRÍTICO 25% — 100 */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginTop: '7px',
                      fontFamily: MONO_READOUT_FONT,
                      fontSize: '9.5px',
                      color: '#5c6678',
                      letterSpacing: '0.04em',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    <span>0</span>
                    <span>UMBRAL CRÍTICO 25%</span>
                    <span>100</span>
                  </div>
                </div>

                {/* Divisor horizontal */}
                <div
                  style={{
                    height: '1px',
                    background: '#1c2230',
                    margin: '16px 0',
                  }}
                />

                {/* Bloque inferior: 2 columnas separadas por línea vertical */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1px 1fr',
                    alignItems: 'stretch',
                  }}
                >
                  {/* Columna izquierda: Pulso cardíaco */}
                  <div style={{ paddingRight: '14px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        <svg
                          viewBox="0 0 16 15"
                          width="14"
                          height="13"
                          fill="none"
                          stroke="#7d899b"
                          strokeWidth="1.3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{
                            transformOrigin: 'center',
                            animation: `plssHeartPulse ${Number((60 / Math.max(40, Math.min(180, heartRate))).toFixed(2))}s ease-in-out infinite`,
                          }}
                        >
                          <path d="M8 13.4S1.5 9.2 1.5 4.8A3.3 3.3 0 0 1 8 3.3a3.3 3.3 0 0 1 6.5 1.5C14.5 9.2 8 13.4 8 13.4Z" />
                          <polyline points="4.2,7.2 6.3,7.2 7.3,5.2 8.6,9.2 9.6,7.2 11.8,7.2" strokeWidth="1.15" />
                        </svg>
                        <span style={{ fontSize: '12px', color: '#8e9bae', fontWeight: 400 }}>
                          Pulso cardíaco
                        </span>
                      </div>

                      <div
                        style={{
                          marginTop: '10px',
                          marginBottom: '12px',
                          display: 'flex',
                          alignItems: 'baseline',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: MONO_READOUT_FONT,
                            fontVariantNumeric: 'tabular-nums',
                            fontSize: '28px',
                            fontWeight: 400,
                            lineHeight: 1,
                            color: isHrElevated ? '#fbbf24' : '#f1f5f9',
                          }}
                        >
                          {Math.round(heartRate)}
                        </span>
                        <span
                          style={{
                            fontFamily: MONO_READOUT_FONT,
                            fontSize: '11px',
                            color: '#687588',
                            marginLeft: '5px',
                            letterSpacing: '0.03em',
                          }}
                        >
                          BPM
                        </span>
                      </div>
                    </div>

                    <ClinicalEcgTrace isElevated={isHrElevated} bpm={heartRate} live={isConnected} />
                  </div>

                  {/* Divisor vertical */}
                  <div style={{ background: '#1c2230', width: '1px' }} />

                  {/* Columna derecha: Presión del traje */}
                  <div style={{ paddingLeft: '14px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ display: 'inline-flex', alignItems: 'center' }}>
                        <span style={{ fontSize: '12px', color: '#8e9bae', fontWeight: 400 }}>
                          Presión del traje
                        </span>
                      </div>

                      <div
                        style={{
                          marginTop: '10px',
                          marginBottom: '14px',
                          display: 'flex',
                          alignItems: 'baseline',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: MONO_READOUT_FONT,
                            fontVariantNumeric: 'tabular-nums',
                            fontSize: '28px',
                            fontWeight: 400,
                            lineHeight: 1,
                            color: suitPressurePct <= 30 ? '#f87171' : '#f1f5f9',
                          }}
                        >
                          {suitPressurePct.toFixed(1)}
                        </span>
                        <span
                          style={{
                            fontFamily: MONO_READOUT_FONT,
                            fontSize: '12.5px',
                            color: '#687588',
                            marginLeft: '4px',
                          }}
                        >
                          %
                        </span>
                      </div>
                    </div>

                    <div>
                      <PlssLinearGauge
                        valuePct={suitPressurePct}
                        minThresholdPct={30}
                        fillColor={suitPressurePct <= 30 ? '#ef4444' : '#9aa6b8'}
                      />
                      <div
                        style={{
                          marginTop: '7px',
                          fontFamily: MONO_READOUT_FONT,
                          fontSize: '9.5px',
                          color: '#5c6678',
                          letterSpacing: '0.04em',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        MIN SEGURO 30%
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            )}
          </div>

          {/* Barra decorativa inferior del marco del mapa (franjas diagonales azules del boceto) */}
          <div
            style={{
              height: '20px',
              background: '#071220',
              borderTop: '1px solid #1e3a5f',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 10px',
            }}
          >
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              {Array.from({ length: 6 }).map((_, idx) => (
                <span
                  key={idx}
                  style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '9px',
                    background: '#0ea5e9',
                    transform: 'skewX(-28deg)',
                    borderRadius: '1px',
                    opacity: 0.9 - idx * 0.08,
                  }}
                />
              ))}
            </div>
            <div
              style={{
                width: '10px',
                height: '10px',
                background: 'linear-gradient(135deg, transparent 50%, #0ea5e9 50%)',
              }}
            />
          </div>
        </div>

        {/* Columna Derecha: Obstáculos & Pendientes + Elevación */}
        <div
          style={{
            flex: '1 1 265px',
            minWidth: '255px',
            maxWidth: '340px',
            background: '#080a0f',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div>
            {/* Encabezado del panel de Obstáculos y pendientes */}
            <div style={{ padding: '12px 14px 10px 14px', borderBottom: '1px solid #23252b' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
                  <AlertTriangle size={15} color="#e2e8f0" />
                  <span style={{ color: '#f1f5f9', fontWeight: 600, fontSize: '13.5px' }}>
                    Obstáculos &amp; pendientes
                  </span>
                </span>
                <span
                  style={{
                    fontSize: '10.5px',
                    color: '#8a9bb2',
                    fontVariantNumeric: 'tabular-nums',
                    border: '1px solid #2a2c33',
                    borderRadius: '4px',
                    padding: '1.5px 6px',
                  }}
                >
                  {String(alertCards.length).padStart(2, '0')}
                </span>
              </div>
              <div
                style={{
                  fontSize: '9.5px',
                  color: '#38bdf8',
                  letterSpacing: '0.08em',
                  marginTop: '5px',
                  fontFamily: MONO_READOUT_FONT,
                }}
              >
                DETECCIÓN EN EL CORREDOR DE RUTA
              </div>
              <div style={{ display: 'flex', gap: '16px', marginTop: '8px' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: '#cbd5e1' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#e5484d' }} />
                  {String(criticalCount).padStart(2, '0')} Críticos
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: '#cbd5e1' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#e5a024' }} />
                  {String(cautionCount).padStart(2, '0')} Precaución
                </span>
              </div>
            </div>

            {/* Lista de hallazgos: uno por obstáculo/pendiente real detectado */}
            <style>{`
              .obstacle-card-list {
                scrollbar-width: thin;
                scrollbar-color: #475569 transparent;
              }
              .obstacle-card-list::-webkit-scrollbar {
                width: 5px;
              }
              .obstacle-card-list::-webkit-scrollbar-track {
                background: transparent;
              }
              .obstacle-card-list::-webkit-scrollbar-thumb {
                background: #475569;
                border-radius: 999px;
              }
              .obstacle-card-list::-webkit-scrollbar-thumb:hover {
                background: #64748b;
              }
            `}</style>
            <div
              className="obstacle-card-list"
              style={{
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                maxHeight: '260px',
                overflowY: 'auto',
              }}
            >
              {alertCards.length === 0 ? (
                <div style={{ fontSize: '11px', color: '#8a9bb2', padding: '6px 2px' }}>
                  Sin alertas de terreno en este momento.
                </div>
              ) : (
                alertCards.map((c, i) => (
                  <div
                    key={i}
                    style={{
                      background: '#15171c',
                      border: '1px solid #262830',
                      borderRadius: '6px',
                      padding: '9px 11px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                          fontSize: '9.5px',
                          fontWeight: 600,
                          letterSpacing: '0.06em',
                          color: c.badgeText,
                        }}
                      >
                        <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: c.accent }} />
                        {c.severityLabel.toUpperCase()}
                      </span>
                      <span
                        style={{
                          fontSize: '13.5px',
                          fontWeight: 700,
                          color: c.accent,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {c.metric}
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginTop: '3px',
                      }}
                    >
                      <span style={{ color: '#f1f5f9', fontSize: '12.5px', fontWeight: 600 }}>{c.title}</span>
                      <ChevronRight size={14} color="#475569" />
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        marginTop: '2px',
                        fontSize: '10px',
                        color: '#64748b',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      <span>{c.source}</span>
                      <span>{c.value}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {detectorList && (
              <div
                style={{
                  padding: '2px 14px 10px 14px',
                  fontSize: '10px',
                  color: '#64748b',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <RefreshCw size={11} color="#475569" />
                {detectorList}
              </div>
            )}
          </div>

          {/* Apartado de Elevación integrado en la parte inferior de la barra derecha */}
          <div style={{ padding: '10px 14px 12px 14px', borderTop: '1px solid #23252b' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
                <Mountain size={14} color="#e2e8f0" />
                <span style={{ color: '#f1f5f9', fontWeight: 600, fontSize: '13px' }}>Perfil de elevación</span>
              </span>
              {elevationProfile.length >= 2 && (
                <span
                  style={{
                    fontSize: '10px',
                    color: '#8a9bb2',
                    border: '1px solid #2a2c33',
                    borderRadius: '4px',
                    padding: '1.5px 6px',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {elevationProfile.length} MUESTRAS
                </span>
              )}
            </div>
            <div style={{ fontSize: '10.5px', color: '#64748b', marginTop: '3px', marginBottom: '8px' }}>
              Terreno sintético · a lo largo de la ruta A*
            </div>

            {!isConnected ? (
              <div style={{ textAlign: 'center', padding: '16px 8px' }}>
                <div style={{ color: '#ef4444', fontWeight: 700, fontSize: '13px', marginBottom: '4px' }}>
                  ● NO HOST
                </div>
                <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.35 }}>
                  Sin conexión con el host. Esperando datos externos para calcular ruta.
                </div>
              </div>
            ) : elevationProfile.length >= 2 ? (
              <>
                <ElevationChart profile={elevationProfile} maxSlopeDeg={maxRouteSlopeDeg} />
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '9.5px',
                    color: '#64748b',
                    marginTop: '2px',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <span>INICIO {elevationProfile[0].elev.toFixed(2)} m</span>
                  <span>FIN {elevationProfile[elevationProfile.length - 1].elev.toFixed(2)} m</span>
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                  <div
                    style={{
                      flex: 1,
                      background: '#15171c',
                      border: '1px solid #262830',
                      borderRadius: '6px',
                      padding: '8px 10px',
                    }}
                  >
                    <div style={{ fontSize: '9px', color: '#64748b', letterSpacing: '0.06em' }}>DESNIVEL NETO</div>
                    <div style={{ fontSize: '15px', fontWeight: 700, color: '#f1f5f9', marginTop: '2px' }}>
                      {(() => {
                        const d =
                          elevationProfile[elevationProfile.length - 1].elev - elevationProfile[0].elev;
                        return `${d >= 0 ? '+' : ''}${d.toFixed(2)} m`;
                      })()}
                    </div>
                  </div>
                  <div
                    style={{
                      flex: 1,
                      background: '#15171c',
                      border: '1px solid #262830',
                      borderRadius: '6px',
                      padding: '8px 10px',
                    }}
                  >
                    <div style={{ fontSize: '9px', color: '#64748b', letterSpacing: '0.06em' }}>PENDIENTE MÁX.</div>
                    <div style={{ fontSize: '15px', fontWeight: 700, color: '#fb923c', marginTop: '2px' }}>
                      {maxRouteSlopeDeg.toFixed(1)}°
                    </div>
                  </div>
                </div>
              </>
            ) : hasUserSelectedTarget ? (
              <div style={{ textAlign: 'center', padding: '16px 8px' }}>
                <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: '12px', marginBottom: '4px' }}>
                  ● ESPERANDO RUTA
                </div>
                <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.35 }}>
                  Destino enviado al host. Esperando waypoints calculados...
                </div>
              </div>
            ) : (
              <p style={{ fontSize: '11px', color: '#64748b', textAlign: 'center', margin: '12px 0' }}>
                Haz clic en el mapa para marcar el objetivo.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
