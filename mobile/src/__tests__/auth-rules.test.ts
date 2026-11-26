import type { Me } from '../api/client';
import { checkLoginForm } from '../auth/loginForm';
import { statusMessage } from '../auth/statusMessage';

test('빈 아이디·비밀번호는 서버에 보내지 않는다', () => {
  expect(checkLoginForm({ loginId: '  ', password: 'x' })).toEqual({
    ok: false,
    message: '아이디를 입력해 주세요',
  });
  expect(checkLoginForm({ loginId: 'kim', password: '' })).toEqual({
    ok: false,
    message: '비밀번호를 입력해 주세요',
  });
});

test('아이디 앞뒤 공백은 지운다', () => {
  expect(checkLoginForm({ loginId: ' kim ', password: 'pw' })).toEqual({
    ok: true,
    value: { loginId: 'kim', password: 'pw' },
  });
});

test.each([
  ['pending', '승인 대기 중'],
  ['rejected', '가입이 반려됐어요'],
  ['suspended', '이용이 정지된 계정이에요'],
  ['approved', '김도윤 소방교님'],
] as const)('me.status=%s → %s', (status, title) => {
  const me: Me = { id: 1, name: '김도윤', rank: '소방교', status };
  expect(statusMessage(me).title).toBe(title);
});
