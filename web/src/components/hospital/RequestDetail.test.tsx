import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer, renderWithQuery } from '@/testing/render';
import { RequestDetail } from './RequestDetail';

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

    // 제목: 번호 · 성별 나이대 · 주 증상
    expect(
      (await screen.findByRole('heading', { level: 2, name: 'R-102 · 남 60대 · 갑작스러운 두통' }))
        .textContent,
    ).toBeTruthy();
    // 남은 시간 25초 → 빨간색 칩
    expect(screen.getByText('0:25').className).toContain('text-destructive');
    // 환자 평가 정보 카드: 산소포화도 86%만 강조, 맥박 88은 기본 (인수 기준)
    expect(screen.getByRole('region', { name: '환자 평가 정보' })).toBeTruthy();
    const spo2 = screen.getByText('⚠ 86%');
    expect(spo2.className).toContain('text-destructive');
    expect(screen.getByText('88회/분').className).not.toContain('text-destructive');
    // 우리 병원 카드: 병상(빈 병상 / 전체)과 길찾기로 잰 도착 예상
    const ours = screen.getByRole('region', { name: '우리 병원' });
    expect(ours.textContent).toContain('응급실5 / 20');
    expect(ours.textContent).toContain('수술실1 / 4');
    expect(ours.textContent).toContain('중환자실0 / 10');
    expect(ours.textContent).toContain('도착 예상12분 (길찾기)');
    // 승인 전 안내: 지금 유효한 승인과 응급실 빈 병상
    expect(screen.getByText(/지금 유효한 승인 0건 · 응급실 병상 5개/)).toBeTruthy();
  });

  it("대원이 '확인 불가'로 보낸 칸은 X, 성별·나이를 모르면 제목에 '성별 X'·'나이 X'", async () => {
    fakeServer({
      'GET /hw/requests/102': {
        status: 200,
        body: detail({
          assessment: {
            chiefComplaint: '의식 저하',
            sex: 'U',
            ageBand: '60s',
            bp: 'unknown',
            unknownFields: ['ageBand', 'pulse'],
          },
          abnormalFields: [],
        }),
      },
    });
    renderWithQuery(<RequestDetail requestId={102} nowMs={NOW} onClose={() => {}} />);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'R-102 · 성별 X 나이 X · 의식 저하' }),
    ).toBeTruthy();
    const card = screen.getByRole('region', { name: '환자 평가 정보' });
    // 혈압('unknown')과 맥박(unknownFields) 둘 다 X
    expect(card.querySelectorAll('[data-unknown]')).toHaveLength(2);
    expect(card.textContent).toContain('혈압X확인 불가');
    expect(card.textContent).toContain('맥박X확인 불가');
  });

  it('수술 가능 여부를 우리 병원 카드 맨 위에', async () => {
    fakeServer({
      'GET /hw/requests/102': {
        status: 200,
        body: detail({
          ourHospital: { capability: { name: '뇌출혈수술', available: true }, beds: null },
        }),
      },
    });
    renderWithQuery(<RequestDetail requestId={102} nowMs={NOW} onClose={() => {}} />);
    expect(await screen.findByText('[뇌출혈수술]')).toBeTruthy();
    expect(screen.getByText('가능 ✓')).toBeTruthy();
    // 병상 정보가 없으면 승인 전 안내를 보여 주지 않는다
    expect(screen.queryByText(/지금 유효한 승인/)).toBeNull();
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
    expect(screen.queryByText(/도착 예상/)).toBeNull();
  });

  it('도착 예정 목록을 아직 못 받았어도 도착한 건에 예전 예상 시간을 보여 주지 않는다', async () => {
    fakeServer({
      'GET /hw/requests/102': {
        status: 200,
        body: detail({ status: 'arrived', etaSource: 'straight', etaMin: 3 }),
      },
    });
    renderWithIncoming([]);
    expect(await screen.findByRole('region', { name: '우리 병원' })).toBeTruthy();
    expect(screen.queryByText(/도착 예상/)).toBeNull();
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
    expect(screen.queryByText('갑작스러운 두통')).toBeNull();
  });

  it('근무 전이면(SHIFT_REQUIRED) 근무를 먼저 시작하라고 안내', async () => {
    fakeServer({ 'GET /hw/requests/102': { status: 409, body: apiError('SHIFT_REQUIRED') } });
    renderWithQuery(<RequestDetail requestId={102} nowMs={NOW} onClose={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toContain('근무를 먼저 시작해 주세요');
  });

  it('닫기를 누르면 닫는다', async () => {
    fakeServer({ 'GET /hw/requests/102': { status: 200, body: detail() } });
    const onClose = vi.fn();
    renderWithQuery(<RequestDetail requestId={102} nowMs={NOW} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: '닫기' }));
    expect(onClose).toHaveBeenCalled();
  });
});
