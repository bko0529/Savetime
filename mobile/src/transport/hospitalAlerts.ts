/**
 * 병원이 보내는 경보 두 가지 (팀 폰 모두에 뜬다, 닫은 PR #109 그대로)
 * - SFR-140 추가 메모: 확정 병원이 이동 중에 한 번 보내는 메모. 이벤트에는 글이 없고(규칙 5) 다시 읽어서 받는다
 * - SFR-158 수용 불가: 도착 후 10분 안에 병원이 받을 수 없다고 알림 → '다시 요청하기'로 직전 환자 정보로 새 요청
 * 화면 어디에 있든 보이도록 엔진 밖 작은 저장소에 두고, ui/TransportAlerts.tsx 가 그린다
 */
import { createStore, useStore } from '../state/store';

export type MemoAlert = { hospitalName: string; memo: string | null; at: number };
export type UnacceptableAlert = {
  transportId: string;
  hospitalName: string;
  reason: string;
  at: number;
};

export const alertStore = createStore<{
  memo: MemoAlert | null;
  unacceptable: UnacceptableAlert | null;
}>({
  memo: null,
  unacceptable: null,
});
export const useHospitalAlerts = () => useStore(alertStore);

/** 수용 불가 사유 코드 → 화면 문구 (서버 사유 코드와 같음) */
const UNACCEPTABLE_TEXT: Record<string, string> = {
  er_bed: '응급실 병상 부족',
  or_room: '수술실 부족',
  ward: '입원 병상 부족',
  icu: '중환자실 부족',
  no_specialist: '해당 전문의 부재',
  equipment: '장비 문제',
  etc: '기타 사유',
};
export const unacceptableText = (reason: string) => UNACCEPTABLE_TEXT[reason] ?? '사유 미상';

export const hospitalAlerts = {
  showMemo: (a: Omit<MemoAlert, 'at'>) => alertStore.set({ memo: { ...a, at: Date.now() } }),
  showUnacceptable: (a: Omit<UnacceptableAlert, 'at'>) =>
    alertStore.set({ unacceptable: { ...a, at: Date.now() } }),
  clearMemo: () => alertStore.set({ memo: null }),
  clearUnacceptable: () => alertStore.set({ unacceptable: null }),
};
