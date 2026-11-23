/**
 * 계정 · 첫 사용 · 근무 상태. 계정·팀은 세이브타임 서버가 정하고(auth-server.ts 가 받아 와서 여기에 넣음),
 * 이 기기에는 위치 동의 · 권한 · 로그인 토큰 · 서버에서 받은 내 정보만 저장한다.
 * 요구사항 v1.4 (CR-004): 자동 로그인(30일) · 앱 잠금(PIN) 삭제 → 로그인은 근무 동안만 유지 (refresh 토큰 최대 14시간).
 * 비밀번호는 이 기기에 저장하지 않는다 (서버에만 해시).
 */
import { useSyncExternalStore } from "react";
import type { Tokens } from "./api";

export type Rank = "소방사" | "소방교" | "소방장" | "소방위" | "소방경";
export const RANKS: Rank[] = ["소방사", "소방교", "소방장", "소방위", "소방경"];

/** 서버의 내 정보(GET /me)를 화면이 쓰던 모양으로 */
export type Account = {
  loginId: string;
  paramedicId: number;
  name: string;
  rank: string;
  orgCode: string;
  orgName: string;
  center: string;
  employeeNo: string;
  status: "pending" | "approved" | "rejected" | "suspended";
  rejectReason?: string;
  appliedAt: string;
  mustChangePassword?: boolean;
};

export type Role = "처치" | "운전";
export type ServerRole = "care" | "driver";
export const toServerRole = (r: Role): ServerRole => (r === "운전" ? "driver" : "care");
export const fromServerRole = (r: ServerRole): Role => (r === "driver" ? "운전" : "처치");

/** loginId 칸에는 서버의 대원 번호(paramedicId)를 문자열로 넣는다 (화면이 key 로만 쓴다) */
export type Member = {
  loginId: string;
  name: string;
  rank: string;
  center: string;
  employeeNo: string;
  role: Role;
};
export type Duty = {
  /** 팀은 서버에 이미 있고, '근무 시작'을 눌렀는지 (팀을 만든 뒤 팀원을 기다리는 동안은 false) */
  started: boolean;
  startedAt: string;
  teamId: number;
  teamCode: string;
  qrToken: string;
  isCreator: boolean;
  role: Role;
  /** 나를 뺀 팀원 */
  members: Member[];
  maxMembers: number;
};

/** SFR-159: 내 폰으로 온 '팀 초대' (서버 team.invited, 5분 뒤 만료) */
export type Incoming = {
  id: string;
  inviteId: number;
  from: { loginId: string; name: string; rank: string; center: string; employeeNo: string };
  teamCode: string;
  role: Role;
  sentAt: number;
};

export type Perm = "unknown" | "granted" | "denied";

export type AuthState = {
  consent: "unknown" | "agreed" | "refused";
  permissions: { location: Perm; phone: Perm; notify: Perm };
  /** 로그인한 내 계정 1개 (loginId → 계정) */
  accounts: Record<string, Account>;
  session: string | null; // 로그인한 loginId
  tokens: Tokens | null;
  /** 로그인 잠금 안내용 (실제 잠금은 서버가 한다, SER-011) */
  failCount: number;
  lockedUntil: number;
  duty: Duty | null;
  incoming: Incoming[];
  serverMinVersion: string;
  featureFlags: { journalAi: boolean; hospitalGrade: boolean };
};

export const APP_VERSION = "1.4.2";
export const MAX_FAILS = 5; // SER-011
export const LOCK_MS = 10 * 60_000; // SER-011
export const DUTY_MAX_MS = 14 * 60 * 60_000; // SER-007
export const TEAM_MAX = 4; // SFR-113
export const INVITE_MS = 5 * 60_000; // SFR-159

const KEY = "savetime-auth-v3";
export const initialAuth = (): AuthState => ({
  consent: "unknown",
  permissions: { location: "unknown", phone: "unknown", notify: "unknown" },
  accounts: {},
  session: null,
  tokens: null,
  failCount: 0,
  lockedUntil: 0,
  duty: null,
  serverMinVersion: "1.0.0",
  incoming: [],
  featureFlags: { journalAi: false, hospitalGrade: false },
});

let s: AuthState = initialAuth();
const SSR = initialAuth();
let loaded = false;
const subs = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) s = { ...initialAuth(), ...JSON.parse(raw) };
  } catch {
    /* 무시 */
  }
}

export function setAuth(patch: Partial<AuthState>) {
  load();
  s = { ...s, ...patch };
  if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(s));
  subs.forEach((f) => f());
}

export function getAuth() {
  load();
  return s;
}

/** 이 기기의 로그인 정보까지 모두 지우고 처음 쓰는 날로 */
export function resetAuth() {
  s = initialAuth();
  if (typeof window !== "undefined") localStorage.removeItem(KEY);
  subs.forEach((f) => f());
}

export function useAuth() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => {
      load();
      return s;
    },
    () => SSR,
  );
}

export const currentAccount = (st: AuthState = getAuth()) =>
  st.session ? (st.accounts[st.session] ?? null) : null;

// ---------------- 서버 응답 → 화면 모양 ----------------

export type ServerMe = {
  id: number;
  name: string;
  rank: string;
  agency: string;
  safetyCenter: string;
  status: Account["status"];
  rejectReason: string | null;
  appliedAt: string | null;
  mustChangePassword: boolean;
  teamId: number | null;
  hasActiveTransport: boolean;
};
export type ServerTeam = {
  id: number;
  code: string;
  qrToken: string;
  maxMembers: number;
  members: { paramedicId: number; name: string; rank: string; role: ServerRole; isMe: boolean }[];
};

export const REJECT_LABEL: Record<string, string> = {
  photo_unclear: "공무원증 사진이 흐려서 확인할 수 없어요",
  info_mismatch: "입력한 정보가 공무원증과 달라요",
  agency_unverified: "소속 소방서를 확인할 수 없어요",
  photo_expired: "30일 동안 확인되지 않아 사진이 지워졌어요. 다시 신청해 주세요",
  etc: "관리자에게 문의해 주세요",
};

const ymdhm = (iso: string | null) => {
  if (!iso) return "-";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function toAccount(me: ServerMe, loginId: string): Account {
  const acc: Account = {
    loginId,
    paramedicId: me.id,
    name: me.name,
    rank: me.rank,
    orgCode: "",
    orgName: me.agency,
    center: me.safetyCenter,
    employeeNo: "",
    status: me.status,
    appliedAt: ymdhm(me.appliedAt),
    mustChangePassword: me.mustChangePassword,
  };
  if (me.rejectReason) acc.rejectReason = REJECT_LABEL[me.rejectReason] ?? me.rejectReason;
  return acc;
}

/**
 * 서버 팀 → 근무. 시작 시각·만든 사람 여부·'근무 시작'을 눌렀는지는 서버가 주지 않아 이 기기에서 기억한 값을 이어 쓴다.
 * 같은 팀이 아니면(앱을 다시 켜서 서버에서 처음 받음) 이미 근무 중인 것으로 본다
 */
export function toDuty(
  team: ServerTeam,
  prev: Duty | null,
  opt: { at?: number; isCreator?: boolean; started?: boolean } = {},
): Duty {
  const me = team.members.find((m) => m.isMe);
  const same = !!prev && prev.teamId === team.id;
  return {
    started: opt.started ?? (same ? prev!.started : true),
    startedAt: same ? prev!.startedAt : new Date(opt.at ?? Date.now()).toISOString(),
    teamId: team.id,
    teamCode: team.code,
    qrToken: team.qrToken,
    isCreator: opt.isCreator ?? (same ? prev!.isCreator : false),
    role: fromServerRole(me?.role ?? "care"),
    maxMembers: team.maxMembers ?? TEAM_MAX,
    members: team.members
      .filter((m) => !m.isMe)
      .map((m) => ({
        loginId: String(m.paramedicId),
        name: m.name,
        rank: m.rank,
        center: "",
        employeeNo: "",
        role: fromServerRole(m.role),
      })),
  };
}

/** 실시간 team.invited → 초대 카드 */
export function toIncoming(d: {
  inviteId: number;
  teamCode: string;
  fromName: string;
  expiresAt: string;
}): Incoming {
  const exp = Date.parse(d.expiresAt);
  return {
    id: `inv-${d.inviteId}`,
    inviteId: d.inviteId,
    from: { loginId: "", name: d.fromName, rank: "", center: "", employeeNo: "" },
    teamCode: d.teamCode,
    role: "처치",
    sentAt: (Number.isNaN(exp) ? Date.now() + INVITE_MS : exp) - INVITE_MS,
  };
}

// ---------------- 규칙 (화면과 검사에서 같이 씀) ----------------

/** SER-006: 8자 이상, 영문+숫자 */
export function passwordOk(pw: string) {
  return pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}

/** SFR-017: 가입 신청 입력 검사 (소방서 코드가 맞는지는 서버가 본다). 통과하면 null */
export function signupError(f: {
  orgCode: string;
  name: string;
  center: string;
  employeeNo: string;
  loginId: string;
  pw: string;
  photo: string | null;
  agree: boolean;
}) {
  if (!f.orgCode.trim()) return "소속 소방서 코드를 적어 주세요";
  if (!f.name.trim() || !f.center.trim() || !f.employeeNo.trim())
    return "이름 · 소속 안전센터 · 사번을 모두 적어 주세요";
  if (!/^[a-z0-9]{4,20}$/.test(f.loginId)) return "아이디는 영문 소문자 · 숫자 4~20자예요";
  if (!passwordOk(f.pw)) return "비밀번호는 8자 이상, 영문과 숫자를 섞어 주세요";
  if (!f.photo) return "공무원증 사진을 올려 주세요";
  if (!f.agree) return "공무원증 사진 수집 · 이용에 동의해야 신청할 수 있어요";
  return null;
}

/** SFR-113: 운전은 팀에 최대 1명 */
export function driverTaken(members: Member[], exceptId?: string) {
  return members.some((m) => m.role === "운전" && m.loginId !== exceptId);
}

// ---------------- 팀 초대 (SFR-159) ----------------

/** 초대는 5분 뒤 만료 → 남은 밀리초 */
export const inviteLeft = (inv: Incoming, at = Date.now()) =>
  Math.max(0, INVITE_MS - (at - inv.sentAt));
export const inviteExpired = (inv: Incoming, at = Date.now()) => inviteLeft(inv, at) === 0;

/** 만료된 초대만 지운 상태 조각 (지울 게 없으면 null) */
export function expiredInvites(st: AuthState, at = Date.now()): Partial<AuthState> | null {
  const keep = st.incoming.filter((i) => !inviteExpired(i, at));
  return keep.length === st.incoming.length ? null : { incoming: keep };
}

/** SER-007: 근무 시작 후 14시간이 지나면 (진행 중 이송이 없을 때) 자동 근무 종료 */
export function dutyExpired(duty: Duty | null, at = Date.now()) {
  return !!duty && at - new Date(duty.startedAt).getTime() >= DUTY_MAX_MS;
}

export function versionBelow(app: string, min: string) {
  const a = app.split(".").map(Number),
    b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** 이 기기의 로그인 정보만 지운다 (서버 로그아웃은 auth-server.ts 의 logoutServer) */
export function clearSession() {
  setAuth({ session: null, tokens: null, duty: null, accounts: {}, incoming: [], failCount: 0 });
}

export function isIOS() {
  return typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
}
