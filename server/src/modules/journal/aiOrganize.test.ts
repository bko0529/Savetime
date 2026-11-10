// SFR-167 AI 일지 정리 인수 기준. 실제 OpenAI 대신 가짜 정리 함수로 확인한다 (보낸 글을 기록해 식별정보가 빠졌는지 본다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../../app.js';
import { addParamedic, TEST_PASSWORD, withAuthContext } from '../../testing/auth.js';
import type { AuthContext } from '../auth/session.js';
import { toSuggestions, type AiOrganizer, type Suggestions } from './aiOrganize.js';

const logger = pino({ level: 'silent' });
const ok = async () => 'ok';
const MEMO = '60대 남성 갑자기 머리 아프다며 쓰러짐 고혈압약 복용 산소 4리터';
const ORGANIZED: Suggestions = {
  chiefComplaint: '갑작스러운 두통·쓰러짐',
  history: '고혈압',
  treatment: '산소 4L/분',
  medicalDirection: null,
  other: null,
};

let seq = 0;

async function harness(ctx: AuthContext, organizer?: AiOrganizer, timeoutMs = 10_000) {
  // 한 테스트에서 여러 번 만들 수 있게 대원 아이디를 바꾼다
  const loginId = `kim${(seq += 1)}`;
  await addParamedic(ctx.pool, { loginId });
  const app = createApp({
    logger,
    healthChecks: { db: ok, redis: ok },
    auth: ctx,
    aiOrganizer: organizer,
    aiTimeoutMs: timeoutMs,
  });
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ loginId, password: TEST_PASSWORD, deviceId: `device-${loginId}` });
  const token = login.body.tokens.accessToken as string;
  return (body: object) =>
    request(app)
      .post('/api/v1/journal/ai-organize')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
}

const enableAi = (ctx: AuthContext, on = true) =>
  ctx.pool.query("UPDATE feature_flag SET enabled = $1 WHERE key = 'journal_ai'", [on]);

test('메모를 보내면 주호소·병력·응급처치가 제안으로 나뉘어 온다 (SFR-167 인수 기준 1)', async () => {
  await withAuthContext(async (ctx) => {
    await enableAi(ctx);
    const sent: string[] = [];
    const organize = await harness(ctx, async (text) => {
      sent.push(text);
      return ORGANIZED;
    });
    const res = await organize({ text: MEMO });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.body, { suggestions: ORGANIZED, removedIdentifiers: 0 });
    assert.deepEqual(sent, [MEMO]);
    // 원문·응답은 어디에도 저장하지 않는다 (DB 에 그 글이 없다)
    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM event_log WHERE payload::text LIKE '%고혈압%'`,
    );
    assert.equal(rows[0].n, 0);
  });
});

test('메모의 이름·전화번호는 AI 로 보낸 글에 없다 (SFR-167 인수 기준 2, SER-017)', async () => {
  await withAuthContext(async (ctx) => {
    await enableAi(ctx);
    const sent: string[] = [];
    const organize = await harness(ctx, async (text) => {
      sent.push(text);
      // AI 가 이름을 지어내 넣어도 한 번 더 지운다
      return { ...ORGANIZED, other: '보호자 홍길동 연락처 010-9999-8888' };
    });
    const res = await organize({ text: `홍길동 010-1234-5678 ${MEMO}`, names: ['홍길동'] });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0], /홍길동|010-1234-5678/);
    assert.equal(res.body.removedIdentifiers, 2);
    assert.equal(res.body.suggestions.other, '보호자 [삭제] 연락처 [삭제]');
  });
});

test("AI 가 10초 안에 답하지 않으면 503 '지금은 정리할 수 없어요' (SFR-167 인수 기준 3, INR-006)", async () => {
  await withAuthContext(async (ctx) => {
    await enableAi(ctx);
    // 테스트는 제한시간을 짧게 둔다. 가짜 AI 는 신호가 끊길 때까지 기다린다
    const organize = await harness(
      ctx,
      (_text, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
      1000,
    );
    const started = Date.now();
    const res = await organize({ text: MEMO });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'AI_UNAVAILABLE');
    assert.equal(res.body.error.message, '지금은 정리할 수 없어요');
    assert.ok(Date.now() - started < 5000);

    // 제공사 오류도 같은 답
    const failing = await harness(ctx, async () => {
      throw new Error('openai_500');
    });
    assert.equal((await failing({ text: MEMO })).status, 503);
  });
});

test('기능 토글이 꺼져 있으면 403 FEATURE_DISABLED, 키가 없는 서버는 503, 빈 글·2000자 초과는 400', async () => {
  await withAuthContext(async (ctx) => {
    const organize = await harness(ctx, async () => ORGANIZED);
    // 기본값은 꺼짐 (schema.sql)
    const off = await organize({ text: MEMO });
    assert.equal(off.status, 403);
    assert.equal(off.body.error.code, 'FEATURE_DISABLED');

    await enableAi(ctx);
    assert.equal((await organize({ text: '   ' })).status, 400);
    assert.equal((await organize({ text: '가'.repeat(2001) })).status, 400);

    const noKey = await harness(ctx);
    const res = await noKey({ text: MEMO });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'AI_UNAVAILABLE');
  });
});

test('AI 답은 아는 칸만, 문자열만, 200자까지 받는다', () => {
  assert.deepEqual(
    toSuggestions({
      chiefComplaint: ' 두통 ',
      history: 3,
      treatment: '',
      extra: '무시',
      other: 'a'.repeat(300),
    }),
    {
      chiefComplaint: '두통',
      history: null,
      treatment: null,
      medicalDirection: null,
      other: 'a'.repeat(200),
    },
  );
  assert.deepEqual(toSuggestions(null), {
    chiefComplaint: null,
    history: null,
    treatment: null,
    medicalDirection: null,
    other: null,
  });
});
