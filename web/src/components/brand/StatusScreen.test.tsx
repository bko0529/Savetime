import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErrorPage from '@/app/error';
import NotFound from '@/app/not-found';
import { StatusScreen } from './StatusScreen';

afterEach(cleanup);

describe('StatusScreen (없는 주소·오류·연결 실패 안내)', () => {
  it('제목은 화면 제목(h1)으로, 설명과 버튼도 함께 보인다', () => {
    render(
      <StatusScreen
        title="병원 웹을 열지 못했어요"
        action={<button type="button">다시 시도</button>}
      >
        서버에 연결할 수 없어요
      </StatusScreen>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('병원 웹을 열지 못했어요');
    expect(screen.getByText('서버에 연결할 수 없어요')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
  });

  it("잠깐 보이는 '확인 중…'은 화면 제목으로 두지 않는다", () => {
    render(<StatusScreen title="확인 중…" heading={false} />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('확인 중…')).toBeTruthy();
  });

  it('없는 주소: 처음 화면(/)으로 가는 링크', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('페이지를 찾을 수 없어요');
    expect(screen.getByRole('link', { name: '처음 화면으로' }).getAttribute('href')).toBe('/');
  });

  it('화면 오류: 오류 내용은 보여 주지 않고, 다시 시도를 누르면 reset 을 부른다', () => {
    const reset = vi.fn();
    render(<ErrorPage error={new Error('내부 정보 R-1 홍길동')} reset={reset} />);
    expect(document.body.textContent).not.toContain('내부 정보');
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
