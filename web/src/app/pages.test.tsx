import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AdminPage from './admin/page';

afterEach(cleanup);

// 병원 화면(/hospital)은 서버에 PC 등록 여부를 물어보므로 hospital/HospitalHome.test.tsx 에서 확인한다
describe('경로 틀', () => {
  it('관리자 화면 제목', () => {
    render(<AdminPage />);
    expect(screen.getByRole('heading', { name: '관리자' })).toBeDefined();
  });
});
