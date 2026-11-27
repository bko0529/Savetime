/**
 * 구급활동일지 (별지 제5호서식) 칸과 초기값. Lovable log.tsx · journal.ts 의 계산을 그대로 옮겼다.
 * 이 휴대폰에서 입력한 환자 정보 + 서버 일지 초안(SFR-164)으로 칸을 자동으로 채운다.
 * 규칙 2: 환자 이름·주민번호·연락처·주소 칸은 이 데이터에 없다. PDF 에만 쓰는 성명 칸은 화면에서 따로 받고 저장하지 않는다.
 */
import type { JournalDraft } from '../transport/engine';
import { UNKNOWN, type Patient } from '../transport/patient';
import { REJECT_TEXT } from '../transport/types';

export type LogData = {
  station: string;
  center: string;
  carNo: string;
  kind: string;
  callAt: string;
  dispatchAt: string;
  sceneAt: string;
  contactAt: string;
  departAt: string;
  arriveAt: string;
  returnAt: string;
  distance: string;
  dispatchType: string;
  reportMethod: string;
  sex: string;
  age: string;
  place: string;
  symptoms: string[];
  symptomEtc: string;
  history: string[];
  historyEtc: string;
  type: string;
  avpu: string;
  pupilL: string;
  pupilR: string;
  vitalTime: string;
  bpS: string;
  bpD: string;
  pulse: string;
  resp: string;
  temp: string;
  spo2: string;
  glucose: string;
  ktas: string;
  complaint: string;
  onset: string;
  opinion: string;
  care: string[];
  o2: string;
  hospital: string;
  hospitalArrive: string;
  selector: string;
  handover: string;
  reTransfer: string;
  hospital2: string;
  crew1: string;
  crew1Rank: string;
  crew1Grade: string;
  driver: string;
  driverRank: string;
  driverGrade: string;
};

export const SYMPTOMS = [
  '두통',
  '흉통',
  '복통',
  '요통',
  '의식장애',
  '호흡곤란',
  '심정지',
  '경련/발작',
  '실신',
  '오심',
  '구토',
  '어지러움',
  '마비',
  '전신쇠약',
  '고열',
];
export const HISTORY = [
  '고혈압',
  '당뇨',
  '뇌혈관질환',
  '심장질환',
  '폐질환',
  '결핵',
  '간염',
  '알레르기',
  '암',
  '신부전',
];
export const TYPES = [
  '질병',
  '질병외 · 교통사고',
  '질병외 · 그 외 외상',
  '질병외 · 비외상성 손상',
  '기타',
];
export const PLACES = [
  '집',
  '집단거주시설',
  '도로',
  '오락/문화/공공시설',
  '학교/교육시설',
  '상업시설',
  '의료관련시설',
  '공장/산업/건설시설',
  '기타',
];
export const CARE = [
  '기도확보',
  '산소투여',
  'CPR',
  'ECG',
  'AED',
  '정맥로 확보',
  '고정(목뼈)',
  '부목',
  '지혈',
  '상처 소독',
  '보온',
];
export const SELECTOR = ['구급대', '119상황실', '구급상황센터', '환자/보호자', '병원 수용곤란 등'];
export const GRADES = ['1급', '2급', '간호사', '구급교육', '기타'];

const AVPU: Record<string, string> = {
  명료: 'A',
  '말에 반응': 'V',
  '통증에 반응': 'P',
  무반응: 'U',
};
const AVPU_NAME: Record<string, string> = {
  A: '명료',
  V: '말에 반응',
  P: '통증에 반응',
  U: '무반응',
};
const v = (s: string) => (s && s !== UNKNOWN ? s : '');
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

/** 시각 → "14:05" (휴대폰 시간대로 표시만) */
export function hhmm(at: string | number | Date | null | undefined) {
  if (at === null || at === undefined || at === '') return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 이 폰에 비어 있는 환자 칸만 서버 초안으로 채운다. 대원이 이 폰에서 입력한 값은 그대로 둔다 (Lovable mergePatient) */
export function mergePatient(p: Patient, d: JournalDraft): Patient {
  const keep = (mine: string, server: string) => (mine.trim() ? mine : server);
  const vit = d.vitals ?? {};
  const bp = vit.sbp && vit.dbp ? `${vit.sbp}/${vit.dbp}` : '';
  return {
    ...p,
    complaint: keep(p.complaint, d.chiefComplaint ?? ''),
    sex: keep(p.sex, d.sex === 'M' ? '남' : d.sex === 'F' ? '여' : ''),
    age: keep(p.age, d.ageBand ?? ''),
    consciousness: keep(p.consciousness, d.consciousness ? (AVPU_NAME[d.consciousness] ?? '') : ''),
    bp: keep(p.bp, bp),
    pulse: keep(p.pulse, str(vit.pulse)),
    resp: keep(p.resp, str(vit.resp)),
    spo2: keep(p.spo2, str(vit.spo2)),
    temp: keep(p.temp, str(vit.temp)),
    glucose: keep(p.glucose, str(vit.glucose)),
    onset: keep(p.onset, d.onsetAt ?? ''),
    history: keep(p.history, d.history ?? ''),
    ktas: keep(p.ktas, str(d.ktas)),
  };
}

type Who = { name?: string; rank?: string; agency?: string; safetyCenter?: string };

/**
 * 일지 칸 초기값. 서버 초안(실제 도착 병원·위치 기록으로 잰 거리·이송 중 팀원·재이송 사유)을 먼저 쓰고,
 * 없으면 이 폰의 기록(확정 병원·출발/도착 시각)을 쓴다.
 */
export function initialLog(input: {
  patient: Patient;
  draft: JournalDraft | null;
  me: Who;
  local: { hospitalName?: string; km?: number; departedAt?: number; arrivedAt?: number };
}): LogData {
  const d = input.draft;
  const p = d ? mergePatient(input.patient, d) : input.patient;
  const crew = d?.crew ?? [];
  const drv = crew.find((c) => c.role === 'driver');
  const care =
    crew.find((c) => c.role === 'care' && c.name === input.me.name) ??
    crew.find((c) => c.role === 'care');
  const departAt = hhmm(d?.departedAt ?? input.local.departedAt);
  const arriveAt = hhmm(d?.arrivedAt ?? input.local.arrivedAt);
  const distanceKm = d?.distanceKm ?? input.local.km;
  const symptoms = SYMPTOMS.filter(
    (s) =>
      p.complaint.includes(s.replace('/발작', '')) ||
      (s === '두통' && p.painSite.includes('머리')) ||
      (s === '의식장애' && p.complaint.includes('의식')),
  );
  const [bpS, bpD] = v(p.bp).split('/');
  const reTransfer = (d?.reTransferReasons ?? [])
    .map(
      (r) =>
        `${r.hospitalName ?? '병원'}(${REJECT_TEXT[r.reason ?? ''] ?? r.reason ?? '사유 없음'})`,
    )
    .join(', ');
  return {
    station: (d?.agencyName ?? input.me.agency ?? '').replace(/소방서$/, ''),
    center: (d?.safetyCenter ?? input.me.safetyCenter ?? '').replace(/119안전센터$/, ''),
    carNo: '',
    kind: '특수일반',
    callAt: '',
    dispatchAt: '',
    sceneAt: '',
    contactAt: '',
    departAt,
    arriveAt,
    returnAt: '',
    distance: distanceKm !== undefined && distanceKm !== null ? String(distanceKm) : '',
    dispatchType: '정상',
    reportMethod: '휴대전화',
    sex: v(p.sex),
    age: v(p.age),
    place: '집',
    symptoms,
    symptomEtc: '',
    history: HISTORY.filter((h) => p.history.includes(h)),
    historyEtc: '',
    type: '질병',
    avpu: AVPU[p.consciousness] ?? '',
    pupilL: '정상',
    pupilR: '정상',
    vitalTime: '',
    bpS: bpS ?? '',
    bpD: bpD ?? '',
    pulse: v(p.pulse),
    resp: v(p.resp),
    temp: v(p.temp),
    spo2: v(p.spo2),
    glucose: v(p.glucose),
    ktas: v(p.ktas),
    complaint: v(p.complaint),
    onset: v(p.onset),
    opinion: [
      p.painSite && `통증 부위 ${v(p.painSite)}`,
      p.painScore && `통증 ${v(p.painScore)}/10`,
      p.trauma && `외상 ${v(p.trauma)}`,
    ]
      .filter(Boolean)
      .join(' · '),
    care: [],
    o2: '',
    hospital: d?.hospitalName ?? input.local.hospitalName ?? '',
    hospitalArrive: arriveAt,
    selector: reTransfer ? '병원 수용곤란 등' : '구급대',
    handover: '의사',
    reTransfer,
    hospital2: '',
    crew1: care?.name ?? input.me.name ?? '',
    crew1Rank: care?.rank ?? input.me.rank ?? '',
    crew1Grade: '1급',
    driver: drv?.name ?? '',
    driverRank: drv?.rank ?? '',
    driverGrade: '2급',
  };
}
