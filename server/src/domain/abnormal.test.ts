// 부록 E 이상 수치 기준의 경계값을 확인한다 (SFR-118 인수 기준 포함)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abnormalFields } from './abnormal.js';

test('산소포화도 86%, 맥박 88 → 산소포화도만 강조 (SFR-118 인수 기준)', () => {
  assert.deepEqual(abnormalFields({ ageBand: '60s', spo2: 86, pulse: 88 }), ['spo2']);
});

test('경계값: 기준선에 걸리는 값과 바로 안쪽 값', () => {
  const cases: [object, string[]][] = [
    [{ bp: '89/60' }, ['bp']],
    [{ bp: '90/60' }, []],
    [{ bp: '179/100' }, []],
    [{ bp: '180/100' }, ['bp']],
    [{ pulse: 49 }, ['pulse']],
    [{ pulse: 50 }, []],
    [{ pulse: 120 }, []],
    [{ pulse: 121 }, ['pulse']],
    [{ resp: 9 }, ['resp']],
    [{ resp: 10 }, []],
    [{ resp: 30 }, []],
    [{ resp: 31 }, ['resp']],
    [{ spo2: 89 }, ['spo2']],
    [{ spo2: 90 }, []],
    [{ temp: 34.9 }, ['temp']],
    [{ temp: 35 }, []],
    [{ temp: 38.9 }, []],
    [{ temp: 39 }, ['temp']],
    [{ glucose: 69 }, ['glucose']],
    [{ glucose: 70 }, []],
    [{ glucose: 299 }, []],
    [{ glucose: 300 }, ['glucose']],
    [{ painScore: 7 }, []],
    [{ painScore: 8 }, ['painScore']],
    [{ consciousness: 'verbal' }, []],
    [{ consciousness: 'pain' }, ['consciousness']],
    [{ consciousness: 'unresponsive' }, ['consciousness']],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(abnormalFields(input), expected, JSON.stringify(input));
  }
});

test('혈압이 확인 불가이거나 값이 없으면 판정하지 않는다', () => {
  assert.deepEqual(abnormalFields({ bp: 'unknown', pulse: null, spo2: undefined }), []);
});

test('여러 항목은 화면 순서대로', () => {
  assert.deepEqual(abnormalFields({ spo2: 85, bp: '80/50', consciousness: 'pain' }), [
    'consciousness',
    'bp',
    'spo2',
  ]);
});

test('1세 미만·소아는 강조하지 않는다 (성인 기준이라)', () => {
  for (const ageBand of ['under1', '1-14']) {
    assert.deepEqual(abnormalFields({ ageBand, spo2: 80, pulse: 160 }), []);
  }
  assert.deepEqual(abnormalFields({ ageBand: '15-19', spo2: 80 }), ['spo2']);
});
