// 공공 데이터 병상 필드 → 우리 3종 병상 (부록 D). 공공 데이터 필드명은 이 파일에만 둔다.
import { z } from 'zod';

const count = z.coerce.number().int().optional();

const itemSchema = z.object({
  hpid: z.string().min(1),
  hvec: count, // 응급실 가용
  hvs01: count, // 응급실 전체
  hvicc: count, // 중환자실(일반) 가용
  hvs17: count, // 중환자실(일반) 전체
  hvoc: count, // 수술실 가용
  hvs22: count, // 수술실 전체
  hvidate: z.coerce.string().regex(/^\d{14}$/), // 기준 시각, 한국 시간
});

export interface BedRow {
  publicId: string;
  erAvail?: number;
  erTotal?: number;
  icuAvail?: number;
  icuTotal?: number;
  orAvail?: number;
  orTotal?: number;
  sourceTime: string;
  raw: unknown;
}

// 공공 데이터 시각에는 시간대가 없다. 서버 시간대와 상관없이 한국 시간으로 고정해 해석한다.
function toIsoTime(value: string): string {
  const [, y, mo, d, h, mi, s] = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)!;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
}

// 형식이 깨진 병원 한 곳 때문에 시·도 전체를 버리지 않도록 그 병원만 뺀다.
export function parseBeds(items: unknown[]): BedRow[] {
  const rows: BedRow[] = [];
  for (const item of items) {
    const parsed = itemSchema.safeParse(item);
    if (!parsed.success) continue;
    const { data } = parsed;
    rows.push({
      publicId: data.hpid,
      erAvail: data.hvec,
      erTotal: data.hvs01,
      icuAvail: data.hvicc,
      icuTotal: data.hvs17,
      orAvail: data.hvoc,
      orTotal: data.hvs22,
      sourceTime: toIsoTime(data.hvidate),
      raw: item,
    });
  }
  return rows;
}
