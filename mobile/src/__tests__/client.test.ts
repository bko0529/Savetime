import { api, ApiError, serverNow, setTokenHooks, type Tokens } from '../api/client';

type FakeRes = { status: number; body?: unknown; headers?: Record<string, string> };
const res = ({ status, body, headers = {} }: FakeRes) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body,
  }) as unknown as Response;

let tokens: Tokens | null;
let lost: jest.Mock;
const fetchMock = jest.fn();

beforeEach(() => {
  tokens = { accessToken: 'old-access', refreshToken: 'old-refresh' };
  lost = jest.fn();
  setTokenHooks({ get: () => tokens, set: (t) => void (tokens = t), lost });
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

test('access 토큰을 Bearer 로 붙인다', async () => {
  fetchMock.mockResolvedValueOnce(res({ status: 200, body: { id: 1 } }));
  await api('GET', '/me');
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer old-access');
});

test('401 이면 refresh 를 한 번 하고 새 토큰으로 다시 보낸다', async () => {
  fetchMock
    .mockResolvedValueOnce(
      res({ status: 401, body: { error: { code: 'TOKEN_EXPIRED', message: '만료' } } }),
    )
    .mockResolvedValueOnce(
      res({ status: 200, body: { accessToken: 'new-access', refreshToken: 'new-refresh' } }),
    )
    .mockResolvedValueOnce(res({ status: 200, body: { id: 1 } }));
  await expect(api('GET', '/me')).resolves.toEqual({ id: 1 });
  expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/v1\/auth\/refresh$/);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ refreshToken: 'old-refresh' });
  expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer new-access');
  expect(lost).not.toHaveBeenCalled();
});

test('동시에 두 요청이 401 을 받아도 refresh 는 한 번만 보낸다', async () => {
  let refreshCalls = 0;
  fetchMock.mockImplementation(async (url: string, init: { headers: Record<string, string> }) => {
    if (url.endsWith('/auth/refresh')) {
      refreshCalls++;
      return res({ status: 200, body: { accessToken: 'new-access', refreshToken: 'new-refresh' } });
    }
    return init.headers.Authorization === 'Bearer new-access'
      ? res({ status: 200, body: {} })
      : res({ status: 401 });
  });
  await Promise.all([api('GET', '/me'), api('GET', '/config')]);
  expect(refreshCalls).toBe(1);
});

test('refresh 도 실패하면 lost() 를 부르고 서버 오류를 던진다', async () => {
  fetchMock
    .mockResolvedValueOnce(
      res({ status: 401, body: { error: { code: 'TOKEN_REVOKED', message: '근무가 끝났어요' } } }),
    )
    .mockResolvedValueOnce(res({ status: 401 }));
  await expect(api('GET', '/me')).rejects.toMatchObject({
    code: 'TOKEN_REVOKED',
    message: '근무가 끝났어요',
  });
  expect(lost).toHaveBeenCalledTimes(1);
});

test('로그인(auth: false)은 401 이어도 refresh 하지 않는다', async () => {
  fetchMock.mockResolvedValueOnce(
    res({
      status: 401,
      body: {
        error: { code: 'INVALID_CREDENTIALS', message: '아이디 또는 비밀번호가 맞지 않아요' },
      },
    }),
  );
  await expect(api('POST', '/auth/login', { auth: false, body: {} })).rejects.toBeInstanceOf(
    ApiError,
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
});

test('네트워크가 끊기면 NETWORK 오류', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
  await expect(api('GET', '/me')).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
});

test('X-Server-Now 로 서버 시각을 맞춘다', async () => {
  const server = new Date(Date.now() + 60_000).toISOString(); // 휴대폰이 1분 느림
  fetchMock.mockResolvedValueOnce(res({ status: 204, headers: { 'X-Server-Now': server } }));
  await api('POST', '/x');
  expect(Math.abs(serverNow() - Date.parse(server))).toBeLessThan(1000);
});
