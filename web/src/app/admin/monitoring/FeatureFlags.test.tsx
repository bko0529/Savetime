import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer } from '@/testing/render';
import { AdminAuthProvider, useAdminAuth } from '../AdminAuth';
import { FeatureFlags } from './FeatureFlags';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/admin/monitoring',
}));

function SignedIn({ children }: { children: ReactNode }) {
  const { signIn } = useAdminAuth();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    signIn({ accessToken: 'admin-token', refreshToken: 'r' });
    setReady(true);
  }, [signIn]);
  return ready ? children : null;
}

function renderFlags() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminAuthProvider>
        <SignedIn>
          <FeatureFlags />
        </SignedIn>
      </AdminAuthProvider>
    </QueryClientProvider>,
  );
}

const item = (name: string) => screen.getByRole('listitem', { name });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('관리자 기능 토글 (QUR-013)', () => {
  it('AI 일지 정리는 꺼짐, 병원 등급 선택은 켜짐으로 보인다', async () => {
    fakeServer({
      'GET /admin/feature-flags': { status: 200, body: { journalAi: false, hospitalGrade: true } },
    });
    renderFlags();
    await screen.findByRole('listitem', { name: 'AI 일지 정리' });
    expect(item('AI 일지 정리').textContent).toContain('꺼짐');
    expect(within(item('AI 일지 정리')).getByRole('button').textContent).toBe('켜기');
    expect(item('병원 등급 선택').textContent).toContain('켜짐');
    expect(within(item('병원 등급 선택')).getByRole('button').textContent).toBe('끄기');
  });

  it("'AI 일지 정리' 켜기를 누르면 그 기능만 보내고 화면이 '켜짐'으로 바뀐다", async () => {
    const server = fakeServer({
      'GET /admin/feature-flags': { status: 200, body: { journalAi: false, hospitalGrade: true } },
      'PUT /admin/feature-flags': { status: 200, body: { journalAi: true, hospitalGrade: true } },
    });
    renderFlags();
    await screen.findByRole('listitem', { name: 'AI 일지 정리' });
    fireEvent.click(within(item('AI 일지 정리')).getByRole('button', { name: '켜기' }));
    await within(item('AI 일지 정리')).findByRole('button', { name: '끄기' });
    expect(item('AI 일지 정리').textContent).toContain('켜짐');
    // 다른 관리자가 바꾼 병원 등급 값을 덮어쓰지 않게 누른 칸만 보낸다
    expect(server.callsTo('PUT /admin/feature-flags')[0].body).toEqual({ journalAi: true });
  });

  it('바꾸기에 실패하면 이유를 보여 주고 값은 그대로', async () => {
    fakeServer({
      'GET /admin/feature-flags': { status: 200, body: { journalAi: false, hospitalGrade: false } },
      'PUT /admin/feature-flags': { status: 400, body: apiError('VALIDATION_FAILED') },
    });
    renderFlags();
    await screen.findByRole('listitem', { name: 'AI 일지 정리' });
    fireEvent.click(within(item('AI 일지 정리')).getByRole('button', { name: '켜기' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(item('AI 일지 정리').textContent).toContain('꺼짐');
  });
});
