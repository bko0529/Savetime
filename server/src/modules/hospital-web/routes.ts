// 병원 웹: PC 등록·현재 PC 정보 (SFR-116, SFR-147, SER-011, COR-012)
import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { notifyAdmin } from '../admin/notifications.js';
import { hashLicenseKey } from './licenseKey.js';
import {
  checkOrigin,
  hashPcToken,
  hospitalPc,
  hospitalSuspended,
  newPcToken,
  requireHospitalPc,
  setPcCookie,
  UNUSED_DAYS,
  type HospitalWebContext,
} from './pcAuth.js';
import { extraMemoSchema, sendExtraMemo } from './extraMemo.js';
import { getRequestDetail, listQuerySchema, listRequests } from './requests.js';
import { pauseSchema, setPaused } from './pause.js';
import { approveSchema, cancelApprovalSchema, rejectSchema, respondToRequest } from './respond.js';

export const MAX_PCS = 3;

const requestIdParams = z.object({ requestId: z.coerce.number().int().positive() });

// 실시간 서버는 PC·병원 id 를 문자열로 다룬다 (DB bigint 를 그대로)
const pcKey = (pc: { pcId: number; hospitalId: number }) => ({
  pcId: String(pc.pcId),
  hospitalId: String(pc.hospitalId),
});
// 키 입력 5번 연속 실패 → 그 PC(접속 주소)에서 10분 막음 (SER-011)
export const MAX_KEY_FAILURES = 5;
export const KEY_LOCK_SECONDS = 600;

const shiftSchema = z.object({ staffName: z.string().trim().min(1).max(40) });
const alarmOnSchema = z.object({ socketId: z.string().min(1).max(100) });

const registerSchema = z.object({
  licenseKey: z.string().min(1).max(60),
  pcName: z.string().trim().min(1).max(40),
  replacePcId: z.number().int().positive().nullish(),
});

interface PcSummary {
  id: number;
  name: string;
  lastUsedAt: string;
}

type RegisterOutcome =
  | { kind: 'ok'; hospital: { id: number; name: string }; pcId: number; token: string }
  | { kind: 'full'; pcs: PcSummary[] }
  | { kind: 'bad_replace' };

// 실패 횟수는 서버 메모리가 아니라 Redis 에 센다. 서버가 2대가 돼도 같이 센다 (규칙 7)
const failKey = (ip: string) => `hw:license-fail:${ip}`;

export function hospitalWebRouter(ctx: HospitalWebContext): Router {
  const router = Router();
  const pcOnly = requireHospitalPc(ctx);
  router.use('/hw', checkOrigin(ctx.allowedOrigins));

  router.post('/hw/pc/register', async (req, res) => {
    const input = parseBody(registerSchema, req.body);
    const ip = req.ip ?? 'unknown';

    const [failures, ttl] = await Promise.all([
      ctx.redis.get(failKey(ip)),
      ctx.redis.ttl(failKey(ip)),
    ]);
    if (Number(failures ?? 0) >= MAX_KEY_FAILURES) {
      throw new AppError(423, 'TOO_MANY_ATTEMPTS', '키를 여러 번 틀려 잠시 막았어요', {
        retryAfterSeconds: Math.max(ttl, 1),
      });
    }

    const { rows: keys } = await ctx.pool.query<{
      hospital_id: string;
      revoked: boolean;
      expired: boolean;
      account_active: boolean;
    }>(
      `SELECT lk.hospital_id, lk.revoked_at IS NOT NULL AS revoked, lk.expires_at <= now() AS expired,
              h.account_active
         FROM license_key lk JOIN hospital h ON h.id = lk.hospital_id
        WHERE lk.key_hash = $1`,
      [hashLicenseKey(input.licenseKey)],
    );
    const key = keys[0];
    // 없는 키·폐기된 키는 같은 답을 준다. 어떤 키가 한때 있었는지 알려 줄 필요가 없다
    if (!key || key.revoked) {
      await ctx.redis.multi().incr(failKey(ip)).expire(failKey(ip), KEY_LOCK_SECONDS).exec();
      throw new AppError(401, 'INVALID_LICENSE', '라이선스 키가 맞지 않아요');
    }
    // 맞는 키지만 기간이 끝남: 틀린 입력이 아니라서 실패로 세지 않는다
    if (key.expired) throw new AppError(403, 'LICENSE_EXPIRED', '라이선스 키 기간이 끝났어요');
    // 맞는 키지만 병원 계정이 정지됨: 역시 실패로 세지 않는다 (SFR-123)
    if (!key.account_active) throw hospitalSuspended();
    await ctx.redis.del(failKey(ip));

    // 같은 병원 PC 등록을 한 줄로 세운다 (병원 행 FOR UPDATE).
    // 두 PC 가 동시에 4번째 자리를 차지해 3대를 넘는 일을 막는다
    const outcome = await withTransaction(ctx.pool, async (client): Promise<RegisterOutcome> => {
      const { rows: hospitals } = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM hospital WHERE id = $1 FOR UPDATE',
        [key.hospital_id],
      );
      const hospital = hospitals[0];

      // 오래 안 쓴 PC 는 자리를 비운다 (SFR-147)
      await client.query(
        `UPDATE hospital_pc SET released_at = now()
          WHERE hospital_id = $1 AND released_at IS NULL
            AND last_used_at < now() - make_interval(days => $2)`,
        [hospital.id, UNUSED_DAYS],
      );

      if (input.replacePcId) {
        const { rowCount } = await client.query(
          `UPDATE hospital_pc SET released_at = now()
            WHERE id = $1 AND hospital_id = $2 AND released_at IS NULL`,
          [input.replacePcId, hospital.id],
        );
        if (rowCount === 0) return { kind: 'bad_replace' };
      }

      const { rows: active } = await client.query<{
        id: string;
        name: string;
        last_used_at: Date;
      }>(
        `SELECT id, name, last_used_at FROM hospital_pc
          WHERE hospital_id = $1 AND released_at IS NULL ORDER BY last_used_at DESC`,
        [hospital.id],
      );
      if (active.length >= MAX_PCS) {
        return {
          kind: 'full',
          pcs: active.map((pc) => ({
            id: Number(pc.id),
            name: pc.name,
            lastUsedAt: pc.last_used_at.toISOString(),
          })),
        };
      }

      const token = newPcToken();
      const { rows: inserted } = await client.query<{ id: string }>(
        'INSERT INTO hospital_pc (hospital_id, name, token_hash) VALUES ($1, $2, $3) RETURNING id',
        [hospital.id, input.pcName, hashPcToken(token)],
      );
      // PC 가 바뀌면 관리자가 알 수 있게 한다 (모르는 PC 등록 감시)
      await notifyAdmin(client, 'pc_change', hospital.id);
      return {
        kind: 'ok',
        hospital: { id: Number(hospital.id), name: hospital.name },
        pcId: Number(inserted[0].id),
        token,
      };
    });

    if (outcome.kind === 'full') {
      throw new AppError(409, 'PC_LIMIT_REACHED', 'PC 3대가 모두 등록돼 있어요', {
        pcs: outcome.pcs,
      });
    }
    if (outcome.kind === 'bad_replace') {
      throw new AppError(400, 'VALIDATION_FAILED', '바꿀 PC를 찾을 수 없어요', {
        fields: ['replacePcId'],
      });
    }

    setPcCookie(res, outcome.token);
    res.status(201).json({ hospital: outcome.hospital, pcId: outcome.pcId });
  });

  router.get('/hw/session', pcOnly, async (_req, res) => {
    const pc = hospitalPc(res);
    const { rows } = await ctx.pool.query<{
      shift_id: string | null;
      staff_name: string | null;
      alarm_on: boolean | null;
      paused: boolean;
      paused_at: Date | null;
      server_now: Date;
    }>(
      `SELECT s.id AS shift_id, s.staff_name, s.alarm_on_at IS NOT NULL AS alarm_on,
              h.requests_paused AS paused, h.paused_at, now() AS server_now
         FROM hospital h
         LEFT JOIN LATERAL (
           SELECT id, staff_name, alarm_on_at FROM hospital_shift
            WHERE pc_id = $2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1
         ) s ON true
        WHERE h.id = $1`,
      [pc.hospitalId, pc.pcId],
    );
    const row = rows[0];
    res.json({
      hospital: { id: pc.hospitalId, name: pc.hospitalName },
      pc: { id: pc.pcId, name: pc.pcName },
      licenseDaysLeft: pc.licenseDaysLeft,
      shift: row.shift_id
        ? { id: Number(row.shift_id), staffName: row.staff_name, alarmOn: row.alarm_on }
        : null,
      paused: row.paused,
      pausedAt: row.paused_at?.toISOString() ?? null,
      serverNow: row.server_now.toISOString(),
    });
  });

  // 근무 시작: 담당자 이름만 받는다 (SFR-117). 아직 알림은 꺼져 있고, 알림 켜기를 눌러야 요청 대상이 된다
  router.post('/hw/shifts', pcOnly, async (req, res) => {
    const pc = hospitalPc(res);
    const input = parseBody(shiftSchema, req.body);

    const started = await withTransaction(ctx.pool, async (client) => {
      // 같은 PC 에서 두 번 눌러도 진행 중인 근무가 하나만 남게 PC 행을 잠근다
      await client.query('SELECT id FROM hospital_pc WHERE id = $1 FOR UPDATE', [pc.pcId]);
      // 앞 근무가 남아 있으면(다른 탭 등) 끝내고 새로 시작한다. 1 PC = 진행 중 근무 1개
      const { rows: ended } = await client.query<{ alarm_on: boolean }>(
        `UPDATE hospital_shift SET ended_at = now(), alarm_on_at = NULL
          WHERE pc_id = $1 AND ended_at IS NULL
         RETURNING alarm_on_at IS NOT NULL AS alarm_on`,
        [pc.pcId],
      );
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO hospital_shift (pc_id, staff_name) VALUES ($1, $2) RETURNING id',
        [pc.pcId, input.staffName],
      );
      return { shiftId: Number(rows[0].id), hadOpenShift: ended.length > 0 };
    });

    // 앞 근무의 탭들은 요청 대상에서 뺀다. 알림은 커밋한 뒤에 보낸다 (롤백된 일이 알려지면 안 된다)
    if (started.hadOpenShift) await ctx.realtime?.alarmOff(pcKey(pc), 'shift_ended');
    res.status(201).json({ shiftId: started.shiftId });
  });

  // 알림 켜기 (SFR-117, SFR-136): 브라우저 소리 정책 때문에 사람이 버튼을 눌러야 한다.
  // 이때부터 이 탭이 hospital:{id}:on 방에 들어가 새 요청을 받는다
  router.post('/hw/shifts/current/alarm-on', pcOnly, async (req, res) => {
    const pc = hospitalPc(res);
    const input = parseBody(alarmOnSchema, req.body);
    const noShift = () => new AppError(404, 'NOT_FOUND', '근무를 먼저 시작해 주세요');

    const { rows } = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM hospital_shift
        WHERE pc_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [pc.pcId],
    );
    if (!rows[0]) throw noShift();
    const shiftId = Number(rows[0].id);

    // 이 PC 의 그 탭인지 실시간 서버가 확인하고 방에 넣는다. 남의 PC 연결 id 로는 못 넣는다
    if (!ctx.realtime || !(await ctx.realtime.alarmOn(pcKey(pc), input.socketId))) {
      throw new AppError(404, 'NOT_FOUND', '실시간 연결을 찾지 못했어요. 잠시 뒤 다시 눌러 주세요');
    }
    const { rowCount } = await ctx.pool.query(
      'UPDATE hospital_shift SET alarm_on_at = now() WHERE id = $1 AND ended_at IS NULL',
      [shiftId],
    );
    // 그사이 다른 탭에서 근무를 끝냈으면 방에서 다시 뺀다
    if (rowCount === 0) {
      await ctx.realtime.alarmOff(pcKey(pc), 'shift_ended');
      throw noShift();
    }
    res.json({ shiftId });
  });

  // 근무 종료: 이 PC 의 탭들을 요청 대상에서 빼고 hospital.alarm_off{shift_ended} 를 보낸다
  router.post('/hw/shifts/current/end', pcOnly, async (_req, res) => {
    const pc = hospitalPc(res);
    const { rowCount } = await ctx.pool.query(
      `UPDATE hospital_shift SET ended_at = now(), alarm_on_at = NULL
        WHERE pc_id = $1 AND ended_at IS NULL`,
      [pc.pcId],
    );
    if (rowCount === 0) throw new AppError(404, 'NOT_FOUND', '진행 중인 근무가 없어요');
    await ctx.realtime?.alarmOff(pcKey(pc), 'shift_ended');
    res.status(204).end();
  });

  // 요청 목록: 새 요청 알림을 받으면, 그리고 다시 연결될 때마다 이걸로 전체를 새로 받는다 (실시간 설계 3장)
  // 잠시 요청 중지 / 다시 받기 (SFR-139). 병원 전체에 적용. 중지하면 대기 요청은 '거절(요청 중지)'로 한꺼번에
  router.put('/hw/pause', pcOnly, async (req, res) => {
    const { paused } = parseBody(pauseSchema, req.body);
    const outcome = await withTransaction(ctx.pool, (client) =>
      setPaused(client, hospitalPc(res), paused),
    );
    // 실시간 알림은 커밋된 뒤에만
    ctx.realtime?.publish(outcome.events);
    res.status(204).end();
  });

  router.get('/hw/requests', pcOnly, async (req, res) => {
    const pc = hospitalPc(res);
    res.json(await listRequests(ctx.pool, pc.hospitalId, parseBody(listQuerySchema, req.query)));
  });

  // 요청 상세: 환자 평가·이상 수치·우리 병원 병상. 열 때마다 열람 기록이 남는다 (SFR-118, SFR-137)
  router.get('/hw/requests/:requestId', pcOnly, async (req, res) => {
    const { requestId } = parseBody(requestIdParams, req.params);
    res.json(await getRequestDetail(ctx.pool, hospitalPc(res), requestId));
  });

  // 승인·거절: 두 PC 가 동시에 눌러도 먼저 반영된 것만 (SFR-119·160). 실시간 알림은 커밋된 뒤에만 보낸다
  router.post('/hw/requests/:requestId/approve', pcOnly, async (req, res) => {
    const { requestId } = parseBody(requestIdParams, req.params);
    const input = parseBody(approveSchema, req.body);
    const outcome = await withTransaction(ctx.pool, (client) =>
      respondToRequest(client, hospitalPc(res), requestId, { event: 'APPROVE', input }),
    );
    ctx.realtime?.publish(outcome.events);
    res.json(outcome.body);
  });

  router.post('/hw/requests/:requestId/reject', pcOnly, async (req, res) => {
    const { requestId } = parseBody(requestIdParams, req.params);
    const input = parseBody(rejectSchema, req.body);
    const outcome = await withTransaction(ctx.pool, (client) =>
      respondToRequest(client, hospitalPc(res), requestId, { event: 'REJECT', input }),
    );
    ctx.realtime?.publish(outcome.events);
    res.json(outcome.body);
  });

  // 승인 취소: 승인·확정한 요청을 사유와 함께 닫는다 (SFR-128). 확정 병원이면 대원 앱에 경보
  router.post('/hw/requests/:requestId/cancel-approval', pcOnly, async (req, res) => {
    const { requestId } = parseBody(requestIdParams, req.params);
    const input = parseBody(cancelApprovalSchema, req.body);
    const outcome = await withTransaction(ctx.pool, (client) =>
      respondToRequest(client, hospitalPc(res), requestId, { event: 'CANCEL_APPROVAL', input }),
    );
    ctx.realtime?.publish(outcome.events);
    res.status(204).end();
  });

  // 추가 메모: 확정된 요청에 한 번만 (SFR-140). 대원 앱에 경보
  router.post('/hw/requests/:requestId/extra-memo', pcOnly, async (req, res) => {
    const { requestId } = parseBody(requestIdParams, req.params);
    const input = parseBody(extraMemoSchema, req.body);
    const events = await withTransaction(ctx.pool, (client) =>
      sendExtraMemo(client, hospitalPc(res), requestId, input),
    );
    ctx.realtime?.publish(events);
    res.status(204).end();
  });

  return router;
}
