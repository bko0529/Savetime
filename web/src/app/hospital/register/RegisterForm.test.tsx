import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockFetch, renderWithQuery } from '@/testing/render';
import { RegisterForm } from './RegisterForm';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

beforeEach(() => replace.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fill(key = 'KEY-123', name = '응급실 접수대') {
  fireEvent.change(screen.getByLabelText('라이선스 키', { exact: false }), {
    target: { value: key },
  });
  fireEvent.change(screen.getByLabelText('PC 이름'), { target: { value: name } });
}

function submitButton() {
  return screen.getByRole('button', { name: /등록/ });
}

function sentBody(fetchFn: ReturnType<typeof mockFetch>, call = 0) {
  const [url, init = {}] = fetchFn.mock.calls[call];
  return { url, method: init.method, body: JSON.parse(init.body as string) };
}

describe('RegisterForm', () => {
  it('키·PC 이름을 다 넣어야 등록 버튼이 눌린다', () => {
    renderWithQuery(<RegisterForm />);
    expect(submitButton()).toHaveProperty('disabled', true);
    fill();
    expect(submitButton()).toHaveProperty('disabled', false);
  });

  it('PC 이름은 40자까지만 입력된다', () => {
    renderWithQuery(<RegisterForm />);
    expect(screen.getByLabelText('PC 이름').getAttribute('maxLength')).toBe('40');
  });

  it('성공하면 같은 사이트 /api/v1 로 보내고 근무 시작 화면으로 간다', async () => {
    const fetchFn = mockFetch({
      status: 201,
      body: { hospital: { id: 1, name: 'A병원' }, pcId: 7 },
    });
    renderWithQuery(<RegisterForm />);
    fill('  KEY-123 ', ' 응급실 접수대 ');
    fireEvent.click(submitButton());

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/hospital'));
    expect(sentBody(fetchFn)).toEqual({
      url: '/api/v1/hw/pc/register',
      method: 'POST',
      body: { licenseKey: 'KEY-123', pcName: '응급실 접수대', replacePcId: null },
    });
  });

  it('성공하면 입력한 라이선스 키를 화면에서 지운다 (숨겨진 화면에 키가 남지 않게)', async () => {
    mockFetch({ status: 201, body: { hospital: { id: 1, name: 'A병원' }, pcId: 7 } });
    renderWithQuery(<RegisterForm />);
    fill('KEY-123');
    fireEvent.click(submitButton());
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/hospital'));
    expect((screen.getByLabelText('라이선스 키', { exact: false }) as HTMLInputElement).value).toBe(
      '',
    );
  });

  it.each([
    ['INVALID_LICENSE', '라이선스 키가 맞지 않아요'],
    ['LICENSE_EXPIRED', '관리자에게 새 키를 요청'],
    ['TOO_MANY_ATTEMPTS', '10분 동안 입력할 수 없어요'],
  ])('%s 이면 쉬운 문구를 보여준다', async (code, text) => {
    mockFetch({ status: 401, body: apiError(code) });
    renderWithQuery(<RegisterForm />);
    fill();
    fireEvent.click(submitButton());
    expect((await screen.findByRole('alert')).textContent).toContain(text);
    expect(replace).not.toHaveBeenCalled();
  });

  it('모르는 오류 코드는 서버 문구를 그대로 보여준다', async () => {
    mockFetch({ status: 400, body: apiError('SOMETHING_NEW') });
    renderWithQuery(<RegisterForm />);
    fill();
    fireEvent.click(submitButton());
    expect((await screen.findByRole('alert')).textContent).toBe('SOMETHING_NEW (서버 문구)');
  });

  it('서버가 꺼져 있으면 연결 문구', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderWithQuery(<RegisterForm />);
    fill();
    fireEvent.click(submitButton());
    expect((await screen.findByRole('alert')).textContent).toContain('서버에 연결할 수 없어요');
  });

  it('3대가 꽉 차면 기존 PC 를 골라 바꿔 등록한다', async () => {
    const pcs = [
      { id: 11, name: '접수대', lastUsedAt: '2026-11-01T09:00:00Z' },
      { id: 12, name: '처치실', lastUsedAt: null },
      { id: 13, name: '간호사실', lastUsedAt: '2026-10-20T09:00:00Z' },
    ];
    const fetchFn = mockFetch(
      { status: 409, body: apiError('PC_LIMIT_REACHED', { pcs }) },
      { status: 201, body: { hospital: { id: 1, name: 'A병원' }, pcId: 14 } },
    );
    renderWithQuery(<RegisterForm />);
    fill();
    fireEvent.click(submitButton());

    expect(await screen.findByText(/PC 3대가 모두 등록돼 있어요/)).toBeDefined();
    expect(screen.getByText('사용 기록 없음')).toBeDefined();
    expect(screen.getAllByText(/^마지막 사용 /)).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
    // 바꿀 PC 를 고르기 전에는 못 누른다
    expect(submitButton()).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByRole('radio', { name: /처치실/ }));
    fireEvent.click(screen.getByRole('button', { name: '이 PC로 바꿔 등록' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/hospital'));
    expect(sentBody(fetchFn, 1).body.replacePcId).toBe(12);
  });
});
