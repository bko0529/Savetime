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
import {
  currentFix,
  currentLocation,
  distanceM,
  FIXED_LOCATION,
  isOutlier,
  moveToward,
  nearEntrance,
  type Fix,
  type LatLng,
} from './location';
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
import { latestCards, saveCards, type CachedCard } from '../offline/cache';
import { whenOnline } from '../offline/net';
import { enqueue, flush } from '../offline/queue';
import type { AlertKind } from './notify';

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
  /** 이 기기에서 병원을 확정했나 (확정하자마자 길 안내 페이지를 연다) */
  confirmedHere: boolean;
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
  /** 추천 카드 상위 5곳 (SFR-027), 병상 정보 없는 병원 최대 3곳 (전화로 확인), 반경 안 전체 (지도용) */
  noBed: string[];
  mapIds: string[];
  /** 추천 후보 0건 안내 (SFR-029): 반경 넓히기 / 전화로 확인 */
  emptyGuide: 'expand_radius' | 'call_nearby' | null;
  /** 추천 목록을 불러오는 중 (SFR-095) */
  nearbyLoading: boolean;
  /** 경로 안내 담당 폰이 입구 근처(거리−오차 ≤ 30m, 시속 10km 이하)에 있음 (SFR-038) */
  nearEntrance: boolean;
  /** 앱을 켠 뒤 서버에서 진행 중 이송을 한 번 읽었음 (SFR-107·133 첫 화면 정하기) */
  loaded: boolean;
  /** 추천 목록이 서버가 아니라 이 휴대폰 저장본에서 왔음 (오프라인, SFR-061). 저장한 시각 */
  cachedAt: number | null;
  /** 통신이 끊긴 채 만든 이송 건 (SFR-099). 복구되면 서버로 올라간다 */
  offlineCreated: boolean;
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
  confirmedHere: false,
  remainingM: null,
  arriveRequested: false,
  confirmed: null,
  lastSentSeq: 0,
  nearby: [],
  hospitalsRev: 0,
  noBed: [],
  mapIds: [],
  emptyGuide: null,
  nearbyLoading: false,
  nearEntrance: false,
  loaded: false,
  cachedAt: null,
  offlineCreated: false,
});

/**
 * 이송 화면 상태만 비운다. '서버를 한 번 읽었는지(loaded)'는 그대로 둔다.
 * loaded 까지 지우면 TransportRouter 가 '아직 안 읽음'으로 보고 화면 이동을 멈춰서,
 * 새 이송 시작 → 병원에 요청 뒤 요청 화면으로 안 넘어가던 버그가 있었다
 */
const cleared = (): EngineState => ({
  ...initial(),
  hospitalsRev: s.hospitalsRev,
  loaded: s.loaded,
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
  collectedAt?: string | null;
  stale?: boolean | null;
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
    collectedAt: c.collectedAt ?? null,
    stale: c.stale ?? null,
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

/**
 * 추천 목록 (SFR-027 · 098 · 029): 상위 5곳 카드 + 병상 정보 없는 병원(전화로 확인) + 반경 안 전체(지도).
 * 1초 넘게 걸리면 화면이 로딩 표시를 한다 (SFR-095)
 */
export async function loadNearby() {
  if (!s.transportId) return;
  s.nearbyLoading = true;
  emit();
  try {
    // 5초 안에 답이 없으면 통신 실패로 보고 지난 목록을 그대로 둔다 (SFR-008)
    const r = await api<{
      radiusKm: number;
      items: Card[];
      map: Card[];
      noBedInfo?: Card[];
      emptyGuide?: 'expand_radius' | 'call_nearby' | null;
    }>('GET', `/transports/${s.transportId}/recommendations`, { timeoutMs: 5000 });
    [...r.map, ...r.items, ...(r.noBedInfo ?? [])].forEach(fromCard);
    s.nearby = r.items.map((c) => String(c.id));
    s.noBed = (r.noBedInfo ?? []).map((c) => String(c.id));
    s.mapIds = [...r.map].sort((a, b) => a.distanceKm - b.distanceKm).map((c) => String(c.id));
    s.emptyGuide = r.emptyGuide ?? null;
    s.cachedAt = null;
    s.hospitalsRev += 1;
    // 조회에 성공할 때마다 휴대폰에 저장 (SFR-059)
    void currentLocation()
      .then((at) => (at ? saveCards(at, r.map as CachedCard[]) : undefined))
      .catch(() => undefined);
  } catch {
    // 통신 오류: 지난 목록 그대로 (SFR-008). 목록이 아예 없으면 휴대폰 저장본으로 (SFR-061)
    if (s.nearby.length === 0) await useCachedList();
  } finally {
    s.nearbyLoading = false;
    emit();
  }
}

/**
 * 휴대폰 저장본으로 추천 목록 채우기 (SFR-061): 서버가 다시 계산하지 않은 마지막 결과 그대로,
 * 제외 병원만 앱에서 뺀다. 빈 병상 있는 가까운 5곳 + 병상 정보 없는 곳
 */
async function useCachedList() {
  try {
    const c = await latestCards(await currentLocation());
    if (!c) return;
    c.cards.forEach((x) => fromCard(x as Card));
    // 고른 등급 이상만 (서버 추천과 같은 규칙, D-140)
    const gradeNo = s.grade ? GRADE_NO[s.grade] : null;
    const sorted = [...c.cards]
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .filter((x) => !s.excluded.includes(String(x.id)))
      .filter((x) => gradeNo === null || x.grade <= gradeNo);
    s.nearby = sorted
      .filter((x) => x.beds.er)
      .slice(0, 5)
      .map((x) => String(x.id));
    s.noBed = sorted
      .filter((x) => !x.beds.er)
      .slice(0, 3)
      .map((x) => String(x.id));
    s.mapIds = sorted.map((x) => String(x.id));
    s.cachedAt = c.savedAt;
    s.hospitalsRev += 1;
  } catch {
    /* 저장본도 없으면 '불러올 수 있는 병원 정보가 없습니다' */
  }
}

/**
 * 환자 정보를 입력하는 동안 반경 안 병원을 미리 불러와 저장 (SFR-001 · 059).
 * 오프라인이 되면 이 저장본으로 예비 추천을 보여 준다
 */
export async function preloadNearby(radiusKm = START_RADIUS) {
  const at = await currentLocation();
  if (!at) return;
  try {
    const cards = await api<CachedCard[]>(
      'GET',
      `/hospitals/nearby?lat=${at.lat}&lng=${at.lng}&radiusKm=${radiusKm}`,
      { timeoutMs: 5000 },
    );
    await saveCards(at, cards);
  } catch {
    /* 못 받으면 지난 저장본 그대로 */
  }
}

/** 추천 카드 상위 5곳 (서버가 등급·거리·빈 병상으로 고름) */
export const nearbyHospitals = () => s.nearby.map((id) => hospital(id));
/** 병상 정보가 전혀 없는 병원 (전화로 확인) */
export const noBedHospitals = () => s.noBed.map((id) => hospital(id));

/** 새로고침 (SFR-006): 이송 건과 추천 목록을 바로 다시 읽는다 */
export async function refreshAll() {
  await refresh();
  await loadNearby();
}

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
let lastT: ServerTransport | null = null;

export function apply(t: ServerTransport, myDevice = myDeviceId) {
  lastT = t;
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
  s.confirmedHere = pickedByMe === t.id;
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
        s = cleared();
        emit();
      }
      return;
    }
    /* 통신 오류: 지난 화면 그대로. 다시 붙으면 이벤트로 다시 읽는다 */
  }
}

/** 근무 시작 뒤 · 앱을 다시 켰을 때: 팀에 진행 중 이송이 있으면 이어서 보여 준다 (SFR-133) */
export async function loadCurrent() {
  if (s.transportId && isActive(s.status)) {
    await refresh();
  } else {
    s = cleared();
    await refresh();
    if (s.transportId) void loadNearby();
  }
  if (!s.loaded) {
    s.loaded = true;
    emit();
  }
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
 * 알림 (SFR-130) 보내는 함수. 앱이 켜질 때 notify.ts 의 notifyTeam 을 넣는다 (테스트에서는 가짜로 바꿈).
 * 팀원 폰 모두 같은 이벤트를 받으므로 각자 울린다.
 */
type Notifier = (kind: AlertKind, title: string, body?: string) => void;
let notifier: Notifier = () => {};
export function setTransportNotifier(fn: Notifier) {
  notifier = fn;
}

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
  // SFR-130: 첫 승인 · 연결 복구 승인 · 전부 거절/2분 만료(예비 추천) · 승인 해제 1분 전 · 해제 · 승인 취소
  offs.push(
    onEvent('request.approved', (ev) => {
      if (!ev.data.firstApproval && !ev.data.afterReconnect) return;
      const r = ev.data.request;
      notifier(
        'approval',
        `${r?.hospitalName ?? '병원'} 승인`,
        r?.etaMin ? `약 ${r.etaMin}분` : undefined,
      );
    }),
    onEvent('transport.status', (ev) => {
      if (ev.data.status !== 'fallback') return;
      notifier('warning', '승인한 병원이 없어요', '가까운 병원에 전화로 확인하세요');
    }),
    onEvent('approval.expiring', () =>
      notifier('warning', '1분 뒤 승인이 해제돼요', '병원을 골라 주세요'),
    ),
    onEvent('approval.expired', () =>
      notifier('warning', '승인이 해제됐어요', '요청 후 5분이 지났어요'),
    ),
    onEvent('request.cancelled', (ev) =>
      notifier(
        ev.data.wasConfirmed ? 'danger' : 'warning',
        `${ev.data.hospitalName ?? '병원'} 승인 취소`,
        ev.data.reason ?? undefined,
      ),
    ),
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
  // 통신이 복구되면: 밀린 기록을 발생 순서대로 올리고 → 최신으로 다시 읽기 (SFR-099 · 068)
  offs.push(
    whenOnline(async () => {
      const r = await flush<ServerTransport>().catch(() => null);
      if (r?.transport) apply(r.transport);
      s.offlineCreated = false;
      if (r?.alert)
        notifier(
          'warning',
          '서버에 이미 승인·확정이 있어요',
          '끊긴 동안의 기록은 이력으로만 남겼어요',
        );
      await refresh();
      await loadNearby();
    }),
  );
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
export async function previewTargets(
  grade: Grade,
  radiusKm = START_RADIUS,
): Promise<number | null> {
  const at = await currentLocation();
  if (!at) return null;
  try {
    const q = `lat=${at.lat}&lng=${at.lng}&radiusKm=${radiusKm}${grade ? `&grade=${GRADE_NO[grade]}` : ''}`;
    const r = await api<{ count: number }>('GET', `/request-targets/preview?${q}`);
    return r.count;
  } catch {
    return null;
  }
}

export type RejectReason =
  'er_bed' | 'or_room' | 'ward' | 'icu' | 'no_specialist' | 'equipment' | 'etc';

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
    // 확정·취소·목적지 변경 등은 통신이 끊기면 쌓아 두지 않는다 (SFR-099 · 111 · 160)
    if (isNetErr(e)) return { ok: false, error: OFFLINE_NOT_ALLOWED };
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

const isNetErr = (e: unknown) => e instanceof ApiError && e.code === 'NETWORK';
const OFFLINE_NOT_ALLOWED = '통신이 끊겨 지금은 할 수 없어요. 연결되면 다시 해 주세요';

/**
 * 통신 두절 중 화면만 먼저 바꾸기 (SFR-099). 서버에는 기록으로 쌓았다가 복구 때 올리고,
 * 최종 판정은 서버가 상태 전이표로 한다 (규칙 4). 그래서 이 값은 잠깐 보여 주는 용도
 */
function localApply(patch: Partial<ServerTransport>) {
  if (!lastT) return;
  apply({ ...lastT, ...patch, version: lastT.version });
}

function offlineConfirmed(hospitalId: string): ServerTransport['confirmedHospital'] {
  const h = hospital(hospitalId);
  return {
    id: Number(hospitalId),
    name: h.name,
    erPhone: h.erPhone || null,
    memo: null,
    extraMemo: null,
    entrance: { lat: h.lat ?? 0, lng: h.lng ?? 0 },
    requestStatus: 'confirmed',
    closeReason: null,
  };
}

/** 통신 두절 중 전화 결과: 기록으로 쌓고 화면만 먼저 (SFR-099) */
async function offlinePhoneResult(
  hospitalId: string,
  body: { result: string; reason?: string; rejectReason?: RejectReason; reasonText?: string },
) {
  await enqueue({
    kind: 'phone_check',
    transportId: tid(),
    hospitalId: Number(hospitalId),
    result: body.result as 'accepted',
    ...(body.reason ? { reason: body.reason } : {}),
    ...(body.reasonText ? { reasonText: body.reasonText } : {}),
    ...(body.rejectReason ? { rejectReason: body.rejectReason } : {}),
  });
  if (body.result === 'accepted' || body.result === 'no_answer' || body.result === 'skipped') {
    localApply({
      status: 'moving',
      phoneTarget: null,
      confirmedHospital: offlineConfirmed(hospitalId),
    });
    return;
  }
  const prev = lastT?.excludedHospitalIds ?? [];
  localApply({
    status: 'fallback',
    phoneTarget: null,
    excludedHospitalIds: body.result === 'rejected' ? [...prev, Number(hospitalId)] : prev,
  });
}

/**
 * 통신이 끊긴 채 '병원에 요청' (SFR-099): 병원에는 보내지 않고(지연 전송 안 함) 예비 추천 건을 만들어
 * 휴대폰 저장본 목록으로 전화 확인을 이어 간다. 복구되면 create_fallback 기록으로 서버에 등록된다
 */
async function offlineCreate(grade: Grade, patient: Patient, radiusKm: number): Promise<Result> {
  const location = await currentLocation();
  if (!location) return { ok: false, error: '위치를 가져오지 못했어요. 위치 권한을 확인해 주세요' };
  const id = uuid();
  await enqueue({
    kind: 'create_fallback',
    transportId: id,
    assessment: toAssessment(patient),
    radiusKm,
    location,
  });
  s = { ...initial(), hospitalsRev: s.hospitalsRev, loaded: true };
  apply({
    id,
    status: 'fallback',
    version: 1,
    serverNow: new Date().toISOString(),
    requestRadiusKm: radiusKm,
    fallbackRadiusKm: radiusKm,
    fallbackReason: 'offline',
    currentRound: null,
    requests: [],
    phoneTarget: null,
    confirmedHospital: null,
    canReRequest: false,
    destinationChangeUsed: false,
    navDeviceId: null,
    etaMin: null,
    lastSentAssessmentSeq: 0,
    excludedHospitalIds: [],
    requestedGrade: grade ? GRADE_NO[grade] : null,
  });
  s.offlineCreated = true;
  prevTransportId = null;
  await useCachedList();
  emit();
  return { ok: true, value: undefined };
}

const tid = () => {
  if (!s.transportId) throw new ApiError(0, 'NO_TRANSPORT', '진행 중 이송이 없어요');
  return s.transportId;
};

async function phoneResult(body: {
  result: string;
  reason?: string;
  rejectReason?: RejectReason;
  reasonText?: string;
}) {
  return guard(async () => {
    const hospitalId = s.phoneTarget;
    if (!hospitalId) throw new ApiError(409, 'NO_PHONE_TARGET', '전화 확인 중인 병원이 없어요');
    if (body.result !== 'rejected' && body.result !== 'dismissed') pickedByMe = tid();
    try {
      await api('POST', `/transports/${tid()}/phone-checks`, {
        body: { hospitalId: Number(hospitalId), version: s.version, ...body },
      });
    } catch (e) {
      if (!isNetErr(e)) throw e;
      await offlinePhoneResult(hospitalId, body);
      return;
    }
    await refresh();
  });
}

export const actions = {
  /** 이송 요청 (SFR-004·163). 환자 정보는 평가 항목만 (이름·연락처 없음, SER-012) */
  async create(grade: Grade, patient: Patient, radiusKm = START_RADIUS) {
    return guard(async () => {
      const location = await currentLocation();
      if (!location)
        throw new ApiError(0, 'NO_LOCATION', '위치를 가져오지 못했어요. 위치 권한을 확인해 주세요');
      stopDrive();
      s = cleared();
      const t = await api<ServerTransport>('POST', '/transports', {
        body: {
          id: uuid(),
          radiusKm,
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
    }).then((r) =>
      r.ok || r.error !== OFFLINE_NOT_ALLOWED ? r : offlineCreate(grade, patient, radiusKm),
    );
  },
  /** 승인 병원 1곳 확정 (SFR-110). 같은 확정을 두 번 보내도 서버가 한 번만 처리하게 Idempotency-Key */
  async confirm(hospitalId: string) {
    return guard(async () => {
      const r = s.hreqs.find((h) => h.hospitalId === hospitalId && h.status === 'approved');
      if (!r) throw new ApiError(409, 'REQUEST_NOT_APPROVED', '승인 상태가 아니에요');
      pickedByMe = tid();
      await api('POST', `/transports/${tid()}/confirm`, {
        body: { hospitalRequestId: r.id, version: s.version },
        headers: { 'Idempotency-Key': uuid() },
      });
      await refresh();
    });
  },
  /** 예비 추천 반경만 한 단계 넓혀 다시 찾기 (SFR-029, 요청은 안 보냄) */
  async widenRecommend() {
    return guard(async () => {
      const next = RADIUS_STEPS[RADIUS_STEPS.indexOf(s.radius) + 1];
      if (!next) throw new ApiError(409, 'MAX_RADIUS', '최대 반경(40km)이에요');
      await api('PUT', `/transports/${tid()}/fallback-radius`, { body: { radiusKm: next } });
      await refresh();
      await loadNearby();
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
      try {
        await api('POST', `/transports/${tid()}/phone-check/start`, {
          body: { hospitalId: Number(hospitalId), version: s.version },
        });
      } catch (e) {
        if (!isNetErr(e)) throw e;
        // 통신 두절: 전화 확인 화면만 먼저 (결과를 고르면 그때 기록으로 쌓는다)
        const h = hospital(hospitalId);
        localApply({
          status: 'phone_check',
          phoneTarget: { hospitalId: Number(hospitalId), name: h.name, erPhone: h.erPhone || null },
        });
        return;
      }
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
  /**
   * 전화 거절 (SFR-044 · 074): 사유는 고르지 않아도 된다. 기타면 글 20자.
   * 서버가 다음 후보로 넘기거나, 없으면 요청 화면·예비 추천으로
   */
  async phoneRejected(
    rejectReason?: RejectReason,
    reasonText?: string,
  ): Promise<Result<string | null>> {
    const r = await phoneResult({
      result: 'rejected',
      ...(rejectReason ? { rejectReason } : {}),
      ...(rejectReason === 'etc' && reasonText?.trim()
        ? { reasonText: reasonText.trim().slice(0, 20) }
        : {}),
    });
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
      try {
        await sendLatest(`/transports/${tid()}/arrive`, { method });
      } catch (e) {
        if (!isNetErr(e)) throw e;
        // 통신 두절: 도착 기록을 쌓고 화면만 먼저 (SFR-099)
        await enqueue({ kind: 'arrive', transportId: tid(), method: 'button' });
        stopDrive();
        localApply({ status: 'arrived' });
        return;
      }
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
    s = cleared();
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
let lastFix: Fix | null = null;
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
  lastFix = null;
  s.remainingM = null;
  s.nearEntrance = false;
}

const iAmDriver = () => {
  const t = teamStore.get().team;
  return t !== 'loading' && !!t?.members?.some((m) => m.isMe && m.role === 'driver');
};
const teamHasDriver = () => {
  const t = teamStore.get().team;
  return t !== 'loading' && !!t?.members?.some((m) => m.role === 'driver');
};

/**
 * SFR-132: 병원을 고른 폰(확정·전화 수용)을 기억한다. 팀에 운전 대원이 없거나
 * 운전 폰이 10초 안에 응답하지 않으면 이 폰이 경로 안내를 맡는다
 */
let pickedByMe: string | null = null;
let movingSince: { id: string; at: number } | null = null;
let claimRetry: ReturnType<typeof setTimeout> | null = null;
const DRIVER_WAIT_MS = 10_000;
/** 경로 안내를 연 이송 건 (한 건에 한 번만 저절로 연다) */
const routeOpened = new Set<string>();
type RouteOpener = (to: LatLng, name: string) => void;
let routeOpener: RouteOpener = () => {};
/** 앱이 켜질 때 '길 안내 페이지 열기'를 넣는다 (테스트에서는 가짜로) */
export function setRouteOpener(fn: RouteOpener) {
  routeOpener = fn;
}

function claimNav() {
  if (claiming) return;
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

function afterApply() {
  if (s.status !== 'moving') {
    if (drive) stopDrive();
    return;
  }
  const id = s.transportId!;
  if (movingSince?.id !== id) movingSince = { id, at: Date.now() };
  // 경로 안내 담당 정하기 (SFR-132): 운전 폰이 맡고, 운전이 없거나 10초 안에 안 맡으면 병원을 고른 폰이 맡는다
  if (!s.navDeviceId) {
    if (iAmDriver()) claimNav();
    else if (pickedByMe === id) {
      const waited = Date.now() - movingSince.at;
      if (!teamHasDriver() || waited >= DRIVER_WAIT_MS) claimNav();
      else if (!claimRetry) {
        claimRetry = setTimeout(
          () => {
            claimRetry = null;
            void refresh();
          },
          DRIVER_WAIT_MS - waited + 50,
        );
      }
    }
  }
  const target = s.confirmed?.entrance;
  if (!s.navIsMe || !target) {
    if (drive) stopDrive();
    return;
  }
  // 담당 폰에서 경로 안내를 저절로 시작 (한 건에 한 번). 다른 팀원 폰에는 목적지·남은 시간만
  if (!routeOpened.has(id)) {
    routeOpened.add(id);
    routeOpener(target, hospital(s.confirmedId).name);
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
  let fix: Fix | null;
  if (FIXED_LOCATION) {
    // 시연: 입구 쪽으로 시속 약 40km 로 움직이다가 도착하면 멈춘 것으로
    const at = moveToward(d.at, d.target, SPEED_MPS * STEP_SEC);
    const arrived = distanceM(at, d.target) < 1;
    fix = { ...at, accuracyM: 5, speedKmh: arrived ? 0 : SPEED_MPS * 3.6, at: now() };
  } else {
    fix = await currentFix(3000);
  }
  if (fix) d.at = { lat: fix.lat, lng: fix.lng };
  const left = distanceM(d.at, d.target);
  s.remainingM = Math.round(left);
  // 도착 버튼 (SFR-038): 이상치 좌표(SFR-040)는 판정에 쓰지 않는다
  if (fix && !isOutlier(lastFix, fix)) {
    s.nearEntrance = nearEntrance(left, fix.accuracyM, fix.speedKmh);
    lastFix = fix;
  }
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
            speedKmh: fix?.speedKmh ?? 0,
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

/** 테스트용: 앱을 켜고 서버를 한 번 읽은 것으로 */
export function __setLoadedForTest() {
  s.loaded = true;
  emit();
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
  lastT = null;
  pickedByMe = null;
  movingSince = null;
  if (claimRetry) clearTimeout(claimRetry);
  claimRetry = null;
  routeOpened.clear();
}
