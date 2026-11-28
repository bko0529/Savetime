/**
 * 서버 설정 GET /config (로그인 없이). 앱이 켜질 때와 1분마다 읽는다.
 * - minAppVersion: 이보다 낮은 앱은 업데이트 화면에서 멈춤 (SFR-142)
 * - featureFlags: 꺼진 기능 버튼 숨기기 (QUR-013)
 * 서버에 못 닿으면 지난 값을 그대로 쓴다 (오프라인이어도 앱은 계속 씀)
 */
import Constants from 'expo-constants';
import { api } from '../api/client';
import { createStore } from './store';

export const APP_VERSION: string = Constants.expoConfig?.version ?? '0.0.0';

export const configStore = createStore({
  minAppVersion: '0.0.0',
  featureFlags: { journalAi: false, hospitalGrade: false },
});

export async function loadConfig() {
  try {
    const c = await api<{
      minAppVersion?: string;
      featureFlags?: { journalAi?: boolean; hospitalGrade?: boolean };
    }>('GET', '/config', { auth: false });
    configStore.set({
      minAppVersion: c.minAppVersion ?? '0.0.0',
      featureFlags: {
        journalAi: !!c.featureFlags?.journalAi,
        hospitalGrade: !!c.featureFlags?.hospitalGrade,
      },
    });
  } catch {
    /* 오프라인이면 지난 값 그대로 */
  }
}

/** '1.2.3' 이 '1.10.0' 보다 낮은지 (숫자 3개, 칸마다 숫자로 비교) */
export function versionBelow(app: string, min: string) {
  const a = app.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}
