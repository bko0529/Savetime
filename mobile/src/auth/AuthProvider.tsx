/**
 * 로그인 상태를 앱 전체에 알려 준다 (SFR-018).
 * - loading: 앱을 막 열어 저장된 refresh 토큰을 확인하는 중
 * - signedOut: 로그인 화면
 * - signedIn: 서버가 준 내 정보(me). me.status 로 승인 대기·반려 화면을 고른다 (SFR-022·083)
 *
 * 자동 로그인·앱 잠금은 없다(D-110). 근무 동안만 refresh 토큰이 살아 있고, 근무가 끝나면 서버가 폐기한다.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api, refreshTokens, setTokenHooks, type Me, type Tokens } from '../api/client';
import { toSignupFormData, type SignupForm } from './signupForm';
import { clearRefreshToken, getDeviceId, loadRefreshToken, saveRefreshToken } from './storage';

type State =
  { status: 'loading' } | { status: 'signedOut'; notice?: string } | { status: 'signedIn'; me: Me };

type AuthValue = {
  state: State;
  /** 성공하면 null, 실패하면 화면에 보여 줄 문구 */
  login: (loginId: string, password: string) => Promise<string | null>;
  /** 가입 신청(SFR-017) · 반려 후 다시 신청(SFR-083). 성공하면 null */
  signup: (f: SignupForm) => Promise<string | null>;
  /** 서버에서 내 정보를 다시 받는다 (승인 결과 확인) */
  refreshMe: () => Promise<void>;
  /** 서버 로그아웃 + 이 기기 토큰 지우기 */
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

// 토큰은 React 상태가 아니라 모듈 변수에 둔다: 화면을 다시 그리지 않아도 되고, api() 가 바로 꺼내 쓸 수 있다
let tokens: Tokens | null = null;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  const signOutLocal = useCallback(async (notice?: string) => {
    tokens = null;
    await clearRefreshToken();
    setState({ status: 'signedOut', notice });
  }, []);

  // api.ts 에 토큰 꺼내기·저장·잃어버림 처리를 연결
  useEffect(() => {
    setTokenHooks({
      get: () => tokens,
      set: async (t) => {
        tokens = t;
        if (t.refreshToken) await saveRefreshToken(t.refreshToken);
      },
      lost: () => void signOutLocal('근무가 끝나 다시 로그인해야 해요'),
    });
  }, [signOutLocal]);

  // 앱을 열 때: 근무 중(refresh 토큰이 살아 있음)이면 로그인을 묻지 않는다
  useEffect(() => {
    (async () => {
      const saved = await loadRefreshToken();
      if (!saved) return setState({ status: 'signedOut' });
      tokens = { refreshToken: saved };
      if (!(await refreshTokens())) return signOutLocal();
      try {
        setState({ status: 'signedIn', me: await api<Me>('GET', '/me') });
      } catch {
        await signOutLocal();
      }
    })();
  }, [signOutLocal]);

  const login = useCallback(async (loginId: string, password: string) => {
    try {
      const r = await api<{ tokens: Tokens; me: Me }>('POST', '/auth/login', {
        auth: false,
        body: { loginId: loginId.trim(), password, deviceId: await getDeviceId() },
      });
      tokens = r.tokens;
      if (r.tokens.refreshToken) await saveRefreshToken(r.tokens.refreshToken);
      setState({ status: 'signedIn', me: r.me });
      return null;
    } catch (e) {
      // 서버 문구를 그대로 보여 준다 (5번 틀림 → 10분 잠금 안내도 서버가 만든다)
      return e instanceof Error ? e.message : '잠시 후 다시 시도해 주세요';
    }
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const me = await api<Me>('GET', '/me');
      setState({ status: 'signedIn', me });
    } catch {
      /* 오프라인이면 지금 화면 그대로 (토큰이 끝났으면 lost() 가 로그인 화면으로 보냄) */
    }
  }, []);

  const signup = useCallback(
    async (f: SignupForm) => {
      const reapply = state.status === 'signedIn' && state.me.status === 'rejected';
      try {
        if (reapply) {
          // 반려된 뒤 다시 신청: 같은 계정이라 아이디·비밀번호 없이 내용·사진만 새로 (PUT /me/signup)
          const me = await api<Me>('PUT', '/me/signup', { form: toSignupFormData(f, false) });
          setState({ status: 'signedIn', me });
          return null;
        }
        await api('POST', '/auth/signup', { auth: false, form: toSignupFormData(f, true) });
        // 통과하면 같은 아이디로 로그인 → me.status = pending → 승인 대기 화면
        return await login(f.loginId, f.password);
      } catch (e) {
        return e instanceof ApiError ? e.message : '가입 신청을 보내지 못했어요';
      }
    },
    [state, login],
  );

  const logout = useCallback(async () => {
    // 승인 전 계정은 팀이 없어 확인 없이 끝난다. 근무 중 로그아웃(진행 중 이송 확인)은 8단계 설정 화면에서
    await api('POST', '/auth/logout').catch(() => undefined);
    await signOutLocal();
  }, [signOutLocal]);

  const value = useMemo(
    () => ({ state, login, signup, refreshMe, logout }),
    [state, login, signup, refreshMe, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth 는 AuthProvider 안에서만 쓸 수 있어요');
  return v;
}
