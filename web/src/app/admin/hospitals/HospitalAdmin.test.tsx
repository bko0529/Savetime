import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer } from '@/testing/render';
import { AdminAuthProvider, useAdminAuth } from '../AdminAuth';
import { AuditLog } from '../monitoring/AuditLog';
import { HospitalAdmin, type AdminHospital } from './HospitalAdmin';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/admin/hospitals',
}));

function SignedIn({ children }: { children: ReactNode }) {
  const { signIn, tokens } = useAdminAuth();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    signIn({ accessToken: 'admin-token', refreshToken: 'r' });
    setReady(true);
  }, [signIn]);
  return (
    <>
      <span data-testid="signed-in">{tokens ? 'yes' : 'no'}</span>
      {ready ? children : null}
    </>
  );
}

function renderAdmin(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AdminAuthProvider>
        <SignedIn>{ui}</SignedIn>
      </AdminAuthProvider>
    </QueryClientProvider>,
  );
}

function hospital(id: number, name: string, extra: Partial<AdminHospital> = {}): AdminHospital {
  return { id, name, accountActive: false, pcCount: 0, pcLimit: 3, license: null, ...extra };
}
const list = (...items: AdminHospital[]) => ({ status: 200, body: { items, nextCursor: null } });
// 가짜 키 (실제 키처럼 보이면 비밀키 검사 gitleaks 가 막는다)
const FAKE_ISSUED = 'ABCD-EFGH-JKMN-PQRS-TUVW';

beforeEach(() => replace.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('병원 관리 (SFR-123)', () => {
  it('병원 이름으로 검색하면 계정 상태·PC 수·키 앞 4자리를 보여 준다', async () => {
    const server = fakeServer({
      'GET /admin/hospitals': list(),
      'GET /admin/hospitals?q=%EC%B2%9C%EC%95%88': list(
        hospital(1, '천안 A병원'),
        hospital(2, '천안 B병원', {
          accountActive: true,
          pcCount: 2,
          license: { id: 9, prefix: 'ABCD', expiresAt: '2027-11-04T00:00:00Z', daysLeft: 365 },
        }),
      ),
    });
    renderAdmin(<HospitalAdmin />);
    fireEvent.change(await screen.findByRole('textbox', { name: '병원 이름' }), {
      target: { value: ' 천안 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '검색' }));

    const rowB = (await screen.findByText('천안 B병원')).closest('tr')!;
    expect(rowB.textContent).toContain('사용 중');
    expect(rowB.textContent).toContain('2/3');
    expect(rowB.textContent).toContain('ABCD-····');
    expect(rowB.textContent).toContain('365일 남음');
    expect(within(rowB).getByRole('button', { name: '정지' })).toBeTruthy();
    const rowA = screen.getByText('천안 A병원').closest('tr')!;
    expect(rowA.textContent).toContain('계정 없음');
    expect(within(rowA).getByRole('button', { name: '계정 발급' })).toBeTruthy();
    expect(server.callsTo('GET /admin/hospitals?q=%EC%B2%9C%EC%95%88')).toHaveLength(1);
  });

  it('계정 발급 → 확인 → 키 전체를 한 번만 보여 주고, 닫으면 앞 4자리만 남는다', async () => {
    const server = fakeServer({
      'GET /admin/hospitals': [
        list(hospital(1, 'A대학교병원')),
        list(
          hospital(1, 'A대학교병원', {
            accountActive: true,
            license: { id: 9, prefix: 'ABCD', expiresAt: '2027-11-04T00:00:00Z', daysLeft: 365 },
          }),
        ),
      ],
      'POST /admin/hospitals/1/account': {
        status: 201,
        body: { licenseKey: FAKE_ISSUED, expiresAt: '2027-11-04T00:00:00Z' },
      },
    });
    renderAdmin(<HospitalAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: '계정 발급' }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm.textContent).toContain('A대학교병원 계정 발급');
    fireEvent.click(within(confirm).getByRole('button', { name: '발급' }));

    const keyDialog = await screen.findByRole('dialog', { name: /라이선스 키/ });
    expect(within(keyDialog).getByText(FAKE_ISSUED)).toBeTruthy();
    expect(keyDialog.textContent).toContain('이 창을 닫으면 키 전체를 다시 볼 수 없어요');
    expect(server.callsTo('POST /admin/hospitals/1/account')).toHaveLength(1);

    fireEvent.click(within(keyDialog).getByRole('button', { name: '확인했어요' }));
    await waitFor(() => expect(screen.queryByText(FAKE_ISSUED)).toBeNull());
    expect(await screen.findByText(/ABCD-····/)).toBeTruthy();
  });

  it('이미 계정이 있으면 확인 창에 이유를 보여 준다', async () => {
    fakeServer({
      'GET /admin/hospitals': list(hospital(1, 'A병원')),
      'POST /admin/hospitals/1/account': { status: 409, body: apiError('ACCOUNT_EXISTS') },
    });
    renderAdmin(<HospitalAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: '계정 발급' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '발급' }),
    );
    expect(await screen.findByText('이미 병원 계정이 있어요.')).toBeTruthy();
  });

  it('정지는 모든 PC가 막힌다는 확인을 거쳐 보낸다', async () => {
    const active = hospital(2, 'B병원', {
      accountActive: true,
      license: { id: 9, prefix: 'ABCD', expiresAt: '2027-11-04T00:00:00Z', daysLeft: 300 },
    });
    const server = fakeServer({
      'GET /admin/hospitals': [list(active), list({ ...active, accountActive: false })],
      'POST /admin/hospitals/2/suspend': { status: 204 },
    });
    renderAdmin(<HospitalAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: '정지' }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm.textContent).toContain('모든 등록 PC에서 병원 웹이 바로 막히고');
    fireEvent.click(within(confirm).getByRole('button', { name: '정지' }));

    await waitFor(() => expect(server.callsTo('POST /admin/hospitals/2/suspend')).toHaveLength(1));
    expect(await screen.findByText('정지됨')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '정지' })).toBeNull();
  });

  it('관리자 토큰이 끝나면 로그아웃시켜 로그인 화면으로 보낸다', async () => {
    fakeServer({
      'GET /admin/hospitals': { status: 401, body: apiError('TOKEN_EXPIRED') },
    });
    renderAdmin(<HospitalAdmin />);
    await waitFor(() => expect(screen.getByTestId('signed-in').textContent).toBe('no'));
  });
});

describe('관리자 작업 이력 (SFR-091)', () => {
  it('시각·관리자·작업·대상을 최신순으로 보여 주고, 더 보기로 이어 받는다', async () => {
    const at = '2026-11-04T01:05:00Z';
    const server = fakeServer({
      'GET /admin/audit-logs?limit=30': {
        status: 200,
        body: {
          items: [{ at, admin: '김관리', action: '병원 계정 정지', target: 'A병원', reason: null }],
          nextCursor: '7',
        },
      },
      'GET /admin/audit-logs?limit=30&cursor=7': {
        status: 200,
        body: {
          items: [{ at, admin: '김관리', action: '병원 계정 발급', target: 'A병원', reason: null }],
          nextCursor: null,
        },
      },
    });
    renderAdmin(<AuditLog />);
    expect(await screen.findByText('병원 계정 정지')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }));
    expect(await screen.findByText('병원 계정 발급')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: '더 보기' })).toBeNull();
    expect(server.callsTo('GET /admin/audit-logs?limit=30&cursor=7')).toHaveLength(1);
  });
});
