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
