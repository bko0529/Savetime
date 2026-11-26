/**
 * 환자 평가 입력 (CR-007 필수 12개) → 서버 평가 항목(openapi Assessment).
 * 규칙 2 (SER-012): 환자 이름·주민번호·전화번호·주소 칸은 아예 없다. 서버로는 증상·측정값만 간다.
 */
import type { Grade } from './hospitals';

export type Patient = {
  grade: Grade;
  complaint: string;
  sex: string;
  age: string;
  consciousness: string;
  bp: string;
  pulse: string;
  resp: string;
  spo2: string;
  painSite: string;
  painScore: string;
  onset: string;
  trauma: string;
  history: string;
  temp: string;
  glucose: string;
  ktas: string;
};

export const emptyPatient: Patient = {
  grade: null,
  complaint: '',
  sex: '',
  age: '',
  consciousness: '',
  bp: '',
  pulse: '',
  resp: '',
  spo2: '',
  painSite: '',
  painScore: '',
  onset: '',
  trauma: '',
  history: '',
  temp: '',
  glucose: '',
  ktas: '',
};

/** 필수 12개 항목 (요구사항 CR-007) */
export const REQUIRED_FIELDS: (keyof Patient)[] = [
  'complaint',
  'sex',
  'age',
  'consciousness',
  'bp',
  'pulse',
  'resp',
  'spo2',
  'painSite',
  'painScore',
  'onset',
  'trauma',
];

export const UNKNOWN = '확인 불가';

export function filledCount(p: Patient) {
  return REQUIRED_FIELDS.filter((k) => String(p[k] ?? '').trim() !== '').length;
}

const CONSC: Record<string, string> = {
  명료: 'alert',
  '말에 반응': 'verbal',
  '통증에 반응': 'pain',
  무반응: 'unresponsive',
};
const known = (v: string) => v.trim() !== '' && v !== UNKNOWN;
const int = (v: string) => {
  const n = Number.parseInt(v, 10);
  return known(v) && Number.isFinite(n) ? n : null;
};

/** 화면 입력 → 서버 평가 항목. 범위를 벗어난 값은 null 로 보낸다 (Lovable toAssessment 그대로) */
export function toAssessment(p: Patient) {
  const unknownFields: string[] = [];
  const pairs: [string, string][] = [
    ['chiefComplaint', p.complaint],
    ['sex', p.sex],
    ['ageBand', p.age],
    ['consciousness', p.consciousness],
    ['bp', p.bp],
    ['pulse', p.pulse],
    ['resp', p.resp],
    ['spo2', p.spo2],
    ['painSite', p.painSite],
    ['painScore', p.painScore],
    ['onset', p.onset],
    ['trauma', p.trauma],
  ];
  for (const [field, v] of pairs) if (v === UNKNOWN) unknownFields.push(field);
  const painScore = int(p.painScore);
  const temp = Number.parseFloat(p.temp);
  const ktas = int(p.ktas);
  return {
    chiefComplaint: p.complaint.trim().slice(0, 100) || UNKNOWN,
    sex: p.sex === '남' ? 'M' : p.sex === '여' ? 'F' : 'U',
    ageBand: known(p.age) ? p.age.slice(0, 10) : UNKNOWN,
    consciousness: CONSC[p.consciousness] ?? 'unknown',
    ...(known(p.bp) ? { bp: p.bp.slice(0, 10) } : {}),
    pulse: int(p.pulse),
    resp: int(p.resp),
    spo2: int(p.spo2),
    painSite: known(p.painSite) ? p.painSite.slice(0, 30) : null,
    painScore: painScore !== null && painScore >= 0 && painScore <= 10 ? painScore : null,
    onset: known(p.onset) ? p.onset.slice(0, 30) : null,
    trauma: !known(p.trauma) ? 'unknown' : /없|무|^no$/i.test(p.trauma.trim()) ? 'no' : 'yes',
    history: known(p.history) ? p.history.slice(0, 500) : null,
    temp: known(p.temp) && temp >= 20 && temp <= 45 ? temp : null,
    glucose: int(p.glucose),
    ktas: ktas !== null && ktas >= 1 && ktas <= 5 ? ktas : null,
    unknownFields,
  };
}
