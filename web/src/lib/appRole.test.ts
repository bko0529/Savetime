import { describe, expect, it } from 'vitest';
import { decideRoute, homePath, parseAppRole } from './appRole';

describe('parseAppRole', () => {
  it('admin일 때만 관리자', () => {
    expect(parseAppRole('admin')).toBe('admin');
  });

  it('비었거나 다른 값이면 병원 (관리자 화면이 실수로 열리지 않게)', () => {
    expect(parseAppRole(undefined)).toBe('hospital');
    expect(parseAppRole('')).toBe('hospital');
    expect(parseAppRole('ADMIN')).toBe('hospital');
    expect(parseAppRole('hospital')).toBe('hospital');
  });
});

describe('decideRoute', () => {
  it('첫 화면(/)은 켜진 쪽으로 보낸다', () => {
    expect(decideRoute('hospital', '/')).toEqual({ type: 'redirect', to: '/hospital' });
    expect(decideRoute('admin', '/')).toEqual({ type: 'redirect', to: '/admin' });
    expect(homePath('admin')).toBe('/admin');
  });

  it('병원 서버에서는 /admin 아래가 모두 404', () => {
    expect(decideRoute('hospital', '/admin')).toEqual({ type: 'notFound' });
    expect(decideRoute('hospital', '/admin/hospitals')).toEqual({ type: 'notFound' });
    expect(decideRoute('hospital', '/hospital')).toEqual({ type: 'allow' });
    expect(decideRoute('hospital', '/hospital/requests/1')).toEqual({ type: 'allow' });
  });

  it('관리자 서버에서는 /hospital 아래가 모두 404', () => {
    expect(decideRoute('admin', '/hospital')).toEqual({ type: 'notFound' });
    expect(decideRoute('admin', '/hospital/requests/1')).toEqual({ type: 'notFound' });
    expect(decideRoute('admin', '/admin')).toEqual({ type: 'allow' });
  });

  it('이름만 비슷한 경로는 막지 않는다', () => {
    expect(decideRoute('hospital', '/administrator')).toEqual({ type: 'allow' });
    expect(decideRoute('admin', '/hospitals')).toEqual({ type: 'allow' });
  });
});
