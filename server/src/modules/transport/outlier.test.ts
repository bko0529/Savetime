// SFR-040 위치 이상치 판정 (DB 없이)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagOutliers, type TimedPoint } from './outlier.js';

const t0 = Date.UTC(2026, 10, 11, 0, 0, 0);
// 위도 0.001도 ≈ 111m
const p = (lat: number, sec: number): TimedPoint => ({
  lat: 36 + lat,
  lng: 127,
  recordedAt: new Date(t0 + sec * 1000),
});

test('직전 정상 좌표 대비 초속 60m를 넘으면 이상치다', () => {
  // 5초에 약 278m(초속 56m) → 정상, 1초에 약 667m → 이상치
  assert.deepEqual(flagOutliers(null, [p(0, 0), p(0.0025, 5), p(0.0085, 6)]), [false, false, true]);
});

test('튄 좌표 뒤 좌표는 튄 좌표가 아니라 직전 정상 좌표와 비교한다', () => {
  assert.deepEqual(flagOutliers(null, [p(0, 0), p(0.05, 1), p(0.0001, 2)]), [false, true, false]);
});

test('앞 정상 좌표(anchor)부터 이어서 판정하고, 첫 좌표는 비교할 것이 없어 정상이다', () => {
  assert.deepEqual(flagOutliers(p(0, 0), [p(0.01, 1)]), [true]);
  assert.deepEqual(flagOutliers(null, [p(0.01, 1)]), [false]);
});

test('시간이 지나면 허용 거리가 늘어 첫 좌표가 틀렸어도 다시 정상으로 잡힌다', () => {
  // 첫 좌표가 1km 틀림 → 5초 뒤(허용 300m)는 이상치, 20초 뒤(허용 1.2km)는 정상
  assert.deepEqual(flagOutliers(null, [p(0.009, 0), p(0, 5), p(0, 20)]), [false, true, false]);
});
