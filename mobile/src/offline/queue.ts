/**
 * 통신 두절 중 기록 (SFR-099): 전화 확인 결과·거절·도착, 그리고 통신이 끊긴 채 만든 예비 추천 건(create_fallback).
 * 발생 시각과 함께 이 휴대폰에 쌓고, 복구되면 발생 순서대로 POST /transports/sync 로 올린 뒤 지운다.
 * 승인 병원 선택·이송 취소·목적지 변경은 쌓지 않는다 (서버가 충돌 규칙으로 정해야 해서, SFR-111 · 160).
 * 판정은 서버가 상태 전이표로 한다 (규칙 4). 앱은 결과를 받아 화면을 맞출 뿐.
 */
import { api } from '../api/client';
import { uuid } from '../transport/ids';
import type { LatLng } from '../transport/location';
import { db } from './db';

export type OfflineRecord = {
  clientRecordId: string;
  kind: 'create_fallback' | 'phone_check' | 'arrive';
  transportId: string;
  occurredAt: string;
  assessment?: unknown;
  radiusKm?: number;
  location?: LatLng;
  hospitalId?: number | null;
  result?: 'accepted' | 'no_answer' | 'skipped' | 'rejected' | 'dismissed';
  reason?: string;
  reasonText?: string;
  rejectReason?: string;
  method?: 'button' | 'menu';
};

export async function enqueue(
  r: Omit<OfflineRecord, 'clientRecordId' | 'occurredAt'>,
  at = Date.now(),
) {
  const rec: OfflineRecord = {
    ...r,
    clientRecordId: uuid(),
    occurredAt: new Date(at).toISOString(),
  };
  await (await db()).runAsync('INSERT INTO offline_queue (data) VALUES (?)', JSON.stringify(rec));
  return rec;
}

export async function pending(): Promise<{ seq: number; rec: OfflineRecord }[]> {
  const rows = await (
    await db()
  ).getAllAsync<{ seq: number; data: string }>('SELECT seq, data FROM offline_queue ORDER BY seq');
  return rows.map((r) => ({ seq: r.seq, rec: JSON.parse(r.data) as OfflineRecord }));
}

export type SyncResult<T> = { transport: T | null; alert: boolean; rejected: number } | null;

/**
 * 밀린 기록을 발생 순서대로 올린다. 서버가 받은 기록(applied·history_only·duplicate·rejected 모두)은 지운다.
 * 통신이 또 끊기면 그대로 두고 다음 복구 때 다시.
 */
export async function flush<T>(): Promise<SyncResult<T>> {
  const list = await pending();
  if (list.length === 0) return null;
  const r = await api<{
    results: { clientRecordId: string; outcome: string }[];
    transport: T | null;
    alert?: boolean;
  }>('POST', '/transports/sync', { body: { records: list.map((x) => x.rec) } });
  const done = new Set(r.results.map((x) => x.clientRecordId));
  const d = await db();
  for (const x of list)
    if (done.has(x.rec.clientRecordId))
      await d.runAsync('DELETE FROM offline_queue WHERE seq = ?', x.seq);
  return {
    transport: r.transport,
    alert: !!r.alert,
    rejected: r.results.filter((x) => x.outcome === 'rejected').length,
  };
}
