/**
 * 아주 작은 상태 저장소 (라이브러리 없이 React 의 useSyncExternalStore 사용).
 * 화면 여러 곳에서 같은 값(동의·권한·서버 설정)을 보고, 값이 바뀌면 그 화면만 다시 그린다.
 */
import { useSyncExternalStore } from 'react';

export function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T>) {
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    /** 테스트용: 처음 값으로 */
    reset() {
      state = initial;
      listeners.forEach((l) => l());
    },
  };
}

export function useStore<T extends object>(store: ReturnType<typeof createStore<T>>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
