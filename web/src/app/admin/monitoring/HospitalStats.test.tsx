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
  it("'최근 7일'로 열면 A병원 응답률 80%·평균 응답 60초가 보인다 (인수 기준)", async () => {
    const server = fakeServer({ 'GET /admin/stats/hospitals?days=7': reply(7, stat(1, 'A병원')) });
    renderStats();
    await screen.findByRole('row', { name: 'A병원' });
    const a = rowOf('A병원');
    expect(a.textContent).toContain('80%');
    expect(a.textContent).toContain('1분');
    expect(a.textContent).toContain('25%');
    // 전체 평균 '평균 요청 → 출발' 상자는 화면에서 뺐다 (병원별 '요청→출발' 칸은 그대로)
    expect(screen.queryByText(/평균 요청 → 출발/)).toBeNull();
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
      'GET /admin/stats/hospitals?days=30': reply(30, stat(1, 'A병원')),
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
    // 병원 줄을 누르면 상세(지표 + 출처별 거절 사유)가 펼쳐진다
    fireEvent.click(await screen.findByRole('row', { name: 'A병원' }));
    expect(screen.getByLabelText('A병원 상세').textContent).toContain('받은 요청');
    const detail = screen.getByLabelText('A병원 출처별 거절 사유');
    expect(detail.textContent).toContain('병원 웹 직접 1건');
    expect(detail.textContent).toContain('해당 전문의 부재 1');
    expect(detail.textContent).toContain('전화 확인 3건');
    expect(detail.textContent).toContain('수술실 부족 3');
  });

  it('상세에 이 병원 평소(30일)와 전체 병원 평균 비교가 나온다', async () => {
    const server = fakeServer({
      'GET /admin/stats/hospitals?days=7': reply(
        7,
        stat(1, 'A병원', { requests: 20, responseRate: 0.5 }),
        stat(2, 'B병원', { requests: 20, responseRate: 0.9 }),
      ),
      'GET /admin/stats/hospitals?days=30': reply(
        30,
        stat(1, 'A병원', { requests: 80, responseRate: 0.7 }),
        stat(2, 'B병원', { requests: 80, responseRate: 0.9 }),
      ),
    });
    renderStats();
    // 펼치기 전에는 30일 통계를 받지 않는다
    await screen.findByRole('row', { name: 'A병원' });
    expect(server.callsTo('GET /admin/stats/hospitals?days=30')).toHaveLength(0);

    fireEvent.click(screen.getByRole('row', { name: 'A병원' }));
    const self = await screen.findByRole('region', { name: '이 병원 평소와 비교' });
    // 응답률: 최근 7일 50% vs 평소 70% → ▼ 20%p (나빠짐, 막대 2개)
    expect(self.textContent).toContain('▼ 20%p최근 7일50%평소(30일)70%');
    const avg = screen.getByRole('region', { name: '전체 병원 평균과 비교' });
    // 전체 평균 (0.5×20 + 0.9×20)/40 = 70% → ▼ 20%p
    expect(avg.textContent).toContain('▼ 20%p이 병원50%전체 평균70%');
    // 전체 병원 중 위치: 응답률 2곳 중 2위
    expect(screen.getByRole('region', { name: '전체 병원 중 위치' }).textContent).toContain(
      '2곳 중 2위',
    );
    expect(avg.textContent).toContain('병원 2곳의 평균');
  });

  it('비교할 병원이 1곳뿐이면 전체 평균 대신 안내', async () => {
    fakeServer({
      'GET /admin/stats/hospitals?days=7': reply(7, stat(1, 'A병원')),
      'GET /admin/stats/hospitals?days=30': reply(30, stat(1, 'A병원')),
    });
    renderStats();
    fireEvent.click(await screen.findByRole('row', { name: 'A병원' }));
    expect(await screen.findByText(/2곳 이상 있어야 해요/)).toBeTruthy();
  });

  it('병원 이름으로 검색하면 그 병원만 보인다', async () => {
    fakeServer({
      'GET /admin/stats/hospitals?days=7': reply(7, stat(1, 'A병원'), stat(2, '천안중앙병원')),
    });
    renderStats();
    await screen.findByRole('row', { name: 'A병원' });
    fireEvent.change(screen.getByRole('searchbox', { name: '병원 이름 검색' }), {
      target: { value: '천안' },
    });
    expect(screen.queryByRole('row', { name: 'A병원' })).toBeNull();
    expect(screen.getByRole('row', { name: '천안중앙병원' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: '병원 이름 검색' }), {
      target: { value: '없는병원' },
    });
    expect(screen.getByText(/에 맞는 병원이 없어요/)).toBeTruthy();
  });

  it('상세 창 안에서도 기간을 바꿀 수 있고, 그 기간에 기록이 없으면 안내', async () => {
    fakeServer({
      'GET /admin/stats/hospitals?days=7': reply(7, stat(1, 'A병원')),
      'GET /admin/stats/hospitals?days=30': reply(30, stat(1, 'A병원', { requests: 44 })),
      'GET /admin/stats/hospitals?days=0': reply(0),
    });
    renderStats();
    fireEvent.click(await screen.findByRole('row', { name: 'A병원' }));
    const dialog = await screen.findByRole('dialog');
    const group = within(dialog).getByRole('group', { name: '상세 기간' });
    fireEvent.click(within(group).getByRole('button', { name: '최근 30일' }));
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByLabelText('A병원 상세').textContent).toContain(
        '44건',
      ),
    );
    fireEvent.click(
      within(
        within(screen.getByRole('dialog')).getByRole('group', { name: '상세 기간' }),
      ).getByRole('button', { name: '전체' }),
    );
    expect(await screen.findByText(/전체 기간 동안 이 병원이 받은 요청이 없어요/)).toBeTruthy();
  });

  it("'전체'를 누르면 전체 기간(days=0) 통계를 받는다", async () => {
    const server = fakeServer({
      'GET /admin/stats/hospitals?days=7': reply(7, stat(1, 'A병원')),
      'GET /admin/stats/hospitals?days=0': reply(0, stat(1, 'A병원', { requests: 300 })),
    });
    renderStats();
    await screen.findByRole('row', { name: 'A병원' });
    fireEvent.click(screen.getByRole('button', { name: '전체' }));
    await waitFor(() => expect(rowOf('A병원').textContent).toContain('300'));
    expect(server.callsTo('GET /admin/stats/hospitals?days=0')).toHaveLength(1);
  });

  it("'최근 30일'로 바꾸면 30일 통계를 받는다", async () => {
    const server = fakeServer({
      'GET /admin/stats/hospitals?days=7': reply(7),
      'GET /admin/stats/hospitals?days=30': reply(30, stat(9, '옛병원')),
    });
    renderStats();
    expect(await screen.findByText('최근 7일 동안 요청을 받은 병원이 없어요.')).toBeTruthy();
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
