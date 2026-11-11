// 이상 PC 등록 감지 (SFR-148). 병원 PC 등록이 수상하면 관리자 알림(SFR-100)에 '이상 PC 등록'을 남긴다. 등록은 막지 않는다.
// ① 새벽 0~6시(한국 시간) 등록  ② 같은 병원에서 1시간 안에 2대 이상 등록
// ③ 병원 소재지와 다른 시·도의 IP 는 이번 범위에서 뺐다 (기술정의서 5장 '이상 PC 등록 감지', v0.11.1).
//    국내 IP 는 통신사가 지역과 상관없이 나눠 줘서 시·도 판정이 자주 틀리고, 오탐 알림이 ①② 알림까지 묻히게 한다
// 판단은 PC 행의 등록 시각(DB now() 로 찍힘)으로 한다 (규칙 6). 관리자 알림 문구도 같은 기준으로 만든다 (notifications.ts)
import type pg from 'pg';
import { notifyAdmin } from '../admin/notifications.js';
import { BURST_COUNT, BURST_WINDOW, NIGHT_END_HOUR } from './oddPcRules.js';

export type OddPcReason = 'night' | 'burst';

// 방금 등록한 PC 가 수상한지 보고, 수상하면 관리자 알림을 남긴다. PC 등록과 같은 트랜잭션에서 부른다
export async function detectOddPc(
  client: pg.PoolClient,
  pcId: number | string,
): Promise<OddPcReason[]> {
  const { rows } = await client.query<{ hospital_id: string; night: boolean; burst: boolean }>(
    `SELECT pc.hospital_id,
            extract(hour FROM pc.registered_at AT TIME ZONE 'Asia/Seoul') < $2 AS night,
            (SELECT count(*) FROM hospital_pc o
              WHERE o.hospital_id = pc.hospital_id
                AND o.registered_at > pc.registered_at - $3::interval
                AND o.registered_at <= pc.registered_at) >= $4 AS burst
       FROM hospital_pc pc WHERE pc.id = $1`,
    [pcId, NIGHT_END_HOUR, BURST_WINDOW, BURST_COUNT],
  );
  const row = rows[0];
  if (!row) return [];
  const reasons: OddPcReason[] = [];
  if (row.night) reasons.push('night');
  if (row.burst) reasons.push('burst');
  // 병원마다 따로 쌓고, 30분 안에 또 생기면 횟수만 는다 (notifyAdmin)
  if (reasons.length > 0) await notifyAdmin(client, 'odd_pc', row.hospital_id);
  return reasons;
}
