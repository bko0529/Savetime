import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/lib/api/schema';
import { fakeServer } from '@/testing/render';
import { AdminAuthProvider, useAdminAuth } from '../AdminAuth';
import { durationText, HospitalStats } from './HospitalStats';

type HospitalStat = components['schemas']['HospitalStat'];

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

function renderStats() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminAuthProvider>
        <SignedIn>
          <HospitalStats />
        </SignedIn>
      </AdminAuthProvider>
    </QueryClientProvider>,
  );
}

const EMPTY_SOURCES = {
  hospitalWeb: {},
  paused: {},
  phoneCheck: {},
  approvalCancelled: {},
  unacceptable: {},
};
const stat = (id: number, name: string, extra: Partial<HospitalStat> = {}): HospitalStat => ({
  hospitalId: id,
  name,
  requests: 10,
  sampleTooSmall: false,
  responseRate: 0.8,
  avgResponseSec: 60,
  topRejectReason: null,
  approvalCancelRate: 0.25,
  unacceptableCount: 0,
  avgRequestToFirstApprovalSec: 40,
  avgRequestToDepartSec: 70,
  rejectSpike: false,
  rejectBySource: EMPTY_SOURCES,
  ...extra,
});
const reply = (days: number, ...hospitals: HospitalStat[]) => ({
  status: 200,
  body: { days, avgRequestToDepartSec: 70, hospitals },
});
const rowOf = (name: string) => screen.getByRole('row', { name });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('관리자 병원 응답 통계 (SFR-106)', () => {
  it("'최근 7일'로 열면 A병원 응답률 80%·평균 응답 60초가 보이고, 핵심 지표 '요청→출발'이 맨 위에 (인수 기준)", async () => {
    const server = fakeServer({ 'GET /admin/stats/hospitals?days=7': reply(7, stat(1, 'A병원')) });
    renderStats();
    await screen.findByRole('row', { name: 'A병원' });
    const a = rowOf('A병원');
    expect(a.textContent).toContain('80%');
    expect(a.textContent).toContain('1분');
    expect(a.textContent).toContain('25%');
    expect(screen.getByText(/평균 요청 → 출발/).textContent).toContain('1분 10초');
    expect(screen.getByRole('button', { name: '최근 7일' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(server.callsTo('GET /admin/stats/hospitals?days=7')).toHaveLength(1);
  });

  it("C병원 요청 6건이면 수치 없이 '표본 부족' (인수 기준)", async () => {
    fakeServer({
      'GET /admin/stats/hospitals?days=7': reply(
        7,
        stat(3, 'C병원', { requests: 6, sampleTooSmall: true, responseRate: null }),
      ),
    });
    renderStats();
    const c = await screen.findByRole('row', { name: 'C병원' });
    expect(c.textContent).toContain('표본 부족');
    expect(c.textContent).not.toContain('%');
  });

  it('D병원처럼 거절률이 급증하면 강조 표시 (인수 기준)', async () => {
    fakeServer({
      'GET /admin/stats/hospitals?days=7': reply(
        7,
        stat(4, 'D병원', { rejectSpike: true }),
        stat(5, 'E병원'),
      ),
    });
    renderStats();
    const d = await screen.findByRole('row', { name: 'D병원' });
    expect(within(d).getByText('거절 급증')).toBeTruthy();
    expect(within(rowOf('E병원')).queryByText('거절 급증')).toBeNull();
  });

  it("거절 사유를 펼치면 '병원 웹 직접' 1건·'전화 확인' 3건이 나뉘어 보인다 (인수 기준)", async () => {
    fakeServer({
      'GET /admin/stats/hospitals?days=7': reply(
        7,
        stat(1, 'A병원', {
          topRejectReason: 'no_specialist',
          rejectBySource: {
            ...EMPTY_SOURCES,
            hospitalWeb: { no_specialist: 1 },
            phoneCheck: { or_room: 3 },
          },
        }),
      ),
    });
    renderStats();
    await screen.findByRole('row', { name: 'A병원' });
    fireEvent.click(screen.getByRole('button', { name: 'A병원 거절 사유 보기' }));
    const detail = screen.getByLabelText('A병원 출처별 거절 사유');
    expect(detail.textContent).toContain('병원 웹 직접 1건');
    expect(detail.textContent).toContain('해당 전문의 부재 1');
    expect(detail.textContent).toContain('전화 확인 3건');
    expect(detail.textContent).toContain('수술실 부족 3');
  });

  it("'최근 30일'로 바꾸면 30일 통계를 받는다", async () => {
    const server = fakeServer({
      'GET /admin/stats/hospitals?days=7': reply(7),
      'GET /admin/stats/hospitals?days=30': reply(30, stat(9, '옛병원')),
    });
    renderStats();
    expect(await screen.findByText('이 기간에 요청을 받은 병원이 없어요.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '최근 30일' }));
    expect(await screen.findByRole('row', { name: '옛병원' })).toBeTruthy();
    await waitFor(() =>
      expect(server.callsTo('GET /admin/stats/hospitals?days=30')).toHaveLength(1),
    );
  });

  it('시간은 분·초로 보여 준다', () => {
    expect(durationText(45)).toBe('45초');
    expect(durationText(60)).toBe('1분');
    expect(durationText(70)).toBe('1분 10초');
    expect(durationText(null)).toBe('—');
  });
});
