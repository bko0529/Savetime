// SFR-106(관리자 통계) 인수 기준을 임시 DB 로 확인한다. 요청·거절·소요시간 기록을 직접 넣고 집계만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic } from '../../testing/auth.js';
import { WEB_ORIGIN, withHospitalWeb } from '../../testing/hospitalWeb.js';
import { signAccessToken, signingKey } from '../auth/tokens.js';
import { signAdminAccessToken } from './tokens.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';

interface Harness {
  pool: pg.Pool;
  jwtKey: Uint8Array;
  stats: (days?: number, token?: string) => request.Test;
  hospital: (name: string) => Promise<string>;
  // 이 병원에 요청 count 건. ago 전에 보냈고, status·응답까지 걸린 초(null 이면 응답 없음)
  requests: (
    hospitalId: string,
    count: number,
    opts: { ago?: string; status?: string; respondSec?: number | null; inStats?: boolean },
  ) => Promise<void>;
  rejection: (
    hospitalId: string,
    source: string,
    reason: string,
    count?: number,
    ago?: string,
  ) => Promise<void>;
}

async function withStats(use: (h: Harness) => Promise<void>): Promise<void> {
  await withHospitalWeb(async (hospitalWeb) => {
    const { pool, redis } = hospitalWeb;
    const jwtKey = signingKey(randomBytes(32).toString('base64'));
    const app = createApp({
      logger,
      healthChecks: { db: ok, redis: ok },
      hospitalWeb,
      admin: { pool, redis, jwtKey, sessionHours: 14, allowedOrigins: [WEB_ORIGIN] },
    });
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO admin (login_id, password_hash, name) VALUES ('kim', 'x', '김관리') RETURNING id",
    );
    const adminToken = await signAdminAccessToken(jwtKey, rows[0].id);

    // 요청을 매달 이송 건 1개 (통계는 이송 건·대원을 보지 않는다)
    const paramedicId = await addParamedic(pool, { loginId: 'stat01' });
    const { rows: team } = await pool.query<{ id: string }>(
      `INSERT INTO team (code, qr_token, created_by) VALUES ('9001', 'qr', $1) RETURNING id`,
      [paramedicId],
    );
    const transportId = randomUUID();
    await pool.query(
      "INSERT INTO transport (id, team_id, status, location_consent) VALUES ($1, $2, 'arrived', true)",
      [transportId, team[0].id],
    );
    let publicSeq = 0;

    await use({
      pool,
      jwtKey,
      stats: (days, token = adminToken) =>
        request(app)
          .get(`/api/v1/admin/stats/hospitals${days ? `?days=${days}` : ''}`)
          .set('Origin', WEB_ORIGIN)
          .set('Authorization', `Bearer ${token}`),
      hospital: async (name) => {
        const { rows: h } = await pool.query<{ id: string }>(
          `INSERT INTO hospital (public_id, name, lat, lng) VALUES ($1, $2, 36.8, 127.1) RETURNING id`,
          [`S${(publicSeq += 1)}`, name],
        );
        return h[0].id;
      },
      requests: async (
        hospitalId,
        count,
        { ago = '1 day', status, respondSec, inStats = true },
      ) => {
        const answered = respondSec !== undefined && respondSec !== null;
        await pool.query(
          `WITH base AS (SELECT coalesce(max(round_no), 0) AS n FROM request_round WHERE transport_id = $1),
                rounds AS (
                  INSERT INTO request_round (transport_id, round_no, radius_km, sent_at, respond_until, approval_valid_until)
                  SELECT $1, base.n + g, 20, now() - $2::interval,
                         now() - $2::interval + interval '2 minutes', now() - $2::interval + interval '5 minutes'
                    FROM base, generate_series(1, $3) g
                  RETURNING id, sent_at)
           INSERT INTO hospital_request (round_id, hospital_id, status, responded_at, in_stats)
           SELECT id, $4, $5::hreq_status,
                  CASE WHEN $6::int IS NULL THEN NULL ELSE sent_at + make_interval(secs => $6::int) END, $7
             FROM rounds`,
          [
            transportId,
            ago,
            count,
            hospitalId,
            status ?? (answered ? 'approved' : 'expired'),
            answered ? respondSec : null,
            inStats,
          ],
        );
      },
      rejection: async (hospitalId, source, reason, count = 1, ago = '1 day') => {
        await pool.query(
          `INSERT INTO rejection_record (hospital_id, source, reason, created_at)
           SELECT $1, $2, $3, now() - $5::interval FROM generate_series(1, $4)`,
          [hospitalId, source, reason, count, ago],
        );
      },
    });
  });
}

type Stat = Record<string, unknown> & { name: string };
const byName = (body: { hospitals: Stat[] }) =>
  Object.fromEntries(body.hospitals.map((h) => [h.name, h]));

test('최근 7일 A병원이 요청 10건 중 8건에 응답하면 응답률 80% (SFR-106 인수 기준)', async () => {
  await withStats(async (h) => {
    const a = await h.hospital('A병원');
    await h.requests(a, 8, { respondSec: 40 });
    await h.requests(a, 2, {}); // 2분 동안 응답 없음
    // 잠시 요청 중지 자동 거절·전달 실패는 '병원이 직접 누른 응답'이 아니라 세지 않는다
    await h.requests(a, 5, { status: 'rejected', respondSec: 0, inStats: false });
    await h.requests(a, 3, { status: 'delivery_failed' });

    const res = await h.stats(7);
    assert.equal(res.status, 200);
    const A = byName(res.body)['A병원'];
    assert.equal(A.requests, 10);
    assert.equal(A.responseRate, 0.8);
    assert.equal(A.sampleTooSmall, false);
  });
});

test('최근 7일 A병원 응답 시간이 30·60·90초면 평균 60초 (SFR-106 인수 기준)', async () => {
  await withStats(async (h) => {
    const a = await h.hospital('A병원');
    await h.requests(a, 1, { respondSec: 30 });
    await h.requests(a, 1, { respondSec: 60 });
    await h.requests(a, 1, { status: 'rejected', respondSec: 90 });
    await h.requests(a, 7, {});
    const A = byName((await h.stats(7)).body)['A병원'];
    assert.equal(A.avgResponseSec, 60);
  });
});

test("최근 7일 C병원 요청이 6건이면 수치 없이 '표본 부족' (SFR-106 인수 기준)", async () => {
  await withStats(async (h) => {
    const c = await h.hospital('C병원');
    await h.requests(c, 6, { respondSec: 20 });
    const C = byName((await h.stats(7)).body)['C병원'];
    assert.equal(C.sampleTooSmall, true);
    assert.equal(C.responseRate, null);
    assert.equal(C.avgResponseSec, null);
    assert.equal(C.approvalCancelRate, null);
  });
});

test('D병원 30일 거절률 20%, 7일 거절률 45%면 강조 (SFR-106 인수 기준)', async () => {
  await withStats(async (h) => {
    const d = await h.hospital('D병원');
    // 최근 7일: 20건 중 9건 거절 (45%)
    await h.requests(d, 9, { status: 'rejected', respondSec: 30 });
    await h.requests(d, 11, { respondSec: 30 });
    // 8~30일 전: 80건 중 11건 거절 → 30일 전체 100건 중 20건 (20%)
    await h.requests(d, 11, { ago: '15 days', status: 'rejected', respondSec: 30 });
    await h.requests(d, 69, { ago: '15 days', respondSec: 30 });
    // 비교 대상: 7일·30일 거절률이 같은 E병원은 강조하지 않는다
    const e = await h.hospital('E병원');
    await h.requests(e, 2, { status: 'rejected', respondSec: 30 });
    await h.requests(e, 8, { respondSec: 30 });
    await h.requests(e, 2, { ago: '15 days', status: 'rejected', respondSec: 30 });
    await h.requests(e, 8, { ago: '15 days', respondSec: 30 });

    const week = byName((await h.stats(7)).body);
    assert.equal(week['D병원'].rejectSpike, true);
    assert.equal(week['E병원'].rejectSpike, false);
    // 30일을 골라도 강조 기준은 같다 (7일 vs 30일)
    const month = byName((await h.stats(30)).body);
    assert.equal(month['D병원'].requests, 100);
    assert.equal(month['D병원'].rejectSpike, true);
  });
});

test('A병원 병원 웹 거절 1건(해당 전문의 부재)·전화 확인 거절 3건은 출처별로 나뉜다 (SFR-106 인수 기준)', async () => {
  await withStats(async (h) => {
    const a = await h.hospital('A병원');
    await h.requests(a, 10, { respondSec: 30 });
    await h.rejection(a, 'hospital_web', 'no_specialist', 1);
    await h.rejection(a, 'phone_check', 'or_room', 3);
    // 30일보다 오래된 기록은 7일 통계에 안 들어간다
    await h.rejection(a, 'hospital_web', 'er_bed', 5, '20 days');

    const A = byName((await h.stats(7)).body)['A병원'];
    assert.deepEqual(A.rejectBySource, {
      hospitalWeb: { no_specialist: 1 },
      paused: {},
      phoneCheck: { or_room: 3 },
      approvalCancelled: {},
      unacceptable: {},
    });
    // 대표 거절 사유는 병원 웹 직접 거절에서만 고른다 (전화 확인 3건이 더 많아도)
    assert.equal(A.topRejectReason, 'no_specialist');
  });
});

test('승인 취소율은 (승인 취소 + 수용 불가) ÷ 승인, 요청→첫 승인·출발 평균은 소요시간 기록에서', async () => {
  await withStats(async (h) => {
    const a = await h.hospital('A병원');
    await h.requests(a, 8, { respondSec: 30 }); // 승인 8
    await h.requests(a, 2, { status: 'rejected', respondSec: 30 });
    await h.rejection(a, 'approval_cancelled', 'er_bed', 1);
    await h.rejection(a, 'unacceptable', 'no_specialist', 1);
    await h.pool.query(
      `INSERT INTO transport_stat (hospital_id, request_to_approve_sec, request_to_depart_sec, departed_at)
       VALUES ($1, 40, 70, now() - interval '1 day'), ($1, 60, 110, now() - interval '2 days'),
              (NULL, NULL, 300, now() - interval '1 day')`,
      [a],
    );

    const res = await h.stats(7);
    const A = byName(res.body)['A병원'];
    assert.equal(A.approvalCancelRate, 2 / 8);
    assert.equal(A.unacceptableCount, 1);
    assert.equal(A.avgRequestToFirstApprovalSec, 50);
    assert.equal(A.avgRequestToDepartSec, 90);
    // 맨 위 핵심 지표는 병원이 정해지기 전에 끝난 건까지 전체 평균 (70·110·300)
    assert.equal(res.body.avgRequestToDepartSec, 160);
    // 통계에는 대원·이송 건 정보가 없다 (DAR-004)
    assert.doesNotMatch(JSON.stringify(res.body), /transport|paramedic|stat01/i);
  });
});

test('기간 밖·요청 없는 병원은 빠지고, days 는 7·30 만, 관리자가 아니면 401', async () => {
  await withStats(async (h) => {
    const old = await h.hospital('옛병원');
    await h.requests(old, 12, { ago: '20 days', respondSec: 30 });
    await h.hospital('빈병원');
    assert.deepEqual((await h.stats(7)).body.hospitals, []);
    assert.deepEqual(
      (await h.stats(30)).body.hospitals.map((x: Stat) => x.name),
      ['옛병원'],
    );
    assert.equal((await h.stats()).body.days, 7, '기본은 7일');
    assert.equal((await h.stats(14)).status, 400);

    const paramedic = await signAccessToken(h.jwtKey, { paramedicId: '1', sessionVersion: 1 });
    assert.equal((await h.stats(7, paramedic)).status, 401);
  });
});
