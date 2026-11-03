import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockFetch, renderWithQuery } from '@/testing/render';
import { HospitalHome } from './HospitalHome';

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
  });

  it('키 기간이 끝났으면 안내 문구', async () => {
    mockFetch({ status: 403, body: apiError('LICENSE_EXPIRED') });
    renderWithQuery(<HospitalHome />);
    expect((await screen.findByRole('alert')).textContent).toContain('새 키를 요청');
    expect(replace).not.toHaveBeenCalled();
  });
});
