import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { ReactElement } from 'react';

// 테스트마다 새 캐시를 쓰고, 실패해도 다시 시도하지 않게 해서 결과가 바로 보이게 한다
export function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// fetch 를 가짜로 바꾼다. 응답을 순서대로 하나씩 돌려준다
export function mockFetch(...responses: { status: number; body?: unknown }[]) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 호출 인자를 테스트에서 확인하려고 받기만 한다
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('예상보다 fetch 를 많이 불렀어요');
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

type Reply = { status: number; body?: unknown };

// 주소별로 답하는 가짜 서버. 화면이 몇 번 부를지 순서를 몰라도 되게 한다.
// 키는 'GET /hw/session' 처럼 '메서드 경로'. 답을 여러 개 주면 차례로 쓰고 마지막 답은 계속 반복한다
export function fakeServer(routes: Record<string, Reply | Reply[]>) {
  const queues = new Map<string, Reply[]>();
  const set = (key: string, reply: Reply | Reply[]) =>
    queues.set(key, Array.isArray(reply) ? [...reply] : [reply]);
  Object.entries(routes).forEach(([key, reply]) => set(key, reply));

  const calls: { key: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.replace(/^\/api\/v1/, '')}`;
    calls.push({ key, body: init?.body ? JSON.parse(init.body as string) : null });
    const queue = queues.get(key);
    if (!queue) throw new Error(`가짜 서버에 없는 주소예요: ${key}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);

  return {
    set,
    callsTo: (key: string) => calls.filter((c) => c.key === key),
  };
}

export function apiError(code: string, details?: unknown) {
  return { error: { code, message: `${code} (서버 문구)`, details: details ?? null } };
}
