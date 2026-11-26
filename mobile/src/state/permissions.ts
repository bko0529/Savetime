/**
 * SFR-092 권한: 위치(필수) → 알림. 저장해 두지 않고 매번 휴대폰에 물어본다
 * (사용자가 설정 앱에서 바꿀 수 있으니 휴대폰이 진짜 값을 가지고 있음).
 *
 * - 위치: '앱 사용 중'만. 백그라운드 위치(항상 허용)는 여기서 묻지 않는다 (COR-014, 9단계)
 * - 전화: 앱은 tel: 로 전화 앱을 열기만 해서 권한이 필요 없다
 */
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { AppState, Linking } from 'react-native';
import { createStore, useStore } from './store';

export type Perm = 'loading' | 'unknown' | 'granted' | 'denied';

export const permissionStore = createStore<{
  location: Perm;
  notify: Perm;
  locationCanAsk: boolean;
}>({
  location: 'loading',
  notify: 'loading',
  /** 거부했어도 휴대폰이 권한 창을 다시 띄워 주는지 (Android 는 한 번 거부 후에도 다시 물을 수 있음) */
  locationCanAsk: true,
});

function toPerm(r: { status: string; granted: boolean }): Perm {
  if (r.granted) return 'granted';
  return r.status === 'undetermined' ? 'unknown' : 'denied';
}

export async function checkPermissions() {
  const [loc, noti] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Notifications.getPermissionsAsync(),
  ]);
  permissionStore.set({
    location: toPerm(loc),
    notify: toPerm(noti),
    locationCanAsk: loc.canAskAgain,
  });
}

export async function requestLocation() {
  const r = await Location.requestForegroundPermissionsAsync();
  permissionStore.set({ location: toPerm(r), locationCanAsk: r.canAskAgain });
}

export async function requestNotify() {
  permissionStore.set({ notify: toPerm(await Notifications.requestPermissionsAsync()) });
}

/** 위치를 거부했으면 휴대폰 설정 앱의 이 앱 화면을 연다 */
export const openSettings = () => Linking.openSettings();

/** 권한 단계가 끝났는지: 위치는 허용, 알림은 한 번 물어봤음(거부해도 진행) */
export function permissionsDone(p: { location: Perm; notify: Perm }) {
  return p.location === 'granted' && (p.notify === 'granted' || p.notify === 'denied');
}

/** 화면에서 쓰는 훅: 앱이 다시 앞으로 올 때(설정 앱에서 돌아올 때) 다시 확인 */
export function usePermissions() {
  useEffect(() => {
    void checkPermissions();
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') void checkPermissions();
    });
    return () => sub.remove();
  }, []);
  return useStore(permissionStore);
}
