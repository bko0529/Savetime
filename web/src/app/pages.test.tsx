import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AdminPage from './admin/page';
import HospitalPage from './hospital/page';

afterEach(cleanup);

describe('경로 틀', () => {
  it('병원 화면 제목', () => {
    render(<HospitalPage />);
    expect(screen.getByRole('heading', { name: '병원 이송 요청' })).toBeDefined();
  });

  it('관리자 화면 제목', () => {
    render(<AdminPage />);
    expect(screen.getByRole('heading', { name: '관리자' })).toBeDefined();
  });
});
