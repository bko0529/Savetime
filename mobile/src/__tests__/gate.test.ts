import { gateTarget, type GateInput } from '../gate';
import { versionBelow } from '../state/config';

const ready: GateInput = {
  appVersion: '1.0.0',
  minAppVersion: '1.0.0',
  consent: 'agreed',
  permissions: { location: 'granted', notify: 'granted' },
  auth: { status: 'signedIn', me: { id: 1, status: 'approved' } },
  duty: { team: 'joined', started: true },
};
const go = (patch: Partial<GateInput>) => gateTarget({ ...ready, ...patch });

test('모두 준비되면 홈', () => expect(go({})).toBe('home'));

test('순서: 업데이트 → 동의 → 권한 → 로그인', () => {
  const all: Partial<GateInput> = {
    minAppVersion: '2.0.0',
    consent: 'unknown',
    permissions: { location: 'unknown', notify: 'unknown' },
    auth: { status: 'signedOut' },
  };
  expect(go(all)).toBe('update');
  expect(go({ ...all, minAppVersion: '1.0.0' })).toBe('welcome');
  expect(go({ ...all, minAppVersion: '1.0.0', consent: 'agreed' })).toBe('permissions');
  expect(go({ auth: { status: 'signedOut' } })).toBe('login');
});

test('동의 안 함이면 동의 화면에 머문다', () => expect(go({ consent: 'refused' })).toBe('welcome'));

test('위치를 거부하면 권한 화면, 알림 거부는 넘어간다', () => {
  expect(go({ permissions: { location: 'denied', notify: 'granted' } })).toBe('permissions');
  expect(go({ permissions: { location: 'granted', notify: 'denied' } })).toBe('home');
  expect(go({ permissions: { location: 'granted', notify: 'unknown' } })).toBe('permissions');
});

test('확인 중인 값이 있으면 빈 화면(loading)', () => {
  expect(go({ consent: 'loading' })).toBe('loading');
  expect(go({ permissions: { location: 'loading', notify: 'loading' } })).toBe('loading');
  expect(go({ auth: { status: 'loading' } })).toBe('loading');
});

test('업데이트는 로그인·동의보다 먼저 막는다', () => {
  expect(go({ minAppVersion: '1.0.1', consent: 'loading', auth: { status: 'loading' } })).toBe(
    'update',
  );
});

test.each([
  ['1.0.0', '1.0.0', false],
  ['1.0.0', '1.0.1', true],
  ['1.9.0', '1.10.0', true], // 글자 비교면 틀리는 경우
  ['2.0.0', '1.99.99', false],
  ['1.0', '1.0.0', false],
])('versionBelow(%s, %s) = %s', (a, b, want) => expect(versionBelow(a, b)).toBe(want));
