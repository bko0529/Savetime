/**
 * 화면 테마 고르기 (QUR-005): 시스템 설정 따름(기본) · 밝게 · 어둡게. 이 휴대폰에만 저장한다.
 */
import * as SecureStore from 'expo-secure-store';
import { createStore, useStore } from '../state/store';
import type { Scheme } from './theme';

export type ThemePref = 'system' | Scheme;
const KEY = 'savetime.theme';

export const themePrefStore = createStore<{ pref: ThemePref }>({ pref: 'system' });
export const useThemePref = () => useStore(themePrefStore).pref;

export async function loadThemePref() {
  try {
    const v = await SecureStore.getItemAsync(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') themePrefStore.set({ pref: v });
  } catch {
    /* 기본값 */
  }
}

export function setThemePref(pref: ThemePref) {
  themePrefStore.set({ pref });
  void SecureStore.setItemAsync(KEY, pref).catch(() => undefined);
}

/** 실제로 쓸 테마: 시스템이면 휴대폰 설정(모르면 밝게) */
export const effectiveScheme = (pref: ThemePref, system: string | null | undefined): Scheme =>
  pref === 'system' ? (system === 'dark' ? 'dark' : 'light') : pref;
