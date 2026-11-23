/**
 * 이송 건 상태 (서버 연결 ②). 예전에는 앱 안에서 서버를 흉내 냈지만, 이제 상태는 모두 세이브타임 서버가 정한다.
 * - 바꾸기: REST (POST /transports …). 상태 전이 판정은 서버의 stateMachine.ts 가 한다 (앱은 결과만 받는다)
 * - 알기: Socket.IO 이벤트에는 ID·개수·시각만 온다 → 받으면 GET /transports/{id} 로 다시 읽는다
 * - 시간: 2분·5분 남은 시간은 서버 시각(serverNow) 기준으로 센다
 * 화면들이 쓰던 모양(useEngine · actions · hospital(id) …)은 그대로 두어 화면 코드를 거의 바꾸지 않았다.
 */
import { useSyncExternalStore } from "react";
import type { TransportStatus, HreqStatus, CloseReason, FallbackReason, PhoneProceedReason, DestChangeReason } from "./domain/stateMachine";
import { api, ApiError, deviceId, errorText, serverNow } from "./api";
import { onEvent } from "./realtime";
import { getAuth } from "./auth-store";
import { RADIUS_STEPS, START_RADIUS, type Hospital } from "./hospitals";
import { currentLocation, distanceM, moveToward, FIXED_LOCATION, type LatLng } from "./location";
import { UNKNOWN, type Grade, type Patient } from "./transport-store";

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

export type HistoryItem = { from: TransportStatus | null; to: TransportStatus; reason: string | null; at: number; label: string };

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
  confirmed: { entrance: LatLng | null; memo: string | null; erPhone: string | null } | null;
  lastSentSeq: number;
  /** 병원 목록 (거리순, 추천 API) */
  nearby: string[];
  /** 병원 정보 캐시가 바뀔 때마다 늘어남 (화면 다시 그리기용) */
  hospitalsRev: number;
};

const initial = (): EngineState => ({
  transportId: null, status: null, version: 1, radius: START_RADIUS, round: 0, roundSentAt: 0, grade: null, hreqs: [],
  excluded: [], phoneTarget: null, confirmedId: null, alert: null, destChanged: false, fallbackReason: null, history: [],
  etaMin: null, navDeviceId: null, navIsMe: false, remainingM: null, arriveRequested: false, confirmed: null,
  lastSentSeq: 0, nearby: [], hospitalsRev: 0,
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
      return () => subs.delete(f);
    },
    () => s,
    () => s,
  );
}
export const getEngine = () => s;

// ---------------- 병원 정보 (서버 응답으로 채우는 캐시) ----------------
const hospitals = new Map<string, Hospital>();
const GRADE_NAME: Record<number, Exclude<Grade, null>> = { 1: "대학병원급", 2: "종합병원급", 3: "일반 병원" };
const GRADE_NO: Record<Exclude<Grade, null>, 1 | 2 | 3> = { 대학병원급: 1, 종합병원급: 2, "일반 병원": 3 };

const placeholder = (id: string): Hospital => ({
  id, name: "병원", km: 0, min: 0, depts: [], caps: [], erPhone: "", mainPhone: "", bedsAt: "", grade: "일반 병원", phone: "",
});

/** 병원 정보 (모르면 빈 자리). 화면은 이것만 부른다 */
export const hospital = (id: string | null): Hospital => (id && hospitals.get(id)) || placeholder(id ?? "");

const hhmm = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }) : "";

function upsertHospital(id: string, patch: { [K in keyof Hospital]?: Hospital[K] | undefined }) {
  const prev = hospitals.get(id) ?? placeholder(id);
  // undefined 칸은 덮어쓰지 않는다 (추천 목록에는 진료과가 없고, 상세에는 거리가 없다)
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Hospital>;
  hospitals.set(id, { ...prev, ...clean });
}

type Card = {
  id: number; name: string; lat: number; lng: number; distanceKm: number; etaMin: number | null;
  beds: { er: string | null; icu: string | null; or: string | null }; bedsSourceTime: string | null;
  capabilityCount: { available: number; total: number }; erPhone: string | null; grade: number;
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
    erPhone: c.erPhone ?? "",
    phone: c.erPhone ?? "",
    bedsAt: hhmm(c.bedsSourceTime),
    grade: GRADE_NAME[c.grade] ?? "일반 병원",
    capCount: c.capabilityCount,
    lat: c.lat,
    lng: c.lng,
  });
}

/** 병원 상세 (진료과·진료가능 항목·대표 전화). 상세 화면을 열 때 부른다 (SFR-007) */
export async function loadHospitalDetail(id: string) {
  try {
    const d = await api<{
      id: number; name: string; lat: number; lng: number; departments: string[] | null; erPhone: string | null; mainPhone: string | null;
      beds: Record<"er" | "icu" | "or", { avail: number | null; total: number | null }>; bedsSourceTime: string | null;
      capabilities: { name: string; available: boolean }[]; grade: number;
    }>("GET", `/hospitals/${id}`);
    const bed = (b: { avail: number | null; total: number | null }) => (b.avail === null ? undefined : `${b.avail}/${b.total ?? "?"}`);
    upsertHospital(id, {
      name: d.name, depts: d.departments ?? [], erPhone: d.erPhone ?? "", phone: d.erPhone ?? "", mainPhone: d.mainPhone ?? "",
      er: bed(d.beds.er), icu: bed(d.beds.icu), or: bed(d.beds.or), bedsAt: hhmm(d.bedsSourceTime), caps: d.capabilities,
      capCount: { available: d.capabilities.filter((c) => c.available).length, total: d.capabilities.length },
      grade: GRADE_NAME[d.grade] ?? "일반 병원", lat: d.lat, lng: d.lng,
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
    const r = await api<{ radiusKm: number; map: Card[] }>("GET", `/transports/${s.transportId}/recommendations`);
    r.map.forEach(fromCard);
    s.nearby = [...r.map].sort((a, b) => a.distanceKm - b.distanceKm).map((c) => String(c.id));
    s.hospitalsRev += 1;
    emit();
  } catch {
    /* 위치 없는 건 등은 목록 없이 */
  }
}

/** 거리순 병원 목록 (지금 반경 안) */
export const nearbyHospitals = () => s.nearby.map((id) => hospital(id)).filter((h) => h.km <= s.radius);

// ---------------- 서버 이송 건 → 화면 상태 ----------------
type ServerRequest = {
  id: number; hospitalId: number; hospitalName: string; lat: number; lng: number; status: HreqStatus; closeReason: CloseReason | null;
  etaMin: number | null; erBeds: string | null; memo: string | null; extraMemo: string | null; reason: string | null;
  reasonText: string | null; approvedAt: string | null; prevApprovedRecheck: boolean; version: number;
};
type ServerTransport = {
  id: string; status: TransportStatus; version: number; serverNow: string; requestRadiusKm: number; fallbackRadiusKm: number;
  fallbackReason: FallbackReason | null;
  currentRound: { roundNo: number; sentAt: string; respondUntil: string } | null;
  requests: ServerRequest[];
  phoneTarget: { hospitalId: number; name: string | null; erPhone: string | null } | null;
  confirmedHospital: {
    id: number; name: string; erPhone: string | null; memo: string | null; extraMemo: string | null;
    entrance: LatLng; requestStatus: HreqStatus; closeReason: CloseReason | null;
  } | null;
  canReRequest: boolean; destinationChangeUsed: boolean; navDeviceId: string | null; etaMin: number | null;
  lastSentAssessmentSeq: number; excludedHospitalIds: number[]; requestedGrade: number | null;
};

const STATUS_STEP_LABEL: Record<TransportStatus, string> = {
  requesting: "병원에 요청", fallback: "예비 추천", phone_check: "전화 확인 시작", moving: "이동 시작", arrived: "도착 처리", cancelled: "이송 취소",
};
const REJECT_TEXT: Partial<Record<string, string>> = {
  er_bed: "응급실 병상 부족", or_room: "수술실 부족", ward: "입원 병상 부족", icu: "중환자실 부족", no_specialist: "전문의 부재",
  equipment: "장비 문제", etc: "기타", paused: "요청 잠시 중지",
};

function apply(t: ServerTransport) {
  const from = s.status;
  s.transportId = t.id;
  s.version = t.version;
  // 요청 중에는 요청 반경, 예비 추천·전화 확인에서는 추천(넓힌) 반경을 보여 준다
  s.radius = t.status === "fallback" || t.status === "phone_check" ? t.fallbackRadiusKm : t.requestRadiusKm;
  s.round = t.currentRound?.roundNo ?? 0;
  s.roundSentAt = t.currentRound ? new Date(t.currentRound.sentAt).getTime() : 0;
  s.grade = t.requestedGrade ? (GRADE_NAME[t.requestedGrade] ?? null) : null;
  s.fallbackReason = t.fallbackReason;
  s.excluded = t.excludedHospitalIds.map(String);
  s.phoneTarget = t.phoneTarget ? String(t.phoneTarget.hospitalId) : null;
  if (t.phoneTarget) {
    upsertHospital(String(t.phoneTarget.hospitalId), {
      name: t.phoneTarget.name ?? "병원",
      ...(t.phoneTarget.erPhone ? { erPhone: t.phoneTarget.erPhone, phone: t.phoneTarget.erPhone } : {}),
    });
  }
  for (const r of t.requests) {
    upsertHospital(String(r.hospitalId), {
      name: r.hospitalName, lat: r.lat, lng: r.lng, ...(r.erBeds ? { er: r.erBeds } : {}), ...(r.etaMin !== null ? { min: r.etaMin } : {}),
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
    ...(r.reason ? { reason: r.reason === "etc" && r.reasonText ? r.reasonText : (REJECT_TEXT[r.reason] ?? r.reason) } : {}),
    ...(r.approvedAt ? { respondedAt: new Date(r.approvedAt).getTime() } : {}),
    recheck: r.prevApprovedRecheck,
  }));
  const c = t.confirmedHospital;
  s.confirmedId = c ? String(c.id) : null;
  s.confirmed = c ? { entrance: c.entrance, memo: c.memo, erPhone: c.erPhone } : null;
  if (c) upsertHospital(String(c.id), { name: c.name, ...(c.erPhone ? { erPhone: c.erPhone, phone: c.erPhone } : {}) });
  s.alert = t.canReRequest && c ? `${c.name}이(가) 승인을 취소했어요` : null;
  s.destChanged = t.destinationChangeUsed;
  s.etaMin = t.etaMin;
  s.navDeviceId = t.navDeviceId;
  s.navIsMe = !!t.navDeviceId && t.navDeviceId === deviceId();
  s.lastSentSeq = t.lastSentAssessmentSeq;
  s.status = t.status;
  if (from !== t.status) {
    s.history = [
      ...s.history,
      { from, to: t.status, reason: t.status === "fallback" ? t.fallbackReason : null, at: now(), label: STATUS_STEP_LABEL[t.status] },
    ];
    if (t.status !== "moving") s.arriveRequested = false;
  }
  s.hospitalsRev += 1;
  emit();
  afterApply();
}

let refreshing: Promise<void> | null = null;
let again = false;
/** 서버에서 이송 건을 다시 읽는다. 이벤트가 몰려 와도 한 번에 하나씩 */
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
  if (!getAuth().tokens) return;
  try {
    const t = s.transportId
      ? await api<ServerTransport>("GET", `/transports/${s.transportId}`).catch(async (e) => {
          // 팀이 바뀌었거나 볼 수 없는 건이면 진행 중 건을 새로 찾는다
          if (e instanceof ApiError && e.status === 404) return api<ServerTransport>("GET", "/transports/current");
          throw e;
        })
      : await api<ServerTransport>("GET", "/transports/current");
    apply(t);
  } catch (e) {
    if (e instanceof ApiError && e.code === "NO_ACTIVE_TRANSPORT") {
      if (s.status && !["arrived", "cancelled"].includes(s.status)) {
        s = { ...initial(), hospitalsRev: s.hospitalsRev };
        emit();
      }
      return;
    }
    /* 통신 오류: 지난 화면 그대로. 다시 붙으면 이벤트로 다시 읽는다 */
  }
}

/** 로그인·근무 시작 뒤: 팀에 진행 중 이송이 있으면 이어서 보여 준다 (SFR-133) */
export async function loadCurrent() {
  if (s.transportId && s.status && !["arrived", "cancelled"].includes(s.status)) return refresh();
  s = { ...initial(), hospitalsRev: s.hospitalsRev };
  await refresh();
  if (s.transportId) void loadNearby();
}

// 팀 방 이벤트 → 다시 읽기 (이벤트에는 ID 만 온다, 규칙 5)
const RELOAD = [
  "transport.created", "transport.status", "transport.confirmed", "transport.phone_target", "transport.nav_device", "transport.eta",
  "transport.arrived", "transport.unacceptable", "request.changed", "request.approved", "request.rejected", "request.expired",
  "request.cancelled", "request.delivered", "request.eta", "round.started", "approval.expiring", "approval.expired", "assessment.sent",
  "snapshot_required",
];
let debounce: ReturnType<typeof setTimeout> | undefined;
let roundStarted = false;
if (typeof window !== "undefined") {
  for (const name of RELOAD) {
    onEvent(name, () => {
      if (name === "round.started" || name === "transport.created") roundStarted = true;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const hadTransport = !!s.transportId;
        const newRound = roundStarted;
        roundStarted = false;
        void refresh().then(() => {
          if ((!hadTransport && s.transportId) || newRound) void loadNearby();
        });
      }, 120);
    });
  }
  onEvent("transport.arrive_requested", () => {
    s.arriveRequested = true;
    emit();
    void refresh();
  });
  // 남은 시간 표시를 위해 0.5초마다 다시 그린다. 진행 중이면 15초마다 서버 상태도 다시 맞춘다 (이벤트를 놓쳐도)
  setInterval(() => {
    if (s.status) emit();
  }, 500);
  setInterval(() => {
    if (s.status && !["arrived", "cancelled"].includes(s.status)) void refresh();
  }, 15_000);
}

// ---------------- 환자 정보 → 서버 평가 항목 (openapi Assessment) ----------------
const CONSC: Record<string, string> = { 명료: "alert", "말에 반응": "verbal", "통증에 반응": "pain", 무반응: "unresponsive" };
const known = (v: string) => v.trim() !== "" && v !== UNKNOWN;
const int = (v: string) => {
  const n = Number.parseInt(v, 10);
  return known(v) && Number.isFinite(n) ? n : null;
};

export function toAssessment(p: Patient) {
  const unknownFields: string[] = [];
  const pairs: [string, string][] = [
    ["chiefComplaint", p.complaint], ["sex", p.sex], ["ageBand", p.age], ["consciousness", p.consciousness], ["bp", p.bp],
    ["pulse", p.pulse], ["resp", p.resp], ["spo2", p.spo2], ["painSite", p.painSite], ["painScore", p.painScore],
    ["onset", p.onset], ["trauma", p.trauma],
  ];
  for (const [field, v] of pairs) if (v === UNKNOWN) unknownFields.push(field);
  const painScore = int(p.painScore);
  const temp = Number.parseFloat(p.temp);
  const ktas = int(p.ktas);
  return {
    chiefComplaint: p.complaint.trim().slice(0, 100) || UNKNOWN,
    sex: p.sex === "남" ? "M" : p.sex === "여" ? "F" : "U",
    ageBand: known(p.age) ? p.age.slice(0, 10) : UNKNOWN,
    consciousness: CONSC[p.consciousness] ?? "unknown",
    ...(known(p.bp) ? { bp: p.bp.slice(0, 10) } : {}),
    pulse: int(p.pulse),
    resp: int(p.resp),
    spo2: int(p.spo2),
    painSite: known(p.painSite) ? p.painSite.slice(0, 30) : null,
    painScore: painScore !== null && painScore >= 0 && painScore <= 10 ? painScore : null,
    onset: known(p.onset) ? p.onset.slice(0, 30) : null,
    trauma: !known(p.trauma) ? "unknown" : /없|무|^no$/i.test(p.trauma.trim()) ? "no" : "yes",
    history: known(p.history) ? p.history.slice(0, 500) : null,
    temp: known(p.temp) && temp >= 20 && temp <= 45 ? temp : null,
    glucose: int(p.glucose),
    ktas: ktas !== null && ktas >= 1 && ktas <= 5 ? ktas : null,
    unknownFields,
  };
}

/** 요청 전 미리보기: 'n곳에 요청합니다' (SFR-163). 못 세면 null */
export async function previewTargets(grade: Grade): Promise<number | null> {
  const at = await currentLocation();
  if (!at) return null;
  try {
    const q = new URLSearchParams({ lat: String(at.lat), lng: String(at.lng), radiusKm: String(START_RADIUS) });
    if (grade) q.set("grade", String(GRADE_NO[grade]));
    const r = await api<{ count: number }>("GET", `/request-targets/preview?${q.toString()}`);
    return r.count;
  } catch {
    return null;
  }
}

// ---------------- 대원 행동 (화면에서 부름). 결과는 { ok, error } ----------------
export type Result<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (e) {
    // 다른 팀원이 먼저 바꿨으면(버전 충돌) 최신 상태로 맞춘다 (SFR-160)
    if (e instanceof ApiError && (e.code === "VERSION_CONFLICT" || e.status === 409)) void refresh();
    return { ok: false, error: errorText(e) };
  }
}

const tid = () => {
  if (!s.transportId) throw new ApiError(0, "NO_TRANSPORT", "진행 중 이송이 없어요");
  return s.transportId;
};

async function phoneResult(body: { result: string; reason?: string }) {
  return guard(async () => {
    const hospitalId = s.phoneTarget;
    if (!hospitalId) throw new ApiError(409, "NO_PHONE_TARGET", "전화 확인 중인 병원이 없어요");
    await api("POST", `/transports/${tid()}/phone-checks`, { body: { hospitalId: Number(hospitalId), version: s.version, ...body } });
    await refresh();
  });
}

export const actions = {
  async create(grade: Grade, patient: Patient) {
    return guard(async () => {
      const location = await currentLocation();
      if (!location) throw new ApiError(0, "NO_LOCATION", "위치를 가져오지 못했어요. 위치 권한을 확인해 주세요");
      stopDrive();
      s = { ...initial(), hospitalsRev: s.hospitalsRev };
      const t = await api<ServerTransport>("POST", "/transports", {
        body: {
          id: crypto.randomUUID(),
          radiusKm: START_RADIUS,
          location,
          locationConsent: true,
          assessment: toAssessment(patient),
          requestedGrade: grade ? GRADE_NO[grade] : null,
        },
      });
      apply(t);
      void loadNearby();
    });
  },
  async confirm(hospitalId: string) {
    return guard(async () => {
      const r = s.hreqs.find((h) => h.hospitalId === hospitalId && h.status === "approved");
      if (!r) throw new ApiError(409, "REQUEST_NOT_APPROVED", "승인 상태가 아니에요");
      await api("POST", `/transports/${tid()}/confirm`, {
        body: { hospitalRequestId: r.id, version: s.version },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      await refresh();
    });
  },
  async expand() {
    return guard(async () => {
      const next = RADIUS_STEPS[RADIUS_STEPS.indexOf(s.radius) + 1];
      if (!next) throw new ApiError(409, "MAX_RADIUS", "최대 반경(40km)이에요");
      await api("POST", `/transports/${tid()}/rounds`, { body: { kind: "expand", radiusKm: next, version: s.version } });
      await refresh();
      void loadNearby();
    });
  },
  async startPhone(hospitalId: string) {
    return guard(async () => {
      await api("POST", `/transports/${tid()}/phone-check/start`, { body: { hospitalId: Number(hospitalId), version: s.version } });
      await refresh();
    });
  },
  phoneAccepted() {
    return phoneResult({ result: "accepted" });
  },
  /** 연결 실패(no_answer)·확인 생략(skipped) 뒤 사유를 골라 이 병원으로 출발 */
  phoneProceed(reason: PhoneProceedReason, kind: "no_answer" | "skipped" = "no_answer") {
    return phoneResult({ result: kind, reason });
  },
  /** 전화 거절: 서버가 다음 후보(추천 순서)로 넘기거나, 없으면 요청 화면·예비 추천으로 */
  async phoneRejected(): Promise<Result<string | null>> {
    const r = await phoneResult({ result: "rejected" });
    return r.ok ? { ok: true, value: s.phoneTarget } : r;
  },
  phoneDismiss() {
    return phoneResult({ result: "dismissed" });
  },
  /** 바뀐 환자 정보를 병원에 보내기 (SFR-105): 팀 작성 중 정보에 넣고 → 보내기 */
  async updateAssessment(patient: Patient) {
    return guard(async () => {
      const draft = await api<{ version: number }>("GET", "/teams/current/draft");
      await api("PATCH", "/teams/current/draft", { body: { baseVersion: draft.version, changes: toAssessment(patient) } });
      await api("POST", `/transports/${tid()}/assessments`, { body: { baseSeq: s.lastSentSeq } }).catch((e) => {
        if (e instanceof ApiError && e.code === "NOTHING_TO_SEND") throw new ApiError(400, e.code, "바뀐 내용이 없어요");
        throw e;
      });
      await refresh();
    });
  },
  async arrive(method: "button" | "hospital" = "button") {
    return guard(async () => {
      await api("POST", `/transports/${tid()}/arrive`, { body: { method, version: s.version } });
      stopDrive();
      await refresh();
    });
  },
  async reRequest() {
    return guard(async () => {
      const location = drive?.at ?? (await currentLocation());
      await api("POST", `/transports/${tid()}/rounds`, { body: { kind: "re_request", version: s.version, location } });
      await refresh();
      void loadNearby();
    });
  },
  async changeDestination(reason: DestChangeReason) {
    return guard(async () => {
      const location = drive?.at ?? (await currentLocation());
      await api("POST", `/transports/${tid()}/destination`, { body: { reason, version: s.version, location } });
      // 새 병원이 정해질 때까지 위치 기록을 멈춘다 (요청 중으로 돌아감). 실패하면 그대로 이어 간다
      stopDrive();
      await refresh();
      void loadNearby();
    });
  },
  async cancel() {
    return guard(async () => {
      await api("POST", `/transports/${tid()}/cancel`, { body: { version: s.version } });
      stopDrive();
      await refresh();
    });
  },
  /** 이 기기 화면만 비운다 (서버의 이송 건은 그대로). 일지를 마치고 새 이송을 시작할 때 */
  reset() {
    stopDrive();
    s = { ...initial(), hospitalsRev: s.hospitalsRev };
    emit();
  },
};

export function openRemain() {
  return s.hreqs.some((h) => (h.round === s.round && h.status === "waiting") || h.status === "approved");
}

/** 전화 확인 후보: 승인 대기 중이 아닌 가까운 병원(제외 병원 빼고) */
export function phoneCandidates() {
  return nearbyHospitals().filter(
    (h) => !s.excluded.includes(h.id) && !s.hreqs.some((r) => r.hospitalId === h.id && (r.status === "waiting" || r.status === "approved")),
  );
}

export function latestReq(id: string) {
  return [...s.hreqs].reverse().find((h) => h.hospitalId === id);
}

export const REASON_LABEL: Record<string, string> = {
  all_rejected: "모든 병원이 거절했어요", expired_no_approval: "2분 동안 승인한 병원이 없어요", none_delivered: "요청이 병원에 전달되지 않았어요",
  approvals_cancelled: "병원들이 승인을 취소했어요", approval_window: "요청 후 5분이 지나 요청이 닫혔어요", no_target: "조건에 맞는 병원이 없어요",
  offline: "통신이 끊겨 요청을 보내지 못했어요", phone_rejected_last: "전화한 병원이 모두 거절했어요", phone_dismissed: "전화 결과를 고르지 않았어요",
  no_answer: "연결 실패", busy: "통화 중", urgent: "환자 급함", etc: "기타", user: "대원이 취소", button: "도착 버튼",
  patient_change: "환자 상태 변화", road: "도로 사정", hospital: "병원 사정",
};
export const HREQ_LABEL: Record<HreqStatus, string> = {
  waiting: "대기", delivery_failed: "전달 실패", approved: "승인", rejected: "거절", expired: "응답 없음",
  closed: "닫힘", confirmed: "확정", arrived: "도착", unacceptable: "수용 불가",
};
export const CLOSE_LABEL: Record<CloseReason, string> = {
  other_hospital: "다른 병원 확정", fallback: "요청 종료", cancelled: "취소됨", expired_approval: "승인 만료(5분)",
  approval_cancelled: "승인 취소", dest_changed: "목적지 변경",
};

// ---------------- 이동 중: 경로 안내 담당 · 위치 기록 (SFR-036·037·121·132) ----------------
// 운전 역할 단말은 확정 뒤 10초 안에 '내가 담당'이라고 알린다. 담당 단말만 5초마다 위치를 올린다.
// 시연(고정 위치)에서는 병원 입구 쪽으로 시속 약 40km 로 움직이는 것처럼 흉내 내고, 남은 분을 1분마다 같이 보낸다.
const SPEED_MPS = 11;
const STEP_SEC = 5;
let drive: { timer: ReturnType<typeof setInterval>; at: LatLng; target: LatLng; minuteSent: number } | null = null;
let claiming = false;

function stopDrive() {
  if (drive) clearInterval(drive.timer);
  drive = null;
  s.remainingM = null;
}

function afterApply() {
  if (s.status !== "moving") {
    if (drive) stopDrive();
    return;
  }
  // 운전 역할이면 경로 안내 담당을 맡는다
  if (!s.navDeviceId && getAuth().duty?.role === "운전" && !claiming) {
    claiming = true;
    void api("POST", `/transports/${s.transportId}/nav-device`, { body: { deviceId: deviceId(), version: s.version } })
      .then(() => refresh())
      .catch(() => undefined)
      .finally(() => {
        claiming = false;
      });
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
  if (drive || s.status !== "moving") return;
  drive = { at: start, target, minuteSent: 0, timer: setInterval(() => void stepDrive(), STEP_SEC * 1000) };
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
    await api("POST", `/transports/${s.transportId}/locations`, {
      body: {
        deviceId: deviceId(),
        points: [{ lat: d.at.lat, lng: d.at.lng, speedKmh: left > 5 ? SPEED_MPS * 3.6 : 0, recordedAt: new Date(now()).toISOString() }],
        ...(sendEta ? { etaMin } : {}),
      },
    });
    if (sendEta) d.minuteSent = now();
  } catch {
    /* 끊기면 다음 5초에 다시 */
  }
}

// ---------------- 구급활동일지 초안 (SFR-164) ----------------
// 이송이 끝난 뒤 10분 안에 팀원 누구나 받을 수 있다. 병원이 '도착 확인'을 눌러 끝났거나 팀원이 도착을 눌러서
// 이 폰에 병원·시각·환자 정보가 없을 때 일지를 채우는 데 쓴다. 환자 이름·연락처는 서버에 없다 (SER-012)
export type JournalDraft = {
  departedAt: string | null;
  arrivedAt: string | null;
  distanceKm: number | null;
  sex: "M" | "F" | null;
  ageBand: string | null;
  chiefComplaint: string | null;
  onsetAt: string | null;
  consciousness: "A" | "V" | "P" | "U" | null;
  vitals: { sbp: number | null; dbp: number | null; pulse: number | null; resp: number | null; temp: number | null; spo2: number | null; glucose: number | null };
  history: string | null;
  ktas: number | null;
  hospitalName: string | null;
};

export async function loadJournalDraft(): Promise<JournalDraft | null> {
  if (!s.transportId || !s.status || !["arrived", "cancelled"].includes(s.status)) return null;
  try {
    return await api<JournalDraft>("GET", `/transports/${s.transportId}/journal-draft`);
  } catch {
    return null;
  }
}
