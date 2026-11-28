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

export const patientStore = createStore<{
  patient: Patient;
  radiusKm: number;
  autoRadius: boolean;
  autoExpand: boolean;
}>({
  patient: emptyPatient,
  /** 대원이 직접 고른 요청 반경 (SFR-012). 자동일 때는 쓰지 않는다 */
  radiusKm: 20,
  /** 시작 반경 자동: 요청할 병원이 3곳 이상인 가장 작은 반경 (D-142, 기본) */
  autoRadius: true,
  /** 승인 0곳이면 서버가 반경을 저절로 넓혀 다시 요청 (D-142, 기본 켬) */
  autoExpand: true,
});
export const useRadius = () => useStore(patientStore).radiusKm;
export const useRadiusMode = () => {
  const { autoRadius, autoExpand } = useStore(patientStore);
  return { autoRadius, autoExpand };
};
/** 반경을 직접 고르면 자동은 꺼진다 */
export const setRadius = (km: number) => patientStore.set({ radiusKm: km, autoRadius: false });
export const setAutoRadius = () => patientStore.set({ autoRadius: true });
export const setAutoExpand = (on: boolean) => patientStore.set({ autoExpand: on });
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
  patientStore.set({ patient: emptyPatient, radiusKm: 20, autoRadius: true, autoExpand: true });
  setManualLocation(null); // 주소로 정한 위치도 이송마다 새로
  void SecureStore.deleteItemAsync(KEY).catch(() => undefined);
}
