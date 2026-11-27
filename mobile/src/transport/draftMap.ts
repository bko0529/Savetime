/**
 * 화면 입력 칸(Patient) ↔ 서버 팀 작성 중 정보(Assessment) 항목 하나씩 바꾸기 (SFR-114).
 * 바뀐 칸만 서버로 보내야 팀원이 동시에 다른 칸을 고쳐도 서로 덮어쓰지 않는다.
 * 환자 이름·연락처 칸은 없다 (SER-012). 서버도 Assessment 밖의 칸은 400 으로 막는다.
 */
import { UNKNOWN, type Patient } from './patient';

type Key = Exclude<keyof Patient, 'grade'>;
export const DRAFT_KEY: Record<Key, string> = {
  complaint: 'chiefComplaint',
  sex: 'sex',
  age: 'ageBand',
  consciousness: 'consciousness',
  bp: 'bp',
  pulse: 'pulse',
  resp: 'resp',
  spo2: 'spo2',
  painSite: 'painSite',
  painScore: 'painScore',
  onset: 'onset',
  trauma: 'trauma',
  history: 'history',
  temp: 'temp',
  glucose: 'glucose',
  ktas: 'ktas',
};
const FROM_DRAFT = Object.fromEntries(Object.entries(DRAFT_KEY).map(([k, v]) => [v, k])) as Record<
  string,
  Key
>;
const INT = new Set<Key>(['pulse', 'resp', 'spo2', 'painScore', 'glucose', 'ktas']);
const CONSC: Record<string, string> = {
  명료: 'alert',
  '말에 반응': 'verbal',
  '통증에 반응': 'pain',
  무반응: 'unresponsive',
};
const CONSC_BACK: Record<string, string> = {
  alert: '명료',
  verbal: '말에 반응',
  pain: '통증에 반응',
  unresponsive: '무반응',
};
/** 서버에 '확인 불가' 값이 따로 있는 칸 (나머지는 unknownFields 로 표시) */
const OWN_UNKNOWN: Partial<Record<Key, string>> = {
  sex: 'U',
  consciousness: 'unknown',
  trauma: 'unknown',
};

/** 화면 값 하나 → 서버 값 (빈 칸 = null = 지우기) */
function toDraftValue(k: Key, v: string): unknown {
  const t = v.trim();
  if (!t) return null;
  if (t === UNKNOWN) return OWN_UNKNOWN[k] ?? null;
  if (k === 'sex') return t === '남' ? 'M' : t === '여' ? 'F' : 'U';
  if (k === 'consciousness') return CONSC[t] ?? 'unknown';
  if (k === 'trauma') return /없|무|^no$/i.test(t) ? 'no' : 'yes';
  if (INT.has(k)) {
    const n = Number.parseInt(t, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (k === 'temp') {
    const n = Number.parseFloat(t);
    return Number.isFinite(n) ? n : null;
  }
  return t;
}

/** 바뀐 칸만 서버 changes 로. unknownFields 는 '확인 불가' 목록 전체를 함께 보낸다 */
export function draftChanges(prev: Patient, next: Patient): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {};
  let unknownChanged = false;
  for (const k of Object.keys(DRAFT_KEY) as Key[]) {
    if (prev[k] === next[k]) continue;
    changes[DRAFT_KEY[k]] = toDraftValue(k, next[k]);
    if ((prev[k] === UNKNOWN) !== (next[k] === UNKNOWN)) unknownChanged = true;
  }
  if (Object.keys(changes).length === 0) return null;
  if (unknownChanged) {
    changes.unknownFields = (Object.keys(DRAFT_KEY) as Key[])
      .filter((k) => next[k] === UNKNOWN)
      .map((k) => DRAFT_KEY[k]);
  }
  return changes;
}

/** 서버 칸 하나 → 화면 값 (지금 화면 값을 참고: 외상 '있음'은 대원이 쓴 설명을 그대로 둔다) */
function fromDraftValue(k: Key, v: unknown, unknown: boolean, mine: string): string {
  if (unknown) return UNKNOWN;
  if (v === null || v === undefined) return '';
  if (k === 'sex') return v === 'M' ? '남' : v === 'F' ? '여' : UNKNOWN;
  if (k === 'consciousness') return CONSC_BACK[String(v)] ?? UNKNOWN;
  if (k === 'trauma') {
    if (v === 'unknown') return UNKNOWN;
    if (v === 'no') return '없음';
    return mine && !/없|무|^no$/i.test(mine) && mine !== UNKNOWN ? mine : '있음';
  }
  return String(v);
}

/** 서버 작성 중 정보에서 fields(서버 칸 이름) 만 화면 값으로 바꿔 넣는다. fields 가 없으면 전부 */
export function applyDraft(
  p: Patient,
  assessment: Record<string, unknown> | null | undefined,
  fields?: string[],
): Patient {
  if (!assessment) return p;
  const unknownSet = new Set((assessment.unknownFields as string[] | undefined) ?? []);
  const next = { ...p };
  const keys = fields
    ? fields.filter((f) => FROM_DRAFT[f])
    : Object.keys(FROM_DRAFT).filter((f) => f in assessment || unknownSet.has(f));
  for (const f of keys) {
    const k = FROM_DRAFT[f]!;
    next[k] = fromDraftValue(k, assessment[f], unknownSet.has(f), p[k]);
  }
  // unknownFields 만 바뀐 경우
  if (fields?.includes('unknownFields')) {
    for (const [f, k] of Object.entries(FROM_DRAFT)) {
      if (unknownSet.has(f)) next[k] = UNKNOWN;
      else if (next[k] === UNKNOWN && !(OWN_UNKNOWN[k] && assessment[f] === OWN_UNKNOWN[k]))
        next[k] = '';
    }
  }
  return next;
}

/** '혈압' 같은 화면 이름 (알림 문구용) */
export const FIELD_NAME: Record<string, string> = {
  chiefComplaint: '주 증상',
  sex: '성별',
  ageBand: '나이대',
  consciousness: '의식',
  bp: '혈압',
  pulse: '맥박',
  resp: '호흡수',
  spo2: '산소포화도',
  painSite: '통증 부위',
  painScore: '통증 정도',
  onset: '증상 시작',
  trauma: '외상',
  history: '과거력',
  temp: '체온',
  glucose: '혈당',
  ktas: 'KTAS',
  unknownFields: '확인 불가 항목',
};
