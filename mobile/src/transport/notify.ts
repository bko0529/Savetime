/**
 * 대원 알림 (SFR-130): 진동 + 소리 + 알림 배너.
 * 앱이 켜져 있으면 휴대폰 알림(expo-notifications 로컬 알림)으로 소리·배너를 내고, 진동도 같이 준다.
 * iPhone 무음 모드면 휴대폰 설정에 따라 소리 없이 진동만 (권한 화면에서 안내함).
 * 앱이 꺼져 있거나 백그라운드일 때의 푸시(FCM)는 9단계에서 서버 푸시로 붙인다.
 */
import * as Notifications from 'expo-notifications';
import { Vibration } from 'react-native';

export type AlertKind = 'approval' | 'warning' | 'danger' | 'info';

const PATTERN: Record<AlertKind, number[]> = {
  approval: [0, 300],
  warning: [0, 300, 120, 300],
  danger: [0, 400, 120, 400, 120, 400],
  info: [0, 200],
};

let handlerSet = false;
function ensureHandler() {
  if (handlerSet) return;
  handlerSet = true;
  // 앱이 앞에 있어도 배너와 소리를 낸다 (기본은 앱이 앞에 있으면 조용함)
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export async function notifyTeam(kind: AlertKind, title: string, body?: string) {
  Vibration.vibrate(PATTERN[kind]);
  try {
    ensureHandler();
    // 알림 내용에는 병원 이름·시간 같은 안내만 (환자 정보 없음)
    await Notifications.scheduleNotificationAsync({
      content: { title, body: body ?? '', sound: true },
      trigger: null,
    });
  } catch {
    /* 알림 권한이 없으면 진동만 */
  }
}
