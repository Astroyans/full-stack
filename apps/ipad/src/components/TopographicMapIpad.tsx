import React, { useMemo, useState } from 'react';
import {
  GestureResponderEvent,
  Image,
  LayoutChangeEvent,
  Pressable,
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
  ElevPoint,
  OperationMode,
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
const TOPO_IMG = require('../../assets/topo-reference.jpg');

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
      {/* Triángulo verde central */}
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
      top: 16,
      right: 16,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: 'rgba(10, 20, 35, 0.68)',
      borderWidth: 1.2,
      borderColor: 'rgba(148, 163, 184, 0.55)',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 6,
    }}
  >
    {/* Líneas de cruz */}
    <View
      style={{
        position: 'absolute',
        width: 38,
        height: 1,
        backgroundColor: 'rgba(148, 163, 184, 0.25)',
      }}
    />
    <View
      style={{
        position: 'absolute',
        width: 1,
        height: 38,
        backgroundColor: 'rgba(148, 163, 184, 0.25)',
      }}
    />

    {/* Letras cardinales */}
    <Text
      style={{
        position: 'absolute',
        top: 3,
        fontSize: 9,
        fontWeight: 'bold',
        color: '#f8fafc',
      }}
    >
      N
    </Text>
    <Text
      style={{
        position: 'absolute',
        bottom: 3,
        fontSize: 9,
        fontWeight: 'bold',
        color: '#f8fafc',
      }}
    >
      S
    </Text>
    <Text
      style={{
        position: 'absolute',
        left: 5,
        fontSize: 9,
        fontWeight: 'bold',
        color: '#f8fafc',
      }}
    >
      W
    </Text>
    <Text
      style={{
        position: 'absolute',
        right: 5,
        fontSize: 9,
        fontWeight: 'bold',
        color: '#f8fafc',
      }}
    >
      E
    </Text>

    {/* Agujas Norte (Roja) y Sur (Azul) */}
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: 4,
          borderRightWidth: 4,
          borderBottomWidth: 12,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderBottomColor: '#ef4444',
        }}
      />
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: 4,
          borderRightWidth: 4,
          borderTopWidth: 12,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderTopColor: '#38bdf8',
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: 4,
          height: 4,
          borderRadius: 2,
          backgroundColor: '#e2e8f0',
        }}
      />
    </View>
  </View>
);

const CardWaveArtIpad: React.FC<{ level: 'red' | 'yellow' | 'green' }> = ({ level }) => {
  const color =
    level === 'red' ? '#ef4444' : level === 'yellow' ? '#f59e0b' : '#10b981';
  const fillBg =
    level === 'red'
      ? 'rgba(239, 68, 68, 0.16)'
      : level === 'yellow'
      ? 'rgba(245, 158, 11, 0.16)'
      : 'rgba(16, 185, 129, 0.18)';

  return (
    <View
      style={{
        height: 24,
        marginTop: 6,
        backgroundColor: fillBg,
        borderTopWidth: 1,
        borderTopColor: color,
        borderRadius: 4,
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingHorizontal: 4,
        paddingBottom: 2,
      }}
    >
      {Array.from({ length: 28 }).map((_, idx) => {
        const h = 4 + Math.round(Math.abs(Math.sin(idx * 0.45)) * 12);
        return (
          <View
            key={idx}
            style={{
              width: 2,
              height: h,
              backgroundColor: color,
              opacity: 0.55,
              borderRadius: 1,
            }}
          />
        );
      })}
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
  const evaRefIdx = Math.min(profile.length - 2, Math.max(2, Math.round(profile.length * 0.42)));

  return (
    <View style={{ marginTop: 2 }}>
      <View style={{ height: 112, flexDirection: 'row', alignItems: 'stretch' }}>
        {/* Eje Y: -1600 m, -1700 m, -1800 m */}
        <View
          style={{
            width: 42,
            justifyContent: 'space-between',
            paddingVertical: 4,
            paddingRight: 4,
            alignItems: 'flex-end',
          }}
        >
          <Text style={{ fontSize: 8, color: '#cbd5e1' }}>-1600 m</Text>
          <Text style={{ fontSize: 8, color: '#cbd5e1' }}>-1700 m</Text>
          <Text style={{ fontSize: 8, color: '#cbd5e1' }}>-1800 m</Text>
        </View>

        {/* Área de la curva */}
        <View
          style={{
            flex: 1,
            borderLeftWidth: 1,
            borderBottomWidth: 1,
            borderColor: 'rgba(148, 163, 184, 0.5)',
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
              left: 8,
              fontSize: 8,
              fontWeight: 'bold',
              color: '#ef4444',
            }}
          >
            Pendiente máx: {maxSlopeDeg}°
          </Text>

          {profile.map((pt, idx) => {
            const norm = Math.max(0.1, (pt.elev - minE) / span);
            const barH = Math.round(norm * 80);
            const isPeak = idx === peakIdx;
            const isEva = idx === evaRefIdx;
            const isDest = idx === profile.length - 3;

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
                      width: 7,
                      height: 7,
                      borderRadius: 4,
                      backgroundColor: '#ef4444',
                      borderWidth: 1,
                      borderColor: '#0b1220',
                      marginBottom: -3,
                      zIndex: 4,
                    }}
                  />
                )}
                {isDest && (
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: '#f59e0b',
                      marginBottom: -3,
                      zIndex: 4,
                    }}
                  />
                )}
                <View
                  style={{
                    width: '85%',
                    height: barH,
                    backgroundColor: 'rgba(56, 189, 248, 0.32)',
                    borderTopWidth: 2,
                    borderTopColor: '#7dd3fc',
                    borderLeftWidth: isEva ? 1 : 0,
                    borderLeftColor: 'rgba(226, 232, 240, 0.8)',
                  }}
                />
              </View>
            );
          })}

          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              right: 4,
              bottom: 3,
              alignItems: 'flex-end',
            }}
          >
            <Text style={{ fontSize: 7.5, color: '#f1f5f9' }}>Posición Actual (EVA-01)</Text>
            <Text style={{ fontSize: 7.5, color: '#e2e8f0' }}>
              Pendiente máx: {maxSlopeDeg}°
            </Text>
            <Text style={{ fontSize: 7.5, color: '#cbd5e1' }}>Altitud actual: -1,640 m</Text>
          </View>
        </View>
      </View>

      {/* Eje X: 0 km .. 8 km */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingLeft: 42,
          marginTop: 3,
        }}
      >
        {['0 km', '2 km', '4 km', '6 km', '8 km'].map((lbl) => (
          <Text key={lbl} style={{ fontSize: 8, color: '#cbd5e1' }}>
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
  const [isTopoLayer, setIsTopoLayer] = useState(false);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);

  // Coordenadas iniciales idénticas al diseño DOLLFUS
  const [targetPoint, setTargetPoint] = useState<[number, number]>([4.45, 2.75]);
  const [mapSize, setMapSize] = useState({ width: 720, height: 460 });
  const [hoverCoords, setHoverCoords] = useState({
    lat: '-11.49907',
    lon: '6.20995°',
  });

  const evaYaw = evaData?.imu?.yaw ?? 0;
  const evaPos: [number, number] = [
    Number((3.62 + Math.sin((evaYaw * Math.PI) / 180) * 0.08).toFixed(2)),
    Number((5.55 + Math.cos((evaYaw * Math.PI) / 180) * 0.08).toFixed(2)),
  ];

  const obstacles = useMemo(() => buildMergedObstacles(droneData), [droneData]);

  const safeRoute = useMemo(
    () => computeIpadSafeRouteAStar(evaPos, targetPoint, obstacles),
    [evaPos[0], evaPos[1], targetPoint[0], targetPoint[1], obstacles]
  );

  const elevationProfile = useMemo(
    () => buildElevationProfile(safeRoute.points, obstacles, droneData?.map_state),
    [safeRoute.points, obstacles, droneData?.map_state]
  );

  const riskCards = useMemo(() => {
    const highReason = risk.reasons.find((r) => /CRÍTIC|BLOQUEADA|INSEGURA|EXTREMA/i.test(r));
    const medReason = risk.reasons.find((r) => !/CRÍTIC|BLOQUEADA|INSEGURA|EXTREMA/i.test(r));

    return [
      {
        level: 'red' as const,
        badge: 'ALTO',
        badgeColor: '#ef4444',
        border: '#dc2626',
        bg: 'rgba(72, 14, 21, 0.92)',
        text: highReason
          ? `Cuidado: ${highReason.toLowerCase()}`
          : 'Cuidado: oxígeno del traje por debajo del 15%',
      },
      {
        level: 'yellow' as const,
        badge: 'MEDIO',
        badgeColor: '#facc15',
        border: '#d97706',
        bg: 'rgba(68, 48, 11, 0.92)',
        text: medReason
          ? `Cuidado: ${medReason.toLowerCase()}`
          : 'Cuidado: 22 obstáculo(s) de riesgo detectado(s)',
      },
      {
        level: 'green' as const,
        badge: 'BAJO',
        badgeColor: '#34d399',
        border: '#10b981',
        bg: 'rgba(10, 56, 48, 0.92)',
        text: 'Cuidado: zona con muchos cráteres a 500m',
      },
    ];
  }, [risk]);

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

  const toPxX = (xm: number) => (xm / 10) * mapSize.width;
  const toPxY = (ym: number) => (ym / 10) * mapSize.height;

  // Círculo morado central y zona roja de riesgo como en la captura DOLLFUS
  const scanCenterX = mapSize.width * 0.42;
  const scanCenterY = mapSize.height * 0.48;
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

  const o2Level = evaData ? evaData.suit_o2 : 14.2;
  const heartRate = evaData ? evaData.heart_rate : 118;
  const suitPressurePct = evaData ? evaData.battery : 84.0;
  const isO2Critical = o2Level < 45;

  const regionLabels = [
    { text: 'Dollfus', x: mapSize.width * 0.21, y: mapSize.height * 0.54 },
    { text: "Ma'adim Vallis", x: mapSize.width * 0.55, y: mapSize.height * 0.41 },
    { text: 'Nervoorn', x: mapSize.width * 0.42, y: mapSize.height * 0.68 },
    { text: 'Bachtiaus Vallis', x: mapSize.width * 0.27, y: mapSize.height * 0.74 },
  ];

  return (
    <View style={styles.unifiedFrame}>
      {/* Columna Izquierda: Encabezado DOLLFUS + Mapa + Barra Inferior */}
      <View style={styles.leftColumn}>
        <View style={styles.integratedHeader}>
          <View>
            <Text style={styles.missionRowText}>
              <Text style={styles.missionPrefix}>Misión: </Text>
              <Text style={styles.missionName}>OPERACIONES SUPERFICIE ARES - IV</Text>
            </Text>
            <Text style={styles.dollfusTitle}>DOLLFUS</Text>
          </View>

          <View style={styles.headerRightGroup}>
            <View style={styles.utcBlock}>
              <Text style={styles.utcLabel}>UTC</Text>
              <Text style={styles.utcValue}>{utcTime || '00:15:45'}</Text>
            </View>

            <TouchableOpacity
              onPress={() => setShowSettingsMenu(!showSettingsMenu)}
              style={[
                styles.settingsGearBtn,
                {
                  backgroundColor: showSettingsMenu ? '#0284c7' : 'rgba(15, 23, 42, 0.7)',
                  borderColor: isConnected ? '#22c55e' : '#334155',
                },
              ]}
            >
              <Text style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 'bold' }}>CFG</Text>
            </TouchableOpacity>
          </View>

          {showSettingsMenu && (
            <View style={styles.settingsDropdown}>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  marginBottom: 8,
                }}
              >
                <Text style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: 11 }}>
                  Enlace y Fuente de Mapa
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
                  <Text style={{ color: '#ffffff', fontWeight: '600', fontSize: 11 }}>
                    Conectar
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={{ flexDirection: 'row', gap: 6 }}>
                <TouchableOpacity
                  onPress={() => fetchMapStateFromServer(customUrls[mode])}
                  style={{
                    flex: 1,
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

                <TouchableOpacity
                  onPress={() => setIsTopoLayer(!isTopoLayer)}
                  style={{
                    flex: 1,
                    backgroundColor: '#065f46',
                    borderWidth: 1,
                    borderColor: '#10b981',
                    borderRadius: 5,
                    paddingVertical: 5,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: '#d1fae5', fontSize: 11 }}>Cambiar Capa</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* Área central del Mapa */}
        <View style={styles.mapAreaWrapper} onLayout={handleMapLayout}>
          <Pressable onPress={handleMapPress} style={styles.mapPressable}>
            <Image
              source={isTopoLayer ? TOPO_IMG : MARS_IMG}
              style={styles.mapBackgroundImage}
              resizeMode="cover"
            />
            <View
              style={[
                styles.mapTintOverlay,
                {
                  backgroundColor: isTopoLayer
                    ? 'rgba(15, 23, 42, 0.08)'
                    : 'rgba(8, 12, 22, 0.14)',
                },
              ]}
            />

            {/* Cinta superior de rumbo y brújula superior derecha */}
            <HeadingTapeOverlay />
            <CompassRoseOverlay />

            {/* Gran círculo morado de escaneo central + pin morado */}
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: scanCenterX - scanRadiusPx,
                top: scanCenterY - scanRadiusPx,
                width: scanRadiusPx * 2,
                height: scanRadiusPx * 2,
                borderRadius: scanRadiusPx,
                backgroundColor: 'rgba(168, 85, 247, 0.27)',
                borderWidth: 1.5,
                borderColor: 'rgba(192, 132, 252, 0.55)',
              }}
            />
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: scanCenterX - 7,
                top: scanCenterY - 14,
                width: 14,
                height: 14,
                borderRadius: 7,
                backgroundColor: '#c084fc',
                borderWidth: 1.5,
                borderColor: '#3b0764',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <View
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: 3,
                  backgroundColor: '#2e1065',
                }}
              />
            </View>

            {/* Zona roja doble de riesgo junto a Ma'adim Vallis */}
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
                  width: hazardR * 0.84,
                  height: hazardR * 0.84,
                  borderRadius: hazardR * 0.42,
                  backgroundColor: 'rgba(239, 68, 68, 0.52)',
                }}
              />
            </View>

            {/* Etiquetas geográficas marcianas */}
            {regionLabels.map((lbl) => (
              <Text
                key={lbl.text}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: lbl.x - 45,
                  top: lbl.y - 8,
                  width: 95,
                  textAlign: 'center',
                  fontSize: 11,
                  fontWeight: '500',
                  color: 'rgba(241, 245, 249, 0.90)',
                }}
              >
                {lbl.text}
              </Text>
            ))}

            {/* Ruta Segura punteada en verde entre EVA_01 y Destino */}
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
                <View
                  key={`seg-${idx}`}
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
                fontSize: 12.5,
                fontWeight: 'bold',
                color: '#f8fafc',
              }}
            >
              EVA_01
            </Text>

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
                fontSize: 12.5,
                fontWeight: 'bold',
                color: '#fbbf24',
              }}
            >
              Destino
            </Text>
          </Pressable>

          {/* Botón inferior izquierdo: Astronauta (abre/cierra Telemetría EVA-01) */}
          <TouchableOpacity
            onPress={() => setShowTelemetry(!showTelemetry)}
            style={[
              styles.astronautCircleBtn,
              { borderColor: showTelemetry ? '#34d399' : '#38bdf8' },
            ]}
          >
            <View style={{ alignItems: 'center' }}>
              <View
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 5,
                  borderWidth: 1.5,
                  borderColor: '#f8fafc',
                }}
              />
              <View
                style={{
                  width: 13,
                  height: 6,
                  borderTopLeftRadius: 5,
                  borderTopRightRadius: 5,
                  borderWidth: 1.5,
                  borderColor: '#f8fafc',
                  marginTop: 1,
                }}
              />
            </View>
            <View style={styles.astronautOnlineDot} />
          </TouchableOpacity>

          {/* Botón del Ojo */}
          <TouchableOpacity
            onPress={() => setIsTopoLayer(!isTopoLayer)}
            style={[
              styles.eyeCircleBtn,
              {
                backgroundColor: isTopoLayer ? '#0284c7' : 'rgba(10, 22, 38, 0.88)',
              },
            ]}
          >
            <View
              style={{
                width: 14,
                height: 8,
                borderRadius: 7,
                borderWidth: 1.5,
                borderColor: '#f8fafc',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <View
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: '#f8fafc',
                }}
              />
            </View>
          </TouchableOpacity>

          {/* Recuadro inferior derecho de Escala 100 km + Lat/Lon */}
          <View pointerEvents="none" style={styles.scaleLatLonBox}>
            <View style={styles.scaleBarRow}>
              <View style={styles.scaleBracket} />
              <Text style={styles.scaleKmText}>100 km</Text>
            </View>
            <Text style={styles.latLonText}>
              Lat: {hoverCoords.lat}   Lon: {hoverCoords.lon}
            </Text>
          </View>

          {/* Tarjeta flotante de Telemetría del traje EVA - 01 */}
          {showTelemetry && (
            <View style={styles.telemetryFloatingCard}>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  marginBottom: 10,
                }}
              >
                <View>
                  <Text style={{ fontSize: 12, color: '#e2e8f0', fontWeight: '500' }}>
                    Telemetría del traje
                  </Text>
                  <Text style={{ fontSize: 13, color: '#ffffff', fontWeight: 'bold' }}>
                    EVA - 01
                  </Text>
                </View>

                <View
                  style={{
                    width: 22,
                    height: 12,
                    borderWidth: 1.3,
                    borderColor: '#5eead4',
                    borderRadius: 2,
                    padding: 1.5,
                    justifyContent: 'center',
                  }}
                >
                  <View
                    style={{
                      width: `${Math.max(15, Math.min(100, suitPressurePct))}%`,
                      height: '100%',
                      backgroundColor: '#22c55e',
                      borderRadius: 1,
                    }}
                  />
                </View>
              </View>

              {/* Sub-caja 1: O2 en depósito */}
              <View
                style={{
                  backgroundColor: 'rgba(45, 12, 18, 0.65)',
                  borderWidth: 1,
                  borderColor: isO2Critical ? '#dc2626' : '#115e59',
                  borderRadius: 6,
                  paddingVertical: 6,
                  paddingHorizontal: 8,
                  marginBottom: 8,
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    marginBottom: 5,
                  }}
                >
                  <Text style={{ color: '#f1f5f9', fontWeight: '600', fontSize: 10.5 }}>
                    O2 en depósito
                  </Text>
                  <Text
                    style={{
                      color: isO2Critical ? '#f87171' : '#34d399',
                      fontWeight: 'bold',
                      fontSize: 10.5,
                    }}
                  >
                    {o2Level.toFixed(1)}%{isO2Critical ? ' - CRÍTICO!' : ''}
                  </Text>
                </View>
                <View
                  style={{
                    backgroundColor: 'rgba(127, 29, 29, 0.45)',
                    borderRadius: 3,
                    height: 11,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      width: `${Math.max(6, Math.min(100, o2Level))}%`,
                      height: '100%',
                      backgroundColor: isO2Critical ? '#ef4444' : '#10b981',
                    }}
                  />
                </View>
              </View>

              {/* Sub-caja 2: Pulso cardíaco */}
              <View
                style={{
                  backgroundColor: 'rgba(6, 30, 31, 0.72)',
                  borderWidth: 1,
                  borderColor: '#0f766e',
                  borderRadius: 6,
                  paddingVertical: 6,
                  paddingHorizontal: 8,
                  marginBottom: 8,
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    marginBottom: 4,
                  }}
                >
                  <Text style={{ color: '#e2e8f0', fontWeight: '600', fontSize: 10.5 }}>
                    Pulso cardíaco
                  </Text>
                  <Text style={{ color: '#ffffff', fontWeight: 'bold', fontSize: 11 }}>
                    {heartRate} BPM
                  </Text>
                </View>
                <View
                  style={{
                    height: 18,
                    backgroundColor: 'rgba(45, 212, 191, 0.08)',
                    borderRadius: 3,
                    justifyContent: 'center',
                    paddingHorizontal: 4,
                  }}
                >
                  <View style={{ height: 2, backgroundColor: '#34d399', width: '100%' }} />
                </View>
              </View>

              {/* Sub-caja 3: Presión del traje */}
              <View
                style={{
                  backgroundColor: 'rgba(6, 30, 31, 0.72)',
                  borderWidth: 1,
                  borderColor: '#0f766e',
                  borderRadius: 6,
                  paddingVertical: 6,
                  paddingHorizontal: 8,
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    marginBottom: 5,
                  }}
                >
                  <Text style={{ color: '#e2e8f0', fontWeight: '600', fontSize: 10.5 }}>
                    Presión del traje
                  </Text>
                  <Text style={{ color: '#cbd5e1', fontSize: 10, fontWeight: '600' }}>
                    <Text style={{ color: '#f8fafc', fontWeight: 'bold' }}>
                      {suitPressurePct.toFixed(1)}%
                    </Text>{' '}
                    | MIN 30!
                  </Text>
                </View>
                <View
                  style={{
                    backgroundColor: 'rgba(15, 118, 110, 0.28)',
                    borderRadius: 3,
                    height: 11,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      width: `${Math.max(8, Math.min(100, suitPressurePct))}%`,
                      height: '100%',
                      backgroundColor: '#34d399',
                    }}
                  />
                </View>
              </View>
            </View>
          )}
        </View>

        {/* Barra decorativa inferior con 6 franjas diagonales azules */}
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

      {/* Columna Derecha: Obstáculos & Pendientes + Elevación */}
      <View style={styles.rightColumn}>
        <View>
          <View style={styles.yellowTopBanner}>
            <Text style={styles.yellowTopBannerText}>Obstáculos & Pendientes</Text>
          </View>

          <View style={styles.riskCardsList}>
            {riskCards.map((c, i) => (
              <View
                key={i}
                style={[
                  styles.riskCardItem,
                  {
                    backgroundColor: c.bg,
                    borderColor: c.border,
                  },
                ]}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 4,
                  }}
                >
                  <Text style={{ color: '#cbd5e1', fontSize: 11.5, fontWeight: '500' }}>
                    Riesgo detectado:{' '}
                    <Text style={{ color: c.badgeColor, fontWeight: 'bold' }}>
                      {c.badge}
                    </Text>
                  </Text>
                  <View
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 5,
                      backgroundColor: c.badgeColor,
                    }}
                  />
                </View>

                <Text
                  style={{
                    color: '#f8fafc',
                    fontSize: 12,
                    fontWeight: '500',
                    lineHeight: 16,
                  }}
                >
                  {c.text}
                </Text>

                <CardWaveArtIpad level={c.level} />
              </View>
            ))}
          </View>
        </View>

        <View style={styles.elevationSection}>
          <Text style={styles.elevationSectionTitle}>Elevación</Text>
          {elevationProfile.length >= 2 ? (
            <ElevationChartIpad
              profile={elevationProfile}
              maxSlopeDeg={safeRoute.maxSlopeDeg}
            />
          ) : (
            <Text style={{ fontSize: 11, color: '#64748b', textAlign: 'center' }}>
              Toca el mapa para trazar la ruta.
            </Text>
          )}
        </View>
      </View>
    </View>
  );
};
