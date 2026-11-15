import React, { useEffect, useState } from 'react';
import {
  connectBackbone,
  evaluateRisk,
  sendRouteRequest,
  setBackboneUrl,
  useBackbone,
} from '@martian/shared';
import { buildTopographicDataset, CONNECTION_MODES, OperationMode } from './config/connectionConfig';
import { TopographicMap2D } from './components/TopographicMap2D';

export default function App() {
  const { isConnected, getEva, getDrone, ingestEnvelope } = useBackbone();

  const [mode, setMode] = useState<OperationMode>('local_esp');
  const [customUrls, setCustomUrls] = useState<Record<OperationMode, string>>({
    local_esp: CONNECTION_MODES.local_esp.defaultWsUrl,
    online_raspi: CONNECTION_MODES.online_raspi.defaultWsUrl,
  });
  const [utcTime, setUtcTime] = useState<string>('');

  useEffect(() => {
    connectBackbone(customUrls[mode]);

    fetch('/data/latest_expo_payload.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (payload && !getDrone()) {
          ingestEnvelope(payload);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const tick = () => setUtcTime(new Date().toISOString().substring(11, 19));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const handleSwitchMode = (newMode: OperationMode) => {
    setMode(newMode);
    setBackboneUrl(customUrls[newMode]);
  };

  const handleApplyUrl = () => {
    setBackboneUrl(customUrls[mode]);
  };

  const eva = getEva();
  const drone = getDrone();

  const activeDroneSource = drone?.data;
  const terrainDataset = buildTopographicDataset(activeDroneSource);
  const risk = evaluateRisk(eva?.data, activeDroneSource as any);

  const handleTargetSelect = async (targetMeters: [number, number]) => {
    const [mapX, mapY] = targetMeters;
    const y_m = Number(((mapX - 1.5) / 1.45).toFixed(2));
    const x_m = Number(((mapY - 5.4) / 1.45).toFixed(2));

    const targetPayload = {
      x_m,
      y_m,
      map_x_m: mapX,
      map_y_m: mapY,
    };

    const currentRoverPose = activeDroneSource?.navigation?.rover_pose;
    const originPayload = currentRoverPose
      ? { x_m: currentRoverPose.x_m, y_m: currentRoverPose.y_m }
      : { x_m: 0.0, y_m: 0.0 };

    await sendRouteRequest(targetPayload, originPayload, customUrls[mode]);
  };

  return (
    <div
      style={{
        padding: '18px 20px',
        fontFamily: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
        color: '#f3f4f6',
        maxWidth: '1360px',
        margin: '0 auto',
      }}
    >
      <TopographicMap2D
        dataset={terrainDataset}
        droneData={activeDroneSource as any}
        mode={mode}
        evaYaw={eva?.data?.imu?.yaw ?? 0}
        eva={eva?.data ?? null}
        risk={risk}
        utcTime={utcTime}
        isConnected={isConnected}
        customUrls={customUrls}
        onSwitchMode={handleSwitchMode}
        onChangeUrl={(newUrl) => setCustomUrls({ ...customUrls, [mode]: newUrl })}
        onApplyUrl={handleApplyUrl}
        onTargetSelect={handleTargetSelect}
      />
    </div>
  );
}
