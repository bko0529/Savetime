// 이상 PC 등록 기준 (SFR-148). 감지(oddPc.ts)와 관리자 알림 문구(admin/notifications.ts)가 같은 값을 쓴다
// 새벽 = 한국 시간 0시 이상 6시 미만
export const NIGHT_END_HOUR = 6;
// 같은 병원에서 이 시간 안에 이 대수 이상 등록되면 수상하다
export const BURST_WINDOW = '1 hour';
export const BURST_COUNT = 2;
