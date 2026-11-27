/**
 * 이송 건 상태 (Lovable engine.ts 를 그대로 옮겼다).
 * - 바꾸기: REST (POST /transports …). 상태 전이 판정은 서버의 stateMachine.ts 가 한다 (앱은 결과만 받는다, 규칙 4)
 * - 알기: 실시간 이벤트에는 ID·개수·시각만 온다 → 받으면 GET /transports/{id} 로 다시 읽는다 (규칙 5)
 * - 시간: 2분·5분 남은 시간은 서버 시각(serverNow) 기준으로 센다 (규칙 6)
 * 화면은 useEngine() 으로 상태를 보고, actions.* 로 대원 행동을 보낸다.
 *
 * 앱에 맞게 바꾼 곳: 위치는 expo-location, 기기 ID 는 secure-store, 운전 역할은 팀 정보(teamStore)에서 읽는다.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, api, currentAccessToken, errorText, serverNow } from '../api/client';
import type { components } from '../api/schema';
import { getDeviceId } from '../auth/storage';
import { teamStore } from '../duty/team';
import { onEvent, type AppEventName } from '../realtime/socket';
import {
  GRADE_NAME,
  GRADE_NO,
  RADIUS_STEPS,
  START_RADIUS,
  type Grade,
  type Hospital,
} from './hospitals';
import { uuid } from './ids';
import { currentLocation, distanceM, FIXED_LOCATION, moveToward, type LatLng } from './location';
import { toAssessment, type Patient } from './patient';
import {
  isActive,
  REJECT_TEXT,
  STATUS_STEP_LABEL,
  type CloseReason,
  type DestChangeReason,
  type FallbackReason,
  type HreqStatus,
  type PhoneProceedReason,
  type TransportStatus,
} from './types';
import { retryOnVersionConflict } from './versionRetry';
import { hospitalAlerts } from './hospitalAlerts';

export type Hreq = {
  id: number;
  hospitalId: string;
  round: number;
  status: HreqStatus;
  version: number;
  sentAt: number;
  closeReason: CloseReason | null;
  note?: string;
  reason?: string;
  respondedAt?: number;
  recheck?: boolean;
};

export type HistoryItem = {
  from: TransportStatus | null;
  to: TransportStatus;
  reason: string | null;
  at: number;
  label: string;
};

export type EngineState = {
  transportId: string | null;
  status: TransportStatus | null;
  version: number;
  radius: number;
  round: number;
  roundSentAt: number;
  grade: Grade;
  hreqs: Hreq[];
  excluded: string[];
  phoneTarget: string | null;
  confirmedId: string | null;
  /** 이동 중 확정 병원이 승인을 취소함 → '다시 요청' 경보 */
  alert: string | null;
  destChanged: boolean;
  fallbackReason: FallbackReason | null;
  history: HistoryItem[];
  /** 이동 중 남은 분 (서버가 담당 단말 값으로 계산) */
  etaMin: number | null;
  navDeviceId: string | null;
  /** 이 기기가 위치 기록·경로 안내 담당인가 */
  navIsMe: boolean;
  /** 담당 단말이 병원 입구까지 남은 거리 (m) */
  remainingM: number | null;
  /** 병원이 '도착 확인'을 눌렀다 (SFR-144) */
  arriveRequested: boolean;
  /** 확정 병원 입구 좌표·메모 */
  confirmed: {
    entrance: LatLng | null;
    memo: string | null;
    /** 이동 중 병원이 한 번 보내는 추가 메모 (SFR-140) */
    extraMemo: string | null;
    erPhone: string | null;
  } | null;
  lastSentSeq: number;
  /** 병원 목록 (거리순, 추천 API) */
  nearby: string[];
  /** 병원 정보 캐시가 바뀔 때마다 늘어남 (화면 다시 그리기용) */
  hospitalsRev: number;
};

const initial = (): EngineState => ({
  transportId: null,
  status: null,
  version: 1,
  radius: START_RADIUS,
  round: 0,
  roundSentAt: 0,
  grade: null,
  hreqs: [],
  excluded: [],
  phoneTarget: null,
  confirmedId: null,
  alert: null,
  destChanged: false,
  fallbackReason: null,
  history: [],
  etaMin: null,
  navDeviceId: null,
  navIsMe: false,
  remainingM: null,
  arriveRequested: false,
  confirmed: null,
  lastSentSeq: 0,
  nearby: [],
  hospitalsRev: 0,
});

let s: EngineState = initial();
const subs = new Set<() => void>();
const emit = () => {
  s = { ...s };
  subs.forEach((f) => f());
};
export const now = () => serverNow();

export function useEngine() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => s,
    () => s,
  );
}
export const getEngine = () => s;

/** 이 휴대폰의 기기 ID (경로 안내 담당 판정). 처음 한 번 secure-store 에서 읽어 둔다 */
let myDeviceId: string | null = null;
async function deviceId() {
  myDeviceId ??= await getDeviceId();
  return myDeviceId;
}

// ---------------- 병원 정보 (서버 응답으로 채우는 캐시) ----------------
const hospitals = new Map<string, Hospital>();

const placeholder = (id: string): Hospital => ({
  id,
  name: '병원',
  km: 0,
  min: 0,
  depts: [],
  caps: [],
  erPhone: '',
  mainPhone: '',
  bedsAt: '',
  grade: '일반 병원',
  phone: '',
});

/** 병원 정보 (모르면 빈 자리). 화면은 이것만 부른다 */
export const hospital = (id: string | null): Hospital =>
  (id && hospitals.get(id)) || placeholder(id ?? '');

const hhmm = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function upsertHospital(id: string, patch: { [K in keyof Hospital]?: Hospital[K] | undefined }) {
  const prev = hospitals.get(id) ?? placeholder(id);
  // undefined 칸은 덮어쓰지 않는다 (추천 목록에는 진료과가 없고, 상세에는 거리가 없다)
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<Hospital>;
  hospitals.set(id, { ...prev, ...clean });
}

type Card = {
  id: number;
  name: string;
  lat: number;
  lng: number;
  distanceKm: number;
  etaMin: number | null;
  beds: { er: string | null; icu: string | null; or: string | null };
  bedsSourceTime: string | null;
  capabilityCount: { available: number; total: number };
  erPhone: string | null;
  grade: number;
};

function fromCard(c: Card) {
  upsertHospital(String(c.id), {
    name: c.name,
    km: c.distanceKm,
    // 길찾기 값이 없으면 거리로 어림 (시속 약 40km + 출발 2분)
    min: c.etaMin ?? Math.max(1, Math.round(c.distanceKm * 1.5 + 2)),
    er: c.beds.er ?? undefined,
    icu: c.beds.icu ?? undefined,
    or: c.beds.or ?? undefined,
    erPhone: c.erPhone ?? '',
    phone: c.erPhone ?? '',
    bedsAt: hhmm(c.bedsSourceTime),
    grade: GRADE_NAME[c.grade] ?? '일반 병원',
    capCount: c.capabilityCount,
    lat: c.lat,
    lng: c.lng,
  });
}

/** 병원 상세 (진료과·진료가능 항목·대표 전화). 상세 화면을 열 때 부른다 (SFR-007) */
export async function loadHospitalDetail(id: string) {
  try {
    const d = await api<{
      id: number;
      name: string;
      lat: number;
      lng: number;
      departments: string[] | null;
      erPhone: string | null;
      mainPhone: string | null;
      beds: Record<'er' | 'icu' | 'or', { avail: number | null; total: number | null }>;
      bedsSourceTime: string | null;
      capabilities: { name: string; available: boolean }[];
      grade: number;
    }>('GET', `/hospitals/${id}`);
    const bed = (b: { avail: number | null; total: number | null }) =>
      b.avail === null ? undefined : `${b.avail}/${b.total ?? '?'}`;
    upsertHospital(id, {
      name: d.name,
      depts: d.departments ?? [],
      erPhone: d.erPhone ?? '',
      phone: d.erPhone ?? '',
      mainPhone: d.mainPhone ?? '',
      er: bed(d.beds.er),
      icu: bed(d.beds.icu),
      or: bed(d.beds.or),
      bedsAt: hhmm(d.bedsSourceTime),
      caps: d.capabilities,
      capCount: {
        available: d.capabilities.filter((c) => c.available).length,
        total: d.capabilities.length,
      },
      grade: GRADE_NAME[d.grade] ?? '일반 병원',
      lat: d.lat,
      lng: d.lng,
    });
    s.hospitalsRev += 1;
    emit();
  } catch {
    /* 상세를 못 읽어도 목록 정보로 보인다 */
  }
}

async function loadNearby() {
  if (!s.transportId) return;
  try {
    const r = await api<{ radiusKm: number; map: Card[] }>(
      'GET',
      `/transports/${s.transportId}/recommendations`,
    );
    r.map.forEach(fromCard);
    s.nearby = [...r.map].sort((a, b) => a.distanceKm - b.distanceKm).map((c) => String(c.id));
    s.hospitalsRev += 1;
    emit();
  } catch {
    /* 위치 없는 건 등은 목록 없이 */
  }
}

/** 거리순 병원 목록 (지금 반경 안) */
export const nearbyHospitals = () =>
  s.nearby.map((id) => hospital(id)).filter((h) => h.km <= s.radius);

// ---------------- 서버 이송 건 → 화면 상태 ----------------
type ServerRequest = {
  id: number;
  hospitalId: number;
  hospitalName: string;
  lat: number;
  lng: number;
  status: HreqStatus;
  closeReason: CloseReason | null;
  etaMin: number | null;
  erBeds: string | null;
  memo: string | null;
  extraMemo: string | null;
  reason: string | null;
  reasonText: string | null;
  approvedAt: string | null;
  prevApprovedRecheck: boolean;
  version: number;
};
export type ServerTransport = {
  id: string;
  status: TransportStatus;
  version: number;
  serverNow: string;
  requestRadiusKm: number;
  fallbackRadiusKm: number;
  fallbackReason: FallbackReason | null;
  currentRound: { roundNo: number; sentAt: string; respondUntil: string } | null;
  requests: ServerRequest[];
  phoneTarget: { hospitalId: number; name: string | null; erPhone: string | null } | null;
  confirmedHospital: {
    id: number;
    name: string;
    erPhone: string | null;
    memo: string | null;
    extraMemo: string | null;
    entrance: LatLng;
    requestStatus: HreqStatus;
    closeReason: CloseReason | null;
  } | null;
  canReRequest: boolean;
  destinationChangeUsed: boolean;
  navDeviceId: string | null;
  etaMin: number | null;
  lastSentAssessmentSeq: number;
  excludedHospitalIds: number[];
  requestedGrade: number | null;
};

/** 테스트에서도 쓰려고 꺼내 둠: 서버 이송 건 1개를 화면 상태로 */
export function apply(t: ServerTransport, myDevice = myDeviceId) {
  const from = s.status;
  s.transportId = t.id;
  s.version = t.version;
  // 요청 중에는 요청 반경, 예비 추천·전화 확인에서는 추천(넓힌) 반경을 보여 준다
  s.radius =
    t.status === 'fallback' || t.status === 'phone_check' ? t.fallbackRadiusKm : t.requestRadiusKm;
  s.round = t.currentRound?.roundNo ?? 0;
  s.roundSentAt = t.currentRound ? new Date(t.currentRound.sentAt).getTime() : 0;
  s.grade = t.requestedGrade ? (GRADE_NAME[t.requestedGrade] ?? null) : null;
  s.fallbackReason = t.fallbackReason;
  s.excluded = t.excludedHospitalIds.map(String);
  s.phoneTarget = t.phoneTarget ? String(t.phoneTarget.hospitalId) : null;
  if (t.phoneTarget) {
    upsertHospital(String(t.phoneTarget.hospitalId), {
      name: t.phoneTarget.name ?? '병원',
      ...(t.phoneTarget.erPhone
        ? { erPhone: t.phoneTarget.erPhone, phone: t.phoneTarget.erPhone }
        : {}),
    });
  }
  for (const r of t.requests) {
    upsertHospital(String(r.hospitalId), {
      name: r.hospitalName,
      lat: r.lat,
      lng: r.lng,
      ...(r.erBeds ? { er: r.erBeds } : {}),
      ...(r.etaMin !== null ? { min: r.etaMin } : {}),
    });
  }
  s.hreqs = t.requests.map((r) => ({
    id: r.id,
    hospitalId: String(r.hospitalId),
    round: s.round,
    status: r.status,
    version: r.version,
    sentAt: s.roundSentAt,
    closeReason: r.closeReason,
    ...(r.memo ? { note: r.extraMemo ? `${r.memo} · ${r.extraMemo}` : r.memo } : {}),
    ...(r.reason
      ? {
          reason:
            r.reason === 'etc' && r.reasonText ? r.reasonText : (REJECT_TEXT[r.reason] ?? r.reason),
        }
      : {}),
    ...(r.approvedAt ? { respondedAt: new Date(r.approvedAt).getTime() } : {}),
    recheck: r.prevApprovedRecheck,
  }));
  const c = t.confirmedHospital;
  s.confirmedId = c ? String(c.id) : null;
  s.confirmed = c
    ? { entrance: c.entrance, memo: c.memo, extraMemo: c.extraMemo, erPhone: c.erPhone }
    : null;
  if (c)
    upsertHospital(String(c.id), {
      name: c.name,
      ...(c.erPhone ? { erPhone: c.erPhone, phone: c.erPhone } : {}),
    });
  s.alert = t.canReRequest && c ? `${c.name}이(가) 승인을 취소했어요` : null;
  s.destChanged = t.destinationChangeUsed;
  s.etaMin = t.etaMin;
  s.navDeviceId = t.navDeviceId;
  s.navIsMe = !!t.navDeviceId && t.navDeviceId === myDevice;
  s.lastSentSeq = t.lastSentAssessmentSeq;
  s.status = t.status;
  if (from !== t.status) {
    s.history = [
      ...s.history,
      {
        from,
        to: t.status,
        reason: t.status === 'fallback' ? t.fallbackReason : null,
        at: now(),
        label: STATUS_STEP_LABEL[t.status],
      },
    ];
    if (t.status !== 'moving') s.arriveRequested = false;
  }
  s.hospitalsRev += 1;
  emit();
  afterApply();
}

let refreshing: Promise<void> | null = null;
let again = false;
/** 서버에서 이송 건을 다시 읽는다. 이벤트가 몰려 와도 한 번에 하나씩 (도중에 또 오면 끝나고 한 번 더) */
export function refresh(): Promise<void> {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      do {
        again = false;
        await loadOnce();
      } while (again);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function loadOnce() {
  if (!currentAccessToken()) return;
  await deviceId();
  try {
    const t = s.transportId
      ? await api<ServerTransport>('GET', `/transports/${s.transportId}`).catch(async (e) => {
          // 팀이 바뀌었거나 볼 수 없는 건이면 진행 중 건을 새로 찾는다
          if (e instanceof ApiError && e.status === 404)
            return api<ServerTransport>('GET', '/transports/current');
          throw e;
        })
      : await api<ServerTransport>('GET', '/transports/current');
    apply(t);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'NO_ACTIVE_TRANSPORT') {
      if (isActive(s.status)) {
        s = { ...initial(), hospitalsRev: s.hospitalsRev };
        emit();
      }
      return;
    }
    /* 통신 오류: 지난 화면 그대로. 다시 붙으면 이벤트로 다시 읽는다 */
  }
}

/** 근무 시작 뒤 · 앱을 다시 켰을 때: 팀에 진행 중 이송이 있으면 이어서 보여 준다 (SFR-133) */
export async function loadCurrent() {
  if (s.transportId && isActive(s.status)) return refresh();
  s = { ...initial(), hospitalsRev: s.hospitalsRev };
  await refresh();
  if (s.transportId) void loadNearby();
}

// ---------------- 실시간: 팀 방 이벤트 → 다시 읽기 (이벤트에는 ID 만 온다, 규칙 5) ----------------
const RELOAD: AppEventName[] = [
  'transport.created',
  'transport.status',
  'transport.confirmed',
  'transport.phone_target',
  'transport.nav_device',
  'transport.eta',
  'transport.arrived',
  'transport.unacceptable',
  'request.approved',
  'request.rejected',
  'request.expired',
  'request.cancelled',
  'request.delivered',
  'request.eta',
  'round.started',
  'approval.expiring',
  'approval.expired',
  'assessment.sent',
  'snapshot_required',
];
const DEBOUNCE_MS = 120;

/**
 * 이송 이벤트를 듣기 시작한다 (근무 중일 때). 돌려준 함수를 부르면 그만 듣는다.
 * 이벤트가 몰려 오면(승인 3곳이 거의 동시에 등) 0.12초 모았다가 한 번만 다시 읽는다.
 * 남은 시간 표시를 위해 0.5초마다 다시 그리고, 진행 중이면 15초마다 서버 상태도 다시 맞춘다 (이벤트를 놓쳐도)
 */
export function startTransportSync() {
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let roundStarted = false;
  const offs = RELOAD.map((name) =>
    onEvent(name, () => {
      if (name === 'round.started' || name === 'transport.created') roundStarted = true;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const hadTransport = !!s.transportId;
        const newRound = roundStarted;
        roundStarted = false;
        void refresh().then(() => {
          if ((!hadTransport && s.transportId) || newRound) void loadNearby();
        });
      }, DEBOUNCE_MS);
    }),
  );
  offs.push(
    // SFR-140: 확정 병원 추가 메모. 이벤트에는 메모 글이 없어(규칙 5) 바로 다시 읽고 경보를 띄운다
    onEvent('hospital.extra_memo', (ev) => {
      void refresh().then(() =>
        hospitalAlerts.showMemo({
          hospitalName: ev.data.hospitalName ?? '병원',
          memo: s.confirmed?.extraMemo ?? null,
        }),
      );
    }),
    // SFR-158: 도착 후 수용 불가. 일지·홈 어디에 있든 경보 → '다시 요청하기'
    onEvent('transport.unacceptable', (ev) => {
      if (!ev.data.transportId) return;
      hospitalAlerts.showUnacceptable({
        transportId: ev.data.transportId,
        hospitalName: ev.data.hospitalName ?? '병원',
        reason: ev.data.reason ?? '',
      });
    }),
  );
  offs.push(
    onEvent('transport.arrive_requested', () => {
      s.arriveRequested = true;
      emit();
      void refresh();
    }),
  );
  const tick = setInterval(() => {
    if (s.status) emit();
  }, 500);
  const poll = setInterval(() => {
    if (isActive(s.status)) void refresh();
  }, 15_000);
  void loadCurrent();
  return () => {
    offs.forEach((off) => off());
    clearTimeout(debounce);
    clearInterval(tick);
    clearInterval(poll);
    stopDrive();
  };
}

/** 요청 전 미리보기: 'n곳에 요청합니다' (SFR-163). 못 세면 null */
export async function previewTargets(grade: Grade): Promise<number | null> {
  const at = await currentLocation();
  if (!at) return null;
  try {
    const q = `lat=${at.lat}&lng=${at.lng}&radiusKm=${START_RADIUS}${grade ? `&grade=${GRADE_NO[grade]}` : ''}`;
    const r = await api<{ count: number }>('GET', `/request-targets/preview?${q}`);
    return r.count;
  } catch {
    return null;
  }
}

// SFR-157·158: 수용 불가 뒤 '다시 요청하기'로 만드는 새 이송은 직전 건 ID 를 같이 보낸다.
// 그러면 서버가 직전 건에서 수용 불가였던 병원을 이번 요청에서 뺀다 (10분 안, 같은 팀만)
let prevTransportId: string | null = null;

// ---------------- 대원 행동 (화면에서 부름). 결과는 { ok, error } ----------------
export type Result<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (e) {
    // 다른 팀원이 먼저 바꿨으면(버전 충돌) 최신 상태로 맞춘다 (SFR-160)
    if (e instanceof ApiError && (e.code === 'VERSION_CONFLICT' || e.status === 409))
      void refresh();
    return { ok: false, error: errorText(e) };
  }
}

/** 도착·취소: 버전이 상태 변화 없이 올라 거절되면 최신으로 한 번 더 보낸다 (확정 직후 운전 폰의 경로 안내 담당 지정 등) */
function sendLatest(path: string, body: Record<string, unknown>) {
  return retryOnVersionConflict(
    { status: s.status, version: s.version },
    (version) => api('POST', path, { body: { ...body, version } }),
    async () => {
      await refresh();
      return { status: s.status, version: s.version };
    },
  );
}

const tid = () => {
  if (!s.transportId) throw new ApiError(0, 'NO_TRANSPORT', '진행 중 이송이 없어요');
  return s.transportId;
};

async function phoneResult(body: { result: string; reason?: string }) {
  return guard(async () => {
    const hospitalId = s.phoneTarget;
    if (!hospitalId) throw new ApiError(409, 'NO_PHONE_TARGET', '전화 확인 중인 병원이 없어요');
    await api('POST', `/transports/${tid()}/phone-checks`, {
      body: { hospitalId: Number(hospitalId), version: s.version, ...body },
    });
    await refresh();
  });
}

export const actions = {
  /** 이송 요청 (SFR-004·163). 환자 정보는 평가 항목만 (이름·연락처 없음, SER-012) */
  async create(grade: Grade, patient: Patient) {
    return guard(async () => {
      const location = await currentLocation();
      if (!location)
        throw new ApiError(0, 'NO_LOCATION', '위치를 가져오지 못했어요. 위치 권한을 확인해 주세요');
      stopDrive();
      s = { ...initial(), hospitalsRev: s.hospitalsRev };
      const t = await api<ServerTransport>('POST', '/transports', {
        body: {
          id: uuid(),
          radiusKm: START_RADIUS,
          location,
          locationConsent: true,
          assessment: toAssessment(patient),
          requestedGrade: grade ? GRADE_NO[grade] : null,
          ...(prevTransportId ? { prevTransportId } : {}),
        },
      });
      prevTransportId = null;
      apply(t);
      void loadNearby();
    });
  },
  /** 승인 병원 1곳 확정 (SFR-110). 같은 확정을 두 번 보내도 서버가 한 번만 처리하게 Idempotency-Key */
  async confirm(hospitalId: string) {
    return guard(async () => {
      const r = s.hreqs.find((h) => h.hospitalId === hospitalId && h.status === 'approved');
      if (!r) throw new ApiError(409, 'REQUEST_NOT_APPROVED', '승인 상태가 아니에요');
      await api('POST', `/transports/${tid()}/confirm`, {
        body: { hospitalRequestId: r.id, version: s.version },
        headers: { 'Idempotency-Key': uuid() },
      });
      await refresh();
    });
  },
  async expand() {
    return guard(async () => {
      const next = RADIUS_STEPS[RADIUS_STEPS.indexOf(s.radius) + 1];
      if (!next) throw new ApiError(409, 'MAX_RADIUS', '최대 반경(40km)이에요');
      await api('POST', `/transports/${tid()}/rounds`, {
        body: { kind: 'expand', radiusKm: next, version: s.version },
      });
      await refresh();
      void loadNearby();
    });
  },
  async startPhone(hospitalId: string) {
    return guard(async () => {
      await api('POST', `/transports/${tid()}/phone-check/start`, {
        body: { hospitalId: Number(hospitalId), version: s.version },
      });
      await refresh();
    });
  },
  phoneAccepted() {
    return phoneResult({ result: 'accepted' });
  },
  /** 연결 실패(no_answer)·확인 생략(skipped) 뒤 사유를 골라 이 병원으로 출발 */
  phoneProceed(reason: PhoneProceedReason, kind: 'no_answer' | 'skipped' = 'no_answer') {
    return phoneResult({ result: kind, reason });
  },
  /** 전화 거절: 서버가 다음 후보로 넘기거나, 없으면 요청 화면·예비 추천으로 */
  async phoneRejected(): Promise<Result<string | null>> {
    const r = await phoneResult({ result: 'rejected' });
    return r.ok ? { ok: true, value: s.phoneTarget } : r;
  },
  phoneDismiss() {
    return phoneResult({ result: 'dismissed' });
  },
  /** 바뀐 환자 정보를 병원에 보내기 (SFR-105): 팀 작성 중 정보에 넣고 → 보내기 */
  async updateAssessment(patient: Patient) {
    return guard(async () => {
      const draft = await api<{ version: number }>('GET', '/teams/current/draft');
      await api('PATCH', '/teams/current/draft', {
        body: { baseVersion: draft.version, changes: toAssessment(patient) },
      });
      await api('POST', `/transports/${tid()}/assessments`, {
        body: { baseSeq: s.lastSentSeq },
      }).catch((e) => {
        if (e instanceof ApiError && e.code === 'NOTHING_TO_SEND')
          throw new ApiError(400, e.code, '바뀐 내용이 없어요');
        throw e;
      });
      await refresh();
    });
  },
  async arrive(method: 'button' | 'hospital' = 'button') {
    return guard(async () => {
      await sendLatest(`/transports/${tid()}/arrive`, { method });
      stopDrive();
      await refresh();
    });
  },
  async reRequest() {
    return guard(async () => {
      const location = drive?.at ?? (await currentLocation());
      await api('POST', `/transports/${tid()}/rounds`, {
        body: { kind: 're_request', version: s.version, location },
      });
      await refresh();
      void loadNearby();
    });
  },
  async changeDestination(reason: DestChangeReason) {
    return guard(async () => {
      const location = drive?.at ?? (await currentLocation());
      await api('POST', `/transports/${tid()}/destination`, {
        body: { reason, version: s.version, location },
      });
      // 새 병원이 정해질 때까지 위치 기록을 멈춘다 (요청 중으로 돌아감)
      stopDrive();
      await refresh();
      void loadNearby();
    });
  },
  async cancel() {
    return guard(async () => {
      await sendLatest(`/transports/${tid()}/cancel`, {});
      stopDrive();
      await refresh();
    });
  },
  /** 다음 '병원에 요청'이 이 이송 건을 이어받게 한다 (수용 불가 뒤 다시 요청하기) */
  continueFrom(transportId: string) {
    prevTransportId = transportId;
  },
  /** 이 기기 화면만 비운다 (서버의 이송 건은 그대로). 일지를 마치고 새 이송을 시작할 때 */
  reset() {
    stopDrive();
    s = { ...initial(), hospitalsRev: s.hospitalsRev };
    emit();
  },
};

export function openRemain() {
  return s.hreqs.some(
    (h) => (h.round === s.round && h.status === 'waiting') || h.status === 'approved',
  );
}

/** 전화 확인 후보: 승인 대기 중이 아닌 가까운 병원(제외 병원 빼고) */
export function phoneCandidates() {
  return nearbyHospitals().filter(
    (h) =>
      !s.excluded.includes(h.id) &&
      !s.hreqs.some(
        (r) => r.hospitalId === h.id && (r.status === 'waiting' || r.status === 'approved'),
      ),
  );
}

export function latestReq(id: string) {
  return [...s.hreqs].reverse().find((h) => h.hospitalId === id);
}

// ---------------- 이동 중: 경로 안내 담당 · 위치 기록 (SFR-036·037·121·132) ----------------
// 운전 역할 단말은 확정 뒤 '내가 담당'이라고 알린다. 담당 단말만 5초마다 위치를 올린다 (화면이 켜져 있는 동안).
// 백그라운드 위치(COR-014)와 카카오 내비 SDK 남은 시간은 9단계에서 붙인다.
// 시연(고정 위치)에서는 병원 입구 쪽으로 시속 약 40km 로 움직이는 것처럼 흉내 내고, 남은 분을 1분마다 같이 보낸다.
const SPEED_MPS = 11;
const STEP_SEC = 5;
let drive: {
  timer: ReturnType<typeof setInterval>;
  at: LatLng;
  target: LatLng;
  minuteSent: number;
} | null = null;
let claiming = false;

function stopDrive() {
  if (drive) clearInterval(drive.timer);
  drive = null;
  s.remainingM = null;
}

const iAmDriver = () => {
  const t = teamStore.get().team;
  return t !== 'loading' && !!t?.members?.some((m) => m.isMe && m.role === 'driver');
};

function afterApply() {
  if (s.status !== 'moving') {
    if (drive) stopDrive();
    return;
  }
  // 운전 역할이면 경로 안내 담당을 맡는다
  if (!s.navDeviceId && iAmDriver() && !claiming) {
    claiming = true;
    void (async () => {
      try {
        await api('POST', `/transports/${s.transportId}/nav-device`, {
          body: { deviceId: await deviceId(), version: s.version },
        });
        await refresh();
      } catch {
        /* 다른 팀원이 먼저 맡았으면 그대로 */
      } finally {
        claiming = false;
      }
    })();
  }
  const target = s.confirmed?.entrance;
  if (!s.navIsMe || !target) {
    if (drive) stopDrive();
    return;
  }
  // 목적지가 바뀌었으면 새 입구로
  if (drive && distanceM(drive.target, target) > 1) drive.target = target;
  if (!drive) void startDrive(target);
}

let starting = false;
async function startDrive(target: LatLng) {
  if (starting) return;
  starting = true;
  const start = (await currentLocation()) ?? target;
  starting = false;
  if (drive || s.status !== 'moving') return;
  drive = {
    at: start,
    target,
    minuteSent: 0,
    timer: setInterval(() => void stepDrive(), STEP_SEC * 1000),
  };
  void stepDrive();
}

async function stepDrive() {
  const d = drive;
  if (!d || !s.transportId) return;
  if (FIXED_LOCATION) d.at = moveToward(d.at, d.target, SPEED_MPS * STEP_SEC);
  else d.at = (await currentLocation(3000)) ?? d.at;
  const left = distanceM(d.at, d.target);
  s.remainingM = Math.round(left);
  const etaMin = Math.ceil(left / SPEED_MPS / 60);
  emit();
  // 남은 분은 1분에 한 번만 실어 보낸다 (그 사이는 서버가 지난 시간을 뺀다)
  const sendEta = now() - d.minuteSent >= 60_000 || etaMin === 0;
  try {
    await api('POST', `/transports/${s.transportId}/locations`, {
      body: {
        deviceId: await deviceId(),
        // 위치 기록은 좌표·속도·시각만 (SFR-041 고지 범위)
        points: [
          {
            lat: d.at.lat,
            lng: d.at.lng,
            speedKmh: left > 5 ? SPEED_MPS * 3.6 : 0,
            recordedAt: new Date(now()).toISOString(),
          },
        ],
        ...(sendEta ? { etaMin } : {}),
      },
    });
    if (sendEta) d.minuteSent = now();
  } catch {
    /* 끊기면 다음 5초에 다시 */
  }
}

// ---------------- 구급활동일지 초안 (SFR-164) ----------------
// 이송이 끝난 뒤 10분 안에 팀원 누구나 받을 수 있다. 환자 이름·연락처는 서버에 없다 (SER-012)
export type JournalDraft = components['schemas']['JournalDraft'];

export async function loadJournalDraft(): Promise<JournalDraft | null> {
  if (!s.transportId || !s.status || isActive(s.status)) return null;
  try {
    return await api<JournalDraft>('GET', `/transports/${s.transportId}/journal-draft`);
  } catch {
    return null;
  }
}

/** 테스트용: 처음 상태로 */
export function __resetEngineForTest() {
  stopDrive();
  hospitals.clear();
  s = initial();
  refreshing = null;
  again = false;
  claiming = false;
  myDeviceId = null;
  prevTransportId = null;
}
