import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer, renderWithQuery } from '@/testing/render';
import { EmptyRequestDetail, RequestDetail } from './RequestDetail';

const NOW = Date.parse('2026-11-03T14:00:00Z');

function detail(extra: object = {}) {
  return {
    id: 102,
    label: 'R-102',
    version: 1,
    status: 'waiting',
    respondUntil: new Date(NOW + 25_000).toISOString(),
    serverNow: new Date(NOW).toISOString(),
    assessment: {
      chiefComplaint: '갑작스러운 두통',
      sex: 'M',
      ageBand: '60s',
      spo2: 86,
      pulse: 88,
      unknownFields: [],
    },
    abnormalFields: ['spo2'],
    updatedFields: [],
    etaMin: 12,
    etaSource: 'route',
    prevApprovedRecheck: false,
    ourHospital: { capability: null, beds: { er: '5/20', icu: '0/10', or: '1/4' } },
    validApprovals: 0,
    respondedBy: null,
    memo: null,
    ...extra,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('요청 상세 (SFR-118)', () => {
  it('환자 평가·도착 예상·우리 병원 병상을 보여 주고, 이상 수치만 빨간색', async () => {
    fakeServer({ 'GET /hw/requests/102': { status: 200, body: detail() } });
    renderWithQuery(<RequestDetail requestId={102} nowMs={NOW} onClose={() => {}} />);

    // 제목: R-번호 · 성별 · 나이대 · 주 증상
    expect(
      await screen.findByRole('heading', { level: 2, name: 'R-102 · 남 · 60대 · 갑작스러운 두통' }),
    ).toBeTruthy();
    expect(screen.getByText('12분')).toBeTruthy();
    // 우리 병원 칸: 응급실·수술실·중환자실
    expect(screen.getByText('5/20')).toBeTruthy();
    expect(screen.getByText('1/4')).toBeTruthy();
    expect(screen.getByText('0/10')).toBeTruthy();
    // 산소포화도 86%만 강조, 맥박 88은 기본 (인수 기준)
    const spo2 = screen.getByText('⚠ 86%');
    expect(spo2.className).toContain('text-destructive');
    expect(screen.getByText('88회/분 · —').className).not.toContain('text-destructive');
    // 남은 시간 25초 → 빨간색
    expect(screen.getByText('남은 0:25').className).toContain('text-destructive');
  });

  it('목록이 길찾기 값으로 바뀌었으면 상세도 그 값을 쓴다 (먼저 받은 추정값 대신)', async () => {
    fakeServer({
      'GET /hw/requests/102': { status: 200, body: detail({ etaSource: 'straight', etaMin: 3 }) },
    });
    renderWithQuery(
      <RequestDetail requestId={102} nowMs={NOW} listEta={{ etaMin: 6, etaSource: 'route' }} />,
    );
    expect(await screen.findByText('6분')).toBeTruthy();
    expect(screen.queryByText(/추정/)).toBeNull();
  });

  it('길찾기 전 추정 시간은 (추정)으로', async () => {
    fakeServer({
      'GET /hw/requests/102': { status: 200, body: detail({ etaSource: 'straight', etaMin: 9 }) },
    });
    renderWithQuery(<RequestDetail requestId={102} nowMs={NOW} onClose={() => {}} />);
    expect(await screen.findByText('약 9분 (추정)')).toBeTruthy();
  });

  // 상세는 열람 기록 때문에 다시 받지 않는다. 확정 뒤 시간은 도착 예정 목록(이미 받아 둔 값)을 따른다
  function renderWithIncoming(items: object[]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['hw', 'incoming'], { items });
    return render(
      <QueryClientProvider client={client}>
        <RequestDetail requestId={102} nowMs={NOW} onClose={() => {}} />
      </QueryClientProvider>,
    );
  }

  it('확정 뒤에는 요청 때 추정값 대신 도착 예정 목록의 내비 남은 시간을 보여 준다', async () => {
    // 도착 예정 목록은 여기서 다시 받지 않는다 (가짜 서버에 /hw/incoming 이 없어 부르면 실패)
    fakeServer({
      'GET /hw/requests/102': {
        status: 200,
        body: detail({ status: 'confirmed', etaSource: 'straight', etaMin: 3 }),
      },
    });
    renderWithIncoming([{ id: 102, status: 'confirmed', etaMin: 4 }]);
    expect(await screen.findByText('4분')).toBeTruthy();
    expect(screen.queryByText(/추정/)).toBeNull();
  });

  it('도착한 뒤에는 예상 시간 대신 도착 시각', async () => {
    fakeServer({
      'GET /hw/requests/102': {
        status: 200,
        body: detail({ status: 'arrived', etaSource: 'straight', etaMin: 3 }),
      },
    });
    const arrivedAt = new Date(2026, 10, 12, 9, 34).toISOString();
    renderWithIncoming([{ id: 102, status: 'arrived', etaMin: 1, arrivedAt }]);
    expect(await screen.findByText('09:34 도착')).toBeTruthy();
    expect(screen.queryByText(/3분/)).toBeNull();
  });

  it('도착 예정 목록을 아직 못 받았어도 도착한 건에 예전 예상 시간을 보여 주지 않는다', async () => {
    fakeServer({
      'GET /hw/requests/102': {
        status: 200,
        body: detail({ status: 'arrived', etaSource: 'straight', etaMin: 3 }),
      },
    });
    renderWithIncoming([]);
    expect(await screen.findByText(/갑작스러운 두통/)).toBeTruthy();
    expect(screen.queryByText(/3분/)).toBeNull();
  });

  it('끝난 요청이면 환자 정보 없이 안내만', async () => {
    fakeServer({
      'GET /hw/requests/102': {
        status: 409,
        body: apiError('REQUEST_CLOSED', { status: 'closed' }),
      },
    });
    renderWithQuery(<RequestDetail requestId={102} nowMs={NOW} onClose={() => {}} />);
    expect(
      await screen.findByText('이미 끝난 요청이에요 (닫힘). 환자 정보는 볼 수 없어요.'),
    ).toBeTruthy();
  });

  it('다른 병원 요청·없는 요청(404)이면 서버 문구로 안내', async () => {
    fakeServer({ 'GET /hw/requests/102': { status: 404, body: apiError('NOT_FOUND') } });
    renderWithQuery(<RequestDetail requestId={102} nowMs={NOW} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/갑작스러운 두통/)).toBeNull();
  });

  it('근무 전이면(SHIFT_REQUIRED) 근무를 먼저 시작하라고 안내', async () => {
    fakeServer({ 'GET /hw/requests/102': { status: 409, body: apiError('SHIFT_REQUIRED') } });
    renderWithQuery(<RequestDetail requestId={102} nowMs={NOW} onClose={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toContain('근무를 먼저 시작해 주세요');
  });

  it('요청이 없어도 환자 평가 정보·우리 병원 칸은 그대로: 환자 값은 —, 병상은 지금 값, 승인·거절 자리는 안내만', () => {
    renderWithQuery(<EmptyRequestDetail beds={{ er: '3/12', icu: '2/10', or: '1/4' }} />);
    expect(screen.getByText('환자 평가 정보')).toBeTruthy();
    expect(screen.getByText('우리 병원')).toBeTruthy();
    expect(screen.getByText('3/12')).toBeTruthy();
    expect(screen.getByText('1/4')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(5);
    expect(screen.getByText('요청이 오면 여기서 승인·거절해요')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '승인' })).toBeNull();
  });

  it('요청 상세에 병상이 없으면 근무 화면의 병상을 쓴다', async () => {
    fakeServer({
      'GET /hw/requests/102': {
        status: 200,
        body: detail({ ourHospital: { capability: null, beds: null } }),
      },
    });
    renderWithQuery(
      <RequestDetail requestId={102} nowMs={NOW} beds={{ er: '7/20', icu: null, or: null }} />,
    );
    expect(await screen.findByText('7/20')).toBeTruthy();
  });
});
