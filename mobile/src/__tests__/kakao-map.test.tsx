/**
 * 카카오 지도 (SFR-027 · 094 · 149 · 062): 마커 고르기, 마커-카드 연동, 지도 실패 시 목록
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { buildMapHtml, validKey } from '../map/mapHtml';

const mockHospitals: Record<string, { name: string; lat?: number; lng?: number }> = {};
jest.mock('../transport/engine', () => ({
  hospital: (id: string) => ({
    id,
    km: 2,
    min: 5,
    er: '3/10',
    ...(mockHospitals[id] ?? { name: '' }),
  }),
}));
jest.mock('../transport/location', () => ({
  currentLocation: jest.fn(async () => ({ lat: 36.8, lng: 127.1 })),
}));

const KEY = 'testkey000000000000000000000000';
const colors = { ink: '#111', accent: '#d00', success: '#070', card: '#fff', text: '#000' };

/** 키를 넣고 지도 모듈을 쓴다 (키는 지도를 만들 때마다 읽는다) */
function loadMap(key: string | undefined) {
  if (key === undefined) delete process.env.EXPO_PUBLIC_KAKAO_JS_KEY;
  else process.env.EXPO_PUBLIC_KAKAO_JS_KEY = key;
  return {
    ...(require('../map/HospitalMap') as typeof import('../map/HospitalMap')),
    ...(require('../map/KakaoMap') as typeof import('../map/KakaoMap')),
  };
}
const msg = (data: object) => ({ nativeEvent: { data: JSON.stringify(data) } });

beforeEach(() => {
  jest.useFakeTimers();
  for (const k of Object.keys(mockHospitals)) delete mockHospitals[k];
});
afterEach(() => jest.useRealTimers());

describe('지도 페이지', () => {
  test('키는 영문·숫자만 받는다 (주소에 그대로 들어가므로)', () => {
    expect(validKey(KEY)).toBe(true);
    expect(validKey(undefined)).toBe(false);
    expect(validKey('abc"><script>')).toBe(false);
  });

  test('키와 색이 들어가고, 병원 이름은 화면에 그릴 때 글자로만 넣는다', () => {
    const html = buildMapHtml(KEY, colors);
    expect(html).toContain(`appkey=${KEY}`);
    expect(html).toContain('autoload=false');
    expect(html).toContain('"#070"');
    expect(html).toContain('function esc(s)');
  });
});

describe('마커 만들기', () => {
  test('승인 병원만 초록 마커로, 같은 병원은 한 번, 좌표 없는 병원은 뺀다', () => {
    const { buildMarkers } = loadMap(KEY);
    mockHospitals.h1 = { name: 'A병원', lat: 36.81, lng: 127.11 };
    mockHospitals.h2 = { name: 'B병원', lat: 36.82, lng: 127.12 };
    mockHospitals.nocoord = { name: '좌표 없음' };
    const m = buildMarkers(['h2', 'nocoord', 'h1', 'h2']);
    expect(m.map((x) => [x.id, x.tone, x.rank])).toEqual([
      ['h2', 'approved', 1],
      ['h1', 'approved', 2],
    ]);
  });
});

describe('KakaoMap', () => {
  test('지도가 뜨면 병원을 그리고, 마커를 누르면 그 병원을 알린다', async () => {
    const { KakaoMap } = loadMap(KEY);
    const { mockInjected } = require('react-native-webview') as { mockInjected: string[] };
    mockInjected.length = 0;
    const onSelect = jest.fn();
    const onFail = jest.fn();
    const data = {
      markers: [
        { id: 'h1', lat: 36.8, lng: 127.1, label: 'A병원', rank: 1, tone: 'normal' as const },
      ],
      me: null,
      selectedId: null,
    };
    await render(<KakaoMap data={data} onSelect={onSelect} onFail={onFail} />);
    const web = screen.getByTestId('kakao-map');
    await act(async () => web.props.onMessage(msg({ type: 'ready' })));
    expect(mockInjected.at(-1)).toContain('"id":"h1"');
    await act(async () => web.props.onMessage(msg({ type: 'select', id: 'h1' })));
    expect(onSelect).toHaveBeenCalledWith('h1');
    await act(async () => jest.advanceTimersByTime(20_000));
    expect(onFail).not.toHaveBeenCalled();
  });

  test('8초 안에 안 뜨면 실패 (도메인 미등록 · 인터넷 끊김)', async () => {
    const { KakaoMap, MAP_READY_MS } = loadMap(KEY);
    const onFail = jest.fn();
    await render(
      <KakaoMap
        data={{ markers: [], me: null, selectedId: null }}
        onSelect={jest.fn()}
        onFail={onFail}
      />,
    );
    await act(async () => jest.advanceTimersByTime(MAP_READY_MS));
    expect(onFail).toHaveBeenCalledWith('timeout');
  });

  test('키가 없으면 지도를 만들지 않고 실패로 알린다', async () => {
    const { KakaoMap } = loadMap(undefined);
    const onFail = jest.fn();
    await render(
      <KakaoMap
        data={{ markers: [], me: null, selectedId: null }}
        onSelect={jest.fn()}
        onFail={onFail}
      />,
    );
    expect(screen.queryByTestId('kakao-map')).toBeNull();
    expect(onFail).toHaveBeenCalledWith('no_key');
  });
});

describe('HospitalMap (승인 병원 지도, SFR-149)', () => {
  const props = {
    approvedIds: ['h1', 'h2'],
    selectedId: null as string | null,
    onSelect: jest.fn(),
    onDetail: jest.fn(),
    online: true,
  };
  beforeEach(() => {
    mockHospitals.h1 = { name: 'A병원', lat: 36.81, lng: 127.11 };
    mockHospitals.h2 = { name: 'B병원', lat: 36.82, lng: 127.12 };
  });

  test('지도를 못 그리면 지도를 접고 목록으로 안내, 인터넷이 돌아오면 다시 불러온다 (SFR-062)', async () => {
    const { HospitalMap } = loadMap(KEY);
    const r = await render(<HospitalMap {...props} />);
    const web = screen.getByTestId('kakao-map');
    await act(async () => web.props.onMessage(msg({ type: 'fail', reason: 'sdk_load' })));
    expect(
      screen.getByText('지도를 불러오지 못했어요 · 승인 병원 목록으로 보여 드려요'),
    ).toBeTruthy();
    expect(screen.queryByTestId('kakao-map')).toBeNull();
    await r.rerender(<HospitalMap {...props} online={false} />);
    await r.rerender(<HospitalMap {...props} online />);
    expect(screen.getByTestId('kakao-map')).toBeTruthy();
  });

  test('오프라인이면 처음부터 목록만', async () => {
    const { HospitalMap } = loadMap(KEY);
    await render(<HospitalMap {...props} online={false} />);
    expect(screen.queryByTestId('kakao-map')).toBeNull();
    expect(screen.getByText(/오프라인이라 지도를 보여 줄 수 없어요/)).toBeTruthy();
  });

  test('승인 카드에서 고른 병원은 지도 아래 띠에 나오고, 누르면 병원 상세', async () => {
    const { HospitalMap } = loadMap(KEY);
    const onDetail = jest.fn();
    await render(<HospitalMap {...props} selectedId="h2" onDetail={onDetail} />);
    expect(screen.getByText('승인 병원 지도')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'B병원 자세히' }));
    expect(onDetail).toHaveBeenCalledWith('h2');
  });

  test('좌표 있는 승인 병원이 없으면 지도 칸을 만들지 않는다', async () => {
    const { HospitalMap } = loadMap(KEY);
    await render(<HospitalMap {...props} approvedIds={['zz']} />);
    expect(screen.queryByText(/지도/)).toBeNull();
  });
});
