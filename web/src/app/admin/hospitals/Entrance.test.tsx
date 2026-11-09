import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/lib/api/schema';
import { loadKakaoMaps, resetKakaoMapsForTest, type KakaoMaps } from '@/lib/map/kakaoMaps';
import { fakeServer } from '@/testing/render';
import { AdminAuthProvider, useAdminAuth } from '../AdminAuth';
import { HospitalAdmin } from './HospitalAdmin';

type AdminHospital = components['schemas']['AdminHospital'];

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/admin/hospitals',
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
          <HospitalAdmin />
        </SignedIn>
      </AdminAuthProvider>
    </QueryClientProvider>,
  );
}

const A: AdminHospital = {
  id: 1,
  name: 'A대학교병원',
  accountActive: true,
  pcCount: 0,
  pcLimit: 3,
  license: { id: 9, prefix: 'ABCD', expiresAt: '2027-11-04T00:00:00Z', daysLeft: 300 },
  location: { lat: 36.8, lng: 127.1 },
  entrance: null,
};
const list = (...items: AdminHospital[]) => ({ status: 200, body: { items, nextCursor: null } });

// 카카오 지도 대신: 만든 지도·핀과 '지도 클릭' 처리기를 모은다
function fakeKakao() {
  const made: { center?: { lat: number; lng: number }; markers: { lat: number; lng: number }[] } = {
    markers: [],
  };
  let onClick: ((e: { latLng: { getLat(): number; getLng(): number } }) => void) | null = null;
  class LatLng {
    constructor(
      readonly lat: number,
      readonly lng: number,
    ) {}
    getLat() {
      return this.lat;
    }
    getLng() {
      return this.lng;
    }
  }
  const maps = {
    load: (cb: () => void) => cb(),
    LatLng,
    Map: class {
      constructor(_el: HTMLElement, opts: { center: LatLng }) {
        made.center = { lat: opts.center.lat, lng: opts.center.lng };
      }
      setCenter() {}
      relayout() {}
    },
    Marker: class {
      constructor(opts: { position: LatLng }) {
        made.markers.push({ lat: opts.position.lat, lng: opts.position.lng });
      }
      setPosition(p: LatLng) {
        made.markers.push({ lat: p.lat, lng: p.lng });
      }
      setMap() {}
    },
    event: {
      addListener: (_m: unknown, _t: string, handler: typeof onClick) => {
        onClick = handler;
      },
    },
  };
  return {
    maps: maps as unknown as KakaoMaps,
    made,
    click: (lat: number, lng: number) => onClick?.({ latLng: new LatLng(lat, lng) }),
  };
}

beforeEach(() => {
  resetKakaoMapsForTest();
  delete window.kakao;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.head.querySelectorAll('script[src*="dapi.kakao.com"]').forEach((s) => s.remove());
});

describe('응급실 입구 좌표 지정 (SFR-145)', () => {
  it("저장 안 한 병원은 '입구 좌표 없음'으로 보인다 (인수 기준)", async () => {
    vi.stubEnv('NEXT_PUBLIC_KAKAO_JS_KEY', '');
    fakeServer({
      'GET /admin/hospitals': list(A, {
        ...A,
        id: 2,
        name: 'B병원',
        entrance: { lat: 36.81, lng: 127.11 },
      }),
    });
    renderAdmin();
    const rowA = (await screen.findByText('A대학교병원')).closest('tr')!;
    expect(rowA.textContent).toContain('입구 좌표 없음');
    expect(within(rowA).getByRole('button', { name: 'A대학교병원 응급실 입구 지정' })).toBeTruthy();
    const rowB = screen.getByText('B병원').closest('tr')!;
    expect(rowB.textContent).toContain('지정됨');
    expect(within(rowB).getByRole('button', { name: 'B병원 응급실 입구 바꾸기' })).toBeTruthy();
  });

  it('지도에서 입구를 찍고 저장하면 그 좌표를 보내고 목록이 지정됨으로 바뀐다 (인수 기준)', async () => {
    vi.stubEnv('NEXT_PUBLIC_KAKAO_JS_KEY', 'test-js-key');
    const kakao = fakeKakao();
    window.kakao = { maps: kakao.maps };
    const server = fakeServer({
      'GET /admin/hospitals': [
        list(A),
        list({ ...A, entrance: { lat: 36.812345, lng: 127.123456 } }),
      ],
      'PUT /admin/hospitals/1/entrance': { status: 204 },
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'A대학교병원 응급실 입구 지정' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('application', { name: '응급실 입구를 찍을 지도' }),
    ).toBeTruthy();
    // 입구가 없으면 공공 데이터 병원 좌표를 가운데로
    await waitFor(() => expect(kakao.made.center).toEqual({ lat: 36.8, lng: 127.1 }));
    const save = within(dialog).getByRole('button', { name: '저장' });
    expect(save).toHaveProperty('disabled', true);

    kakao.click(36.812345, 127.123456);
    await waitFor(() =>
      expect((within(dialog).getByLabelText('위도') as HTMLInputElement).value).toBe('36.812345'),
    );
    expect(kakao.made.markers).toEqual([{ lat: 36.812345, lng: 127.123456 }]);
    fireEvent.click(save);

    await waitFor(() =>
      expect(server.callsTo('PUT /admin/hospitals/1/entrance')[0].body).toEqual({
        lat: 36.812345,
        lng: 127.123456,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('지정됨')).toBeTruthy();
  });

  it('지도 키가 없으면 위도·경도를 직접 넣어 저장한다', async () => {
    vi.stubEnv('NEXT_PUBLIC_KAKAO_JS_KEY', '');
    const server = fakeServer({
      'GET /admin/hospitals': list(A),
      'PUT /admin/hospitals/1/entrance': { status: 204 },
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'A대학교병원 응급실 입구 지정' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('application')).toBeNull();
    expect(dialog.textContent).toContain('위도·경도를 넣어 주세요');

    fireEvent.change(within(dialog).getByLabelText('위도'), { target: { value: '36.81' } });
    fireEvent.change(within(dialog).getByLabelText('경도'), { target: { value: '127.11' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    await waitFor(() =>
      expect(server.callsTo('PUT /admin/hospitals/1/entrance')[0].body).toEqual({
        lat: 36.81,
        lng: 127.11,
      }),
    );
  });

  it('이미 지정한 입구는 그 자리에 핀을 꽂고 시작하고, 대한민국 밖 좌표는 저장할 수 없다', async () => {
    vi.stubEnv('NEXT_PUBLIC_KAKAO_JS_KEY', 'test-js-key');
    const kakao = fakeKakao();
    window.kakao = { maps: kakao.maps };
    fakeServer({ 'GET /admin/hospitals': list({ ...A, entrance: { lat: 36.81, lng: 127.11 } }) });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'A대학교병원 응급실 입구 바꾸기' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(kakao.made.center).toEqual({ lat: 36.81, lng: 127.11 }));
    expect(kakao.made.markers).toEqual([{ lat: 36.81, lng: 127.11 }]);
    expect((within(dialog).getByLabelText('위도') as HTMLInputElement).value).toBe('36.810000');

    fireEvent.change(within(dialog).getByLabelText('위도'), { target: { value: '0' } });
    expect(within(dialog).getByRole('alert').textContent).toContain('대한민국 안의 좌표만');
    expect(within(dialog).getByRole('button', { name: '저장' })).toHaveProperty('disabled', true);
  });

  it('지도를 못 불러오면 직접 입력으로 안내한다', async () => {
    vi.stubEnv('NEXT_PUBLIC_KAKAO_JS_KEY', 'test-js-key');
    fakeServer({ 'GET /admin/hospitals': list(A) });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'A대학교병원 응급실 입구 지정' }));
    const dialog = await screen.findByRole('dialog');
    // 스크립트 내려받기 실패를 흉내 낸다
    const script = document.head.querySelector<HTMLScriptElement>('script[src*="dapi.kakao.com"]')!;
    script.onerror?.(new Event('error'));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      '지도를 불러오지 못했어요',
    );
    expect(within(dialog).getByLabelText('위도')).toBeTruthy();
  });
});

describe('카카오 지도 스크립트 불러오기', () => {
  it('키를 붙여 autoload=false 로 한 번만 붙이고, 다 받으면 지도 기능을 돌려준다', async () => {
    const kakao = fakeKakao();
    const first = loadKakaoMaps('key-1');
    const second = loadKakaoMaps('key-1');
    const scripts = document.head.querySelectorAll<HTMLScriptElement>(
      'script[src*="dapi.kakao.com"]',
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe(
      'https://dapi.kakao.com/v2/maps/sdk.js?appkey=key-1&autoload=false',
    );

    window.kakao = { maps: kakao.maps };
    scripts[0].onload?.(new Event('load'));
    expect(await first).toBe(kakao.maps);
    expect(await second).toBe(kakao.maps);
  });
});
