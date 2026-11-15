import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Radio, RefreshCw, Server, Settings, Upload } from 'lucide-react';
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
  OperationMode,
  sampleMatrixAt,
} from '../config/connectionConfig';
import { MapLayerMode, renderTopographicMapCanvas } from './map/mapCanvasRenderer';

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

const CardWaveArt: React.FC<{ level: 'red' | 'yellow' | 'green' }> = ({ level }) => {
  if (level === 'red') {
    return (
      <svg viewBox="0 0 240 34" preserveAspectRatio="none" style={{ width: '100%', height: '30px', display: 'block', marginTop: '4px' }}>
        <defs>
          <linearGradient id="redCardGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#7f1d1d" stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <path
          d="M0,26 Q28,6 58,20 T122,14 T186,22 T240,12 L240,34 L0,34 Z"
          fill="url(#redCardGrad)"
        />
        <path
          d="M0,26 Q28,6 58,20 T122,14 T186,22 T240,12"
          fill="none"
          stroke="#ef4444"
          strokeWidth="1.2"
          strokeDasharray="2,2"
          strokeOpacity="0.75"
        />
        {/* Triángulo de peligro + ícono bio/radiación en la esquina inferior derecha */}
        <g transform="translate(194, 12)" stroke="#ef4444" strokeWidth="1.3" fill="none" opacity="0.85">
          <path d="M8,16 L15,3 L22,16 Z" />
          <line x1="15" y1="7.5" x2="15" y2="11.5" />
          <circle cx="15" cy="13.8" r="0.6" fill="#ef4444" />
          <circle cx="33" cy="10" r="2.2" />
          <path d="M30,5.5 A5.5,5.5 0 0 1 36,5.5" />
          <path d="M37.5,11 A5.5,5.5 0 0 1 34.5,15.5" />
          <path d="M28.5,11 A5.5,5.5 0 0 0 31.5,15.5" />
        </g>
      </svg>
    );
  }

  if (level === 'yellow') {
    return (
      <svg viewBox="0 0 240 34" preserveAspectRatio="none" style={{ width: '100%', height: '30px', display: 'block', marginTop: '4px' }}>
        <path
          d="M0,28 C38,24 66,8 106,16 C146,24 182,28 240,16 L240,34 L0,34 Z"
          fill="rgba(245, 158, 11, 0.22)"
        />
        <path d="M0,28 C38,24 66,8 106,16 C146,24 182,28 240,16" fill="none" stroke="#f59e0b" strokeWidth="1.1" strokeOpacity="0.7" />
        <path d="M0,31 C42,27 72,13 112,20 C152,27 188,30 240,21" fill="none" stroke="#fbbf24" strokeWidth="0.8" strokeOpacity="0.45" />
        <path d="M0,24 C34,20 60,4 100,12 C140,20 176,25 240,11" fill="none" stroke="#d97706" strokeWidth="0.8" strokeOpacity="0.4" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 240 34" preserveAspectRatio="none" style={{ width: '100%', height: '30px', display: 'block', marginTop: '4px' }}>
      <path
        d="M0,24 Q35,12 72,21 T146,13 T212,22 L240,18 L240,34 L0,34 Z"
        fill="rgba(16, 185, 129, 0.22)"
      />
      {Array.from({ length: 46 }).map((_, idx) => {
        const x = idx * 4.5 + 2;
        const h = 6 + Math.sin(idx * 0.42) * 5 + Math.cos(idx * 0.9) * 3;
        return (
          <line
            key={idx}
            x1={x}
            y1={33}
            x2={x}
            y2={33 - Math.max(2, h)}
            stroke="#10b981"
            strokeWidth="1.3"
            strokeOpacity="0.48"
          />
        );
      })}
      <path d="M206,32 L217,17 L224,25 L230,20 L238,32 Z" fill="#10b981" fillOpacity="0.65" />
    </svg>
  );
};

const CardHeaderIcon: React.FC<{ level: 'red' | 'yellow' | 'green' }> = ({ level }) => {
  if (level === 'red') {
    return (
      <svg viewBox="0 0 24 22" width="18" height="17" fill="none">
        <path d="M12 2L22 19H2L12 2Z" fill="#ef4444" stroke="#fca5a5" strokeWidth="1" />
        <line x1="12" y1="8" x2="12" y2="13.5" stroke="#1f2937" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="16.5" r="1.1" fill="#1f2937" />
      </svg>
    );
  }
  if (level === 'yellow') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <svg viewBox="0 0 24 22" width="18" height="17" fill="none">
          <path
            d="M6.5 14.5H17.5A3.5 3.5 0 0 0 18 7.6 5 5 0 0 0 8.3 6.5 3.8 3.8 0 0 0 6.5 14.5Z"
            fill="#facc15"
          />
          <polyline points="11,15 9.5,18.5 12,18.5 10.5,21.5" stroke="#facc15" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="7" y1="16.5" x2="5.8" y2="19.5" stroke="#facc15" strokeWidth="1.3" strokeLinecap="round" />
          <line x1="15.5" y1="16.5" x2="14.3" y2="19.5" stroke="#facc15" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <svg viewBox="0 0 24 22" width="17" height="16" fill="none">
          <path d="M12 2L22 19H2L12 2Z" fill="#facc15" />
          <line x1="12" y1="8" x2="12" y2="13.5" stroke="#1f2937" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="16.5" r="1.1" fill="#1f2937" />
        </svg>
      </div>
    );
  }
  return (
    <svg viewBox="0 0 36 22" width="28" height="17" fill="none">
      <ellipse cx="10" cy="16.5" rx="7" ry="2.6" stroke="#34d399" strokeWidth="1.4" />
      <path d="M6 12C6 9.5 14 9.5 14 12" stroke="#34d399" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M20 18L26 8L33 18Z" fill="#34d399" fillOpacity="0.85" />
      <path d="M15 18L20 11L25 18Z" fill="#10b981" />
    </svg>
  );
};

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

  const xLabels = ['0 km', '2 km', '4 km', '6 km', '8 km'];

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
      <path d={linePath} fill="none" stroke="#7dd3fc" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />

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
          <g key={xl}>
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

const EcgBoxWave: React.FC = () => (
  <div
    style={{
      position: 'relative',
      width: '100%',
      height: '26px',
      overflow: 'hidden',
      backgroundImage:
        'linear-gradient(to right, rgba(45,212,191,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(45,212,191,0.08) 1px, transparent 1px)',
      backgroundSize: '8px 8px',
      borderRadius: '3px',
    }}
  >
    <style>{`
      @keyframes ecgScroll {
        from { transform: translateX(0); }
        to { transform: translateX(-50%); }
      }
    `}</style>
    <div style={{ display: 'flex', width: '200%', height: '100%', animation: 'ecgScroll 1.8s linear infinite' }}>
      <svg viewBox="0 0 220 26" preserveAspectRatio="none" style={{ width: '50%', height: '26px', display: 'block', flexShrink: 0 }}>
        <polyline points={ECG_POINTS} fill="none" stroke="#34d399" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <svg viewBox="0 0 220 26" preserveAspectRatio="none" style={{ width: '50%', height: '26px', display: 'block', flexShrink: 0 }}>
        <polyline points={ECG_POINTS} fill="none" stroke="#34d399" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  </div>
);

const StatusIconsCluster: React.FC<{ level: number }> = ({ level }) => {
  const pct = Math.max(15, Math.min(100, level));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
      {/* Bluetooth */}
      <svg viewBox="0 0 12 16" width="10" height="13" fill="none" stroke="#5eead4" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="2.5,4.5 9.5,11.5 6,15 6,1 9.5,4.5 2.5,11.5" />
      </svg>
      {/* Wi-Fi */}
      <svg viewBox="0 0 16 14" width="13" height="11" fill="none" stroke="#5eead4" strokeWidth="1.4" strokeLinecap="round">
        <path d="M1.5 5.2a10 10 0 0 1 13 0" />
        <path d="M4 8a6.5 6.5 0 0 1 8 0" />
        <circle cx="8" cy="11" r="1" fill="#5eead4" />
      </svg>
      {/* Batería verde */}
      <svg viewBox="0 0 24 13" width="20" height="11">
        <rect x="1" y="1" width="19" height="11" rx="2" fill="none" stroke="#5eead4" strokeWidth="1.3" />
        <rect x="21" y="4" width="2" height="5" rx="0.8" fill="#5eead4" />
        <rect x="2.8" y="2.8" width={Math.max(2, (pct / 100) * 15.4)} height="7.4" rx="1" fill="#22c55e" />
      </svg>
    </div>
  );
};

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
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadedImgRef = useRef<HTMLImageElement | null>(null);

  const [mapLayerMode, setMapLayerMode] = useState<MapLayerMode>('fusion_mars_d415');
  const [imageSrc, setImageSrc] = useState<string>('/mars-terrain.jpg');

  const [baseVisionData, setBaseVisionData] = useState<ImageVisionAnalysis | null>(null);
  const [localMapState, setLocalMapState] = useState<RealMapStatePayload | null>(null);

  const showContours = mapLayerMode === 'topo_lines';
  const [showDetectedZones] = useState<boolean>(true);
  const showD415GridOverlay = false;
  const showServerPaths = false;

  // Ubicaciones iniciales alineadas con la composición del boceto (EVA_01 y Destino dentro del círculo morado)
  const [targetPoint, setTargetPoint] = useState<[number, number]>([4.45, 2.75]);
  const [showTelemetry, setShowTelemetry] = useState<boolean>(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState<boolean>(false);

  const [hoverCoords, setHoverCoords] = useState<{ lat: string; lon: string }>({
    lat: '-11.49907',
    lon: '6.20995°',
  });

  useEffect(() => {
    fetch('/data/real_map_state.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.occupancy_grid) {
          setLocalMapState(d);
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
      const analysis = analyzeImageTerrainReal(img, GRID_COLS, GRID_ROWS);
      setBaseVisionData(analysis);
    };
  }, [imageSrc]);

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
  const evaPos: [number, number] = [
    Number((3.62 + Math.sin((evaYaw * Math.PI) / 180) * 0.08).toFixed(2)),
    Number((5.55 + Math.cos((evaYaw * Math.PI) / 180) * 0.08).toFixed(2)),
  ];

  const startPoint: [number, number] = evaPos;

  const safeRoute = useMemo(() => {
    if (!visionData) {
      return {
        points: [startPoint, targetPoint],
        distanceMeters: 40,
        estimatedSeconds: 33,
        maxSlopeDeg: 18,
        isCompletelySafe: true,
      };
    }
    return computeSafeRouteFromImageVision(startPoint, targetPoint, visionData, dataset);
  }, [startPoint[0], startPoint[1], targetPoint[0], targetPoint[1], visionData, dataset]);

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
      mapLayerMode,
      showContours,
      showDetectedZones,
      showD415GridOverlay,
      showServerPaths,
      safeRoute,
      targetPoint,
      basePos,
      dronePadPos,
      evaPos,
    });
  }, [
    dataset,
    visionData,
    activeMapState,
    droneData,
    mapLayerMode,
    showContours,
    showDetectedZones,
    showD415GridOverlay,
    showServerPaths,
    evaYaw,
    targetPoint,
    safeRoute,
  ]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const relX = Math.max(0.04, Math.min(0.96, (e.clientX - rect.left) / rect.width));
    const relY = Math.max(0.05, Math.min(0.95, (e.clientY - rect.top) / rect.height));
    const xm = Number((relX * dataset.widthMeters).toFixed(2));
    const ym = Number((relY * dataset.heightMeters).toFixed(2));
    setTargetPoint([xm, ym]);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    const lat = (-11.45 - relY * 0.14).toFixed(5);
    const lon = (6.15 + relX * 0.12).toFixed(5) + '°';
    setHoverCoords({ lat, lon });
  };

  // Las 3 tarjetas de Obstáculos & Pendientes (ALTO, MEDIO, BAJO) siguiendo el diseño del boceto
  // y actualizándose si llegan razones en vivo del evaluador de riesgo.
  const riskCards = useMemo(() => {
    const highReason = risk.reasons.find((r) => /CRÍTIC|BLOQUEADA|INSEGURA|EXTREMA/i.test(r));
    const medReason = risk.reasons.find((r) => !/CRÍTIC|BLOQUEADA|INSEGURA|EXTREMA/i.test(r));

    return [
      {
        level: 'red' as const,
        badge: 'ALTO',
        badgeColor: '#ef4444',
        border: '#dc2626',
        bg: 'linear-gradient(180deg, rgba(58, 12, 18, 0.94) 0%, rgba(98, 16, 24, 0.90) 100%)',
        text: highReason
          ? `Cuidado: ${highReason.toLowerCase()}`
          : 'Cuidado: oxígeno del traje por debajo del 15%',
      },
      {
        level: 'yellow' as const,
        badge: 'MEDIO',
        badgeColor: '#facc15',
        border: '#d97706',
        bg: 'linear-gradient(180deg, rgba(54, 38, 10, 0.94) 0%, rgba(92, 64, 12, 0.90) 100%)',
        text: medReason
          ? `Cuidado: ${medReason.toLowerCase()}`
          : 'Cuidado: se aproxima una tormenta de arena',
      },
      {
        level: 'green' as const,
        badge: 'BAJO',
        badgeColor: '#34d399',
        border: '#10b981',
        bg: 'linear-gradient(180deg, rgba(8, 44, 38, 0.94) 0%, rgba(12, 74, 62, 0.90) 100%)',
        text: 'Cuidado: zona con muchos cráteres a 500m',
      },
    ];
  }, [risk]);

  const cycleMapLayerMode = () => {
    setMapLayerMode(mapLayerMode === 'topo_lines' ? 'fusion_mars_d415' : 'topo_lines');
  };

  // Valores de telemetría del traje (usa datos reales si están presentes, o los valores de referencia del boceto)
  const o2Level = eva ? eva.suit_o2 : 14.2;
  const heartRate = eva ? eva.heart_rate : 118;
  const suitPressurePct = eva ? eva.battery : 84.0;
  const isO2Critical = o2Level < 45;

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

      {/* Marco Táctico Unificado (Mapa + Barra Lateral Derecha en un solo bloque como en el boceto) */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          background: '#081322',
          border: '2px solid #0ea5e9',
          borderRadius: '12px',
          overflow: 'hidden',
          boxShadow: '0 0 28px rgba(14, 165, 233, 0.18), 0 12px 32px rgba(0, 0, 0, 0.65)',
        }}
      >
        {/* Columna Izquierda: Encabezado de Misión + Mapa + Barra Inferior */}
        <div
          style={{
            flex: '2.5 1 620px',
            minWidth: '320px',
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid #1e3a5f',
            position: 'relative',
          }}
        >
          {/* Encabezado integrado dentro del marco del mapa */}
          <div
            style={{
              background: 'linear-gradient(90deg, #09192e 0%, #0b213d 100%)',
              borderBottom: '1px solid #1e3a5f',
              padding: '8px 16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              position: 'relative',
            }}
          >
            <div>
              <div style={{ fontSize: '12px', letterSpacing: '0.3px', lineHeight: 1.25 }}>
                <span style={{ color: '#38bdf8', fontWeight: 600 }}>Misión: </span>
                <span style={{ color: '#e2e8f0', fontWeight: 500 }}>
                  OPERACIONES SUPERFICIE ARES - IV
                </span>
              </div>
              <div
                style={{
                  fontSize: '15px',
                  fontWeight: 700,
                  color: '#ffffff',
                  letterSpacing: '0.6px',
                  marginTop: '1px',
                }}
              >
                DOLLFUS
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ textAlign: 'right', lineHeight: 1.2 }}>
                <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600 }}>UTC</div>
                <div
                  style={{
                    fontSize: '12px',
                    color: '#f1f5f9',
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: 600,
                  }}
                >
                  {utcTime || '10:46:22'}
                </div>
              </div>

              {/* Botón discreto para abrir la configuración de IP / Subir imagen */}
              <button
                onClick={() => setShowSettingsMenu(!showSettingsMenu)}
                title="Configuración de conexión IP y mapa"
                style={{
                  background: showSettingsMenu ? '#0284c7' : 'rgba(15, 23, 42, 0.7)',
                  border: `1px solid ${isConnected ? '#22c55e' : '#334155'}`,
                  color: '#e2e8f0',
                  borderRadius: '6px',
                  width: '28px',
                  height: '28px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <Settings size={14} />
              </button>
            </div>

            {/* Menú desplegable discreto con los controles de IP y Subir Imagen */}
            {showSettingsMenu && (
              <div
                style={{
                  position: 'absolute',
                  top: '52px',
                  right: '14px',
                  width: '310px',
                  background: 'rgba(9, 19, 34, 0.97)',
                  border: '1px solid #0ea5e9',
                  borderRadius: '8px',
                  padding: '12px',
                  zIndex: 20,
                  boxShadow: '0 10px 25px rgba(0, 0, 0, 0.75)',
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
          </div>

          {/* Área central del Mapa */}
          <div style={{ position: 'relative', flex: 1, background: '#07101d' }}>
            <canvas
              ref={canvasRef}
              width={920}
              height={540}
              onClick={handleCanvasClick}
              onMouseMove={handleMouseMove}
              style={{
                width: '100%',
                height: '100%',
                minHeight: '460px',
                cursor: 'crosshair',
                display: 'block',
                objectFit: 'cover',
              }}
            />

            {/* Botón inferior izquierdo: Astronauta (abre/cierra Telemetría del traje EVA-01) */}
            <button
              onClick={() => setShowTelemetry(!showTelemetry)}
              title="Telemetría del traje EVA-01"
              style={{
                position: 'absolute',
                left: '14px',
                bottom: '14px',
                width: '38px',
                height: '38px',
                borderRadius: '50%',
                background: 'rgba(10, 22, 38, 0.88)',
                border: `2px solid ${showTelemetry ? '#34d399' : '#38bdf8'}`,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 12px rgba(56, 189, 248, 0.35)',
                zIndex: 5,
                padding: 0,
              }}
            >
              <AstronautIcon size={20} color="#f8fafc" />
              <span
                style={{
                  position: 'absolute',
                  right: '-2px',
                  bottom: '-2px',
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  background: '#10b981',
                  border: '1.5px solid #081322',
                }}
              />
            </button>

            {/* Botón del Ojo (arriba del recuadro de escala y coordenadas en la esquina inferior derecha) */}
            <button
              onClick={cycleMapLayerMode}
              title="Alternar curvas topográficas"
              style={{
                position: 'absolute',
                right: '14px',
                bottom: '54px',
                width: '34px',
                height: '34px',
                borderRadius: '50%',
                background: mapLayerMode === 'topo_lines' ? '#0284c7' : 'rgba(10, 22, 38, 0.88)',
                border: '1.5px solid rgba(226, 232, 240, 0.7)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
                zIndex: 5,
                padding: 0,
              }}
            >
              <Eye size={17} color="#f8fafc" />
            </button>

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
                <span style={{ fontSize: '9.5px', color: '#f1f5f9', fontWeight: 600 }}>100 km</span>
              </div>
              <div style={{ fontSize: '9.5px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                Lat: {hoverCoords.lat} &nbsp;Lon: {hoverCoords.lon}
              </div>
            </div>

            {/* Tarjeta flotante de Telemetría del traje EVA - 01 (diseño verde esmeralda del boceto) */}
            {showTelemetry && (
              <div
                style={{
                  position: 'absolute',
                  left: '14px',
                  bottom: '60px',
                  width: '245px',
                  background:
                    'linear-gradient(180deg, rgba(11, 43, 41, 0.96) 0%, rgba(7, 25, 27, 0.98) 100%)',
                  border: '1.5px solid #2dd4bf',
                  borderRadius: '10px',
                  padding: '12px 12px 14px 12px',
                  color: '#f1f5f9',
                  zIndex: 6,
                  boxShadow: '0 0 20px rgba(45, 212, 191, 0.25), 0 8px 24px rgba(0, 0, 0, 0.7)',
                }}
              >
                {/* Encabezado de la tarjeta de telemetría */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: '10px',
                  }}
                >
                  <div style={{ lineHeight: 1.25 }}>
                    <div style={{ fontSize: '12px', color: '#e2e8f0', fontWeight: 500 }}>
                      Telemetría del traje
                    </div>
                    <div style={{ fontSize: '13px', color: '#ffffff', fontWeight: 700 }}>
                      EVA - 01
                    </div>
                  </div>
                  <StatusIconsCluster level={suitPressurePct} />
                </div>

                {/* Sub-caja 1: O2 en depósito */}
                <div
                  style={{
                    background: 'rgba(45, 12, 18, 0.65)',
                    border: `1px solid ${isO2Critical ? '#dc2626' : '#115e59'}`,
                    borderRadius: '6px',
                    padding: '6px 8px',
                    marginBottom: '8px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '10.5px',
                      marginBottom: '5px',
                    }}
                  >
                    <span style={{ color: '#f1f5f9', fontWeight: 600 }}>O2 en depósito</span>
                    <strong style={{ color: isO2Critical ? '#f87171' : '#34d399' }}>
                      {o2Level.toFixed(1)}%{isO2Critical ? ' - CRÍTICO!' : ''}
                    </strong>
                  </div>
                  <div
                    style={{
                      background: 'rgba(127, 29, 29, 0.45)',
                      borderRadius: '3px',
                      height: '13px',
                      overflow: 'hidden',
                      border: '1px solid rgba(239, 68, 68, 0.25)',
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.max(6, Math.min(100, o2Level))}%`,
                        height: '100%',
                        background: isO2Critical
                          ? 'linear-gradient(90deg, #dc2626, #ef4444)'
                          : 'linear-gradient(90deg, #10b981, #34d399)',
                        boxShadow: isO2Critical ? '0 0 8px #ef4444' : 'none',
                      }}
                    />
                  </div>
                </div>

                {/* Sub-caja 2: Pulso cardíaco */}
                <div
                  style={{
                    background: 'rgba(6, 30, 31, 0.72)',
                    border: '1px solid #0f766e',
                    borderRadius: '6px',
                    padding: '6px 8px',
                    marginBottom: '8px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '10.5px',
                      marginBottom: '4px',
                    }}
                  >
                    <span style={{ color: '#e2e8f0', fontWeight: 600 }}>Pulso cardíaco</span>
                    <strong style={{ color: '#ffffff', fontSize: '11.5px' }}>{heartRate} BPM</strong>
                  </div>
                  <EcgBoxWave />
                </div>

                {/* Sub-caja 3: Presión del traje */}
                <div
                  style={{
                    background: 'rgba(6, 30, 31, 0.72)',
                    border: '1px solid #0f766e',
                    borderRadius: '6px',
                    padding: '6px 8px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '10.5px',
                      marginBottom: '5px',
                    }}
                  >
                    <span style={{ color: '#e2e8f0', fontWeight: 600 }}>Presión del traje</span>
                    <span style={{ color: '#cbd5e1', fontSize: '10px', fontWeight: 600 }}>
                      <strong style={{ color: '#f8fafc' }}>{suitPressurePct.toFixed(1)}%</strong> | MIN 30!
                    </span>
                  </div>
                  <div
                    style={{
                      background: 'rgba(15, 118, 110, 0.28)',
                      borderRadius: '3px',
                      height: '13px',
                      overflow: 'hidden',
                      border: '1px solid rgba(45, 212, 191, 0.25)',
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.max(8, Math.min(100, suitPressurePct))}%`,
                        height: '100%',
                        background: 'linear-gradient(90deg, #059669, #34d399)',
                        boxShadow: '0 0 10px rgba(52, 211, 153, 0.5)',
                      }}
                    />
                  </div>
                </div>

                {/* Pestaña luminosa inferior central del marco de telemetría (como en el boceto) */}
                <div
                  style={{
                    position: 'absolute',
                    bottom: '-1px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: '54px',
                    height: '4px',
                    borderRadius: '3px 3px 0 0',
                    background: '#34d399',
                    boxShadow: '0 0 8px #34d399',
                  }}
                />
              </div>
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
            background: '#081322',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div>
            {/* Banner Amarillo Superior sin márgenes, idéntico al boceto */}
            <div
              style={{
                background: '#ffd000',
                color: '#0f172a',
                fontWeight: 700,
                fontSize: '15px',
                padding: '13px 16px',
                letterSpacing: '0.2px',
              }}
            >
              Obstáculos &amp; Pendientes
            </div>

            {/* Tarjetas de Riesgo (Alto, Medio, Bajo) */}
            <div style={{ padding: '10px 10px 6px 10px', display: 'flex', flexDirection: 'column', gap: '9px' }}>
              {riskCards.map((c, i) => (
                <div
                  key={i}
                  style={{
                    background: c.bg,
                    border: `1.5px solid ${c.border}`,
                    borderRadius: '8px',
                    padding: '9px 11px 2px 11px',
                    boxShadow: 'inset 0 0 14px rgba(0,0,0,0.35)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: '4px',
                      fontSize: '11.5px',
                    }}
                  >
                    <span style={{ color: '#cbd5e1', fontWeight: 500 }}>
                      Riesgo detectado:{' '}
                      <strong style={{ color: c.badgeColor, fontWeight: 700 }}>{c.badge}</strong>
                    </span>
                    <CardHeaderIcon level={c.level} />
                  </div>
                  <div
                    style={{
                      color: '#f8fafc',
                      fontSize: '12.5px',
                      lineHeight: 1.28,
                      fontWeight: 500,
                    }}
                  >
                    {c.text}
                  </div>
                  <CardWaveArt level={c.level} />
                </div>
              ))}
            </div>
          </div>

          {/* Apartado de Elevación integrado en la parte inferior de la barra derecha */}
          <div style={{ padding: '4px 10px 10px 10px' }}>
            <div
              style={{
                textAlign: 'center',
                fontSize: '14px',
                fontWeight: 600,
                color: '#f1f5f9',
                marginBottom: '2px',
              }}
            >
              Elevación
            </div>
            {elevationProfile.length >= 2 ? (
              <ElevationChart profile={elevationProfile} maxSlopeDeg={maxRouteSlopeDeg} />
            ) : (
              <p style={{ fontSize: '11px', color: '#64748b', textAlign: 'center', margin: '12px 0' }}>
                Haz clic en el mapa para trazar la ruta.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
