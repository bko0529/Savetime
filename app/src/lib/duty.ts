/** 근무 종료 · 로그아웃 · 탈퇴 (SFR-070 · 071 · 113). 팀의 마지막 대원이면 진행 중 이송은 서버가 '취소'로 끝낸다 */
import { getAuth, type AuthState } from "@/lib/auth-store";
import { logoutServer, withdrawServer } from "@/lib/auth-server";
import { actions, getEngine } from "@/lib/engine";
import { ACTIVE } from "@/lib/domain/stateMachine";

export const hasActiveTransport = () => {
  const st = getEngine().status;
  return !!st && ACTIVE.includes(st);
};

/** 내가 빠지면 팀에 아무도 안 남는지 */
export const isLastMember = (a: AuthState = getAuth()) => (a.duty?.members.length ?? 0) === 0;

export async function leave(kind: "duty_end" | "logout" | "withdrawal"): Promise<string | null> {
  // 팀의 마지막 대원이면 서버가 진행 중 이송을 '취소'로 끝낸다. 이 기기 화면만 비운다
  if (hasActiveTransport()) actions.reset();
  if (kind === "withdrawal") return withdrawServer();
  await logoutServer();
  return null;
}
