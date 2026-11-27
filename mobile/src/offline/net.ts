/**
 * 통신 상태 (SFR-064 · 068). 라이브러리 없이: 요청이 통신 실패면 오프라인,
 * 오프라인인 동안 5초마다 서버(GET /config)를 두드려 보고 답이 오면 복구.
 * 복구되면 등록된 일(밀린 기록 올리기 · 최신 정보 다시 읽기)을 하고 '최신 정보로 갱신되었습니다'를 잠깐 보인다.
 */
import { api, setNetHooks } from '../api/client';
import { createStore, useStore } from '../state/store';

export const netStore = createStore<{ online: boolean; recoveredAt: number | null }>({
  online: true,
  recoveredAt: null,
});
export const useNet = () => useStore(netStore);

const PROBE_MS = 5000;
let probe: ReturnType<typeof setInterval> | null = null;
const onRecover = new Set<() => Promise<void> | void>();

/** 복구될 때 할 일 등록. 돌려준 함수를 부르면 뺀다 */
export function whenOnline(fn: () => Promise<void> | void) {
  onRecover.add(fn);
  return () => void onRecover.delete(fn);
}

/** 통신 실패를 알림 (api 가 부른다. 테스트에서도 직접 부른다) */
export function markOffline() {
  if (!netStore.get().online) return;
  netStore.set({ online: false });
  probe ??= setInterval(
    () => void api('GET', '/config', { auth: false, timeoutMs: 3000 }).catch(() => undefined),
    PROBE_MS,
  );
}

/** 서버가 답했음을 알림. 오프라인이었으면 복구할 일을 한다 */
export function markOnline() {
  if (netStore.get().online) return;
  if (probe) clearInterval(probe);
  probe = null;
  netStore.set({ online: true });
  void (async () => {
    for (const fn of [...onRecover]) {
      try {
        await fn();
      } catch {
        /* 다음 일은 계속 */
      }
    }
    netStore.set({ recoveredAt: Date.now() });
  })();
}

setNetHooks({ online: markOnline, offline: markOffline });

/** 테스트용 */
export function __resetNetForTest() {
  if (probe) clearInterval(probe);
  probe = null;
  onRecover.clear();
  netStore.reset();
}
