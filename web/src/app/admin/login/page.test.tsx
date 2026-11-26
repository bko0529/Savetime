import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/testing/render';
import { AdminAuthProvider } from '../AdminAuth';
import AdminLoginPage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/admin/login',
}));

afterEach(cleanup);

describe('관리자 로그인 화면', () => {
  it('새로고침하면 다시 로그인해야 한다는 안내가 보인다 (토큰을 메모리에만 두는 보안 설계)', () => {
    renderWithQuery(
      <AdminAuthProvider>
        <AdminLoginPage />
      </AdminAuthProvider>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('관리자 로그인');
    expect(screen.getByText('새로고침하면 다시 로그인해야 해요.')).toBeTruthy();
  });
});
