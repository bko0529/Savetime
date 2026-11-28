/**
 * 이동 중 백그라운드 위치 기록 (SFR-079 · COR-014).
 * 화면이 꺼지거나 다른 앱으로 가도 OS 가 위치를 계속 넘겨준다 (setInterval 은 iOS 가 멈춰서 안 됨).
 * - iOS: '앱 사용 중' 권한 + 백그라운드 위치 업데이트 → 화면 맨 위에 위치 사용 표시
 * - Android: 포그라운드 서비스 → '이송 중 · 위치 기록 중' 상단 알림
 * - 둘 다 '항상 허용' 권한은 묻지 않는다. 이송이 끝나면 멈춘다
 *
 * 작업(task)은 앱이 켜질 때 한 번 정의해야 해서(OS 가 이 이름으로 부름) 이 파일을 _layout 에서 먼저 불러온다.
 */
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { Fix } from './location';

export const LOCATION_TASK = 'savetime-transport-location';

type Listener = (fixes: Fix[]) => void;
let listener: Listener | null = null;
/** 엔진이 받을 준비가 되기 전에 온 위치 (앱이 백그라운드에서 다시 켜진 직후 등) */
let pending: Fix[] = [];

/** 엔진이 위치를 받는다. 기다리던 위치가 있으면 바로 넘긴다 */
export function onBackgroundFixes(fn: Listener | null) {
  listener = fn;
  if (fn && pending.length) {
    const p = pending;
    pending = [];
    fn(p);
  }
}

export const toFix = (p: Location.LocationObject): Fix => ({
  lat: p.coords.latitude,
  lng: p.coords.longitude,
  accuracyM: p.coords.accuracy ?? null,
  // 휴대폰은 m/s 로 주고, 모르면 음수·null
  speedKmh: p.coords.speed !== null && p.coords.speed >= 0 ? p.coords.speed * 3.6 : null,
  at: p.timestamp,
});

/** OS 가 위치를 넘겨줄 때 부르는 곳 (테스트에서도 직접 부른다) */
export function handleTaskLocations(data: unknown) {
  const locations = (data as { locations?: Location.LocationObject[] } | null)?.locations ?? [];
  if (!locations.length) return;
  const fixes = locations.map(toFix);
  if (listener) listener(fixes);
  else pending = [...pending, ...fixes].slice(-120); // 10분치(5초 간격)까지만 기다린다
}

if (!TaskManager.isTaskDefined(LOCATION_TASK)) {
  TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
    if (error) return;
    handleTaskLocations(data);
  });
}

/** 이동 중 위치 기록 시작. '앱 사용 중' 권한이 없으면 시작하지 않는다 (false) */
export async function startBackgroundLocation(): Promise<boolean> {
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted) return false;
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return true;
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 5000,
      distanceInterval: 10,
      activityType: Location.ActivityType.AutomotiveNavigation,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: '이송 중 · 위치 기록 중',
        notificationBody: '병원 도착 예상 시간을 계산하려고 위치를 기록해요. 이송이 끝나면 멈춰요',
        killServiceOnDestroy: false,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** 이송이 끝나면 멈춘다 (표시·알림도 사라짐) */
export async function stopBackgroundLocation() {
  pending = [];
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK))
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    /* 이미 멈춤 */
  }
}
