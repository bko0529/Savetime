import { api, setTokenHooks } from '../api/client';
import { canSignup, gateTarget, type GateInput } from '../gate';
import { signupError, toSignupFormData, type SignupForm } from '../auth/signupForm';
import type { Me } from '../api/client';

const ok: SignupForm = {
  agencyCode: 'cn-sb-019',
  safetyCenter: '서북119안전센터',
  name: '김도윤',
  rank: '소방교',
  employeeNo: '2019-1234',
  loginId: 'kimdoyun',
  password: 'abcd1234',
  password2: 'abcd1234',
  photo: { uri: 'file:///id.jpg', name: 'id.jpg', type: 'image/jpeg', size: 1000 },
  photoConsent: true,
};

test.each<[Partial<SignupForm>, string]>([
  [{ agencyCode: ' ' }, '소속 소방서 코드를 적어 주세요'],
  [{ employeeNo: '' }, '이름 · 소속 안전센터 · 사번을 모두 적어 주세요'],
  [{ loginId: 'ab' }, '아이디는 영문 · 숫자 · . _ - 로 4~40자예요'],
  [{ loginId: '김도윤1' }, '아이디는 영문 · 숫자 · . _ - 로 4~40자예요'],
  [
    { password: 'abcdefgh', password2: 'abcdefgh' },
    '비밀번호는 8자 이상, 영문과 숫자를 섞어 주세요',
  ],
  [{ password2: 'abcd12345' }, '비밀번호 확인이 달라요'],
  [{ photo: null }, '공무원증 사진을 올려 주세요'],
  [{ photo: { ...ok.photo!, size: 6 * 1024 * 1024 } }, '사진은 5MB 이하만 올릴 수 있어요'],
  [{ photoConsent: false }, '공무원증 사진 수집 · 이용에 동의해야 신청할 수 있어요'],
])('가입 입력 검사 %o → %s', (patch, msg) =>
  expect(signupError({ ...ok, ...patch }, false)).toBe(msg),
);

test('서버와 같은 아이디 규칙: 대문자·. _ - 도 된다', () => {
  expect(signupError({ ...ok, loginId: 'Kim.Do_Yun-1' }, false)).toBeNull();
});

test('다시 신청할 때는 아이디·비밀번호를 검사하지 않는다', () => {
  expect(signupError({ ...ok, loginId: '', password: '', password2: '' }, true)).toBeNull();
});

// 테스트(Node)의 FormData 는 RN 과 달리 {uri,name,type} 파일을 글자로 바꿔 버려서, 넣은 값을 그대로 기억하는 가짜로 바꾼다
class FakeFormData {
  parts: [string, unknown][] = [];
  append(k: string, v: unknown) {
    this.parts.push([k, v]);
  }
}
const RealFormData = global.FormData;
beforeAll(() => {
  global.FormData = FakeFormData as unknown as typeof FormData;
});
afterAll(() => {
  global.FormData = RealFormData;
});
const fields = (fd: FormData) => Object.fromEntries((fd as unknown as FakeFormData).parts);

test('보내는 칸: 처음 신청은 아이디·비밀번호 포함, 소방서 코드는 대문자', () => {
  const f = fields(toSignupFormData(ok, true));
  expect(f).toMatchObject({
    agencyCode: 'CN-SB-019',
    loginId: 'kimdoyun',
    password: 'abcd1234',
    photoConsent: 'true',
  });
  expect(f.photo).toEqual(ok.photo);
  expect(f).not.toHaveProperty('password2');
});

test('다시 신청은 아이디·비밀번호를 보내지 않는다', () => {
  const f = fields(toSignupFormData(ok, false));
  expect(f).not.toHaveProperty('loginId');
  expect(f).not.toHaveProperty('password');
});

test('사진 요청(form)은 Content-Type 을 직접 붙이지 않는다 (fetch 가 경계값을 붙임)', async () => {
  const fetchMock = jest
    .fn()
    .mockResolvedValue({ ok: true, status: 204, headers: { get: () => null } });
  global.fetch = fetchMock as unknown as typeof fetch;
  setTokenHooks({ get: () => null, set: () => {}, lost: () => {} });
  const form = toSignupFormData(ok, true);
  await api('POST', '/auth/signup', { auth: false, form });
  expect(fetchMock.mock.calls[0][1].body).toBe(form);
  expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBeUndefined();
});

describe('화면 순서: 승인 대기·가입 신청', () => {
  const base: Omit<GateInput, 'auth'> = {
    appVersion: '1.0.0',
    minAppVersion: '1.0.0',
    consent: 'agreed',
    permissions: { location: 'granted', notify: 'granted' },
  };
  const signedIn = (status: Me['status']): GateInput => ({
    ...base,
    auth: { status: 'signedIn', me: { id: 1, status } },
  });

  test.each(['pending', 'rejected', 'suspended'] as const)('%s 이면 승인 대기 화면', (st) => {
    expect(gateTarget(signedIn(st))).toBe('pending');
  });
  test('가입 신청은 로그인 전과 반려됐을 때만', () => {
    expect(canSignup({ ...base, auth: { status: 'signedOut' } })).toBe(true);
    expect(canSignup(signedIn('rejected'))).toBe(true);
    expect(canSignup(signedIn('pending'))).toBe(false);
    expect(canSignup(signedIn('approved'))).toBe(false);
  });
});
