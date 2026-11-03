import { describe, expect, it } from 'vitest';
import { ageBandText, fieldText, isUrgent, remainingText, type Assessment } from './labels';

const base: Assessment = { chiefComplaint: '흉통', unknownFields: [] };

describe('환자 평가 표시 문구', () => {
  it('나이대를 한국어로', () => {
    expect(ageBandText('60s')).toBe('60대');
    expect(ageBandText('1-14')).toBe('1~14세');
    expect(ageBandText('under1')).toBe('1세 미만');
    expect(ageBandText('90plus')).toBe('90세 이상');
  });

  it('값에 단위를 붙이고, 없는 칸은 null 이라 화면에서 뺀다', () => {
    const a: Assessment = { ...base, bp: '160/95', spo2: 86, temp: 38, consciousness: 'pain' };
    expect(fieldText(a, 'bp')).toBe('160/95 mmHg');
    expect(fieldText(a, 'spo2')).toBe('86%');
    expect(fieldText(a, 'temp')).toBe('38.0℃');
    expect(fieldText(a, 'consciousness')).toBe('통증 반응 (P)');
    expect(fieldText(a, 'pulse')).toBeNull();
  });

  it("'확인 불가'로 보낸 칸은 그렇게 보여 준다", () => {
    expect(fieldText({ ...base, unknownFields: ['pulse'] }, 'pulse')).toBe('확인 불가');
    expect(fieldText({ ...base, bp: 'unknown' }, 'bp')).toBe('확인 불가');
  });
});

describe('남은 시간', () => {
  const until = new Date(100_000).toISOString();
  it("'m:ss' 로 보여 주고 지나면 0:00", () => {
    expect(remainingText(until, 100_000 - 95_000)).toBe('1:35');
    expect(remainingText(until, 100_000 - 25_000)).toBe('0:25');
    expect(remainingText(until, 200_000)).toBe('0:00');
  });
  it('30초 이하면 급함 (SFR-135)', () => {
    expect(isUrgent(until, 100_000 - 31_000)).toBe(false);
    expect(isUrgent(until, 100_000 - 30_000)).toBe(true);
  });
});
