import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockFetch, renderWithQuery } from '@/testing/render';
import { AdminAuthProvider } from '../AdminAuth';
import { AdminHome } from '../AdminHome';
import { groupSecret, LoginForm, otpSecret } from './LoginForm';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

beforeEach(() => replace.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TOKENS = { accessToken: 'access-1', refreshToken: 'refresh-1' };
const SETUP = {
  setupToken: 'setup-1',
  otpauthUrl:
    'otpauth://totp/%EC%84%B8%EC%9D%B4%EB%B8%8C%ED%83%80%EC%9E%84:admin?secret=JBSWY3DPEHPK3PXP&issuer=savetime',
};

// 로그인 화면과 관리자 첫 화면을 같은 저장소(메모리) 안에 같이 띄운다
function renderAdmin() {
  return renderWithQuery(
    <AdminAuthProvider>
      <LoginForm />
      <AdminHome />
    </AdminAuthProvider>,
  );
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function sent(fetchFn: ReturnType<typeof mockFetch>, call = 0) {
  const [url, init = {}] = fetchFn.mock.calls[call];
  return { url, body: JSON.parse(init.body as string) };
}

describe('관리자 로그인', () => {
  it('로그인 전에는 관리자 화면이 안 보이고 로그인 화면으로 보낸다', () => {
    renderAdmin();
    expect(screen.queryByRole('heading', { name: '관리자' })).toBeNull();
    expect(replace).toHaveBeenCalledWith('/admin/login');
  });

  it('아이디·비밀번호·OTP 로 로그인하면 관리자 화면이 열리고, 로그아웃하면 다시 닫힌다', async () => {
    const fetchFn = mockFetch({ status: 200, body: TOKENS });
    renderAdmin();
    type('아이디', ' admin ');
    type('비밀번호', 'pw!');
    type('OTP 6자리', '12a3456');
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));

    expect(await screen.findByRole('heading', { name: '관리자' })).toBeDefined();
    expect(replace).toHaveBeenLastCalledWith('/admin');
    expect(sent(fetchFn)).toEqual({
      url: '/api/v1/admin/auth/login',
      body: { loginId: 'admin', password: 'pw!', otp: '123456' },
    });

    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(screen.queryByRole('heading', { name: '관리자' })).toBeNull();
    expect(replace).toHaveBeenLastCalledWith('/admin/login');
  });

  it('OTP 를 덜 입력하면 로그인 버튼이 안 눌린다 (비우면 눌림: 첫 로그인)', () => {
    renderAdmin();
    type('아이디', 'admin');
    type('비밀번호', 'pw');
    type('OTP 6자리', '123');
    expect(screen.getByRole('button', { name: '로그인' })).toHaveProperty('disabled', true);
    type('OTP 6자리', '');
    expect(screen.getByRole('button', { name: '로그인' })).toHaveProperty('disabled', false);
  });

  it.each([
    ['INVALID_CREDENTIALS', '아이디 또는 비밀번호가 맞지 않아요'],
    ['INVALID_OTP', 'OTP 코드가 맞지 않아요'],
    ['ACCOUNT_LOCKED', '10분 동안 로그인할 수 없어요'],
  ])('%s 이면 쉬운 문구', async (code, text) => {
    mockFetch({ status: 401, body: apiError(code) });
    renderAdmin();
    type('아이디', 'admin');
    type('비밀번호', 'pw');
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect((await screen.findByRole('alert')).textContent).toContain(text);
    expect(screen.queryByRole('heading', { name: '관리자' })).toBeNull();
  });

  it('첫 로그인이면 OTP 키를 보여주고, 앱 코드로 연결하면 바로 로그인된다', async () => {
    const fetchFn = mockFetch(
      { status: 403, body: apiError('OTP_SETUP_REQUIRED', SETUP) },
      { status: 200, body: TOKENS },
    );
    renderAdmin();
    type('아이디', 'admin');
    type('비밀번호', 'pw');
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));

    expect((await screen.findByTestId('otp-secret')).textContent).toBe('JBSW Y3DP EHPK 3PXP');
    expect(sent(fetchFn).body).toEqual({ loginId: 'admin', password: 'pw' });

    type('앱에 뜬 6자리', '654321');
    fireEvent.click(screen.getByRole('button', { name: '연결하고 로그인' }));

    expect(await screen.findByRole('heading', { name: '관리자' })).toBeDefined();
    expect(sent(fetchFn, 1)).toEqual({
      url: '/api/v1/admin/auth/otp/enroll',
      body: { setupToken: 'setup-1', otp: '654321' },
    });
  });

  it('연결 시간 5분이 지나면 처음 화면으로 돌아가 안내한다', async () => {
    mockFetch(
      { status: 403, body: apiError('OTP_SETUP_REQUIRED', SETUP) },
      { status: 401, body: apiError('TOKEN_EXPIRED') },
    );
    renderAdmin();
    type('아이디', 'admin');
    type('비밀번호', 'pw');
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    await screen.findByTestId('otp-secret');

    type('앱에 뜬 6자리', '654321');
    fireEvent.click(screen.getByRole('button', { name: '연결하고 로그인' }));

    expect((await screen.findByRole('alert')).textContent).toContain('5분)이 지났어요');
    expect(screen.queryByTestId('otp-secret')).toBeNull();
    expect((screen.getByLabelText('비밀번호') as HTMLInputElement).value).toBe('');
  });

  it('연결 코드가 틀리면 그 화면에서 다시 입력', async () => {
    mockFetch(
      { status: 403, body: apiError('OTP_SETUP_REQUIRED', SETUP) },
      { status: 401, body: apiError('INVALID_OTP') },
    );
    renderAdmin();
    type('아이디', 'admin');
    type('비밀번호', 'pw');
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    await screen.findByTestId('otp-secret');
    type('앱에 뜬 6자리', '000000');
    fireEvent.click(screen.getByRole('button', { name: '연결하고 로그인' }));
    expect((await screen.findByRole('alert')).textContent).toContain('OTP 코드가 맞지 않아요');
    expect(screen.getByTestId('otp-secret')).toBeDefined();
  });
});

describe('OTP 키 다루기', () => {
  it('otpauth 주소에서 키만 꺼낸다', () => {
    expect(otpSecret(SETUP.otpauthUrl)).toBe('JBSWY3DPEHPK3PXP');
    expect(otpSecret('잘못된 주소')).toBeNull();
  });

  it('4글자씩 띄운다', () => {
    expect(groupSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });
});
