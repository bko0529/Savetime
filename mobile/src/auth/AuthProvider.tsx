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
import { api, refreshTokens, setTokenHooks, type Me, type Tokens } from '../api/client';
import { clearRefreshToken, getDeviceId, loadRefreshToken, saveRefreshToken } from './storage';

type State =
  { status: 'loading' } | { status: 'signedOut'; notice?: string } | { status: 'signedIn'; me: Me };

type AuthValue = {
  state: State;
  /** 성공하면 null, 실패하면 화면에 보여 줄 문구 */
  login: (loginId: string, password: string) => Promise<string | null>;
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

  const value = useMemo(() => ({ state, login }), [state, login]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth 는 AuthProvider 안에서만 쓸 수 있어요');
  return v;
}
