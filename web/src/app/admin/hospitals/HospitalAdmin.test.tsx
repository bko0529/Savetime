import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer } from '@/testing/render';
import { AdminAuthProvider, useAdminAuth } from '../AdminAuth';
import { AuditLog } from '../monitoring/AuditLog';
import { Notifications } from '../monitoring/Notifications';
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

describe('라이선스 키 폐기·재발급 (SFR-146)', () => {
  const LICENSE = { id: 9, prefix: 'ABCD', expiresAt: '2027-11-04T00:00:00Z', daysLeft: 300 };
  const FAKE_NEW = 'WXYZ-EFGH-JKMN-PQRS-TUVW';

  it('재발급: 사유를 써야 보낼 수 있고, 새 키를 한 번만 보여 준다', async () => {
    const active = hospital(1, 'A병원', { accountActive: true, pcCount: 3, license: LICENSE });
    const server = fakeServer({
      'GET /admin/hospitals': [
        list(active),
        list({ ...active, pcCount: 0, license: { ...LICENSE, id: 10, prefix: 'WXYZ' } }),
      ],
      'POST /admin/hospitals/1/license-keys': {
        status: 201,
        body: { licenseKey: FAKE_NEW, expiresAt: '2027-11-04T00:00:00Z' },
      },
    });
    renderAdmin(<HospitalAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: '키 재발급' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('등록된 PC는 모두 막히고');
    const send = within(dialog).getByRole('button', { name: '재발급' });
    expect(send).toHaveProperty('disabled', true);

    fireEvent.change(within(dialog).getByRole('textbox', { name: /사유/ }), {
      target: { value: ' 키 유출 의심 ' },
    });
    expect(send).toHaveProperty('disabled', false);
    fireEvent.click(send);

    const keyDialog = await screen.findByRole('dialog', { name: /라이선스 키/ });
    expect(within(keyDialog).getByText(FAKE_NEW)).toBeTruthy();
    expect(server.callsTo('POST /admin/hospitals/1/license-keys')[0].body).toEqual({
      reason: '키 유출 의심',
    });
    fireEvent.click(within(keyDialog).getByRole('button', { name: '확인했어요' }));
    expect(await screen.findByText(/WXYZ-····/)).toBeTruthy();
  });

  it('폐기: 키 id 로 사유와 함께 보내고, 폐기된 병원은 재발급만 할 수 있다', async () => {
    const active = hospital(2, 'B병원', { accountActive: true, pcCount: 2, license: LICENSE });
    const server = fakeServer({
      'GET /admin/hospitals': [list(active), list({ ...active, pcCount: 0, license: null })],
      'POST /admin/license-keys/9/revoke': { status: 204 },
    });
    renderAdmin(<HospitalAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: '키 폐기' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('새 키는 만들지 않아요');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /사유/ }), {
      target: { value: '병원 탈퇴' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '폐기' }));

    await waitFor(() =>
      expect(server.callsTo('POST /admin/license-keys/9/revoke')[0].body).toEqual({
        reason: '병원 탈퇴',
      }),
    );
    const row = (await screen.findByText('키 폐기됨')).closest('tr')!;
    expect(within(row).getByRole('button', { name: '키 재발급' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: '키 폐기' })).toBeNull();
    // 계정은 이미 있으니 '계정 발급'은 보이지 않는다 (누르면 ACCOUNT_EXISTS)
    expect(within(row).queryByRole('button', { name: '계정 발급' })).toBeNull();
  });

  it('취소하면 쓰던 사유를 지운다', async () => {
    fakeServer({
      'GET /admin/hospitals': list(hospital(1, 'A병원', { accountActive: true, license: LICENSE })),
    });
    renderAdmin(<HospitalAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: '키 폐기' }));
    fireEvent.change(await screen.findByRole('textbox', { name: /사유/ }), {
      target: { value: '분실' },
    });
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '키 폐기' }));
    expect(((await screen.findByRole('textbox', { name: /사유/ })) as HTMLInputElement).value).toBe(
      '',
    );
  });
});

describe('병원 등록 PC 관리 (SFR-147)', () => {
  const LICENSE = { id: 9, prefix: 'ABCD', expiresAt: '2027-11-04T00:00:00Z', daysLeft: 300 };
  const PC = (id: number, name: string, online = false) => ({
    id,
    name,
    registeredAt: '2026-10-01T00:00:00Z',
    lastUsedAt: '2026-11-04T00:00:00Z',
    online,
  });

  it("PC 목록을 열고 '응급실 접수대'를 확인 창을 거쳐 해제한다", async () => {
    const a = hospital(1, 'A병원', { accountActive: true, pcCount: 2, license: LICENSE });
    const server = fakeServer({
      'GET /admin/hospitals': [list(a), list({ ...a, pcCount: 1 })],
      'GET /admin/hospitals/1/pcs': [
        { status: 200, body: [PC(7, '응급실 접수대', true), PC(8, '야간 PC')] },
        { status: 200, body: [PC(8, '야간 PC')] },
      ],
      'DELETE /admin/pcs/7': { status: 204 },
    });
    renderAdmin(<HospitalAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: 'A병원 등록 PC 보기' }));

    const section = await screen.findByRole('region', { name: 'A병원 등록 PC' });
    const desk = (await within(section).findByText('응급실 접수대')).closest('tr')!;
    expect(desk.textContent).toContain('접속 중');
    expect(within(section).getByText('야간 PC').closest('tr')!.textContent).not.toContain(
      '접속 중',
    );
    fireEvent.click(within(desk).getByRole('button', { name: '해제' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('응급실 접수대 해제');
    expect(dialog.textContent).toContain('병원 웹이 바로 막혀요');
    fireEvent.click(within(dialog).getByRole('button', { name: '해제' }));

    await waitFor(() => expect(server.callsTo('DELETE /admin/pcs/7')).toHaveLength(1));
    await waitFor(() => expect(within(section).queryByText('응급실 접수대')).toBeNull());
    expect(within(section).getByText('야간 PC')).toBeTruthy();
  });

  it('등록 PC 가 없는 병원은 PC 보기 버튼이 없다', async () => {
    fakeServer({
      'GET /admin/hospitals': list(hospital(1, 'A병원', { accountActive: true, license: LICENSE })),
    });
    renderAdmin(<HospitalAdmin />);
    await screen.findByText('A병원');
    expect(screen.queryByRole('button', { name: 'A병원 등록 PC 보기' })).toBeNull();
  });
});

describe('관리자 알림 목록 (SFR-100)', () => {
  const note = (id: number, text: string, extra: object = {}) => ({
    id,
    kind: 'pc_change',
    text,
    occurrences: 1,
    lastAt: '2026-11-04T05:09:00Z',
    read: false,
    ...extra,
  });

  it('알림을 최근 순으로 보여 주고, 열면 읽음으로 바꾼다', async () => {
    const server = fakeServer({
      'GET /admin/notifications?limit=30': [
        {
          status: 200,
          body: {
            items: [
              note(2, 'A병원 PC 등록 · 응급실 접수대'),
              note(1, '병상 수집 3회 연속 실패', { kind: 'collect_fail', occurrences: 2 }),
            ],
            nextCursor: null,
            unread: 2,
          },
        },
        {
          status: 200,
          body: {
            items: [
              note(2, 'A병원 PC 등록 · 응급실 접수대', { read: true }),
              note(1, '병상 수집 3회 연속 실패', { kind: 'collect_fail', occurrences: 2 }),
            ],
            nextCursor: null,
            unread: 1,
          },
        },
      ],
      'POST /admin/notifications/2/read': { status: 204 },
    });
    renderAdmin(<Notifications />);
    const pc = await screen.findByRole('button', {
      name: 'A병원 PC 등록 · 응급실 접수대 (안 읽음)',
    });
    expect(screen.getByRole('button', { name: /병상 수집 3회 연속 실패/ }).textContent).toContain(
      '2회',
    );

    fireEvent.click(pc);
    await waitFor(() => expect(server.callsTo('POST /admin/notifications/2/read')).toHaveLength(1));
    expect(
      await screen.findByRole('button', { name: 'A병원 PC 등록 · 응급실 접수대' }),
    ).toBeTruthy();
    // 이미 읽은 알림은 다시 눌러도 보내지 않는다
    fireEvent.click(screen.getByRole('button', { name: 'A병원 PC 등록 · 응급실 접수대' }));
    expect(server.callsTo('POST /admin/notifications/2/read')).toHaveLength(1);
  });

  it('더 보기는 커서를 그대로(인코딩해서) 보낸다', async () => {
    const cursor = '2026-11-04T05:09:00.123Z|7';
    const server = fakeServer({
      'GET /admin/notifications?limit=30': {
        status: 200,
        body: { items: [note(9, '새 가입 신청')], nextCursor: cursor, unread: 1 },
      },
      [`GET /admin/notifications?limit=30&cursor=${encodeURIComponent(cursor)}`]: {
        status: 200,
        body: { items: [note(7, '이상 PC 등록 감지')], nextCursor: null, unread: 1 },
      },
    });
    renderAdmin(<Notifications />);
    fireEvent.click(await screen.findByRole('button', { name: '알림 더 보기' }));
    expect(await screen.findByText('이상 PC 등록 감지')).toBeTruthy();
    expect(
      server.callsTo(`GET /admin/notifications?limit=30&cursor=${encodeURIComponent(cursor)}`),
    ).toHaveLength(1);
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
