// 회원 탈퇴 (SFR-071, DAR-003): 팀에서 빠지고(마지막 1명이면 진행 중 이송 취소) 계정·프로필을 즉시 지운다.
// paramedic 행 자체는 팀·이송 기록이 가리키고 있어 지우지 않는다. 대신 사람을 알아볼 수 있는 값을 모두 비우고
// '탈퇴' 상태만 남긴다. 그러면 기록의 연결은 깨지지 않으면서 누구였는지는 더 이상 알 수 없다.
// 부르는 쪽이 트랜잭션을 열고 client를 넘긴다. 커밋한 뒤에는 forgetSessionState를 한 번 더 부른다.
import type pg from 'pg';
import { endDuty } from '../team/endDuty.js';
import type { AuthContext } from './session.js';

export async function withdrawParamedic(
  client: pg.PoolClient,
  ctx: Pick<AuthContext, 'redis'>,
  paramedicId: string,
  confirmCancelActive: boolean,
): Promise<void> {
  // 탈퇴는 막지 않는다. 진행 중 이송이 있으면 확인만 받는다 (확인 없으면 여기서 409)
  await endDuty(client, ctx, paramedicId, 'withdrawal', confirmCancelActive);

  // 아이디도 바꿔 둔다: 옛 아이디로는 로그인되지 않고, 같은 아이디로 새로 가입할 수 있다
  await client.query(
    `UPDATE paramedic
        SET status = 'withdrawn', withdrawn_at = now(),
            login_id = 'withdrawn:' || id, password_hash = '',
            name = '탈퇴한 대원', rank = '', safety_center = '', employee_no = '',
            failed_count = 0, locked_until = NULL
      WHERE id = $1`,
    [paramedicId],
  );
  await client.query('DELETE FROM push_device WHERE paramedic_id = $1', [paramedicId]);
  // 내가 쓴 메모와 남이 나에 대해 쓴 메모 모두 (SFR-143)
  await client.query('DELETE FROM paramedic_memo WHERE owner_id = $1 OR target_id = $1', [
    paramedicId,
  ]);
  // 공무원증 사진은 승인·반려 때 이미 지우지만, 심사 중에 탈퇴하면 남아 있을 수 있다
  await client.query('UPDATE signup_request SET photo_key = NULL WHERE paramedic_id = $1', [
    paramedicId,
  ]);
}
