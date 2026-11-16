// SER-006 비밀번호 규칙과 임시 비밀번호가 규칙을 지키는지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTempPassword } from '../admin/paramedics.js';
import { meetsPasswordRule } from './password.js';

test('8자 이상이고 영문과 숫자가 모두 있어야 한다', () => {
  assert.equal(meetsPasswordRule('abcd1234'), true);
  assert.equal(meetsPasswordRule('Ab3!Ab3!'), true);
  assert.equal(meetsPasswordRule('abc1234'), false, '7자');
  assert.equal(meetsPasswordRule('onlyletters'), false, '숫자 없음');
  assert.equal(meetsPasswordRule('1234567890'), false, '영문 없음');
  assert.equal(meetsPasswordRule('비밀번호123456'), false, '한글은 영문이 아님');
});

test('관리자가 만드는 임시 비밀번호도 규칙을 지킨다', () => {
  for (let i = 0; i < 2000; i += 1) {
    assert.ok(meetsPasswordRule(newTempPassword()));
  }
});
