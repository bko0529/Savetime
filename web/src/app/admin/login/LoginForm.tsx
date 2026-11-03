'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { useAdminAuth, type Tokens } from '../AdminAuth';

type LoginBody =
  ApiPaths['/admin/auth/login']['post']['requestBody']['content']['application/json'];
type EnrollBody =
  ApiPaths['/admin/auth/otp/enroll']['post']['requestBody']['content']['application/json'];

// 첫 로그인 때 서버가 주는 OTP 연결 정보 (OTP_SETUP_REQUIRED 의 details)
type OtpSetup = { setupToken: string; secret: string };

const OTP_PATTERN = /^\d{6}$/;

const inputClass =
  'h-14 rounded-lg border-2 border-input px-4 text-xl outline-none focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/40';

// otpauth://totp/세이브타임:admin?secret=ABCD...&issuer=... 에서 OTP 앱에 직접 입력할 키만 꺼낸다.
// QR 라이브러리 없이 키를 글자로 보여주기로 했다 (관리자는 몇 명뿐이라 한 번만 입력하면 됨).
export function otpSecret(otpauthUrl: string): string | null {
  try {
    return new URL(otpauthUrl).searchParams.get('secret');
  } catch {
    return null;
  }
}

// 읽기 쉽게 4글자씩 띄운다 (OTP 앱은 띄어쓰기를 무시함)
export function groupSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

function toSetup(error: unknown): OtpSetup | null {
  if (!(error instanceof ApiError) || error.code !== 'OTP_SETUP_REQUIRED') return null;
  const setupToken = error.details?.setupToken;
  const otpauthUrl = error.details?.otpauthUrl;
  if (typeof setupToken !== 'string' || typeof otpauthUrl !== 'string') return null;
  const secret = otpSecret(otpauthUrl);
  return secret ? { setupToken, secret } : null;
}

// 관리자 로그인 (SFR-082, SFR-152, A-01). 가입 메뉴는 없고, 계정은 초기 데이터로만 만든다.
export function LoginForm() {
  const router = useRouter();
  const { signIn } = useAdminAuth();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [setup, setSetup] = useState<OtpSetup | null>(null);
  const [enrollOtp, setEnrollOtp] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  function finish(tokens: Tokens) {
    signIn(tokens);
    router.replace('/admin');
  }

  const login = useMutation({
    mutationFn: (body: LoginBody) =>
      apiFetch<Tokens>('/admin/auth/login', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: finish,
    onError: (error) => {
      const next = toSetup(error);
      if (next) {
        setSetup(next);
        setEnrollOtp('');
      }
    },
  });

  const enroll = useMutation({
    mutationFn: (body: EnrollBody) =>
      apiFetch<Tokens>('/admin/auth/otp/enroll', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: finish,
    onError: (error) => {
      // 연결 정보는 5분만 유효하다. 지나면 처음(비밀번호 입력)부터 다시
      if (error instanceof ApiError && error.code === 'TOKEN_EXPIRED') {
        setSetup(null);
        setPassword('');
        setOtp('');
        login.reset();
        setNotice('OTP 연결 시간(5분)이 지났어요. 처음부터 다시 로그인해 주세요.');
      }
    },
  });

  // OTP 는 처음 로그인(아직 앱 연결 전)이면 비워도 되고, 넣었다면 6자리 숫자여야 한다
  const canLogin =
    loginId.trim() !== '' &&
    password !== '' &&
    (otp === '' || OTP_PATTERN.test(otp)) &&
    !login.isPending;

  function submitLogin(e: FormEvent) {
    e.preventDefault();
    if (!canLogin) return;
    setNotice(null);
    login.mutate({ loginId: loginId.trim(), password, ...(otp ? { otp } : {}) });
  }

  function submitEnroll(e: FormEvent) {
    e.preventDefault();
    if (!setup || !OTP_PATTERN.test(enrollOtp) || enroll.isPending) return;
    enroll.mutate({ setupToken: setup.setupToken, otp: enrollOtp });
  }

  if (setup) {
    return (
      <form onSubmit={submitEnroll} className="flex w-full max-w-xl flex-col gap-6" noValidate>
        <h2 className="text-2xl font-bold">OTP 앱 연결 (처음 한 번)</h2>
        <ol className="list-decimal space-y-2 pl-6 text-lg">
          <li>휴대폰 OTP 앱(Google Authenticator 등)에서 &lsquo;설정 키 입력&rsquo;을 골라요.</li>
          <li>아래 키를 입력해요. 키 종류는 &lsquo;시간 기준&rsquo;이에요.</li>
          <li>앱에 뜬 6자리 숫자를 입력해요. 5분 안에 끝내야 해요.</li>
        </ol>
        <p
          data-testid="otp-secret"
          className="rounded-lg border-2 border-foreground bg-muted p-4 text-center font-mono text-2xl font-bold tracking-wider break-all select-all"
        >
          {groupSecret(setup.secret)}
        </p>
        <label className="flex flex-col gap-2">
          <span className="text-xl font-bold">앱에 뜬 6자리</span>
          <input
            className={inputClass}
            value={enrollOtp}
            onChange={(e) => setEnrollOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
          />
        </label>
        {enroll.isError && (
          <p role="alert" className="text-lg font-bold text-destructive">
            {errorText(enroll.error)}
          </p>
        )}
        <Button type="submit" size="lg" disabled={!OTP_PATTERN.test(enrollOtp) || enroll.isPending}>
          {enroll.isPending ? '확인 중…' : '연결하고 로그인'}
        </Button>
      </form>
    );
  }

  const loginError = login.isError && !toSetup(login.error) ? errorText(login.error) : null;

  return (
    <form onSubmit={submitLogin} className="flex w-full max-w-xl flex-col gap-6" noValidate>
      <label className="flex flex-col gap-2">
        <span className="text-xl font-bold">아이디</span>
        <input
          className={inputClass}
          value={loginId}
          onChange={(e) => setLoginId(e.target.value)}
          autoComplete="username"
          autoFocus
        />
      </label>
      <label className="flex flex-col gap-2">
        <span className="text-xl font-bold">비밀번호</span>
        <input
          className={inputClass}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </label>
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-2">
          <span className="text-xl font-bold">OTP 6자리</span>
          <input
            className={inputClass}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-describedby="otp-hint"
          />
        </label>
        <span id="otp-hint" className="text-base text-muted-foreground">
          처음 로그인해서 아직 OTP 앱을 연결하지 않았다면 비워 두세요.
        </span>
      </div>
      {(notice ?? loginError) && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {notice ?? loginError}
        </p>
      )}
      <Button type="submit" size="lg" disabled={!canLogin}>
        {login.isPending ? '로그인 중…' : '로그인'}
      </Button>
    </form>
  );
}
