/**
 * 근무 = 팀 (SFR-113) · 팀 초대 (SFR-159). Lovable auth-server.ts 의 팀 부분을 옮겼다.
 *
 * - 팀은 서버가 만든다. 서버에서 팀을 나오는 것 = 근무 종료 = 로그아웃이라, 팀이 생긴 뒤에는 만들기 ↔ 참여를 바꿀 수 없다
 * - '근무 시작'을 눌렀는지는 서버가 모른다 → 이 휴대폰(secure-store)에 팀 번호와 함께 기억한다
 * - 받은 초대는 실시간 이벤트(team.invited)로만 온다 → 메모리에 두고 만료되면 지운다 (서버 메모리 아님, 앱 메모리)
 */
import * as SecureStore from 'expo-secure-store';
import { ApiError, api, serverNow } from '../api/client';
import type { components } from '../api/schema';
import { reconnectRealtime } from '../realtime/socket';
import { createStore } from '../state/store';

export type Team = components['schemas']['Team'];
export type Member = components['schemas']['Member'];
export type Colleague = components['schemas']['OnDutyParamedic'];
export type Role = '처치' | '운전';
export type ServerRole = 'care' | 'driver';
export const toServerRole = (r: Role): ServerRole => (r === '운전' ? 'driver' : 'care');
export const fromServerRole = (r: ServerRole | undefined): Role =>
  r === 'driver' ? '운전' : '처치';

/** 팀 QR 내용의 앞부분. 스캔 화면이 이걸 보고 우리 앱 QR 인지 안다 */
export const QR_PREFIX = 'savetime:team:';

/** QR 글자에서 팀 토큰만 꺼낸다. 우리 앱 QR 이 아니면 null */
export function parseTeamQr(data: string): string | null {
  return data.startsWith(QR_PREFIX) && data.length > QR_PREFIX.length
    ? data.slice(QR_PREFIX.length)
    : null;
}

export const TEAM_MAX = 4;
export const INVITE_MS = 5 * 60_000;

export type Incoming = { inviteId: number; teamCode: string; fromName: string; expiresAt: string };

type TeamState = {
  /** loading = 아직 서버에 안 물어봄, null = 팀 없음 */
  team: Team | null | 'loading';
  /** 이 팀으로 '근무 시작'을 눌렀는지 */
  started: boolean;
  /** 내가 팀을 만들었는지 (만들기/참여 탭을 고정할 때) */
  isCreator: boolean;
  incoming: Incoming[];
  /** 화면 위에 잠깐 보여 줄 한 줄 (초대 결과 등) */
  notice: string | null;
};

export const teamStore = createStore<TeamState>({
  team: 'loading',
  started: false,
  isCreator: false,
  incoming: [],
  notice: null,
});

const KEY = 'savetime.duty';
type Saved = { teamId: number; started: boolean; isCreator: boolean };

async function save(s: Saved | null) {
  if (s) await SecureStore.setItemAsync(KEY, JSON.stringify(s));
  else await SecureStore.deleteItemAsync(KEY);
}
async function loadSaved(): Promise<Saved | null> {
  try {
    const v = await SecureStore.getItemAsync(KEY);
    return v ? (JSON.parse(v) as Saved) : null;
  } catch {
    return null;
  }
}

/** 서버가 준 팀을 넣고, 이 휴대폰에 기억한 '근무 시작' 여부를 이어 붙인다 */
async function putTeam(team: Team, opt: { started?: boolean; isCreator?: boolean } = {}) {
  const prev = teamStore.get();
  const sameTeam = prev.team !== 'loading' && prev.team?.id === team.id;
  const started = opt.started ?? (sameTeam ? prev.started : false);
  const isCreator = opt.isCreator ?? (sameTeam ? prev.isCreator : false);
  teamStore.set({ team, started, isCreator });
  await save({ teamId: team.id!, started, isCreator });
}

/**
 * 앱을 열 때 · 팀 이벤트가 왔을 때: 서버의 내 팀으로 맞춘다.
 * 앱을 다시 켰는데 기억이 없거나 다른 팀이면 이미 근무 중인 것으로 본다 (Lovable 과 같음)
 */
export async function refreshTeam() {
  try {
    const team = await api<Team>('GET', '/teams/current');
    const prev = teamStore.get();
    if (prev.team === 'loading' || prev.team === null) {
      const saved = await loadSaved();
      const same = saved?.teamId === team.id;
      await putTeam(team, {
        started: same ? saved!.started : true,
        isCreator: same ? saved!.isCreator : false,
      });
    } else {
      await putTeam(team);
    }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.code === 'NOT_IN_TEAM')) {
      teamStore.set({ team: null, started: false, isCreator: false });
      await save(null);
      return;
    }
    // 오프라인: 처음 묻던 중이면 '팀 없음'으로 보여 근무 시작 화면에서 다시 시도하게 (빈 화면에 갇히지 않게)
    if (teamStore.get().team === 'loading') teamStore.set({ team: null });
  }
}

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** 팀 만들기. 4자리 코드·QR 은 서버가 정한다. 두 번 눌러도 서버에는 한 번만 */
let creating: Promise<string | null> | null = null;
export function createTeam(role: Role): Promise<string | null> {
  creating ??= (async () => {
    try {
      const team = await api<Team>('POST', '/teams', { body: { role: toServerRole(role) } });
      await putTeam(team, { started: false, isCreator: true });
      reconnectRealtime();
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ALREADY_IN_TEAM') {
        await refreshTeam();
        return null;
      }
      return message(e, '팀을 만들지 못했어요');
    } finally {
      creating = null;
    }
  })();
  return creating;
}

/** 4자리 코드 또는 QR 로 참여 */
export async function joinTeam(
  by: { code: string } | { qrToken: string },
  role: Role,
): Promise<string | null> {
  try {
    const team = await api<Team>('POST', '/teams/join', {
      body: { ...by, role: toServerRole(role) },
    });
    await putTeam(team, { started: false, isCreator: false });
    reconnectRealtime();
    return null;
  } catch (e) {
    return message(e, '팀에 들어가지 못했어요');
  }
}

/** 내 역할 바꾸기 (운전은 팀에 1명, 서버가 막는다) */
export async function setMyRole(role: Role): Promise<string | null> {
  try {
    const team = await api<Team>('PATCH', '/teams/current/members/me', {
      body: { role: toServerRole(role) },
    });
    await putTeam(team);
    return null;
  } catch (e) {
    return message(e, '역할을 바꾸지 못했어요');
  }
}

/** '근무 시작' (팀은 이미 서버에 있음) → 홈으로 */
export async function startDuty() {
  const s = teamStore.get();
  if (s.team === 'loading' || !s.team) return;
  teamStore.set({ started: true });
  await save({ teamId: s.team.id!, started: true, isCreator: s.isCreator });
}

/** 같은 소방서 대원 목록 (근무 중 먼저). q 를 주면 이름으로 소방서 전체 검색 */
export async function listColleagues(q = ''): Promise<Colleague[]> {
  const qs = `limit=50${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`;
  const r = await api<{ items: Colleague[] }>('GET', `/paramedics/on-duty?${qs}`);
  return r.items;
}

export async function sendInvite(paramedicId: number): Promise<string | null> {
  try {
    await api('POST', '/teams/current/invites', { body: { toParamedicId: paramedicId } });
    return null;
  } catch (e) {
    return message(e, '초대를 보내지 못했어요');
  }
}

/** 초대가 남은 시간(ms). 서버 시각 기준 (휴대폰 시계가 틀려도 같게) */
export const inviteLeft = (inv: Incoming, now = serverNow()) =>
  Math.max(0, Date.parse(inv.expiresAt) - now);

const dropInvite = (inviteId: number) =>
  teamStore.set({ incoming: teamStore.get().incoming.filter((i) => i.inviteId !== inviteId) });

/** 받은 초대 수락 = 그 팀으로 근무 시작. 운전이 이미 있으면 서버가 막으니 그때는 처치로 다시 */
export async function acceptInvite(inv: Incoming, role: Role): Promise<string | null> {
  const s = teamStore.get();
  // 팀은 하나만. 팀에서 나오기 = 근무 종료 = 로그아웃이라 이미 팀이 있으면 수락할 수 없다
  if (s.team !== 'loading' && s.team)
    return '이미 팀에 있어요. 근무를 마친 뒤 다른 팀에 참여할 수 있어요';
  try {
    let team: Team;
    try {
      team = await api<Team>('POST', `/invites/${inv.inviteId}/accept`, {
        body: { role: toServerRole(role) },
      });
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'DRIVER_TAKEN' || role === '처치') throw e;
      team = await api<Team>('POST', `/invites/${inv.inviteId}/accept`, { body: { role: 'care' } });
    }
    dropInvite(inv.inviteId);
    await putTeam(team, { started: true, isCreator: false });
    reconnectRealtime();
    return null;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.code === 'INVITE_EXPIRED'))
      dropInvite(inv.inviteId);
    return message(e, '초대를 수락하지 못했어요');
  }
}

export async function declineInvite(inv: Incoming) {
  dropInvite(inv.inviteId);
  await api('POST', `/invites/${inv.inviteId}/decline`).catch(() => undefined);
}

/** 실시간: 초대 받음 (같은 초대는 한 번만) */
export function addIncoming(inv: Incoming) {
  const s = teamStore.get();
  if (!s.incoming.some((i) => i.inviteId === inv.inviteId))
    teamStore.set({ incoming: [...s.incoming, inv] });
}

/** 로그아웃 · 근무 종료: 이 휴대폰의 팀 기억을 지운다 */
export async function clearTeam() {
  teamStore.set({ team: 'loading', started: false, isCreator: false, incoming: [], notice: null });
  await save(null);
}
