/** me.status 별 첫 화면 문구 (SFR-022 승인 대기 · SFR-083 반려) */
import type { Me } from '../api/client';

export function statusMessage(me: Me): { title: string; body: string } {
  switch (me.status) {
    case 'pending':
      return {
        title: '승인 대기 중',
        body: '관리자가 가입 신청을 확인하고 있어요. 승인되면 알려 드려요.',
      };
    case 'rejected':
      return { title: '가입이 반려됐어요', body: '반려 사유를 확인하고 다시 신청해 주세요.' };
    case 'suspended':
      return { title: '이용이 정지된 계정이에요', body: '소속 관리자에게 문의해 주세요.' };
    default:
      return {
        title: `${me.name ?? ''} ${me.rank ?? ''}님`.trim(),
        body: '근무 시작 화면은 준비 중이에요.',
      };
  }
}

/** 서버 반려 사유 코드 → 문구 (Lovable REJECT_LABEL 그대로) */
export const REJECT_LABEL: Record<string, string> = {
  photo_unclear: '공무원증 사진이 흐려서 확인할 수 없어요',
  info_mismatch: '입력한 정보가 공무원증과 달라요',
  agency_unverified: '소속 소방서를 확인할 수 없어요',
  photo_expired: '30일 동안 확인되지 않아 사진이 지워졌어요. 다시 신청해 주세요',
  etc: '관리자에게 문의해 주세요',
};

/** 신청 일시 2026.11.26 14:05 (휴대폰 시간대로 표시만. 판정은 서버가 함) */
export function ymdhm(iso: string | null | undefined) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
