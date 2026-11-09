import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer } from '@/testing/render';
import { AdminAuthProvider, useAdminAuth } from '../AdminAuth';
import { SignupReview } from './SignupReview';

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

function renderAdmin({ strict = false } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={client}>
      <AdminAuthProvider>
        <SignedIn>
          <SignupReview />
        </SignedIn>
      </AdminAuthProvider>
    </QueryClientProvider>
  );
  // 개발 모드처럼 화면을 두 번 그려 본다 (StrictMode)
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const SIGNUP = {
  id: 11,
  name: '최하늘',
  rank: '소방사',
  agencyCode: 'CN-SB-019',
  agencyName: '천안서북소방서',
  safetyCenter: '성정안전센터',
  employeeNo: 'E-2026-77',
  consentAt: '2026-11-06T07:00:00Z',
  createdAt: '2026-11-06T07:00:00Z',
  resubmitted: false,
};
const list = (...items: (typeof SIGNUP)[]) => ({ status: 200, body: { items, nextCursor: null } });
const PHOTO = { status: 200, body: 'jpeg-bytes' };

const createObjectURL = vi.fn(() => 'blob:photo-1');
const revokeObjectURL = vi.fn();
beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  // jsdom 에는 blob URL 이 없어서 흉내 낸다
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('가입 승인·반려 (SFR-083)', () => {
  it('대기 목록을 보여 주고, 열면 토큰을 붙여 사진을 한 번만 받아 신청 정보와 나란히 보여 준다', async () => {
    const server = fakeServer({
      'GET /admin/signups': list(SIGNUP, { ...SIGNUP, id: 12, name: '한바다', resubmitted: true }),
      'GET /admin/signups/11/photo': PHOTO,
    });
    renderAdmin();
    expect(await screen.findByText('2건')).toBeTruthy();
    expect(screen.getByText('한바다').closest('tr')!.textContent).toContain('다시 신청');

    fireEvent.click(screen.getByRole('button', { name: '최하늘 신청 확인' }));
    const dialog = await screen.findByRole('dialog');
    const img = (await within(dialog).findByRole('img', {
      name: '최하늘 공무원증 사진',
    })) as HTMLImageElement;
    expect(img.src).toBe('blob:photo-1');
    expect(dialog.textContent).toContain('천안서북소방서 (CN-SB-019)');
    expect(dialog.textContent).toContain('E-2026-77');

    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/photo'))!;
    expect((call[1]?.headers as Record<string, string>).Authorization).toBe('Bearer admin-token');
    expect(server.callsTo('GET /admin/signups/11/photo')).toHaveLength(1);

    // 닫으면 메모리의 사진을 바로 버린다
    fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:photo-1'));
  });

  it('개발 모드(StrictMode)에서도 사진은 한 번만 받는다 (열람 기록이 2건 남지 않게)', async () => {
    const server = fakeServer({
      'GET /admin/signups': list(SIGNUP),
      'GET /admin/signups/11/photo': PHOTO,
    });
    renderAdmin({ strict: true });
    fireEvent.click(await screen.findByRole('button', { name: '최하늘 신청 확인' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('img', { name: '최하늘 공무원증 사진' });
    // 그려진 뒤 잠깐 기다려도 더 부르지 않는다
    await new Promise((r) => setTimeout(r, 50));
    expect(server.callsTo('GET /admin/signups/11/photo')).toHaveLength(1);
  });

  it('대기가 30건을 넘으면 이상으로 표시하고 더 보기로 이어 받는다', async () => {
    const server = fakeServer({
      'GET /admin/signups': {
        status: 200,
        body: { items: [SIGNUP], nextCursor: '11' },
      },
      'GET /admin/signups?cursor=11': list({ ...SIGNUP, id: 12, name: '한바다' }),
    });
    renderAdmin();
    expect(await screen.findByText('1건 이상')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '가입 신청 더 보기' }));
    expect(await screen.findByText('한바다')).toBeTruthy();
    expect(screen.getByText('2건')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '가입 신청 더 보기' })).toBeNull();
    expect(server.callsTo('GET /admin/signups?cursor=11')).toHaveLength(1);
  });

  it('승인하면 보내고 목록을 새로 받는다', async () => {
    const server = fakeServer({
      'GET /admin/signups': [list(SIGNUP), list()],
      'GET /admin/signups/11/photo': PHOTO,
      'POST /admin/signups/11/approve': { status: 204 },
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: '최하늘 신청 확인' }));
    const dialog = await screen.findByRole('dialog');
    const approve = within(dialog).getByRole('button', { name: '승인' });
    // 사진을 보기 전에는 승인할 수 없다
    await within(dialog).findByRole('img');
    fireEvent.click(approve);

    await waitFor(() => expect(server.callsTo('POST /admin/signups/11/approve')).toHaveLength(1));
    expect(await screen.findByText('기다리는 가입 신청이 없어요.')).toBeTruthy();
  });

  it("반려는 사유를 골라야 보낼 수 있고, '사진 불명확'으로 보낸다", async () => {
    const server = fakeServer({
      'GET /admin/signups': [list(SIGNUP), list()],
      'GET /admin/signups/11/photo': PHOTO,
      'POST /admin/signups/11/reject': { status: 204 },
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: '최하늘 신청 확인' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '반려' }));
    const send = within(dialog).getByRole('button', { name: '반려 보내기' });
    expect(send).toHaveProperty('disabled', true);

    fireEvent.click(within(dialog).getByRole('radio', { name: '사진 불명확' }));
    fireEvent.click(send);
    await waitFor(() =>
      expect(server.callsTo('POST /admin/signups/11/reject')[0].body).toEqual({
        reason: 'photo_unclear',
        etcText: null,
      }),
    );
  });

  it('기타는 사유를 써야 보낼 수 있다', async () => {
    const server = fakeServer({
      'GET /admin/signups': list(SIGNUP),
      'GET /admin/signups/11/photo': PHOTO,
      'POST /admin/signups/11/reject': { status: 204 },
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: '최하늘 신청 확인' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '반려' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: '기타' }));
    const send = within(dialog).getByRole('button', { name: '반려 보내기' });
    expect(send).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByRole('textbox', { name: '기타 사유' }), {
      target: { value: ' 사번 확인 필요 ' },
    });
    fireEvent.click(send);
    await waitFor(() =>
      expect(server.callsTo('POST /admin/signups/11/reject')[0].body).toEqual({
        reason: 'etc',
        etcText: '사번 확인 필요',
      }),
    );
  });

  it('다른 관리자가 먼저 처리했으면 이유를 보여 준다', async () => {
    fakeServer({
      'GET /admin/signups': list(SIGNUP),
      'GET /admin/signups/11/photo': PHOTO,
      'POST /admin/signups/11/approve': {
        status: 409,
        body: {
          error: {
            code: 'ALREADY_RESPONDED',
            message: '이미 처리된 가입 신청이에요',
            details: null,
          },
        },
      },
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: '최하늘 신청 확인' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('img');
    fireEvent.click(within(dialog).getByRole('button', { name: '승인' }));
    expect(await within(dialog).findByText('이미 처리된 가입 신청이에요')).toBeTruthy();
  });

  it('사진이 이미 지워졌으면 안내하고 승인 버튼을 막는다', async () => {
    fakeServer({
      'GET /admin/signups': list(SIGNUP),
      'GET /admin/signups/11/photo': { status: 410, body: apiError('PHOTO_DELETED') },
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: '최하늘 신청 확인' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '승인' })).toHaveProperty('disabled', true);
  });
});
