// 환자 평가 입력 규칙 (openapi Assessment). 이송 건 만들기(SFR-109)와 팀 작성 중 정보(SFR-114)가 같이 쓴다.
// 두 곳의 규칙이 갈리면 작성 중에는 저장되던 값이 병원에 요청할 때 거절되는 일이 생긴다.
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
