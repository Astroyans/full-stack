import React, { useMemo, useState } from 'react';
import {
  GestureResponderEvent,
  Image,
  LayoutChangeEvent,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  DroneData,
  EvaData,
  fetchMapStateFromServer,
  RiskAssessment,
} from '@martian/shared';
import {
  buildElevationProfile,
  buildMergedObstacles,
  computeIpadSafeRouteAStar,
  DEFAULT_MARS_ESCARPMENTS,
  ElevPoint,
  OperationMode,
  ScientificStop,
} from '../utils/ipadMapEngine';
import { tacticalStyles as styles } from '../styles/tacticalStyles';

interface TopographicMapIpadProps {
  droneData?: DroneData | null;
  evaData?: EvaData | null;
  risk: RiskAssessment;
  mode: OperationMode;
  utcTime: string;
  isConnected: boolean;
  customUrls: Record<OperationMode, string>;
  onSwitchMode: (newMode: OperationMode) => void;
  onChangeUrl: (newUrl: string) => void;
  onApplyUrl: () => void;
}

const MARS_IMG = require('../../assets/mars-terrain.jpg');

const HeadingTapeOverlay: React.FC = () => {
  const ticks = Array.from({ length: 25 });
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 8,
        left: '50%',
        marginLeft: -120,
        width: 240,
        alignItems: 'center',
        zIndex: 6,
      }}
    >
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: 4.5,
          borderRightWidth: 4.5,
          borderTopWidth: 6,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderTopColor: '#34d399',
          marginBottom: 1,
        }}
      />
      <View
        style={{
          width: '100%',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
        }}
      >
        {ticks.map((_, i) => {
          const isMajor = i % 6 === 0;
          const isMid = i % 3 === 0;
          return (
            <View
              key={i}
              style={{
                width: 1,
                height: isMajor ? 8 : isMid ? 5 : 3,
                backgroundColor: 'rgba(226, 232, 240, 0.55)',
              }}
            />
          );
        })}
      </View>
      <View
        style={{
          width: '100%',
          flexDirection: 'row',
          justifyContent: 'space-around',
          marginTop: 2,
          paddingHorizontal: 10,
        }}
      >
        <Text style={{ fontSize: 10, fontWeight: '600', color: 'rgba(226, 232, 240, 0.85)' }}>
          S
        </Text>
        <Text style={{ fontSize: 10, fontWeight: '600', color: 'rgba(226, 232, 240, 0.85)' }}>
          00
        </Text>
        <Text style={{ fontSize: 10, fontWeight: '600', color: 'rgba(226, 232, 240, 0.85)' }}>
          09
        </Text>
        <Text style={{ fontSize: 10, fontWeight: '600', color: 'rgba(226, 232, 240, 0.85)' }}>
          E
        </Text>
      </View>
    </View>
  );
};

const CompassRoseOverlay: React.FC = () => (
  <View
    pointerEvents="none"
    style={{
      position: 'absolute',
      top: 14,
      right: 14,
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: 'rgba(10, 20, 35, 0.72)',
      borderWidth: 1.2,
      borderColor: 'rgba(148, 163, 184, 0.55)',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 6,
    }}
  >
    <View
      style={{
        position: 'absolute',
        width: 36,
        height: 1,
        backgroundColor: 'rgba(148, 163, 184, 0.25)',
      }}
    />
    <View
      style={{
        position: 'absolute',
        width: 1,
        height: 36,
        backgroundColor: 'rgba(148, 163, 184, 0.25)',
      }}
    />
    <Text style={{ position: 'absolute', top: 3, fontSize: 8.5, fontWeight: 'bold', color: '#f8fafc' }}>
      N
    </Text>
    <Text style={{ position: 'absolute', bottom: 3, fontSize: 8.5, fontWeight: 'bold', color: '#f8fafc' }}>
      S
    </Text>
    <Text style={{ position: 'absolute', left: 4, fontSize: 8.5, fontWeight: 'bold', color: '#f8fafc' }}>
      W
    </Text>
    <Text style={{ position: 'absolute', right: 4, fontSize: 8.5, fontWeight: 'bold', color: '#f8fafc' }}>
      E
    </Text>
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: 3.5,
          borderRightWidth: 3.5,
          borderBottomWidth: 11,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderBottomColor: '#ef4444',
        }}
      />
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: 3.5,
          borderRightWidth: 3.5,
          borderTopWidth: 11,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderTopColor: '#38bdf8',
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: 3.5,
          height: 3.5,
          borderRadius: 2,
          backgroundColor: '#e2e8f0',
        }}
      />
    </View>
  </View>
);

const ClinicalEcgTraceIpad: React.FC<{ isElevated?: boolean; bpm?: number }> = ({
  isElevated = false,
  bpm = 75,
}) => {
  const strokeColor = isElevated ? '#e5a024' : '#2fb380';
  const points = [14, 14, 11, 14, 14, 17, 3, 18, 10, 14, 14, 14, 11, 14, 14, 17, 3, 18, 10, 14, 14];

  return (
    <View
      style={{
        width: '100%',
        height: 22,
        backgroundColor: 'rgba(10, 15, 25, 0.65)',
        borderRadius: 4,
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingHorizontal: 4,
        paddingBottom: 2,
        overflow: 'hidden',
      }}
    >
      {points.map((val, idx) => {
        const barH = Math.max(3, 20 - val);
        return (
          <View
            key={idx}
            style={{
              width: 2.2,
              height: barH,
              backgroundColor: strokeColor,
              opacity: idx % 2 === 0 ? 0.9 : 0.6,
              borderRadius: 1,
            }}
          />
        );
      })}
    </View>
  );
};

const PlssLinearGaugeIpad: React.FC<{
  valuePct: number;
  minThresholdPct?: number;
  fillColor?: string;
}> = ({ valuePct, minThresholdPct, fillColor = '#38bdf8' }) => {
  const clamped = Math.max(0, Math.min(100, valuePct));
  return (
    <View
      style={{
        position: 'relative',
        width: '100%',
        height: 6,
        backgroundColor: '#1b2333',
        borderRadius: 3,
        overflow: 'visible',
      }}
    >
      <View
        style={{
          width: `${clamped}%`,
          height: '100%',
          backgroundColor: fillColor,
          borderRadius: 3,
        }}
      />
      {minThresholdPct !== undefined && (
        <View
          style={{
            position: 'absolute',
            left: `${minThresholdPct}%`,
            top: -2,
            bottom: -2,
            width: 2,
            backgroundColor: '#f87171',
            zIndex: 3,
          }}
        />
      )}
    </View>
  );
};

const ElevationChartIpad: React.FC<{ profile: ElevPoint[]; maxSlopeDeg: number }> = ({
  profile,
  maxSlopeDeg,
}) => {
  if (profile.length < 2) return null;

  const elevs = profile.map((p) => p.elev);
  const minE = Math.min(...elevs);
  const maxE = Math.max(...elevs);
  const span = Math.max(0.5, maxE - minE);

  let peakIdx = 1;
  for (let i = 1; i < profile.length - 1; i++) {
    if (profile[i].slope > profile[peakIdx].slope) {
      peakIdx = i;
    }
  }

  return (
    <View style={{ marginTop: 2 }}>
      <View style={{ height: 110, flexDirection: 'row', alignItems: 'stretch' }}>
        <View
          style={{
            width: 44,
            justifyContent: 'space-between',
            paddingVertical: 4,
            paddingRight: 4,
            alignItems: 'flex-end',
          }}
        >
          <Text style={{ fontSize: 7.5, color: '#94a3b8', fontFamily: 'monospace' }}>-1600 m</Text>
          <Text style={{ fontSize: 7.5, color: '#94a3b8', fontFamily: 'monospace' }}>-1700 m</Text>
          <Text style={{ fontSize: 7.5, color: '#94a3b8', fontFamily: 'monospace' }}>-1800 m</Text>
        </View>

        <View
          style={{
            flex: 1,
            borderLeftWidth: 1,
            borderBottomWidth: 1,
            borderColor: 'rgba(148, 163, 184, 0.45)',
            flexDirection: 'row',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            paddingHorizontal: 2,
            paddingTop: 14,
            position: 'relative',
          }}
        >
          <Text
            style={{
              position: 'absolute',
              top: 2,
              left: 6,
              fontSize: 8,
              fontWeight: '700',
              color: '#ef4444',
              fontFamily: 'monospace',
            }}
          >
            Pendiente máx: {maxSlopeDeg}°
          </Text>

          {profile.map((pt, idx) => {
            const norm = Math.max(0.08, (pt.elev - minE) / span);
            const barH = Math.round(norm * 78);
            const isPeak = idx === peakIdx;

            return (
              <View
                key={idx}
                style={{
                  flex: 1,
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  height: '100%',
                }}
              >
                {isPeak && (
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: '#ef4444',
                      borderWidth: 1,
                      borderColor: '#080a0f',
                      marginBottom: -3,
                      zIndex: 4,
                    }}
                  />
                )}
                <View
                  style={{
                    width: '84%',
                    height: barH,
                    backgroundColor: 'rgba(56, 189, 248, 0.28)',
                    borderTopWidth: 2,
                    borderTopColor: '#38bdf8',
                  }}
                />
              </View>
            );
          })}
        </View>
      </View>

      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingLeft: 44,
          marginTop: 3,
        }}
      >
        {['0 km', '2 km', '4 km', '6 km', '8 km'].map((lbl) => (
          <Text key={lbl} style={{ fontSize: 7.5, color: '#94a3b8', fontFamily: 'monospace' }}>
            {lbl}
          </Text>
        ))}
      </View>
    </View>
  );
};

export const TopographicMapIpad: React.FC<TopographicMapIpadProps> = ({
  droneData,
  evaData,
  risk,
  mode,
  utcTime,
  isConnected,
  customUrls,
  onSwitchMode,
  onChangeUrl,
  onApplyUrl,
}) => {
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const [showLayersPanel, setShowLayersPanel] = useState(false);

  // Capas del mapa
  const [showCraters, setShowCraters] = useState(true);
  const [showEscarpments, setShowEscarpments] = useState(true);
  const [showContourLines, setShowContourLines] = useState(true);
  const [showMetricGrid, setShowMetricGrid] = useState(true);

  // Paradas científicas
  const [stops, setStops] = useState<ScientificStop[]>([]);
  const [selectedStop, setSelectedStop] = useState<ScientificStop | null>(null);
  const [pendingStopPos, setPendingStopPos] = useState<[number, number] | null>(null);
  const [pendingStopName, setPendingStopName] = useState('');
  const [pendingStopObj, setPendingStopObj] = useState('');

  // Zoom táctico
  const [zoomScale, setZoomScale] = useState(1.0);
  const [targetPoint, setTargetPoint] = useState<[number, number]>([4.45, 2.75]);
  const [mapSize, setMapSize] = useState({ width: 680, height: 460 });
  const [hoverCoords, setHoverCoords] = useState({
    lat: '-11.53010',
    lon: '6.23993°',
  });

  const evaYaw = evaData?.imu?.yaw ?? 0;
  const evaPos: [number, number] = [
    Number((3.62 + Math.sin((evaYaw * Math.PI) / 180) * 0.08).toFixed(2)),
    Number((5.55 + Math.cos((evaYaw * Math.PI) / 180) * 0.08).toFixed(2)),
  ];

  const obstacles = useMemo(() => buildMergedObstacles(droneData), [droneData]);

  const safeRoute = useMemo(
    () => computeIpadSafeRouteAStar(evaPos, targetPoint, obstacles, stops),
    [evaPos[0], evaPos[1], targetPoint[0], targetPoint[1], obstacles, stops]
  );

  const elevationProfile = useMemo(
    () => buildElevationProfile(safeRoute.points, obstacles, droneData?.map_state),
    [safeRoute.points, obstacles, droneData?.map_state]
  );

  const maxRouteSlopeDeg = safeRoute.maxSlopeDeg;

  // Obstáculos & alertas reales detectados en la ruta
  const KIND_TITLE: Record<string, string> = {
    crater_wall: 'Cráter segmentado',
    steep_cliff: 'Escarpe pronunciado',
    rock_obstacle: 'Roca / obstáculo',
  };

  const alertCards = useMemo(() => {
    const overallLevel = maxRouteSlopeDeg >= 28 ? 'red' : maxRouteSlopeDeg >= 16 ? 'yellow' : 'green';
    const overallCard = {
      level: overallLevel,
      badgeText: overallLevel === 'red' ? 'CRÍTICO' : 'PRECAUCIÓN',
      accent: overallLevel === 'red' ? '#e5484d' : '#e5a024',
      title: 'Pendiente de terreno',
      metric: `${maxRouteSlopeDeg.toFixed(1)}°`,
      source: 'Elevación sintética',
      value: '0.00 m',
    };

    const detected = obstacles.slice(0, 8).map((obs) => {
      const isRed = obs.slopeDeg >= 30;
      return {
        level: isRed ? ('red' as const) : ('yellow' as const),
        badgeText: isRed ? 'CRÍTICO' : 'PRECAUCIÓN',
        accent: isRed ? '#e5484d' : '#e5a024',
        title: KIND_TITLE[obs.kind ?? ''] ?? 'Obstáculo detectado',
        metric: `${obs.slopeDeg.toFixed(1)}°`,
        source: obs.detector ?? 'HoughCircles',
        value: `${obs.radius.toFixed(2)} m`,
      };
    });

    return [overallCard, ...detected];
  }, [obstacles, maxRouteSlopeDeg]);

  const criticalCount = alertCards.filter((c) => c.level === 'red').length;
  const cautionCount = alertCards.filter((c) => c.level === 'yellow').length;

  const handleMapLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setMapSize({ width, height });
    }
  };

  const handleMapPress = (e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    const relX = Math.max(0.04, Math.min(0.96, locationX / mapSize.width));
    const relY = Math.max(0.05, Math.min(0.95, locationY / mapSize.height));
    const xm = Number((relX * 10).toFixed(2));
    const ym = Number((relY * 10).toFixed(2));
    setTargetPoint([xm, ym]);
    setHoverCoords({
      lat: (-11.45 - relY * 0.14).toFixed(5),
      lon: (6.15 + relX * 0.12).toFixed(5) + '°',
    });
  };

  const handleMapLongPress = (e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    const relX = Math.max(0.04, Math.min(0.96, locationX / mapSize.width));
    const relY = Math.max(0.05, Math.min(0.95, locationY / mapSize.height));
    const xm = Number((relX * 10).toFixed(2));
    const ym = Number((relY * 10).toFixed(2));
    setPendingStopPos([xm, ym]);
    setPendingStopName(`Parada ${stops.length + 1}`);
    setPendingStopObj('Muestreo geológico');
  };

  const confirmAddStop = () => {
    if (!pendingStopPos) return;
    const number = stops.length + 1;
    const newStop: ScientificStop = {
      id: `stop-${Date.now()}`,
      number,
      name: pendingStopName.trim() || `Parada ${number}`,
      objective: pendingStopObj.trim() || 'Muestreo de regolito',
      xm: pendingStopPos[0],
      ym: pendingStopPos[1],
    };
    setStops([...stops, newStop]);
    setPendingStopPos(null);
  };

  const toPxX = (xm: number) => (xm / 10) * mapSize.width;
  const toPxY = (ym: number) => (ym / 10) * mapSize.height;

  // Círculo morado central de escaneo y zona roja de riesgo
  const scanCenterX = mapSize.width * 0.42;
  const scanCenterY = mapSize.height * 0.49;
  const scanRadiusPx = Math.min(mapSize.width, mapSize.height) * 0.34;

  const hazardPx = mapSize.width * 0.51;
  const hazardPy = mapSize.height * 0.36;
  const hazardR = Math.min(mapSize.width, mapSize.height) * 0.068;

  const startPt = safeRoute.points[0] ?? evaPos;
  const endPt = safeRoute.points[safeRoute.points.length - 1] ?? targetPoint;
  const evaPx = toPxX(startPt[0]);
  const evaPy = toPxY(startPt[1]);
  const targetPx = toPxX(endPt[0]);
  const targetPy = toPxY(endPt[1]);

  const o2Level = evaData ? evaData.suit_o2 : 87.0;
  const heartRate = evaData ? evaData.heart_rate : 75;
  const suitPressurePct = evaData ? evaData.battery : 96.1;
  const isO2Critical = o2Level <= 25;
  const isO2Warn = !isO2Critical && o2Level <= 40;
  const isHrElevated = heartRate >= 135 || heartRate <= 50;

  const regionLabels = [
    { text: 'Dollfus', x: mapSize.width * 0.21, y: mapSize.height * 0.55 },
    { text: "Ma'adim Vallis", x: mapSize.width * 0.55, y: mapSize.height * 0.41 },
    { text: 'Nervoorn', x: mapSize.width * 0.43, y: mapSize.height * 0.69 },
    { text: 'Bachtiaus Vallis', x: mapSize.width * 0.28, y: mapSize.height * 0.74 },
  ];

  return (
    <View style={styles.container}>
      {/* 1. BARRA SUPERIOR: ARES FLIGHT DECK */}
      <View style={styles.aresTopHeader}>
        <View style={styles.brandGroup}>
          <View style={styles.brandIconBox}>
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                borderWidth: 1.4,
                borderColor: '#cbd5e1',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  borderWidth: 1,
                  borderColor: '#cbd5e1',
                }}
              />
            </View>
          </View>
          <View>
            <View style={styles.brandTitleRow}>
              <Text style={styles.brandAresText}>ARES</Text>
              <Text style={styles.brandDeckText}>FLIGHT DECK</Text>
            </View>
            <Text style={styles.brandSubText}>MARTIAN TACTICAL & MISSION CONTROL</Text>
          </View>
        </View>

        <View style={styles.headerRightInfoGroup}>
          <View style={styles.headerDivider} />

          <View style={styles.headerMetaBlock}>
            <Text style={styles.headerMetaLabel}>IDENTIFICADOR DE MISIÓN</Text>
            <Text style={styles.headerMetaValue}>MISIÓN: ARES-IV // SECTOR DOLLFUS</Text>
          </View>

          <View style={styles.headerMetaBlock}>
            <Text style={styles.headerMetaLabel}>TIEMPO UNIVERSAL</Text>
            <View style={styles.utcValueRow}>
              <Text style={styles.utcValueBig}>{utcTime || '06:58:17'}</Text>
              <Text style={styles.utcLabelSmall}>UTC</Text>
            </View>
          </View>

          <View style={styles.headerDivider} />

          <View style={styles.headerMetaBlock}>
            <View style={styles.activeLinkBadge}>
              <View
                style={[
                  styles.activeLinkDot,
                  { backgroundColor: isConnected ? '#10b981' : '#ef4444' },
                ]}
              />
              <Text
                style={[
                  styles.activeLinkText,
                  { color: isConnected ? '#10b981' : '#f87171' },
                ]}
              >
                {isConnected ? 'ENLACE ACTIVO' : 'SIN CONEXIÓN'}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setShowSettingsMenu(!showSettingsMenu)}
              style={styles.simulationSelectorBtn}
            >
              <Text style={styles.simulationSelectorText}>SIMULACIÓN TELEMÉTRICA ⌄</Text>
            </TouchableOpacity>
          </View>
        </View>

        {showSettingsMenu && (
          <View style={styles.floatingDropdown}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: 11 }}>
                Enlace y Fuente de Datos
              </Text>
              <Text
                style={{
                  color: isConnected ? '#4ade80' : '#f87171',
                  fontWeight: '600',
                  fontSize: 11,
                }}
              >
                {isConnected ? '● CONECTADO' : '○ SIN CONEXIÓN'}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
              <TouchableOpacity
                onPress={() => onSwitchMode('local_esp')}
                style={{
                  flex: 1,
                  paddingVertical: 5,
                  borderRadius: 5,
                  borderWidth: 1,
                  borderColor: mode === 'local_esp' ? '#38bdf8' : '#334155',
                  backgroundColor: mode === 'local_esp' ? '#0c4a6e' : '#1e293b',
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#f8fafc', fontSize: 11 }}>ESP32</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => onSwitchMode('online_raspi')}
                style={{
                  flex: 1,
                  paddingVertical: 5,
                  borderRadius: 5,
                  borderWidth: 1,
                  borderColor: mode === 'online_raspi' ? '#a855f7' : '#334155',
                  backgroundColor: mode === 'online_raspi' ? '#4c1d95' : '#1e293b',
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#f8fafc', fontSize: 11 }}>Raspi</Text>
              </TouchableOpacity>
            </View>

            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
              <TextInput
                style={{
                  flex: 1,
                  backgroundColor: '#020617',
                  borderWidth: 1,
                  borderColor: '#334155',
                  borderRadius: 4,
                  color: '#e2e8f0',
                  paddingVertical: 4,
                  paddingHorizontal: 7,
                  fontSize: 11,
                }}
                value={customUrls[mode]}
                onChangeText={onChangeUrl}
                placeholder="ws://192.168.1.100:8765"
                placeholderTextColor="#64748b"
                autoCapitalize="none"
              />
              <TouchableOpacity
                onPress={onApplyUrl}
                style={{
                  backgroundColor: '#ea580c',
                  borderRadius: 4,
                  paddingHorizontal: 8,
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: '#ffffff', fontWeight: '600', fontSize: 11 }}>Conectar</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              onPress={() => fetchMapStateFromServer(customUrls[mode])}
              style={{
                backgroundColor: '#1e3a8a',
                borderWidth: 1,
                borderColor: '#3b82f6',
                borderRadius: 5,
                paddingVertical: 5,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: '#dbeafe', fontSize: 11 }}>Sync D415</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* 2. FILA DE CONTEXTO TÁCTICO */}
      <View style={styles.contextBarRow}>
        <Text style={styles.terminalTacticalTitle}>Terminal táctica</Text>
        <View style={styles.verticalSmallDivider} />
        <Text style={styles.tacticalSubLabel}>CARTOGRAFÍA & NAVEGACIÓN EVA</Text>
      </View>

      {/* 3. FRANJA OPERATIVA */}
      <View style={styles.operationalStrip}>
        <View style={styles.stripItemsGroup}>
          <View style={styles.stripItem}>
            <Text style={styles.stripItemLabel}>OPERACIÓN</Text>
            <Text style={styles.stripItemValue}>Reconocimiento de superficie</Text>
          </View>
          <View style={styles.verticalSmallDivider} />
          <View style={styles.stripItem}>
            <Text style={styles.stripItemLabel}>UNIDAD EVA</Text>
            <Text style={styles.stripItemValueMono}>ASTRONAUTA 01</Text>
          </View>
          <View style={styles.verticalSmallDivider} />
          <View style={styles.stripItem}>
            <Text style={styles.stripItemLabel}>ÁREA DE EXPLORACIÓN</Text>
            <Text style={styles.stripItemValueMono}>100.00 m²</Text>
          </View>
        </View>

        <View style={styles.plannerActiveBadge}>
          <View style={{ width: 5.5, height: 5.5, borderRadius: 3, backgroundColor: '#10b981' }} />
          <Text style={{ fontSize: 9, color: '#8b98a9', fontFamily: 'monospace' }}>
            PLANIFICADOR ACTIVO
          </Text>
        </View>
      </View>

      {/* 4. CONTENIDO PRINCIPAL (2 COLUMNAS) */}
      <View style={styles.mainContentRow}>
        {/* COLUMNA IZQUIERDA: CARTOGRAFÍA */}
        <View style={styles.leftCard}>
          <View style={styles.mapTopCardHeader}>
            <View style={styles.mapTopTitleGroup}>
              <View
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  borderWidth: 1.2,
                  borderColor: '#64748b',
                }}
              />
              <Text style={styles.mapTopCardTitle}>Cartografía de superficie</Text>
            </View>
          </View>

          <View style={styles.mapAreaWrapper} onLayout={handleMapLayout}>
            <Pressable
              onPress={handleMapPress}
              onLongPress={handleMapLongPress}
              style={styles.mapPressable}
            >
              <Image source={MARS_IMG} style={styles.mapBackgroundImage} resizeMode="cover" />
              <View style={styles.mapTintOverlay} />

              {/* Botón superior izquierdo: LEYENDA */}
              <TouchableOpacity
                onPress={() => setShowLegend(!showLegend)}
                style={styles.legendBtn}
              >
                <Text style={styles.legendBtnText}>LEYENDA {showLegend ? '▲' : '▼'}</Text>
              </TouchableOpacity>

              {/* Panel de Leyenda Plegable */}
              {showLegend && (
                <View style={styles.legendPanel}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: '#38bdf8', marginBottom: 6 }}>
                    LEYENDA DEL MAPA
                  </Text>
                  {[
                    { label: 'Base de operaciones', desc: 'Punto de partida', color: '#38bdf8' },
                    { label: 'Rover / D415', desc: 'Plataforma sensorizada', color: '#f59e0b' },
                    { label: 'Astronauta EVA-01', desc: 'Posición actual en tiempo real', color: '#38bdf8' },
                    { label: 'Objetivo de navegación', desc: 'Destino fijado', color: '#f59e0b' },
                    { label: 'Parada científica', desc: 'Puntos de muestreo', color: '#38bdf8' },
                    { label: 'Obstáculo o cráter', desc: 'Depresión o terreno de riesgo', color: '#ef4444' },
                  ].map((item, idx) => (
                    <View
                      key={idx}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 4,
                      }}
                    >
                      <View
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: item.color,
                        }}
                      />
                      <View>
                        <Text style={{ fontSize: 9.5, color: '#f1f5f9', fontWeight: '600' }}>
                          {item.label}
                        </Text>
                        <Text style={{ fontSize: 8, color: '#94a3b8' }}>{item.desc}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}

              {/* Botón superior derecho: CAPAS DEL MAPA */}
              <TouchableOpacity
                onPress={() => setShowLayersPanel(!showLayersPanel)}
                style={styles.layersBtn}
              >
                <Text style={styles.layersBtnText}>CAPAS DEL MAPA {showLayersPanel ? '▲' : '▼'}</Text>
              </TouchableOpacity>

              {/* Panel de Capas Desplegable */}
              {showLayersPanel && (
                <View style={styles.layersPanel}>
                  {[
                    {
                      label: 'Cráteres detectados',
                      checked: showCraters,
                      onChange: () => setShowCraters(!showCraters),
                      count: obstacles.filter((o) => o.detector === 'HoughCircles').length,
                    },
                    {
                      label: 'Escarpes geológicos',
                      checked: showEscarpments,
                      onChange: () => setShowEscarpments(!showEscarpments),
                      count: DEFAULT_MARS_ESCARPMENTS.length,
                    },
                    {
                      label: 'Curvas de nivel',
                      checked: showContourLines,
                      onChange: () => setShowContourLines(!showContourLines),
                    },
                    {
                      label: 'Cuadrícula métrica',
                      checked: showMetricGrid,
                      onChange: () => setShowMetricGrid(!showMetricGrid),
                    },
                  ].map((row, idx) => (
                    <TouchableOpacity
                      key={idx}
                      onPress={row.onChange}
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                        <View
                          style={{
                            width: 14,
                            height: 14,
                            borderRadius: 3,
                            borderWidth: 1,
                            borderColor: row.checked ? '#38bdf8' : '#475569',
                            backgroundColor: row.checked ? '#38bdf8' : 'transparent',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {row.checked && (
                            <View
                              style={{
                                width: 6,
                                height: 6,
                                backgroundColor: '#080a0f',
                                borderRadius: 1,
                              }}
                            />
                          )}
                        </View>
                        <Text style={{ fontSize: 10.5, color: '#e2e8f0' }}>{row.label}</Text>
                      </View>
                      {row.count !== undefined && (
                        <Text style={{ fontSize: 9.5, color: '#64748b', fontFamily: 'monospace' }}>
                          {String(row.count).padStart(2, '0')}
                        </Text>
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* Controles de Zoom verticales derechos */}
              <View style={styles.zoomControlsBox}>
                <TouchableOpacity
                  onPress={() => setZoomScale(Math.min(2.5, zoomScale + 0.25))}
                  style={styles.zoomBtn}
                >
                  <Text style={styles.zoomBtnText}>+</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setZoomScale(Math.max(0.75, zoomScale - 0.25))}
                  style={styles.zoomBtn}
                >
                  <Text style={styles.zoomBtnText}>−</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setZoomScale(1.0)} style={styles.zoomBtn}>
                  <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: 'bold' }}>⊙</Text>
                </TouchableOpacity>
              </View>

              {/* Cinta superior y brújula */}
              <HeadingTapeOverlay />
              <CompassRoseOverlay />

              {/* Círculo morado central de escaneo */}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: scanCenterX - scanRadiusPx,
                  top: scanCenterY - scanRadiusPx,
                  width: scanRadiusPx * 2,
                  height: scanRadiusPx * 2,
                  borderRadius: scanRadiusPx,
                  backgroundColor: 'rgba(168, 85, 247, 0.22)',
                  borderWidth: 1.4,
                  borderColor: 'rgba(192, 132, 252, 0.55)',
                }}
              />
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: scanCenterX - 6,
                  top: scanCenterY - 12,
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: '#c084fc',
                  borderWidth: 1.5,
                  borderColor: '#3b0764',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <View
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: '#2e1065',
                  }}
                />
              </View>

              {/* Zona roja de riesgo */}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: hazardPx - hazardR,
                  top: hazardPy - hazardR,
                  width: hazardR * 2,
                  height: hazardR * 2,
                  borderRadius: hazardR,
                  backgroundColor: 'rgba(220, 38, 38, 0.36)',
                  borderWidth: 1.4,
                  borderColor: 'rgba(248, 113, 113, 0.72)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <View
                  style={{
                    width: hazardR * 0.8,
                    height: hazardR * 0.8,
                    borderRadius: hazardR * 0.4,
                    backgroundColor: 'rgba(239, 68, 68, 0.5)',
                  }}
                />
              </View>

              {/* Etiquetas geográficas */}
              {regionLabels.map((lbl) => (
                <Text
                  key={lbl.text}
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: lbl.x - 45,
                    top: lbl.y - 8,
                    width: 90,
                    textAlign: 'center',
                    fontSize: 10.5,
                    fontWeight: '500',
                    color: 'rgba(241, 245, 249, 0.88)',
                  }}
                >
                  {lbl.text}
                </Text>
              ))}

              {/* Cráteres verificados en anillos rojos limpios */}
              {showCraters &&
                obstacles.map((crater) => {
                  if (crater.detector !== 'HoughCircles') return null;
                  const cx = toPxX(crater.x);
                  const cy = toPxY(crater.y);
                  const rx = Math.max(8, (crater.radius / 10) * mapSize.width);
                  const ry = Math.max(8, ((crater.radiusY ?? crater.radius) / 10) * mapSize.height);

                  return (
                    <View
                      key={crater.id}
                      pointerEvents="none"
                      style={{
                        position: 'absolute',
                        left: cx - rx,
                        top: cy - ry,
                        width: rx * 2,
                        height: ry * 2,
                        borderRadius: rx,
                        borderWidth: 1.3,
                        borderColor: 'rgba(248, 113, 113, 0.82)',
                        backgroundColor: 'rgba(239, 68, 68, 0.08)',
                      }}
                    />
                  );
                })}

              {/* Escarpes geológicos */}
              {showEscarpments &&
                DEFAULT_MARS_ESCARPMENTS.map((esc) =>
                  esc.points.map((pt, idx) => {
                    if (idx === 0) return null;
                    const prev = esc.points[idx - 1];
                    const x1 = toPxX(prev[0]);
                    const y1 = toPxY(prev[1]);
                    const x2 = toPxX(pt[0]);
                    const y2 = toPxY(pt[1]);
                    const length = Math.hypot(x2 - x1, y2 - y1);
                    const angleRad = Math.atan2(y2 - y1, x2 - x1);
                    const cx = (x1 + x2) / 2;
                    const cy = (y1 + y2) / 2;
                    return (
                      <View
                        key={`${esc.id}-${idx}`}
                        pointerEvents="none"
                        style={{
                          position: 'absolute',
                          left: cx - length / 2,
                          top: cy - 1,
                          width: length,
                          height: 2,
                          backgroundColor: 'rgba(56, 189, 248, 0.85)',
                          transform: [{ rotate: `${angleRad}rad` }],
                        }}
                      />
                    );
                  })
                )}

              {/* Ruta Segura A* con corredor translúcido */}
              {safeRoute.points.map((pt, idx) => {
                if (idx === 0) return null;
                const prev = safeRoute.points[idx - 1];
                const x1 = toPxX(prev[0]);
                const y1 = toPxY(prev[1]);
                const x2 = toPxX(pt[0]);
                const y2 = toPxY(pt[1]);
                const length = Math.hypot(x2 - x1, y2 - y1);
                const angleRad = Math.atan2(y2 - y1, x2 - x1);
                const cx = (x1 + x2) / 2;
                const cy = (y1 + y2) / 2;

                return (
                  <React.Fragment key={`seg-${idx}`}>
                    <View
                      pointerEvents="none"
                      style={{
                        position: 'absolute',
                        left: cx - length / 2,
                        top: cy - 6,
                        width: length,
                        height: 12,
                        backgroundColor: 'rgba(52, 211, 153, 0.16)',
                        borderRadius: 6,
                        transform: [{ rotate: `${angleRad}rad` }],
                      }}
                    />
                    <View
                      pointerEvents="none"
                      style={{
                        position: 'absolute',
                        left: cx - length / 2,
                        top: cy - 1.3,
                        width: length * 0.72,
                        height: 2.6,
                        backgroundColor: '#4ade80',
                        borderRadius: 1.5,
                        transform: [{ rotate: `${angleRad}rad` }],
                      }}
                    />
                  </React.Fragment>
                );
              })}

              {/* Marcador EVA_01 */}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: evaPx - 7,
                  top: evaPy - 7,
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  backgroundColor: '#0b192c',
                  borderWidth: 2.8,
                  borderColor: '#38bdf8',
                }}
              />
              <Text
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: evaPx + 10,
                  top: evaPy - 8,
                  fontSize: 12,
                  fontWeight: 'bold',
                  color: '#f8fafc',
                }}
              >
                EVA_01
              </Text>

              {/* Paradas Científicas */}
              {stops.map((stop) => {
                const sx = toPxX(stop.xm);
                const sy = toPxY(stop.ym);
                return (
                  <TouchableOpacity
                    key={stop.id}
                    onPress={() => setSelectedStop(stop)}
                    style={{
                      position: 'absolute',
                      left: sx - 9,
                      top: sy - 9,
                      width: 18,
                      height: 18,
                      borderRadius: 4,
                      backgroundColor: '#0284c7',
                      borderWidth: 1.5,
                      borderColor: '#e0f2fe',
                      alignItems: 'center',
                      justifyContent: 'center',
                      zIndex: 8,
                    }}
                  >
                    <Text style={{ fontSize: 9.5, fontWeight: 'bold', color: '#ffffff' }}>
                      {stop.number}
                    </Text>
                  </TouchableOpacity>
                );
              })}

              {/* Marcador Destino */}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: targetPx - 7,
                  top: targetPy - 7,
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  backgroundColor: '#1c1917',
                  borderWidth: 2.8,
                  borderColor: '#f59e0b',
                }}
              />
              <Text
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: targetPx + 10,
                  top: targetPy - 8,
                  fontSize: 12,
                  fontWeight: 'bold',
                  color: '#fbbf24',
                }}
              >
                Destino
              </Text>
            </Pressable>

            {/* Botón Astronauta (Telemetría EVA-01) */}
            <TouchableOpacity
              onPress={() => setShowTelemetry(!showTelemetry)}
              style={styles.astronautCircleBtn}
            >
              <View
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  borderWidth: 1.5,
                  borderColor: '#f8fafc',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <View
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 2.5,
                    backgroundColor: '#38bdf8',
                  }}
                />
              </View>
              <View
                style={[
                  styles.astronautOnlineDot,
                  { backgroundColor: isO2Critical ? '#ef4444' : isO2Warn ? '#f59e0b' : '#10b981' },
                ]}
              />
            </TouchableOpacity>

            {/* Modal flotante de Telemetría PLSS EVA-01 */}
            {showTelemetry && (
              <View style={styles.telemetryModalHud}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: 12.5, color: '#8e9bae' }}>Oxígeno · O₂</Text>
                  <Text
                    style={{
                      fontSize: 10,
                      fontWeight: '700',
                      color: isO2Critical ? '#ef4444' : isO2Warn ? '#f59e0b' : '#10b981',
                      fontFamily: 'monospace',
                    }}
                  >
                    {isO2Critical ? 'CRÍTICO' : isO2Warn ? 'ATENCIÓN' : 'NOMINAL'}
                  </Text>
                </View>

                <View style={{ flexDirection: 'row', alignItems: 'baseline', marginVertical: 8 }}>
                  <Text
                    style={{
                      fontSize: 34,
                      fontWeight: 'bold',
                      color: isO2Critical ? '#f87171' : '#f1f5f9',
                      fontFamily: 'monospace',
                    }}
                  >
                    {o2Level.toFixed(1)}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#7d899b', marginLeft: 4 }}>%</Text>
                </View>

                <PlssLinearGaugeIpad
                  valuePct={o2Level}
                  minThresholdPct={25}
                  fillColor={isO2Critical ? '#ef4444' : isO2Warn ? '#f59e0b' : '#29b6f6'}
                />

                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    marginTop: 4,
                  }}
                >
                  <Text style={{ fontSize: 8.5, color: '#5c6678', fontFamily: 'monospace' }}>0</Text>
                  <Text style={{ fontSize: 8.5, color: '#5c6678', fontFamily: 'monospace' }}>
                    UMBRAL CRÍTICO 25%
                  </Text>
                  <Text style={{ fontSize: 8.5, color: '#5c6678', fontFamily: 'monospace' }}>100</Text>
                </View>

                <View style={{ height: 1, backgroundColor: '#1c2230', marginVertical: 12 }} />

                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: '#8e9bae' }}>Pulso cardíaco</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', marginVertical: 4 }}>
                      <Text
                        style={{
                          fontSize: 22,
                          fontWeight: 'bold',
                          color: isHrElevated ? '#fbbf24' : '#f1f5f9',
                          fontFamily: 'monospace',
                        }}
                      >
                        {Math.round(heartRate)}
                      </Text>
                      <Text style={{ fontSize: 10, color: '#687588', marginLeft: 4 }}>BPM</Text>
                    </View>
                    <ClinicalEcgTraceIpad isElevated={isHrElevated} bpm={heartRate} />
                  </View>

                  <View style={{ width: 1, backgroundColor: '#1c2230' }} />

                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: '#8e9bae' }}>Presión traje</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', marginVertical: 4 }}>
                      <Text
                        style={{
                          fontSize: 22,
                          fontWeight: 'bold',
                          color: '#f1f5f9',
                          fontFamily: 'monospace',
                        }}
                      >
                        {suitPressurePct.toFixed(1)}
                      </Text>
                      <Text style={{ fontSize: 10, color: '#687588', marginLeft: 4 }}>%</Text>
                    </View>
                    <PlssLinearGaugeIpad valuePct={suitPressurePct} minThresholdPct={30} />
                    <Text
                      style={{
                        fontSize: 8.5,
                        color: '#5c6678',
                        marginTop: 4,
                        fontFamily: 'monospace',
                      }}
                    >
                      MIN SEGURO 30%
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Recuadro inferior derecho de Escala Táctica */}
            <View pointerEvents="none" style={styles.scaleLatLonBox}>
              <View style={styles.scaleBarRow}>
                <View style={styles.scaleBracket} />
                <Text style={styles.scaleKmText}>100 km</Text>
              </View>
              <Text style={styles.latLonText}>
                Lat: {hoverCoords.lat}  Lon: {hoverCoords.lon}
              </Text>
              <Text style={styles.scaleFactorText}>
                ESCALA TÁCTICA · {zoomScale.toFixed(2)}x
              </Text>
            </View>
          </View>

          {/* Barra decorativa inferior con franjas cian */}
          <View style={styles.bottomDecorativeBar}>
            <View style={styles.stripesGroup}>
              {Array.from({ length: 6 }).map((_, idx) => (
                <View
                  key={idx}
                  style={[styles.skewStripe, { opacity: 0.9 - idx * 0.08 }]}
                />
              ))}
            </View>
            <View style={styles.cornerTriangle} />
          </View>
        </View>

        {/* COLUMNA DERECHA: OBSTÁCULOS & PENDIENTES + PERFIL DE ELEVACIÓN */}
        <View style={styles.rightColumn}>
          <View>
            <View style={styles.rightHeaderBox}>
              <View style={styles.rightHeaderTopRow}>
                <View style={styles.rightHeaderTitleRow}>
                  <View
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 2,
                      borderWidth: 1.2,
                      borderColor: '#e5a024',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ color: '#e5a024', fontSize: 9, fontWeight: 'bold' }}>!</Text>
                  </View>
                  <Text style={styles.rightHeaderTitleText}>Obstáculos & pendientes</Text>
                </View>
                <Text style={styles.counterBadge}>
                  {String(alertCards.length).padStart(2, '0')}
                </Text>
              </View>
              <Text style={styles.rightHeaderSubtitle}>DETECCIÓN EN EL CORREDOR DE RUTA</Text>

              <View style={styles.countersBreakdownRow}>
                <View style={styles.breakdownItem}>
                  <View style={styles.smallDotRed} />
                  <Text style={styles.breakdownText}>
                    {String(criticalCount).padStart(2, '0')} Críticos
                  </Text>
                </View>
                <View style={styles.breakdownItem}>
                  <View style={styles.smallDotAmber} />
                  <Text style={styles.breakdownText}>
                    {String(cautionCount).padStart(2, '0')} Precaución
                  </Text>
                </View>
              </View>
            </View>

            {/* Lista de alertas */}
            <ScrollView style={styles.obstacleCardsList} nestedScrollEnabled>
              {alertCards.map((c, i) => (
                <View key={i} style={styles.alertCard}>
                  <View style={styles.alertCardTopRow}>
                    <View style={styles.alertBadgeGroup}>
                      <View style={[styles.alertBadgeDot, { backgroundColor: c.accent }]} />
                      <Text style={[styles.alertBadgeText, { color: c.accent }]}>
                        {c.badgeText}
                      </Text>
                    </View>
                    <Text style={[styles.alertMetricText, { color: c.accent }]}>
                      {c.metric}
                    </Text>
                  </View>
                  <View style={styles.alertCardMidRow}>
                    <Text style={styles.alertCardTitle}>{c.title}</Text>
                    <Text style={{ color: '#475569', fontSize: 13 }}>›</Text>
                  </View>
                  <View style={styles.alertCardBottomRow}>
                    <Text style={styles.alertSourceText}>{c.source}</Text>
                    <Text style={styles.alertValueText}>{c.value}</Text>
                  </View>
                </View>
              ))}
            </ScrollView>

            <View style={styles.detectorFooter}>
              <Text style={styles.detectorFooterText}>
                HoughCircles · Canny+Morphology · SAM+OpenCV
              </Text>
            </View>
          </View>

          {/* Sección de Elevación */}
          <View style={styles.elevationSection}>
            <View style={styles.elevationTopRow}>
              <View style={styles.elevationTitleGroup}>
                <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: 'bold' }}>▲</Text>
                <Text style={styles.elevationSectionTitle}>Perfil de elevación</Text>
              </View>
              {elevationProfile.length >= 2 && (
                <Text style={styles.elevationSamplesBadge}>
                  {elevationProfile.length} MUESTRAS
                </Text>
              )}
            </View>
            <Text style={styles.elevationSubtitle}>
              Terreno sintético · a lo largo de la ruta A*
            </Text>

            <ElevationChartIpad
              profile={elevationProfile}
              maxSlopeDeg={maxRouteSlopeDeg}
            />

            {elevationProfile.length >= 2 && (
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  marginTop: 3,
                }}
              >
                <Text style={{ fontSize: 8.5, color: '#64748b', fontFamily: 'monospace' }}>
                  INICIO {elevationProfile[0].elev.toFixed(2)} m
                </Text>
                <Text style={{ fontSize: 8.5, color: '#64748b', fontFamily: 'monospace' }}>
                  FIN {elevationProfile[elevationProfile.length - 1].elev.toFixed(2)} m
                </Text>
              </View>
            )}

            <View style={styles.statsBoxesRow}>
              <View style={styles.statBox}>
                <Text style={styles.statBoxLabel}>DESNIVEL NETO</Text>
                <Text style={styles.statBoxValue}>
                  {elevationProfile.length >= 2
                    ? `${(
                        elevationProfile[elevationProfile.length - 1].elev -
                        elevationProfile[0].elev
                      ).toFixed(2)} m`
                    : '0.00 m'}
                </Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statBoxLabel}>PENDIENTE MÁX.</Text>
                <Text style={styles.statBoxValueOrange}>{maxRouteSlopeDeg.toFixed(1)}°</Text>
              </View>
            </View>
          </View>
        </View>
      </View>

      {/* Modal para Agregar Parada Científica */}
      <Modal visible={!!pendingStopPos} transparent animationType="fade">
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <View
            style={{
              width: 320,
              backgroundColor: '#0c1018',
              borderWidth: 1.5,
              borderColor: '#38bdf8',
              borderRadius: 8,
              padding: 16,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: 'bold', color: '#38bdf8', marginBottom: 12 }}>
              NUEVA PARADA CIENTÍFICA
            </Text>
            <TextInput
              style={{
                backgroundColor: '#15171c',
                borderWidth: 1,
                borderColor: '#262830',
                borderRadius: 5,
                color: '#ffffff',
                padding: 8,
                fontSize: 12,
                marginBottom: 10,
              }}
              value={pendingStopName}
              onChangeText={setPendingStopName}
              placeholder="Nombre de la parada"
              placeholderTextColor="#64748b"
            />
            <TextInput
              style={{
                backgroundColor: '#15171c',
                borderWidth: 1,
                borderColor: '#262830',
                borderRadius: 5,
                color: '#ffffff',
                padding: 8,
                fontSize: 12,
                marginBottom: 14,
              }}
              value={pendingStopObj}
              onChangeText={setPendingStopObj}
              placeholder="Objetivo científico"
              placeholderTextColor="#64748b"
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                onPress={confirmAddStop}
                style={{
                  flex: 1,
                  backgroundColor: '#0284c7',
                  paddingVertical: 8,
                  borderRadius: 5,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#ffffff', fontWeight: 'bold', fontSize: 12 }}>Agregar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setPendingStopPos(null)}
                style={{
                  flex: 1,
                  backgroundColor: '#1e293b',
                  paddingVertical: 8,
                  borderRadius: 5,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#94a3b8', fontSize: 12 }}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Modal para Ver Parada Seleccionada */}
      <Modal visible={!!selectedStop} transparent animationType="fade">
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <View
            style={{
              width: 300,
              backgroundColor: '#0c1018',
              borderWidth: 1.5,
              borderColor: '#38bdf8',
              borderRadius: 8,
              padding: 16,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: 'bold', color: '#38bdf8' }}>
              #{selectedStop?.number} · {selectedStop?.name}
            </Text>
            <Text style={{ fontSize: 11.5, color: '#cbd5e1', marginVertical: 8 }}>
              {selectedStop?.objective}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
              <TouchableOpacity
                onPress={() => {
                  setStops(stops.filter((s) => s.id !== selectedStop?.id));
                  setSelectedStop(null);
                }}
                style={{
                  flex: 1,
                  backgroundColor: '#b91c1c',
                  paddingVertical: 7,
                  borderRadius: 5,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: 'bold' }}>Eliminar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setSelectedStop(null)}
                style={{
                  flex: 1,
                  backgroundColor: '#1e293b',
                  paddingVertical: 7,
                  borderRadius: 5,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#94a3b8', fontSize: 11 }}>Cerrar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};
