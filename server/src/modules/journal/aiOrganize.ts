// AI 일지 정리 (SFR-167, S-13): 대원이 쓴 메모를 일지 항목별로 나눈 '제안'을 돌려준다.
// - 보내기 전에 식별정보를 지운다 (SER-017, scrub.ts)
// - 원문·AI 응답은 저장하지도, 로그에 남기지도 않는다. 실패 로그에도 이유 코드만 (절대 규칙 2)
// - 10초 안에 답이 없으면 503 AI_UNAVAILABLE → 앱은 초안을 그대로 두고 '지금은 정리할 수 없어요' (INR-006)
// - 기능 토글 journal_ai 가 꺼져 있으면 403 FEATURE_DISABLED (QUR-013)
// - 앱은 제안을 보여 주기만 하고, 대원이 '적용'을 눌러야 초안에 들어간다 (앱 몫)
// 제공사는 OpenAI (기술정의서 T-12). 요청 1종뿐이라 SDK 없이 Node 내장 fetch 로 부른다
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';
import { AppError } from '../../http/errors.js';
import { parseBody } from '../../http/validate.js';
import { scrubIdentifiers } from './scrub.js';

export const SUGGESTION_FIELDS = [
  'chiefComplaint',
  'history',
  'treatment',
  'medicalDirection',
  'other',
] as const;
type SuggestionField = (typeof SUGGESTION_FIELDS)[number];
export type Suggestions = Record<SuggestionField, string | null>;

// AI 를 부르는 부분을 이 모양 뒤에 숨긴다. 테스트는 가짜 함수를 넘긴다
export type AiOrganizer = (scrubbedText: string, signal: AbortSignal) => Promise<Suggestions>;

const bodySchema = z.object({
  text: z.string().trim().min(1).max(2000),
  // 앱 단말에만 있는 이름 칸 값(환자·보호자). 메모에 섞여 있으면 지우려고 받는다. 서버는 저장하지 않는다
  names: z.array(z.string().max(40)).max(5).default([]),
});

const unavailable = () => new AppError(503, 'AI_UNAVAILABLE', '지금은 정리할 수 없어요');

const SYSTEM_PROMPT = `너는 119 구급대원의 구급활동일지 작성을 돕는다.
대원이 쓴 메모를 아래 항목으로 나눠 JSON 하나로만 답한다. 메모에 없는 내용은 지어내지 말고 null 로 둔다.
- chiefComplaint: 주호소 (예: "갑작스러운 두통·쓰러짐")
- history: 병력·복용약 (예: "고혈압")
- treatment: 응급처치 (예: "산소 4L/분")
- medicalDirection: 의료지도 내용
- other: 그 밖에 일지에 남길 내용
짧은 한국어 명사구로 쓰고, [삭제] 표시는 그대로 두거나 빼라. 이름·연락처·주소를 새로 만들지 마라.
답 모양: {"chiefComplaint": string|null, "history": string|null, "treatment": string|null, "medicalDirection": string|null, "other": string|null}`;

// AI 답을 그대로 믿지 않는다: 아는 칸만, 문자열만, 칸마다 200자까지
export function toSuggestions(raw: unknown): Suggestions {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as Suggestions;
  for (const field of SUGGESTION_FIELDS) {
    const v = obj[field];
    out[field] = typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 200) : null;
  }
  return out;
}

// OpenAI Chat Completions (JSON 모드). 키·모델은 server/.env 의 AI_API_KEY·AI_MODEL (절대 규칙 1)
export function createOpenAiOrganizer(apiKey: string, model: string): AiOrganizer {
  return async (scrubbedText, signal) => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: scrubbedText },
        ],
      }),
    });
    if (!res.ok) throw new Error(`openai_${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('openai_empty');
    return toSuggestions(JSON.parse(content));
  };
}

export function aiOrganizeRouter(
  pool: pg.Pool,
  guards: RequestHandler[],
  logger: Logger,
  options: { organizer?: AiOrganizer; timeoutMs: number },
): Router {
  const router = Router();

  router.post('/journal/ai-organize', ...guards, async (req, res) => {
    // 토글을 먼저 본다: 꺼져 있으면 입력이 어떻든 버튼을 숨기라는 뜻이다
    const { rows } = await pool.query<{ enabled: boolean }>(
      "SELECT enabled FROM feature_flag WHERE key = 'journal_ai'",
    );
    if (!rows[0]?.enabled) {
      throw new AppError(403, 'FEATURE_DISABLED', 'AI 일지 정리가 꺼져 있어요');
    }
    const input = parseBody(bodySchema, req.body);
    // 키가 없는 서버(개발·테스트)는 정리할 수 없다
    if (!options.organizer) throw unavailable();

    const scrubbed = scrubIdentifiers(input.text, input.names);
    let suggestions: Suggestions;
    try {
      suggestions = await options.organizer(scrubbed.text, AbortSignal.timeout(options.timeoutMs));
    } catch (err) {
      // 원문·응답은 로그에 넣지 않는다. 시간 초과인지, 제공사 오류인지만
      const reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? 'timeout'
          : err instanceof Error
            ? err.message.slice(0, 40)
            : 'unknown';
      logger.warn({ reason }, 'AI 일지 정리 실패');
      throw unavailable();
    }
    // 메모에 없던 식별정보를 AI 가 만들어 넣었을 수도 있어 한 번 더 지운다
    for (const field of SUGGESTION_FIELDS) {
      const v = suggestions[field];
      if (v !== null) suggestions[field] = scrubIdentifiers(v, input.names).text;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ suggestions, removedIdentifiers: scrubbed.removed });
  });

  return router;
}
