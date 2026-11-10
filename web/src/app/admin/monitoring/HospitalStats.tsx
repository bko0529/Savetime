'use client';

import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Button } from '@/components/ui/button';
import { REJECT_REASONS } from '@/components/hospital/RejectReasonDialog';
import type { ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import type { components } from '@/lib/api/schema';
import { cn } from '@/lib/utils';
import { useAdminApi } from '../useAdminApi';

type Stats =
  ApiPaths['/admin/stats/hospitals']['get']['responses'][200]['content']['application/json'];
type HospitalStat = components['schemas']['HospitalStat'];
type Days = 7 | 30;

// 거절 사유 이름 (병원 웹 거절 창과 같은 말) + 요청 중지 자동 거절
const REASON_LABEL: Record<string, string> = {
  ...Object.fromEntries(REJECT_REASONS.map((r) => [r.value, r.label])),
  paused: '요청 중지',
};
const SOURCE_LABEL: { key: keyof NonNullable<HospitalStat['rejectBySource']>; label: string }[] = [
  { key: 'hospitalWeb', label: '병원 웹 직접' },
  { key: 'paused', label: '요청 중지' },
  { key: 'phoneCheck', label: '전화 확인' },
  { key: 'approvalCancelled', label: '승인 취소' },
  { key: 'unacceptable', label: '수용 불가' },
];

const percent = (v?: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
// '1분 10초' · '45초'
export function durationText(sec?: number | null): string {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}분${s ? ` ${s}초` : ''}` : `${s}초`;
}

// 병원 응답 통계 (SFR-106, A-02). 최근 7일·30일을 골라 병원별로 본다.
// 요청 10건 미만은 '표본 부족', 7일 거절률이 30일보다 20%p 이상 높으면 강조 (판단은 서버)
export function HospitalStats() {
  const api = useAdminApi();
  const [days, setDays] = useState<Days>(7);
  const [openId, setOpenId] = useState<number | null>(null);

  const stats = useQuery({
    queryKey: ['admin', 'stats', days],
    queryFn: () => api<Stats>(`/admin/stats/hospitals?days=${days}`),
  });
  const hospitals = stats.data?.hospitals ?? [];

  return (
    <section aria-labelledby="stats-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="stats-title" className="text-2xl font-bold">
          병원 응답 통계
        </h2>
        <div role="group" aria-label="기간" className="flex gap-2">
          {([7, 30] as Days[]).map((d) => (
            <Button
              key={d}
              variant={days === d ? 'default' : 'outline'}
              aria-pressed={days === d}
              onClick={() => {
                setDays(d);
                setOpenId(null);
              }}
            >
              최근 {d}일
            </Button>
          ))}
        </div>
      </div>

      {stats.isError && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(stats.error)}
        </p>
      )}
      {stats.isSuccess && (
        <p className="text-xl">
          평균 요청 → 출발{' '}
          <strong className="tabular-nums">{durationText(stats.data.avgRequestToDepartSec)}</strong>
        </p>
      )}
      {stats.isSuccess && hospitals.length === 0 && (
        <p className="text-lg text-muted-foreground">이 기간에 요청을 받은 병원이 없어요.</p>
      )}
      {hospitals.length > 0 && (
        <table className="w-full border-collapse text-lg">
          <thead>
            <tr className="border-b-2 border-foreground text-left">
              <th className="p-3">병원</th>
              <th className="p-3">요청</th>
              <th className="p-3">응답률</th>
              <th className="p-3">평균 응답</th>
              <th className="p-3">승인 취소율</th>
              <th className="p-3">요청→첫 승인</th>
              <th className="p-3">요청→출발</th>
              <th className="p-3">거절 사유</th>
            </tr>
          </thead>
          <tbody>
            {hospitals.map((h) => {
              const open = openId === h.hospitalId;
              return (
                <Fragment key={h.hospitalId}>
                  <tr
                    className={cn('border-b', h.rejectSpike && 'bg-destructive/10 font-bold')}
                    aria-label={h.name}
                  >
                    <td className="p-3 font-bold">
                      {h.name}
                      {h.rejectSpike && (
                        <span className="ml-2 rounded bg-destructive px-2 py-0.5 text-base text-white">
                          거절 급증
                        </span>
                      )}
                    </td>
                    <td className="p-3 tabular-nums">{h.requests}</td>
                    {h.sampleTooSmall ? (
                      <td colSpan={5} className="p-3 text-muted-foreground">
                        표본 부족 (요청 10건 미만)
                      </td>
                    ) : (
                      <>
                        <td className="p-3 tabular-nums">{percent(h.responseRate)}</td>
                        <td className="p-3 tabular-nums">{durationText(h.avgResponseSec)}</td>
                        <td className="p-3 tabular-nums">
                          {percent(h.approvalCancelRate)}
                          {(h.unacceptableCount ?? 0) > 0 && (
                            <span className="ml-1 text-base text-muted-foreground">
                              (수용 불가 {h.unacceptableCount})
                            </span>
                          )}
                        </td>
                        <td className="p-3 tabular-nums">
                          {durationText(h.avgRequestToFirstApprovalSec)}
                        </td>
                        <td className="p-3 tabular-nums">
                          {durationText(h.avgRequestToDepartSec)}
                        </td>
                      </>
                    )}
                    <td className="p-3">
                      <Button
                        variant="link"
                        className="h-auto p-0 text-lg"
                        aria-expanded={open}
                        aria-label={`${h.name} 거절 사유 ${open ? '접기' : '보기'}`}
                        onClick={() => setOpenId(open ? null : (h.hospitalId ?? null))}
                      >
                        {h.topRejectReason ? REASON_LABEL[h.topRejectReason] : '—'}
                      </Button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b bg-muted">
                      <td colSpan={8} className="p-4">
                        <RejectBreakdown stat={h} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// 거절 사유별 건수, 출처별로 (기본 수치는 병원 웹 직접, 나머지는 따로)
function RejectBreakdown({ stat }: { stat: HospitalStat }) {
  return (
    <dl aria-label={`${stat.name} 출처별 거절 사유`} className="grid gap-2 sm:grid-cols-2">
      {SOURCE_LABEL.map(({ key, label }) => {
        const counts = Object.entries(stat.rejectBySource?.[key] ?? {});
        const total = counts.reduce((s, [, n]) => s + n, 0);
        return (
          <div key={key} className="flex flex-col">
            <dt className="font-bold">
              {label} {total}건
            </dt>
            <dd className="text-base">
              {counts.length === 0
                ? '—'
                : counts.map(([reason, n]) => `${REASON_LABEL[reason] ?? reason} ${n}`).join(' · ')}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
