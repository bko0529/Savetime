/**
 * 계정 · 팀을 세이브타임 서버와 맞추는 행동 (화면이 부름). 결과는 auth-store 에 넣고 화면은 useAuth() 로 본다.
 * - 로그인 (SFR-018) · 가입 신청 (SFR-017) · 내 정보 (SFR-022) · 최소 버전·기능 토글 (SFR-142, QUR-013)
 * - 근무 = 팀 (SFR-113): 만들기 · 코드/QR 참여 · 내 역할 · 근무 종료
 * - 목록 초대 (SFR-159): 근무 중 대원 목록 · 초대 보내기 · 받은 초대 수락/거절
 * - 실시간: 가입 결과 · 강제 로그아웃 · 초대 · 팀원 변화
 */
import { toast } from "sonner";
import { api, ApiError, deviceId, setTokenHooks, type Tokens } from "./api";
import {
  connectRealtime,
  disconnectRealtime,
  onEvent,
  reconnectRealtime,
  type Envelope,
} from "./realtime";
import {
  clearSession,
  getAuth,
  setAuth,
  toAccount,
  toDuty,
  toIncoming,
  toServerRole,
  type Role,
  type ServerMe,
  type ServerTeam,
} from "./auth-store";

// ---- 토큰 저장소를 api.ts 에 연결 ----
setTokenHooks({
  get: () => getAuth().tokens,
  set: (tokens: Tokens) => setAuth({ tokens }),
  lost: () => {
    if (!getAuth().session) return;
    disconnectRealtime();
    clearSession();
    toast("근무가 끝나 다시 로그인해야 해요");
  },
});

// ---------------- 설정 (로그인 없이) ----------------

/** SFR-142 · QUR-013: 앱이 켜질 때와 1분마다. 서버에 못 닿아도 앱은 계속 쓴다 */
export async function loadConfig() {
  try {
    const c = await api<{
      featureFlags: { journalAi: boolean; hospitalGrade: boolean };
      minAppVersion: string;
    }>("GET", "/config", { auth: false });
    setAuth({ serverMinVersion: c.minAppVersion, featureFlags: c.featureFlags });
  } catch {
    /* 오프라인이면 지난 값 그대로 */
  }
}

// ---------------- 로그인 · 내 정보 ----------------

/** SFR-018 · SER-011. 실패하면 서버 문구를 그대로 돌려준다 (5번 틀리면 서버가 10분 잠금) */
export async function login(loginId: string, password: string): Promise<string | null> {
  const id = loginId.trim();
  try {
    const r = await api<{ tokens: Tokens; me: ServerMe }>("POST", "/auth/login", {
      auth: false,
      body: { loginId: id, password, deviceId: deviceId() },
    });
    setAuth({
      tokens: r.tokens,
      session: id,
      accounts: { [id]: toAccount(r.me, id) },
      failCount: 0,
      lockedUntil: 0,
      duty: null,
    });
    startRealtime();
    if (r.me.teamId) await refreshTeam();
    return null;
  } catch (e) {
    if (e instanceof ApiError && e.code === "ACCOUNT_LOCKED") {
      const sec = Number(e.details?.["retryAfterSeconds"]);
      if (Number.isFinite(sec)) setAuth({ lockedUntil: Date.now() + sec * 1000 });
    }
    return e instanceof ApiError ? e.message : "로그인하지 못했어요";
  }
}

/** 내 정보 다시 읽기 (앱 시작 · 가입 결과 알림 뒤). 근무 중이면 팀도 */
export async function refreshMe() {
  const st = getAuth();
  if (!st.session || !st.tokens) return;
  try {
    const me = await api<ServerMe>("GET", "/me");
    setAuth({ accounts: { [st.session]: toAccount(me, st.session) } });
    if (me.teamId) await refreshTeam();
    else if (getAuth().duty) setAuth({ duty: null });
  } catch {
    /* 오프라인: 지난 정보로 */
  }
}

/** 앱이 켜질 때: 로그인돼 있으면 실시간을 붙이고 서버 상태로 맞춘다 */
export async function resumeSession() {
  if (!getAuth().session) return;
  startRealtime();
  await refreshMe();
}

/** SFR-017: 가입 신청. 통과하면 같은 아이디로 로그인해 '승인 대기' 화면으로 */
export async function signup(f: {
  orgCode: string;
  name: string;
  rank: string;
  center: string;
  employeeNo: string;
  loginId: string;
  pw: string;
  photo: File;
}): Promise<string | null> {
  const st = getAuth();
  const form = new FormData();
  form.set("agencyCode", f.orgCode.trim().toUpperCase());
  form.set("name", f.name.trim());
  form.set("rank", f.rank);
  form.set("safetyCenter", f.center.trim());
  form.set("employeeNo", f.employeeNo.trim());
  form.set("photoConsent", "true");
  form.set("photo", f.photo, f.photo.name || "id-card.jpg");
  const reapply = !!st.session && st.accounts[st.session]?.status === "rejected";
  try {
    if (reapply) {
      // 반려된 뒤 다시 신청: 같은 계정으로 내용·사진만 새로
      await api("PUT", "/me/signup", { form });
      await refreshMe();
      return null;
    }
    form.set("loginId", f.loginId);
    form.set("password", f.pw);
    await api("POST", "/auth/signup", { auth: false, form });
    return await login(f.loginId, f.pw);
  } catch (e) {
    return e instanceof ApiError ? e.message : "가입 신청을 보내지 못했어요";
  }
}

// ---------------- 근무 (팀) ----------------

export async function refreshTeam() {
  try {
    const team = await api<ServerTeam>("GET", "/teams/current");
    setAuth({ duty: toDuty(team, getAuth().duty) });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) setAuth({ duty: null });
  }
}

/**
 * SFR-113: 팀 만들기. 4자리 코드·QR 은 서버가 정한다.
 * 화면이 두 번 불러도(개발 모드의 이중 실행 등) 서버에는 한 번만 보낸다. 이미 팀이 있으면 그 팀을 불러온다
 */
let creating: Promise<string | null> | null = null;
export function createTeam(role: Role): Promise<string | null> {
  creating ??= (async () => {
    try {
      const team = await api<ServerTeam>("POST", "/teams", { body: { role: toServerRole(role) } });
      setAuth({ duty: toDuty(team, null, { isCreator: true, started: false }) });
      reconnectRealtime();
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.code === "ALREADY_IN_TEAM") {
        await refreshTeam();
        return null;
      }
      return e instanceof ApiError ? e.message : "팀을 만들지 못했어요";
    } finally {
      setTimeout(() => (creating = null), 0);
    }
  })();
  return creating;
}

/** SFR-113: 4자리 코드 또는 QR 로 참여 */
export async function joinTeam(
  code: { code?: string; qrToken?: string },
  role: Role,
): Promise<string | null> {
  try {
    const team = await api<ServerTeam>("POST", "/teams/join", {
      body: { ...code, role: toServerRole(role) },
    });
    setAuth({ duty: toDuty(team, null, { isCreator: false, started: false }) });
    reconnectRealtime();
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : "팀에 들어가지 못했어요";
  }
}

/** '근무 시작' (팀은 이미 서버에 있음). 이제 홈으로 */
export function startDuty() {
  const d = getAuth().duty;
  if (d) setAuth({ duty: { ...d, started: true, startedAt: new Date().toISOString() } });
}

/** 내 역할 바꾸기 (운전은 팀에 1명, 서버가 막는다) */
export async function setMyRole(role: Role): Promise<string | null> {
  try {
    const team = await api<ServerTeam>("PATCH", "/teams/current/members/me", {
      body: { role: toServerRole(role) },
    });
    setAuth({ duty: toDuty(team, getAuth().duty) });
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : "역할을 바꾸지 못했어요";
  }
}

export type OnDuty = {
  paramedicId: number;
  name: string;
  rank: string;
  safetyCenter: string;
  employeeNoTail: string;
  myMemo: string | null;
  onDuty: boolean;
  inTeam: boolean;
  inviteStatus: "none" | "sent" | "accepted";
};

/** SFR-159: 같은 소방서 대원 목록 (근무 중 먼저). q 를 주면 이름으로 소방서 전체 검색 */
export async function listColleagues(q = ""): Promise<OnDuty[]> {
  const qs = new URLSearchParams({ limit: "50", ...(q.trim() ? { q: q.trim() } : {}) });
  const r = await api<{ items: OnDuty[] }>("GET", `/paramedics/on-duty?${qs}`);
  return r.items;
}

export async function sendInvite(paramedicId: number): Promise<string | null> {
  try {
    await api("POST", "/teams/current/invites", { body: { toParamedicId: paramedicId } });
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : "초대를 보내지 못했어요";
  }
}

/** SFR-159: 받은 초대 수락 (근무 시작). 운전이 이미 있으면 서버가 막으니 그때는 처치로 다시 */
export async function acceptInvite(
  id: string,
  role: Role,
): Promise<{ error?: string; message?: string }> {
  const inv = getAuth().incoming.find((i) => i.id === id);
  if (!inv) return { error: "초대를 찾을 수 없어요" };
  const drop = () => setAuth({ incoming: getAuth().incoming.filter((i) => i.id !== id) });
  // 팀은 하나만. 팀에서 나오기 = 근무 종료 = 로그아웃이라(서버 규칙) 이미 팀이 있으면 수락할 수 없다
  if (getAuth().duty) return { error: "이미 팀에 있어요. 근무를 마친 뒤 다른 팀에 참여할 수 있어요" };
  try {
    let team: ServerTeam;
    try {
      team = await api<ServerTeam>("POST", `/invites/${inv.inviteId}/accept`, {
        body: { role: toServerRole(role) },
      });
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "DRIVER_TAKEN" || role === "처치") throw e;
      team = await api<ServerTeam>("POST", `/invites/${inv.inviteId}/accept`, {
        body: { role: "care" },
      });
    }
    drop();
    setAuth({ duty: toDuty(team, null, { isCreator: false, started: true }) });
    reconnectRealtime();
    return { message: `${inv.from.name} 대원의 팀 ${inv.teamCode}에 들어갔어요` };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.code === "INVITE_EXPIRED")) drop();
    return { error: e instanceof ApiError ? e.message : "초대를 수락하지 못했어요" };
  }
}

export async function declineInvite(id: string): Promise<string> {
  const inv = getAuth().incoming.find((i) => i.id === id);
  setAuth({ incoming: getAuth().incoming.filter((i) => i.id !== id) });
  if (inv) await api("POST", `/invites/${inv.inviteId}/decline`).catch(() => {});
  return inv ? `${inv.from.name} 님의 초대를 거절했어요` : "초대를 거절했어요";
}

// ---------------- 근무 종료 · 로그아웃 · 탈퇴 ----------------

/**
 * SFR-070 · 113: 근무 종료 = 로그아웃 (서버에서 같은 처리). 나만 팀에서 빠지고, 팀의 마지막 대원이면 서버가 진행 중 이송을 취소한다.
 * 진행 중 이송이 있으면 화면(설정)이 먼저 물어보므로 여기서는 확인을 넘긴다 (confirmCancelActive)
 */
export async function logoutServer() {
  await api("POST", "/auth/logout?confirmCancelActive=true").catch(() => {});
  disconnectRealtime();
  clearSession();
}

/** SFR-071: 회원 탈퇴. 서버가 계정 정보를 바로 지운다 */
export async function withdrawServer(): Promise<string | null> {
  try {
    await api("DELETE", "/me?confirmCancelActive=true");
    disconnectRealtime();
    clearSession();
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : "탈퇴하지 못했어요";
  }
}

// ---------------- 실시간 ----------------

let wired = false;
function startRealtime() {
  connectRealtime(() => getAuth().tokens?.accessToken ?? null);
  if (wired) return;
  wired = true;

  onEvent("account.signup_result", () => void refreshMe());
  onEvent("account.force_logout", () => {
    disconnectRealtime();
    clearSession();
    toast("관리자가 로그인을 끝냈어요. 다시 로그인해 주세요");
  });
  onEvent("team.invited", (e: Envelope) => {
    const inv = toIncoming(
      e.data as { inviteId: number; teamCode: string; fromName: string; expiresAt: string },
    );
    const st = getAuth();
    if (!st.incoming.some((i) => i.id === inv.id)) setAuth({ incoming: [...st.incoming, inv] });
  });
  onEvent("team.invite_result", (e: Envelope) => {
    const d = e.data as { toName: string; result: "accepted" | "declined" | "expired" };
    const word = { accepted: "수락했어요", declined: "거절했어요", expired: "만료됐어요" }[
      d.result
    ];
    toast(`${d.toName} 님 초대: ${word}`);
    if (d.result === "accepted") void refreshTeam();
  });
  for (const name of ["team.member_joined", "team.member_left", "team.role_changed"]) {
    onEvent(name, () => void refreshTeam());
  }
  onEvent("snapshot_required", () => void refreshMe());
}
