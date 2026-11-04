// 이상 수치 강조 기준 (요구사항 10_부록 E, SFR-118·155, D-38).
// 앱은 위급도를 판정하지 않는다. 정해진 범위를 벗어난 값을 '빨간색으로 보여 줄 항목'으로만 골라낸다.
// 성인 기준이라 1세 미만·1~14세(소아)는 강조하지 않고 값만 보여 준다 (소아 기준은 나중에 추가).

export interface AbnormalInput {
  ageBand?: string | null;
  consciousness?: string | null;
  bp?: string | null; // '160/95' 또는 'unknown'
  pulse?: number | null;
  resp?: number | null;
  spo2?: number | null;
  temp?: number | null;
  glucose?: number | null;
  painScore?: number | null;
}

// 화면에 보여 주는 순서 그대로. 값은 API 의 Assessment 칸 이름
export type AbnormalField =
  | 'consciousness'
  | 'bp'
  | 'pulse'
  | 'resp'
  | 'spo2'
  | 'temp'
  | 'glucose'
  | 'painScore';

const CHILD_AGE_BANDS = new Set(['under1', '1-14']);

const has = (v: number | null | undefined): v is number => typeof v === 'number';

// '160/95' → 160. 숫자가 아니면(확인 불가 등) 판정하지 않는다
function systolic(bp: string | null | undefined): number | null {
  const match = /^(\d{2,3})\/\d{2,3}$/.exec(bp?.trim() ?? '');
  return match ? Number(match[1]) : null;
}

export function abnormalFields(a: AbnormalInput): AbnormalField[] {
  if (a.ageBand && CHILD_AGE_BANDS.has(a.ageBand)) return [];
  const sys = systolic(a.bp);
  const rules: [AbnormalField, boolean][] = [
    ['consciousness', a.consciousness === 'pain' || a.consciousness === 'unresponsive'],
    ['bp', sys !== null && (sys < 90 || sys >= 180)],
    ['pulse', has(a.pulse) && (a.pulse < 50 || a.pulse > 120)],
    ['resp', has(a.resp) && (a.resp < 10 || a.resp > 30)],
    ['spo2', has(a.spo2) && a.spo2 < 90],
    ['temp', has(a.temp) && (a.temp < 35 || a.temp >= 39)],
    ['glucose', has(a.glucose) && (a.glucose < 70 || a.glucose >= 300)],
    ['painScore', has(a.painScore) && a.painScore >= 8],
  ];
  return rules.filter(([, abnormal]) => abnormal).map(([field]) => field);
}
