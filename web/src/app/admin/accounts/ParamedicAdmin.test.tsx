import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer } from '@/testing/render';
import { AdminAuthProvider, useAdminAuth } from '../AdminAuth';
import { ParamedicAdmin } from './ParamedicAdmin';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/admin/accounts',
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

function renderAdmin() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AdminAuthProvider>
        <SignedIn>
          <ParamedicAdmin />
        </SignedIn>
      </AdminAuthProvider>
    </QueryClientProvider>,
  );
}

const KIM = {
  id: 3,
  name: '김도윤',
  agencyName: '천안서북소방서',
  safetyCenter: '성정안전센터',
  employeeNo: '2019-0412',
  status: 'approved',
  hasActiveTransport: false,
};
const list = (...items: (typeof KIM)[]) => ({ status: 200, body: { items, nextCursor: null } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('대원 계정 정지·해제 (SFR-151)', () => {
  it('이름·사번으로 찾고, 소속·상태·이송 중을 보여 준다', async () => {
    const server = fakeServer({
      'GET /admin/paramedics': list(),
      'GET /admin/paramedics?q=2019': list({ ...KIM, hasActiveTransport: true }),
    });
    renderAdmin();
    fireEvent.change(await screen.findByRole('textbox', { name: '이름 또는 사번' }), {
      target: { value: ' 2019 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '검색' }));

    const row = (await screen.findByText('김도윤')).closest('tr')!;
    expect(row.textContent).toContain('2019-0412');
    expect(row.textContent).toContain('천안서북소방서 · 성정안전센터');
    expect(row.textContent).toContain('사용 중');
    expect(row.textContent).toContain('이송 중');
    expect(server.callsTo('GET /admin/paramedics?q=2019')).toHaveLength(1);
  });

  it("사유 '폰 분실'을 골라야 정지할 수 있고, 정지되면 '정지 해제'로 바뀐다", async () => {
    const server = fakeServer({
      'GET /admin/paramedics': [list(KIM), list({ ...KIM, status: 'suspended' })],
      'POST /admin/paramedics/3/suspend': { status: 204 },
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: '정지' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('대원 앱이 바로 로그아웃되고');
    const send = within(dialog).getByRole('button', { name: '정지' });
    expect(send).toHaveProperty('disabled', true);

    fireEvent.click(within(dialog).getByRole('radio', { name: '폰 분실' }));
    fireEvent.click(send);

    await waitFor(() =>
      expect(server.callsTo('POST /admin/paramedics/3/suspend')[0].body).toEqual({
        reason: 'phone_lost',
        etcText: null,
      }),
    );
    expect(await screen.findByRole('button', { name: '정지 해제' })).toBeTruthy();
    expect(screen.getByText('정지됨')).toBeTruthy();
  });

  it("이동 중이면 '진행 중 이송 1건이 있어요' 경고가 먼저 나오고, 그래도 정지하면 확인을 붙여 보낸다", async () => {
    const server = fakeServer({
      'GET /admin/paramedics': list({ ...KIM, hasActiveTransport: true }),
      'POST /admin/paramedics/3/suspend': [
        { status: 409, body: apiError('ACTIVE_TRANSPORT_CONFIRM_REQUIRED') },
        { status: 204 },
      ],
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: '정지' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: '부정 사용' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '정지' }));

    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      '진행 중 이송 1건이 있어요',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '그래도 정지' }));

    await waitFor(() => expect(server.callsTo('POST /admin/paramedics/3/suspend')).toHaveLength(2));
    expect(server.callsTo('POST /admin/paramedics/3/suspend')[1].body).toEqual({
      reason: 'misuse',
      etcText: null,
      confirmCancelActive: true,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('기타는 사유를 써야 보낼 수 있다', async () => {
    const server = fakeServer({
      'GET /admin/paramedics': list(KIM),
      'POST /admin/paramedics/3/suspend': { status: 204 },
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: '정지' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: '기타' }));
    const send = within(dialog).getByRole('button', { name: '정지' });
    expect(send).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByRole('textbox', { name: '기타 사유' }), {
      target: { value: ' 장기 휴직 ' },
    });
    fireEvent.click(send);
    await waitFor(() =>
      expect(server.callsTo('POST /admin/paramedics/3/suspend')[0].body).toEqual({
        reason: 'etc',
        etcText: '장기 휴직',
      }),
    );
  });

  it('비밀번호 초기화: 확인을 거쳐 임시 비밀번호를 한 번만 보여 주고, 닫으면 다시 볼 수 없다 (SFR-021 인수 기준)', async () => {
    const server = fakeServer({
      'GET /admin/paramedics': list(KIM),
      'POST /admin/paramedics/3/reset-password': {
        status: 200,
        body: { tempPassword: 'abcd2345ef' },
      },
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: '김도윤 비밀번호 초기화' }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm.textContent).toContain('소속 기관 전화로 본인인지 먼저 확인하세요');
    // 확인 전에는 보내지 않는다
    expect(server.callsTo('POST /admin/paramedics/3/reset-password')).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole('button', { name: '초기화' }));

    const shown = await screen.findByRole('dialog', { name: /임시 비밀번호/ });
    expect(within(shown).getByText('abcd2345ef')).toBeTruthy();
    expect(shown.textContent).toContain('이 창을 닫으면 다시 볼 수 없어요');
    expect(server.callsTo('POST /admin/paramedics/3/reset-password')).toHaveLength(1);

    fireEvent.click(within(shown).getByRole('button', { name: '확인했어요' }));
    await waitFor(() => expect(screen.queryByText('abcd2345ef')).toBeNull());
  });

  it('정지된 계정도 비밀번호를 초기화할 수 있다', async () => {
    fakeServer({ 'GET /admin/paramedics': list({ ...KIM, status: 'suspended' }) });
    renderAdmin();
    const row = (await screen.findByText('김도윤')).closest('tr')!;
    expect(within(row).getByRole('button', { name: '김도윤 비밀번호 초기화' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: '정지 해제' })).toBeTruthy();
  });

  it('정지 해제는 확인 창을 거쳐 보낸다', async () => {
    const suspended = { ...KIM, status: 'suspended' };
    const server = fakeServer({
      'GET /admin/paramedics': [list(suspended), list(KIM)],
      'POST /admin/paramedics/3/unsuspend': { status: 204 },
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: '정지 해제' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('다시 로그인해서 쓸 수 있어요');
    fireEvent.click(within(dialog).getByRole('button', { name: '정지 해제' }));
    await waitFor(() =>
      expect(server.callsTo('POST /admin/paramedics/3/unsuspend')).toHaveLength(1),
    );
    expect(await screen.findByRole('button', { name: '정지' })).toBeTruthy();
  });
});
