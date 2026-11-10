// AI 로 보내기 전 식별정보 지우기 (SER-017)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubIdentifiers } from './scrub.js';

test('이름 칸 값·전화번호·주민번호·주소를 지우고 개수만 센다', () => {
  assert.deepEqual(scrubIdentifiers('홍길동 010-1234-5678 60대 남성', ['홍길동']), {
    text: '[삭제] [삭제] 60대 남성',
    removed: 2,
  });
  assert.equal(scrubIdentifiers('보호자 01012345678').text, '보호자 [삭제]');
  assert.equal(scrubIdentifiers('보호자 02-123-4567').text, '보호자 [삭제]');
  assert.equal(scrubIdentifiers('900101-1234567').text, '[삭제]');
  assert.equal(scrubIdentifiers('주소 천안시 동남구 신부동 123-4').text, '주소 [삭제] [삭제]');
  assert.equal(scrubIdentifiers('번영로 123 앞 도로').text, '[삭제] 앞 도로');
  assert.equal(scrubIdentifiers('성거읍 55번지').text, '[삭제]');
  // 긴 이름부터, 같은 이름이 여러 번 나와도 모두
  assert.equal(
    scrubIdentifiers('홍길동씨 보호자 홍길 홍길동', ['홍길', '홍길동']).text,
    '[삭제]씨 보호자 [삭제] [삭제]',
  );
});

test('의료 수치·처치 문장은 주소로 잘못 지우지 않는다', () => {
  for (const text of [
    '60대 남성 갑자기 머리 아프다며 쓰러짐 고혈압약 복용 산소 4리터',
    '산소 마스크로 10L 투여',
    '병원으로 5분 이송',
    '운동 3회 후 흉통',
    '혈압 140/90 맥박 110 체온 38.5도',
    '오후 3시 쓰러짐, 당시 의식 저하 후 구토',
  ]) {
    assert.deepEqual(scrubIdentifiers(text), { text, removed: 0 }, text);
  }
});
