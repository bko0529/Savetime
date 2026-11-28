/**
 * 팀원 간 환자 정보 공유·공동 입력 (SFR-114 · 157 · 115).
 * - 팀의 작성 중 환자 정보는 서버에 1개. 내가 고치면 0.5초 모았다가 바뀐 칸만 PATCH (나중 값으로 저장)
 * - 팀원이 고치면 draft.updated(바뀐 칸 이름만, 규칙 5) → GET 으로 다시 읽어 그 칸만 내 화면에 넣는다
 * - 같은 칸을 동시에 고쳤으면 서버가 overwritten 으로 알려 준다 → '나중 값으로 저장했어요'
 * - 운전 역할이 주행 중(시속 10km 이상)이면 서버가 DRIVER_INPUT_LOCKED 로 막는다 → '주행 중에는 팀원이 입력해요'
 * - 직전 환자 정보로 채워졌으면 '직전 환자 정보 · 지우기' (DELETE, SFR-157)
 */
import { ApiError, api } from '../api/client';
import { teamStore } from '../duty/team';
import { onEvent } from '../realtime/socket';
import { createStore, useStore } from '../state/store';
import { applyDraft, draftChanges, FIELD_NAME } from './draftMap';
import { currentFix } from './location';
import type { Patient } from './patient';
import { patientStore, setPatient } from './patientStore';

type DraftResp = {
  version: number;
  assessment: Record<string, unknown> | null;
  prefilledFromTransportId?: string | null;
  prefillExpiresAt?: string | null;
  overwritten?: { field: string; prevByName: string }[];
};

export const draftStore = createStore<{
  /** 화면 위에 잠깐 보여 줄 한 줄 (팀원이 입력함 · 동시에 고침) */
  notice: string | null;
  /** 직전 환자 정보로 채워짐 (SFR-157) */
  prefilled: boolean;
  /** 운전 대원 주행 중 입력 잠금 (SFR-115) */
  locked: boolean;
}>({ notice: null, prefilled: false, locked: false });
export const useDraft = () => useStore(draftStore);

const DEBOUNCE_MS = 500;
const LOCK_KMH = 10;
let version = 0;
let pending: Record<string, unknown> = {};
let timer: ReturnType<typeof setTimeout> | null = null;

const iAmDriver = () => {
  const t = teamStore.get().team;
  return t !== 'loading' && !!t?.members?.some((m) => m.isMe && m.role === 'driver');
};

/** 화면에서 입력을 바꿀 때 부른다: 휴대폰에 바로 반영하고, 바뀐 칸은 모아서 서버로 */
export function editPatient(next: Patient) {
  const prev = patientStore.get().patient;
  setPatient(next);
  const ch = draftChanges(prev, next);
  if (!ch) return;
  pending = { ...pending, ...ch };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void push(), DEBOUNCE_MS);
}

async function push() {
  timer = null;
  const changes = pending;
  pending = {};
  if (Object.keys(changes).length === 0) return;
  try {
    // 운전 대원이면 지금 속도를 같이 보낸다 (서버가 잠금 판단, SFR-115)
    const speedKmh = iAmDriver() ? ((await currentFix(2000))?.speedKmh ?? undefined) : undefined;
    const r = await api<DraftResp>('PATCH', '/teams/current/draft', {
      body: { baseVersion: version, changes, ...(speedKmh !== undefined ? { speedKmh } : {}) },
    });
    version = r.version;
    draftStore.set({ locked: false, prefilled: false });
    if (r.overwritten?.length) {
      const names = r.overwritten
        .map((o) => `${FIELD_NAME[o.field] ?? o.field}(${o.prevByName})`)
        .join(', ');
      draftStore.set({ notice: `같은 칸을 팀원도 고쳤어요 · 나중 값으로 저장: ${names}` });
    }
  } catch (e) {
    if (e instanceof ApiError && e.code === 'DRIVER_INPUT_LOCKED') {
      draftStore.set({ locked: true, notice: '주행 중에는 팀원이 입력해요' });
      await pull(); // 잠긴 동안 쓴 값은 서버 값으로 되돌린다
      return;
    }
    // 통신 오류: 다음 입력 때 다시 보낸다
    pending = { ...changes, ...pending };
  }
}

/** 서버의 팀 작성 중 정보를 읽어 화면에 넣는다. fields 를 주면 그 칸만 (팀원이 고친 칸) */
export async function pull(fields?: string[]) {
  try {
    const r = await api<DraftResp>('GET', '/teams/current/draft');
    version = r.version;
    // 내가 아직 안 보낸 칸은 내 값을 둔다
    const mine = new Set(Object.keys(pending));
    const only = fields?.filter((f) => !mine.has(f));
    const next = applyDraft(patientStore.get().patient, r.assessment, only);
    setPatient(next);
    draftStore.set({ prefilled: !!r.prefilledFromTransportId && r.version > 0 });
  } catch {
    /* 팀이 없거나 끊겼으면 이 휴대폰 값 그대로 */
  }
}

/** 직전 환자 정보 지우기 (SFR-157) */
export async function clearPrefill() {
  await api('DELETE', '/teams/current/draft').catch(() => undefined);
  version = 0;
  draftStore.set({ prefilled: false });
}

/** 근무 중에 듣기 시작. 돌려준 함수를 부르면 그만 */
export function startDraftSync() {
  void pull();
  const off = onEvent('draft.updated', (ev) => {
    if (ev.data.version <= version) return; // 내가 보낸 것이거나 이미 받은 것
    void pull(ev.data.fields).then(() => {
      if (ev.data.byName) {
        const what = ev.data.fields.map((f) => FIELD_NAME[f] ?? f).join(', ');
        draftStore.set({ notice: `${ev.data.byName} 대원이 ${what}을(를) 입력했어요` });
      }
    });
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
  };
}

/** 이 휴대폰에서 운전 대원이 주행 중인지 (SFR-115): 3초마다 속도를 본다 */
export function watchDriverLock() {
  const tick = async () => {
    if (!iAmDriver()) return draftStore.set({ locked: false });
    const f = await currentFix(2000);
    if (f?.speedKmh !== null && f?.speedKmh !== undefined)
      draftStore.set({ locked: f.speedKmh >= LOCK_KMH });
  };
  void tick();
  const t = setInterval(() => void tick(), 3000);
  return () => clearInterval(t);
}

/** 테스트용 */
export function __resetDraftForTest() {
  version = 0;
  pending = {};
  if (timer) clearTimeout(timer);
  timer = null;
  draftStore.reset();
}
