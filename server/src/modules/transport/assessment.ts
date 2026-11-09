// 환자 평가 입력 규칙 (openapi Assessment). 이송 건 만들기(SFR-109)와 팀 작성 중 정보(SFR-114)가 같이 쓴다.
// 두 곳의 규칙이 갈리면 작성 중에는 저장되던 값이 병원에 요청할 때 거절되는 일이 생긴다.
import type pg from 'pg';
import { z } from 'zod';

const nullableInt = z.number().int().nullable().optional();

// 환자 평가 (openapi Assessment). strict: 이름·주민번호·연락처처럼 정해지지 않은 칸이 오면 통째로 거절한다 (SER-012)
export const assessmentShape = {
  chiefComplaint: z.string().max(100).optional(),
  sex: z.enum(['M', 'F', 'U']).optional(),
  ageBand: z.string().max(10).optional(),
  consciousness: z.enum(['alert', 'verbal', 'pain', 'unresponsive', 'unknown']).optional(),
  bp: z.string().max(10).optional(),
  pulse: nullableInt,
  resp: nullableInt,
  spo2: nullableInt,
  painSite: z.string().max(30).nullable().optional(),
  painScore: z.number().int().min(0).max(10).nullable().optional(),
  onset: z.string().max(30).nullable().optional(),
  trauma: z.enum(['yes', 'no', 'unknown']).optional(),
  traumaCause: z
    .enum(['traffic', 'fall_high', 'fall', 'penetrating', 'burn', 'etc'])
    .nullable()
    .optional(),
  history: z.string().max(500).nullable().optional(),
  temp: z.number().min(20).max(45).nullable().optional(),
  glucose: nullableInt,
  ktas: z.number().int().min(1).max(5).nullable().optional(),
  unknownFields: z.array(z.string().max(30)).max(30).optional(),
};

export const assessmentSchema = z.object(assessmentShape).strict();

export type AssessmentField = keyof typeof assessmentShape;
export const ASSESSMENT_FIELDS = Object.keys(assessmentShape) as AssessmentField[];

// 팀 작성 중 정보에서 바뀐 칸만 보낼 때: 모든 칸이 선택이고, null 은 그 칸을 지운다.
// strict 라 정해지지 않은 칸(환자 이름 등)은 통째로 거절된다 (SER-012)
export const assessmentChangesSchema = z
  .object(
    Object.fromEntries(
      ASSESSMENT_FIELDS.map((field) => [field, assessmentShape[field].nullable()]),
    ) as { [K in AssessmentField]: z.ZodNullable<(typeof assessmentShape)[K]> },
  )
  .partial()
  .strict();

// ---- 병원에 보낸 환자 평가(assessment 행)와 비교하기 (SFR-105) ----
// '변경 사항 보내기(n)'의 n, 보낼 칸, 병원 웹 강조 칸을 모두 이 비교 하나로 센다. 세는 방법이 갈리면
// 앱은 '2개 바뀜'이라는데 병원 웹은 1개만 강조하는 일이 생긴다.

// API 칸 이름 → DB 칸 이름
export const ASSESSMENT_COLUMN: Record<AssessmentField, string> = {
  chiefComplaint: 'chief_complaint',
  sex: 'sex',
  ageBand: 'age_band',
  consciousness: 'consciousness',
  bp: 'bp',
  pulse: 'pulse',
  resp: 'resp',
  spo2: 'spo2',
  painSite: 'pain_site',
  painScore: 'pain_score',
  onset: 'onset',
  trauma: 'trauma',
  traumaCause: 'trauma_cause',
  history: 'history',
  temp: 'temp',
  glucose: 'glucose',
  ktas: 'ktas',
  unknownFields: 'unknown_fields',
};

export type AssessmentData = Partial<Record<AssessmentField, unknown>>;

// SELECT 목록: a.chief_complaint AS b_chief_complaint, ... (같은 쿼리에서 두 행을 읽을 때 prefix 로 구분)
export function assessmentSelect(alias: string, prefix = ''): string {
  return ASSESSMENT_FIELDS.map(
    (f) => `${alias}.${ASSESSMENT_COLUMN[f]} AS ${prefix}${ASSESSMENT_COLUMN[f]}`,
  ).join(', ');
}

// DB 행 → API 칸. 빈 값(null·빈 글·빈 목록)은 칸을 빼서 '입력 안 함'으로 둔다 (팀 작성 중 정보와 같은 모양)
export function assessmentFromRow(row: Record<string, unknown>, prefix = ''): AssessmentData {
  const out: AssessmentData = {};
  for (const field of ASSESSMENT_FIELDS) {
    const value = normalize(field, row[`${prefix}${ASSESSMENT_COLUMN[field]}`]);
    if (value !== null) out[field] = value;
  }
  return out;
}

// API 모양 환자 평가에서 빈 칸을 빼고 값을 맞춘다 (팀 작성 중 정보에 넣을 모양)
export function cleanAssessment(data: AssessmentData): AssessmentData {
  return assessmentFromRow(
    Object.fromEntries(ASSESSMENT_FIELDS.map((f) => [ASSESSMENT_COLUMN[f], data[f]])),
  );
}

// 비교용으로 값을 맞춘다: numeric(pg 는 문자열로 줌) → 숫자, 목록은 순서 무시, 빈 값은 null
function normalize(field: AssessmentField, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  // 앞뒤 빈칸만 다른 글은 같은 값으로 본다
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (field === 'temp') return Number(value);
  if (Array.isArray(value)) return value.length === 0 ? null : [...value].sort();
  return value;
}

// 두 환자 평가에서 값이 다른 칸 (칸 순서는 화면 순서 = ASSESSMENT_FIELDS 순서)
export function changedFields(before: AssessmentData, after: AssessmentData): AssessmentField[] {
  return ASSESSMENT_FIELDS.filter(
    (field) =>
      JSON.stringify(normalize(field, before[field])) !==
      JSON.stringify(normalize(field, after[field])),
  );
}

// assessment 행에 넣을 값 목록 (ASSESSMENT_FIELDS 순서)
export function assessmentValues(data: AssessmentData): unknown[] {
  return ASSESSMENT_FIELDS.map((field) => {
    const value = normalize(field, data[field]);
    if (field === 'unknownFields') return value ?? [];
    return value;
  });
}

// 팀 작성 중 정보와 마지막으로 보낸 환자 평가. 둘 다 '빈 칸은 뺀' 같은 모양이다
export async function draftAndLastSent(
  db: pg.Pool | pg.PoolClient,
  transportId: string,
  teamId: string,
): Promise<{ draft: AssessmentData | null; last: AssessmentData; lastSeq: number }> {
  // 트랜잭션 client 에서도 쓰므로 한 번에 하나씩 묻는다 (client 하나로 동시 쿼리는 하지 않는다)
  const { rows: drafts } = await db.query<{ data: AssessmentData }>(
    'SELECT data FROM team_draft WHERE team_id = $1',
    [teamId],
  );
  const { rows: sent } = await db.query<Record<string, unknown> & { seq: number }>(
    `SELECT a.seq, ${assessmentSelect('a')} FROM assessment a
      WHERE a.transport_id = $1 ORDER BY a.seq DESC LIMIT 1`,
    [transportId],
  );
  return {
    draft: drafts[0]?.data ?? null,
    last: sent[0] ? assessmentFromRow(sent[0]) : {},
    lastSeq: sent[0]?.seq ?? 0,
  };
}

// '변경 사항 보내기(n)'의 n. 작성 중 정보가 없으면(아직 아무도 안 고침) 0
export function pendingCount(draft: AssessmentData | null, last: AssessmentData): number {
  return draft ? changedFields(last, draft).length : 0;
}
