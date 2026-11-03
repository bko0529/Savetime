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

export async function askNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}
