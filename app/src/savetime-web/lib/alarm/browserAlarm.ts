// 브라우저는 사람이 버튼을 누르기 전에는 소리를 못 내게 막는다.
// 그래서 '알림 켜기'를 누르는 순간에 소리 장치를 깨워 두고, 브라우저 알림 권한도 같이 묻는다 (SFR-117).

let audioContext: AudioContext | null = null;

export async function unlockSound(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return false;
  try {
    audioContext ??= new window.AudioContext();
    await audioContext.resume();
    return audioContext.state === 'running';
  } catch {
    return false;
  }
}

export function soundContext(): AudioContext | null {
  return audioContext;
}

// 알림음: 소리 파일 없이 '삐' 소리를 만들어 1.5초마다 반복한다.
// 대기 요청이 여러 건이어도 반복은 하나만 돈다 — 이미 돌고 있으면 새로 시작하지 않는다 (SFR-117, D-76)
export const BEEP_EVERY_MS = 1500;
let loopTimer: ReturnType<typeof setInterval> | null = null;

function beep(ctx: AudioContext) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  gain.gain.value = 0.3;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.3);
}

export function startAlarmLoop(): void {
  if (loopTimer !== null || !audioContext) return;
  const ctx = audioContext;
  beep(ctx);
  loopTimer = setInterval(() => beep(ctx), BEEP_EVERY_MS);
}

export function stopAlarmLoop(): void {
  if (loopTimer === null) return;
  clearInterval(loopTimer);
  loopTimer = null;
}

// 브라우저 알림은 요청마다 1번. 잠금 화면에도 뜰 수 있어서 환자 정보 없이 요청 번호만 넣는다 (SER-014)
export function showRequestNotification(requestId: number, label: string): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification('🔴 새 이송 요청', { body: label, tag: `request-${requestId}` });
  } catch {
    // 일부 브라우저는 페이지에서 직접 알림을 못 만든다. 소리·탭 제목·덮개 창이 있으니 넘어간다
  }
}

export async function askNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export type PermissionState = NotificationPermission | 'unsupported';

// 지금 브라우저 알림 권한 (묻지 않고 읽기만). 직원이 브라우저 설정에서 바꾸고 돌아올 수 있어서 수시로 다시 읽는다 (SFR-136)
export function notificationPermission(): PermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}
