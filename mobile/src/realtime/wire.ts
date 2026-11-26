/**
 * 실시간 이벤트 → 할 일 (계정 · 팀). 이송 이벤트는 4단계에서 붙인다.
 * 이벤트에는 ID·이름·시각만 오고, 화면에 필요한 상세는 REST 로 다시 읽는다 (규칙 5).
 */
import { addIncoming, refreshTeam, teamStore } from '../duty/team';
import { onEvent } from './socket';

const RESULT_WORD = {
  accepted: '수락했어요',
  declined: '거절했어요',
  expired: '만료됐어요',
} as const;

/** 로그인할 때 한 번 부른다. 돌려준 함수를 부르면 모두 그만 듣는다 */
export function wireAccountAndTeam(cb: {
  refreshMe: () => void;
  forceLogout: (notice: string) => void;
}) {
  const offs = [
    // 승인·반려 결과 → 내 정보를 다시 읽으면 화면 순서(gate)가 알아서 바뀐다 (SFR-083)
    onEvent('account.signup_result', () => cb.refreshMe()),
    // 정지·탈퇴 등 → 바로 로그인 화면으로 (SER-016)
    onEvent('account.force_logout', () =>
      cb.forceLogout('관리자가 로그인을 끝냈어요. 다시 로그인해 주세요'),
    ),
    onEvent('team.invited', (e) => addIncoming(e.data)),
    onEvent('team.invite_result', (e) => {
      teamStore.set({ notice: `${e.data.toName} 님 초대: ${RESULT_WORD[e.data.result]}` });
      if (e.data.result === 'accepted') void refreshTeam();
    }),
    onEvent('team.member_joined', () => void refreshTeam()),
    onEvent('team.member_left', () => void refreshTeam()),
    onEvent('team.role_changed', () => void refreshTeam()),
    onEvent('snapshot_required', () => {
      cb.refreshMe();
      void refreshTeam();
    }),
  ];
  return () => offs.forEach((off) => off());
}
