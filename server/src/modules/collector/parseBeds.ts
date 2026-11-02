// 공공 데이터 병상 필드 → 우리 3종 병상 (부록 D, CR-007). 공공 데이터 필드명은 이 파일에만 둔다.
import { z } from 'zod';
import { lastByKey, optionalInt } from './fields.js';

// 일반 + 진료과별 중환자실 [가용, 전체]. 일반 값 없이 진료과별 값만 보내는 큰 병원이 있다.
// 신생아·소아·음압격리는 일반 환자를 받는 병상이 아니라서 뺀다.
const ICU_FIELDS = [
  ['hvicc', 'hvs17'], // 일반
  ['hv2', 'hvs06'], // 내과
  ['hv3', 'hvs07'], // 외과
  ['hv6', 'hvs12'], // 신경외과
  ['hv8', 'hvs13'], // 화상
  ['hv9', 'hvs14'], // 외상
  ['hv34', 'hvs15'], // 심장내과
  ['hvcc', 'hvs11'], // 신경과
  ['hvccc', 'hvs16'], // 흉부외과
] as const;

const itemSchema = z.object({
  hpid: z.string().min(1),
  hvec: optionalInt, // 응급실 가용
  hvs01: optionalInt, // 응급실 전체
  hvoc: optionalInt, // 수술실 가용
  hvs22: optionalInt, // 수술실 전체
  ...Object.fromEntries(ICU_FIELDS.flat().map((field) => [field, optionalInt])),
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
  excluded: boolean; // 가용이 전체보다 많음: 믿을 수 없어 추천에서 제외 (SFR-088)
}

// 음수는 공공 데이터에 정상으로 오는 값이다. 그 병상만 빈자리 0개로 본다 (CR-007).
function available(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(value, 0);
}

// 값이 하나도 없으면 0이 아니라 '정보 없음'으로 남긴다 (SFR-089).
function sum(values: (number | undefined)[]): number | undefined {
  const known = values.filter((value) => value !== undefined);
  return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0);
}

function isOverTotal(avail: number | undefined, total: number | undefined): boolean {
  return avail !== undefined && total !== undefined && avail > total;
}

// 공공 데이터 시각에는 시간대가 없다. 서버 시간대와 상관없이 한국 시간으로 고정해 해석한다.
function toIsoTime(value: string): string {
  const [, y, mo, d, h, mi, s] = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)!;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
}

// 병상 값이 깨진 것은 그 값만 비운다. 기관 ID나 기준 시각이 없으면 저장할 수 없어 그 병원만 빼고 알린다.
export function parseBeds(
  items: unknown[],
  onSkipped: (count: number) => void = () => {},
): BedRow[] {
  const rows: BedRow[] = [];
  for (const item of items) {
    const parsed = itemSchema.safeParse(item);
    if (!parsed.success) continue;
    const data = parsed.data as Record<string, number | undefined> & typeof parsed.data;
    const erAvail = available(data.hvec);
    const erTotal = data.hvs01;
    const orAvail = available(data.hvoc);
    const orTotal = data.hvs22;
    const icuPairs = ICU_FIELDS.map(
      ([avail, total]) => [available(data[avail]), data[total]] as const,
    );
    rows.push({
      publicId: data.hpid,
      erAvail,
      erTotal,
      icuAvail: sum(icuPairs.map(([avail]) => avail)),
      icuTotal: sum(icuPairs.map(([, total]) => total)),
      orAvail,
      orTotal,
      sourceTime: toIsoTime(data.hvidate),
      raw: item,
      // 중환자실은 진료과끼리 비교한다. 합계로 비교하면 전체 값이 빠진 진료과 때문에 잘못 제외된다.
      excluded:
        isOverTotal(erAvail, erTotal) ||
        isOverTotal(orAvail, orTotal) ||
        icuPairs.some(([avail, total]) => isOverTotal(avail, total)),
    });
  }
  const skipped = items.length - rows.length;
  if (skipped > 0) onSkipped(skipped);
  return lastByKey(rows, (row) => row.publicId);
}
