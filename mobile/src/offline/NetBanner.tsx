/**
 * 오프라인 표시 (SFR-064 · 081 ③) · 복구 알림 (SFR-068). 모든 화면 위쪽에.
 * 끊기면: '오프라인 — 저장된 정보입니다' + '이동 전 반드시 병원에 직접 전화로 확인하세요'
 * 복구되면: '최신 정보로 갱신되었습니다' 3초
 */
import { WifiOff } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Txt } from '../ui/kit';
import { color, font } from '../ui/theme';
import { useNet } from './net';

export function NetBanner() {
  const { online, recoveredAt } = useNet();
  const [showRecovered, setShowRecovered] = useState(false);
  useEffect(() => {
    if (!recoveredAt) return;
    setShowRecovered(true);
    const t = setTimeout(() => setShowRecovered(false), 3000);
    return () => clearTimeout(t);
  }, [recoveredAt]);

  if (online && !showRecovered) return null;
  return (
    <SafeAreaView
      edges={['top']}
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 60 }}
    >
      {!online ? (
        <View
          accessibilityRole="alert"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingHorizontal: 16,
            paddingVertical: 10,
            backgroundColor: color.primary,
          }}
        >
          <WifiOff size={18} color={color.primaryText} />
          <View style={{ flex: 1 }}>
            <Txt style={{ fontFamily: font.extrabold, fontSize: 14, color: color.primaryText }}>
              오프라인 — 저장된 정보입니다
            </Txt>
            <Txt
              style={{ fontFamily: font.semibold, fontSize: 12, color: 'rgba(251,250,247,0.85)' }}
            >
              이동 전 반드시 병원에 직접 전화로 확인하세요
            </Txt>
          </View>
        </View>
      ) : (
        <View
          accessibilityRole="alert"
          style={{ paddingHorizontal: 16, paddingVertical: 10, backgroundColor: color.success }}
        >
          <Txt
            style={{
              fontFamily: font.bold,
              fontSize: 14,
              color: color.accentText,
              textAlign: 'center',
            }}
          >
            최신 정보로 갱신되었습니다
          </Txt>
        </View>
      )}
    </SafeAreaView>
  );
}
