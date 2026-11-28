import { describe, expect, it } from 'vitest';
import { comparableCount, diffOf, METRICS, weightedAverage } from './compareStats';

const rate = METRICS.find((m) => m.key === 'responseRate')!;
const sec = METRICS.find((m) => m.key === 'avgResponseSec')!;

describe('병원 통계 비교 계산', () => {
  it('전체 평균은 요청 수로 가중하고, 표본 부족 병원은 뺀다', () => {
    const all = [
      { hospitalId: 1, requests: 30, responseRate: 0.9 },
      { hospitalId: 2, requests: 10, responseRate: 0.5 },
      { hospitalId: 3, requests: 5, responseRate: 0.0, sampleTooSmall: true },
    ];
    // (0.9×30 + 0.5×10) / 40 = 0.8
    expect(weightedAverage(all, 'responseRate')).toBeCloseTo(0.8);
    expect(comparableCount(all)).toBe(2);
    expect(weightedAverage([], 'responseRate')).toBeNull();
  });

  it('응답률은 높을수록, 시간은 짧을수록 좋음 (좋으면 good, 나쁘면 bad)', () => {
    expect(diffOf(rate, 0.08, 0.62)).toEqual({ text: '▼ 54%p', tone: 'bad' });
    expect(diffOf(rate, 0.9, 0.8)).toEqual({ text: '▲ 10%p', tone: 'good' });
    expect(diffOf(sec, 54, 41)).toEqual({ text: '▲ 13초', tone: 'bad' });
    expect(diffOf(sec, 70, 130)).toEqual({ text: '▼ 1분', tone: 'good' });
    expect(diffOf(sec, 60, 60)).toEqual({ text: '같음', tone: 'same' });
    expect(diffOf(sec, null, 60)).toBeNull();
  });
});
