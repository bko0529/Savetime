// 근무 끝내기: 로그아웃(SFR-070)·근무 종료(SFR-113)·14시간 자동 종료·탈퇴·정지가 모두 이 함수를 쓴다.
// 팀에서 빠지고, 마지막 1명이면 진행 중 이송을 취소하고 팀을 닫고, 로그인 토큰을 모두 끊는다.
// 부르는 쪽이 트랜잭션을 열고 client를 넘긴다. 커밋한 뒤에는 forgetSessionState를 한 번 더 부른다.
import type pg from 'pg';
import { ACTIVE, type CancelReason, type TransportStatus } from '../../domain/stateMachine.js';
import { AppError } from '../../http/errors.js';
import { endSessions, type AuthContext } from '../auth/session.js';
import { cancelTransport } from '../transport/cancel.js';

export type LeaveReason = 'logout' | 'duty_end' | 'auto_14h' | 'withdrawal' | 'suspended';

// 취소 사유에는 14시간 자동 종료가 따로 없어서 근무 종료로 남긴다 (상태 전이표 취소 사유 7종)
const CANCEL_REASON: Record<LeaveReason, CancelReason> = {
  logout: 'logout',
  duty_end: 'duty_end',
  auto_14h: 'duty_end',
  withdrawal: 'withdrawal',
  suspended: 'suspended',
};

export interface EndDutyResult {
  teamId: string | null;
  teamEnded: boolean;
  cancelledTransportId: string | null;
}

export async function endDuty(
  client: pg.PoolClient,
  ctx: Pick<AuthContext, 'redis'>,
  paramedicId: string,
  reason: LeaveReason,
  // 대원이 '진행 중 이송이 있어요' 확인을 눌렀는지. 관리자 정지·자동 종료처럼 묻지 않는 경우는 true로 부른다
  confirmCancelActive: boolean,
): Promise<EndDutyResult> {
  const { rows: membership } = await client.query<{ team_id: string }>(
    'SELECT team_id FROM team_member WHERE paramedic_id = $1 AND left_at IS NULL',
    [paramedicId],
  );
  const teamId = membership[0]?.team_id ?? null;
  let teamEnded = false;
  let cancelledTransportId: string | null = null;

  if (teamId !== null) {
    // 팀 행을 잠가 같은 팀의 퇴장을 한 줄로 세운다. 두 명이 동시에 나가도 '내가 마지막'을 정확히 한 명만 본다.
    await client.query('SELECT id FROM team WHERE id = $1 FOR UPDATE', [teamId]);

    const { rows: active } = await client.query<{
      id: string;
      status: TransportStatus;
      hospital_name: string | null;
    }>(
      `SELECT t.id, t.status, h.name AS hospital_name
         FROM transport t
         LEFT JOIN hospital h ON h.id = t.confirmed_hospital_id
        WHERE t.team_id = $1 AND t.status = ANY($2::transport_status[])`,
      [teamId, ACTIVE],
    );
    const transport = active[0];
    if (transport && !confirmCancelActive) {
      throw new AppError(409, 'ACTIVE_TRANSPORT_CONFIRM_REQUIRED', '진행 중 이송 1건이 있어요', {
        activeTransport: {
          id: transport.id,
          status: transport.status,
          hospitalName: transport.hospital_name,
        },
      });
    }

    await client.query(
      `UPDATE team_member SET left_at = now(), left_reason = $2
        WHERE paramedic_id = $1 AND left_at IS NULL`,
      [paramedicId, reason],
    );
    const { rows: remaining } = await client.query<{ count: string }>(
      'SELECT count(*) FROM team_member WHERE team_id = $1 AND left_at IS NULL',
      [teamId],
    );
    // 남은 팀원이 있으면 이송은 그 팀원이 이어간다
    if (remaining[0].count === '0') {
      if (transport) {
        await cancelTransport(client, transport.id, CANCEL_REASON[reason]);
        cancelledTransportId = transport.id;
      }
      await client.query('UPDATE team SET ended_at = now() WHERE id = $1', [teamId]);
      teamEnded = true;
    }
  }

  // 근무가 끝나면 로그인도 끝난다 (SFR-018·070, SER-007). 다른 폰에 남은 토큰도 함께 막힌다.
  await endSessions(ctx, client, paramedicId);
  return { teamId, teamEnded, cancelledTransportId };
}
