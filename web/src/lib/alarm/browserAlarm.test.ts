import { afterEach, describe, expect, it, vi } from 'vitest';
import { notificationPermission, showRequestNotification } from './browserAlarm';

// jsdom 에는 Notification 이 없어서 권한만 바꿀 수 있는 가짜를 둔다
function stubNotification(permission: NotificationPermission) {
  const created: { title: string; options?: NotificationOptions }[] = [];
  const Fake = vi.fn(function (this: unknown, title: string, options?: NotificationOptions) {
    created.push({ title, options });
  }) as unknown as typeof Notification;
  Object.defineProperty(Fake, 'permission', { value: permission });
  vi.stubGlobal('Notification', Fake);
  return created;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('브라우저 알림 (SFR-117·136)', () => {
  it('권한이 거부됐으면 브라우저 알림을 만들지 않는다', () => {
    const created = stubNotification('denied');
    showRequestNotification(101, 'R-101');
    expect(created).toHaveLength(0);
    expect(notificationPermission()).toBe('denied');
  });

  it('허용됐으면 요청 번호만 넣어 알림을 만든다 (환자 정보 없음)', () => {
    const created = stubNotification('granted');
    showRequestNotification(101, 'R-101');
    expect(created).toEqual([
      { title: '🔴 새 이송 요청', options: { body: 'R-101', tag: 'request-101' } },
    ]);
  });

  it('알림을 지원하지 않는 브라우저는 unsupported', () => {
    expect(notificationPermission()).toBe('unsupported');
  });
});
