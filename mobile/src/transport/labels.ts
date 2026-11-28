import type { TransportStatus } from './types';

/** 이송 단계 이름 (Lovable progress.tsx 그대로) */
export const STATUS_LABEL: Record<TransportStatus, string> = {
  requesting: '요청 중',
  fallback: '예비 추천',
  phone_check: '전화 확인',
  moving: '이동 중',
  arrived: '도착',
  cancelled: '취소됨',
};

/** 2:00 모양. 0 아래로는 안 내려간다 */
export const mmss = (sec: number) =>
  `${Math.floor(Math.max(0, sec) / 60)}:${String(Math.max(0, sec) % 60).padStart(2, '0')}`;

/** 활력징후 경고 (정상 범위 밖이면 병원 웹에 빨간색) */
export function vitalWarnings(p: { spo2: string; bp: string; pulse: string }): string[] {
  const out: string[] = [];
  const spo2 = Number(p.spo2);
  if (spo2 && spo2 < 94) out.push(`산소포화도 ${spo2}%`);
  const [sys] = p.bp.split('/').map(Number);
  if (sys && (sys >= 160 || sys < 90)) out.push(`혈압 ${p.bp}`);
  const pulse = Number(p.pulse);
  if (pulse && (pulse > 120 || pulse < 50)) out.push(`맥박 ${pulse}`);
  return out;
}
