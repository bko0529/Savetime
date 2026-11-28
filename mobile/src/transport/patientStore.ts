/**
 * 지금 입력 중인 환자 정보. 이 휴대폰에만 둔다 (secure-store = 암호화).
 * - 앱을 다시 켜도 일지까지 이어지도록 보관하고, 7일이 지나면 지운다 (DAR-015)
 * - 환자 이름·주민번호·연락처 칸은 아예 없다 (SER-012)
 * 일지용 오프라인 보관(expo-sqlite)은 7단계에서 이 값을 옮겨 쓴다.
 */
import * as SecureStore from 'expo-secure-store';
import { createStore, useStore } from '../state/store';
import { setManualLocation } from './location';
import { emptyPatient, type Patient } from './patient';

const KEY = 'savetime.patient';
const KEEP_MS = 7 * 24 * 60 * 60_000;

export const patientStore = createStore<{ patient: Patient; radiusKm: number }>({
  patient: emptyPatient,
  /** 요청 반경 (SFR-012, 기본 20km). 이송마다 다시 20km 로 */
  radiusKm: 20,
});
export const useRadius = () => useStore(patientStore).radiusKm;
export const setRadius = (km: number) => patientStore.set({ radiusKm: km });
export const usePatient = () => useStore(patientStore).patient;

export async function loadPatient(at = Date.now()) {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return;
    const d = JSON.parse(raw) as { savedAt: number; patient: Partial<Patient> };
    if (at - d.savedAt > KEEP_MS) {
      await SecureStore.deleteItemAsync(KEY);
      return;
    }
    patientStore.set({ patient: { ...emptyPatient, ...d.patient } });
  } catch {
    /* 깨진 값이면 빈 칸으로 시작 */
  }
}

export function setPatient(p: Patient) {
  patientStore.set({ patient: p });
  void SecureStore.setItemAsync(KEY, JSON.stringify({ savedAt: Date.now(), patient: p })).catch(
    () => undefined,
  );
}

/** 새 이송 시작: 모든 칸을 비운다 */
export function resetPatient() {
  patientStore.set({ patient: emptyPatient, radiusKm: 20 });
  setManualLocation(null); // 주소로 정한 위치도 이송마다 새로
  void SecureStore.deleteItemAsync(KEY).catch(() => undefined);
}
