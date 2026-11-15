import React, { useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StatusBar, Vibration } from 'react-native';
import {
  connectBackbone,
  evaluateRisk,
  setBackboneUrl,
  useBackbone,
} from '@martian/shared';
import { tacticalStyles as styles } from './src/styles/tacticalStyles';
import { TopographicMapIpad } from './src/components/TopographicMapIpad';
import { CONNECTION_MODES, OperationMode } from './src/utils/ipadMapEngine';

export default function App() {
  const { isConnected, getEva, getDrone } = useBackbone();

  const [mode, setMode] = useState<OperationMode>('local_esp');
  const [customUrls, setCustomUrls] = useState<Record<OperationMode, string>>({
    local_esp: CONNECTION_MODES.local_esp.defaultWsUrl,
    online_raspi: CONNECTION_MODES.online_raspi.defaultWsUrl,
  });
  const [utcTime, setUtcTime] = useState<string>('');

  useEffect(() => {
    connectBackbone(customUrls[mode]);
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
  const evaData = eva?.data ?? null;
  const droneData = drone?.data ?? null;
  const risk = evaluateRisk(evaData ?? undefined, droneData ?? undefined);

  useEffect(() => {
    if (risk.level === 'red') {
      Vibration.vibrate([0, 200, 100, 200]);
    } else if (risk.level === 'yellow') {
      Vibration.vibrate(120);
    }
  }, [risk.level]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <TopographicMapIpad
          droneData={droneData}
          evaData={evaData}
          risk={risk}
          mode={mode}
          utcTime={utcTime}
          isConnected={isConnected}
          customUrls={customUrls}
          onSwitchMode={handleSwitchMode}
          onChangeUrl={(newUrl) => setCustomUrls({ ...customUrls, [mode]: newUrl })}
          onApplyUrl={handleApplyUrl}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
