import { cleanup, fireEvent, screen } from '@testing-library/react';
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

    expect(await screen.findByText('갑작스러운 두통')).toBeTruthy();
    expect(screen.getByText('도착 예상 12분')).toBeTruthy();
    expect(screen.getByText(/응급실 5\/20 · 수술실 1\/4 · 중환자실 0\/10/)).toBeTruthy();
    // 산소포화도 86%만 강조, 맥박 88은 기본 (인수 기준)
    const spo2 = screen.getByText('⚠ 86%');
    expect(spo2.className).toContain('text-destructive');
    expect(screen.getByText('88회/분').className).not.toContain('text-destructive');
    expect(screen.getByText('60대')).toBeTruthy();
    // 남은 시간 25초 → 빨간색
    expect(screen.getByText('남은 시간 0:25').className).toContain('text-destructive');
  });

  it('길찾기 전 추정 시간은 (추정)으로', async () => {
    fakeServer({
      'GET /hw/requests/102': { status: 200, body: detail({ etaSource: 'straight', etaMin: 9 }) },
    });
    renderWithQuery(<RequestDetail requestId={102} nowMs={NOW} onClose={() => {}} />);
    expect(await screen.findByText('도착 예상 약 9분 (추정)')).toBeTruthy();
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

  it('닫기를 누르면 닫는다', async () => {
    fakeServer({ 'GET /hw/requests/102': { status: 200, body: detail() } });
    const onClose = vi.fn();
    renderWithQuery(<RequestDetail requestId={102} nowMs={NOW} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: '닫기' }));
    expect(onClose).toHaveBeenCalled();
  });
});
