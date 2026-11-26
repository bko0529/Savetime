'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
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
  // 병원 이름으로 걸러 보기 (받아 둔 목록 안에서)
  const [search, setSearch] = useState('');
  const keyword = search.trim();
  const shown = keyword ? hospitals.filter((h) => (h.name ?? '').includes(keyword)) : hospitals;

  return (
    <section aria-labelledby="stats-title" className="panel">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="stats-title" className="section-title panel-title">
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
        <p className="well w-fit px-4 py-2.5 text-lg font-semibold">
          평균 요청 → 출발{' '}
          <strong className="tabular-nums">{durationText(stats.data.avgRequestToDepartSec)}</strong>
        </p>
      )}
      {stats.isSuccess && hospitals.length === 0 && (
        <p className="well px-5 py-6 text-center text-base text-muted-foreground">
          이 기간에 요청을 받은 병원이 없어요.
        </p>
      )}
      {hospitals.length > 0 && (
        <input
          type="search"
          aria-label="병원 이름 검색"
          placeholder="병원 이름 검색 (예: 천안)"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpenId(null);
          }}
          maxLength={40}
          className="field h-11 max-w-md rounded-xl text-base"
        />
      )}
      {hospitals.length > 0 && shown.length === 0 && (
        <p className="well px-5 py-6 text-center text-base text-muted-foreground">
          &lsquo;{keyword}&rsquo;에 맞는 병원이 없어요.
        </p>
      )}
      {shown.length > 0 && (
        // 병원이 많아도 화면이 길어지지 않게 상자 안에서 스크롤 (제목 줄은 위에 고정)
        <div className="panel-table max-h-[440px] overflow-y-auto">
          <table className="data-table data-table-flush">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="text-left">
                <th className="px-3 py-3.5">병원</th>
                <th className="px-3 py-3.5">요청</th>
                <th className="px-3 py-3.5">응답률</th>
                <th className="px-3 py-3.5">평균 응답</th>
                <th className="px-3 py-3.5">승인 취소율</th>
                <th className="px-3 py-3.5">요청→첫 승인</th>
                <th className="px-3 py-3.5">요청→출발</th>
                <th className="px-3 py-3.5">거절 사유</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((h) => {
                const open = openId === h.hospitalId;
                const toggle = () => setOpenId(open ? null : (h.hospitalId ?? null));
                return (
                  <Fragment key={h.hospitalId}>
                    {/* 줄을 누르면(또는 Enter) 그 병원 상세가 아래에 펼쳐진다 */}
                    <tr
                      className={cn(
                        'cursor-pointer hover:bg-surface',
                        h.rejectSpike && 'bg-urgent font-bold',
                        open && 'bg-surface',
                      )}
                      aria-label={h.name}
                      aria-expanded={open}
                      tabIndex={0}
                      onClick={toggle}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggle();
                        }
                      }}
                    >
                      <td className="px-3 py-4 font-extrabold">
                        {h.name}
                        {h.rejectSpike && (
                          <span className="ml-2 rounded-full bg-destructive px-2.5 py-0.5 text-xs font-bold text-white">
                            거절 급증
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-4 tabular-nums">{h.requests}</td>
                      {h.sampleTooSmall ? (
                        <td colSpan={5} className="px-3 py-4 text-muted-foreground">
                          표본 부족 (요청 10건 미만)
                        </td>
                      ) : (
                        <>
                          <td className="px-3 py-4 tabular-nums">{percent(h.responseRate)}</td>
                          <td className="px-3 py-4 tabular-nums">
                            {durationText(h.avgResponseSec)}
                          </td>
                          <td className="px-3 py-4 tabular-nums">
                            {percent(h.approvalCancelRate)}
                            {(h.unacceptableCount ?? 0) > 0 && (
                              <span className="ml-1 text-base text-muted-foreground">
                                (수용 불가 {h.unacceptableCount})
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-4 tabular-nums">
                            {durationText(h.avgRequestToFirstApprovalSec)}
                          </td>
                          <td className="px-3 py-4 tabular-nums">
                            {durationText(h.avgRequestToDepartSec)}
                          </td>
                        </>
                      )}
                      <td className="px-3 py-4 font-bold">
                        <span className="flex items-center justify-between gap-2">
                          {h.topRejectReason ? REASON_LABEL[h.topRejectReason] : '—'}
                          <ChevronDown
                            aria-hidden
                            className={cn('size-4 shrink-0 transition', open && 'rotate-180')}
                          />
                        </span>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b bg-muted">
                        <td colSpan={8} className="p-5">
                          <HospitalDetail stat={h} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// 병원 상세: 숫자를 이름과 함께 크게, 아래에 출처별 거절 사유
function HospitalDetail({ stat }: { stat: HospitalStat }) {
  const rows: [string, string][] = [
    ['받은 요청', `${stat.requests ?? 0}건`],
    ['응답률', percent(stat.responseRate)],
    ['평균 응답 시간', durationText(stat.avgResponseSec)],
    ['승인 취소율', percent(stat.approvalCancelRate)],
    ['수용 불가', `${stat.unacceptableCount ?? 0}건`],
    ['요청 → 첫 승인', durationText(stat.avgRequestToFirstApprovalSec)],
    ['요청 → 출발', durationText(stat.avgRequestToDepartSec)],
    ['가장 많은 거절 사유', stat.topRejectReason ? REASON_LABEL[stat.topRejectReason] : '—'],
  ];
  return (
    <div className="flex flex-col gap-4" aria-label={`${stat.name} 상세`}>
      <p className="text-lg font-extrabold">
        {stat.name} 상세
        {stat.sampleTooSmall && (
          <span className="ml-2 text-base font-normal text-muted-foreground">
            · 표본 부족 (요청 10건 미만이라 비율은 참고만)
          </span>
        )}
        {stat.rejectSpike && (
          <span className="ml-2 rounded-full bg-destructive px-2.5 py-0.5 text-xs font-bold text-white">
            거절 급증 (최근 7일이 30일보다 20%p 이상 높음)
          </span>
        )}
      </p>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label} className="well flex flex-col gap-1 px-4 py-3">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-lg font-bold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <RejectBreakdown stat={stat} />
    </div>
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
