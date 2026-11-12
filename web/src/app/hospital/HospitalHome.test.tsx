import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockFetch, renderWithQuery } from '@/testing/render';
import { HospitalHome, StatusChip } from './HospitalHome';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

beforeEach(() => replace.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HospitalHome', () => {
  it('등록 안 된 PC 는 키 입력 화면으로 보낸다', async () => {
    mockFetch({ status: 401, body: apiError('PC_NOT_REGISTERED') });
    renderWithQuery(<HospitalHome />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/hospital/register'));
  });

  it('등록된 PC 면 병원·PC 이름을 보여준다', async () => {
    const fetchFn = mockFetch({
      status: 200,
      body: {
        hospital: { id: 1, name: 'A병원' },
        pc: { id: 7, name: '응급실 접수대' },
        shift: null,
      },
    });
    renderWithQuery(<HospitalHome />);
    expect(await screen.findByText('A병원')).toBeDefined();
    expect(screen.getByText(/응급실 접수대/)).toBeDefined();
    expect(fetchFn.mock.calls[0][0]).toBe('/api/v1/hw/session');
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('근무 시작');
  });

  it('키 기간이 끝났으면 안내 문구', async () => {
    mockFetch({ status: 403, body: apiError('LICENSE_EXPIRED') });
    renderWithQuery(<HospitalHome />);
    expect((await screen.findByRole('alert')).textContent).toContain('새 키를 요청');
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('StatusChip (위쪽 띠의 상태 표시)', () => {
  it.each([
    [false, false, '근무 전'],
    [true, false, '근무 중'],
    [true, true, '요청 잠시 멈춤'],
  ])('근무 %s · 멈춤 %s → %s (색만이 아니라 글자로도)', (shift, paused, text) => {
    render(<StatusChip shift={shift} paused={paused} />);
    expect(screen.getByText(text)).toBeDefined();
  });
});
