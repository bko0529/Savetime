/**
 * SFR-041 위치정보 수집·이용 동의. 휴대폰에만 저장한다 (서버로 보내지 않음).
 * unknown = 아직 안 물어봄, agreed = 동의, refused = 동의 안 함(앱을 못 씀)
 */
import * as SecureStore from 'expo-secure-store';
import { createStore } from './store';

export type Consent = 'loading' | 'unknown' | 'agreed' | 'refused';
const KEY = 'savetime.locationConsent';

export const consentStore = createStore<{ consent: Consent }>({ consent: 'loading' });

export async function loadConsent() {
  const v = await SecureStore.getItemAsync(KEY);
  consentStore.set({ consent: v === 'agreed' || v === 'refused' ? v : 'unknown' });
}

export async function setConsent(c: 'agreed' | 'refused' | 'unknown') {
  consentStore.set({ consent: c });
  if (c === 'unknown') await SecureStore.deleteItemAsync(KEY);
  else await SecureStore.setItemAsync(KEY, c);
}
