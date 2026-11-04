import type { components } from '@/lib/api/schema';

export type Assessment = components['schemas']['Assessment'];
type Field = keyof Assessment;

// 환자 평가 칸 → 병원 직원이 읽는 한국어 (SFR-108 입력 항목과 같은 순서)
export const FIELD_LABEL: Partial<Record<Field, string>> = {
  sex: '성별',
  ageBand: '나이대',
  consciousness: '의식',
  bp: '혈압',
  pulse: '맥박',
  resp: '호흡수',
  spo2: '산소포화도',
  temp: '체온',
  glucose: '혈당',
  painSite: '통증 부위',
  painScore: '통증 정도',
  onset: '발생 시각',
  trauma: '외상',
  traumaCause: '외상 원인',
  history: '병력',
  ktas: 'Pre-KTAS',
};

const SEX: Record<string, string> = { M: '남', F: '여', U: '확인 불가' };
const CONSCIOUSNESS: Record<string, string> = {
  alert: '명료 (A)',
  verbal: '언어 반응 (V)',
  pain: '통증 반응 (P)',
  unresponsive: '무반응 (U)',
  unknown: '확인 불가',
};
const TRAUMA: Record<string, string> = { yes: '있음', no: '없음', unknown: '확인 불가' };
const TRAUMA_CAUSE: Record<string, string> = {
  traffic: '교통사고',
  fall_high: '추락',
  fall: '낙상',
  penetrating: '관통상',
  burn: '화상',
  etc: '기타',
};

// '60s' → '60대', '1-14' → '1~14세', 'under1' → '1세 미만', '90plus' → '90세 이상'
export function ageBandText(band: string): string {
  if (band === 'under1') return '1세 미만';
  if (band === '90plus') return '90세 이상';
  const decade = /^(\d+)s$/.exec(band);
  if (decade) return `${decade[1]}대`;
  const range = /^(\d+)-(\d+)$/.exec(band);
  if (range) return `${range[1]}~${range[2]}세`;
  return band;
}

// 값이 없으면 null (화면에서 그 줄을 뺀다). '확인 불가'로 보낸 칸은 그렇게 보여 준다
export function fieldText(a: Assessment, field: Field): string | null {
  if (a.unknownFields?.includes(field)) return '확인 불가';
  const value = a[field];
  if (value === null || value === undefined || value === '') return null;
  switch (field) {
    case 'sex':
      return SEX[String(value)] ?? String(value);
    case 'ageBand':
      return ageBandText(String(value));
    case 'consciousness':
      return CONSCIOUSNESS[String(value)] ?? String(value);
    case 'bp':
      return value === 'unknown' ? '확인 불가' : `${value} mmHg`;
    case 'pulse':
    case 'resp':
      return `${value}회/분`;
    case 'spo2':
      return `${value}%`;
    case 'temp':
      return `${Number(value).toFixed(1)}℃`;
    case 'glucose':
      return `${value} mg/dL`;
    case 'painScore':
      return `${value} / 10`;
    case 'trauma':
      return TRAUMA[String(value)] ?? String(value);
    case 'traumaCause':
      return TRAUMA_CAUSE[String(value)] ?? String(value);
    default:
      return String(value);
  }
}

// 남은 시간 'm:ss' (요구사항 예: '남은 시간 0:25'). 지났으면 0:00
export function remainingText(respondUntil: string, nowMs: number): string {
  const sec = Math.max(0, Math.floor((Date.parse(respondUntil) - nowMs) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// 30초 이하면 빨간색 (SFR-135)
export function isUrgent(respondUntil: string, nowMs: number): boolean {
  return Date.parse(respondUntil) - nowMs <= 30_000;
}
