'use client';

import { useQuery } from '@tanstack/react-query';
import { Maximize2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { cn } from '@/lib/utils';
import { ExpandableBox } from '../ExpandableBox';
import { useAdminApi } from '../useAdminApi';
import {
  durationText,
  HospitalDetailDialog,
  percent,
  periodText,
  REASON_LABEL,
  type Days,
} from './HospitalDetailDialog';

export { durationText };

type Stats =
  ApiPaths['/admin/stats/hospitals']['get']['responses'][200]['content']['application/json'];

const PERIODS: Days[] = [7, 30, 0];

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
  // 상세 창을 열었을 때만 '평소와 비교'에 필요한 7일·30일 통계를 받는다 (지금 기간과 같으면 다시 받지 않음)
  const week = useQuery({
    queryKey: ['admin', 'stats', 7],
    queryFn: () => api<Stats>('/admin/stats/hospitals?days=7'),
    enabled: openId !== null && days !== 7,
  });
  const month = useQuery({
    queryKey: ['admin', 'stats', 30],
    queryFn: () => api<Stats>('/admin/stats/hospitals?days=30'),
    enabled: openId !== null && days !== 30,
  });
  const weekData = days === 7 ? stats.data : week.data;
  const monthData = days === 30 ? stats.data : month.data;
  const opened = hospitals.find((h) => h.hospitalId === openId) ?? null;
  // 창 안에서 기간을 바꿔 그 기간에 기록이 없어도 창 제목(병원 이름)은 남긴다
  const [openedName, setOpenedName] = useState('');
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
          {PERIODS.map((d) => (
            <Button
              key={d}
              variant={days === d ? 'default' : 'outline'}
              aria-pressed={days === d}
              onClick={() => {
                setDays(d);
                setOpenId(null);
              }}
            >
              {d === 0 ? '전체' : `최근 ${d}일`}
            </Button>
          ))}
        </div>
      </div>

      {stats.isError && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(stats.error)}
        </p>
      )}
      {stats.isSuccess && hospitals.length === 0 && (
        <p className="well px-5 py-6 text-center text-base text-muted-foreground">
          {`${periodText(days)} 동안 요청을 받은 병원이 없어요.`}
        </p>
      )}
      {hospitals.length > 0 && (
        <input
          type="search"
          aria-label="병원 이름 검색"
          placeholder="병원 이름 검색 (예: 천안)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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
        // 화면에는 낮은 상자(스크롤), '병원 더 보기'를 누르면 큰 창에 전체 표
        <ExpandableBox
          title="병원 응답 통계"
          label="병원 더 보기"
          showMore={shown.length > 3}
          boxClassName="panel-table max-h-[300px]"
        >
          {(expanded) => (
            <table className="data-table data-table-flush overflow-visible">
              <thead
                className={
                  expanded ? 'sticky -top-8 z-10 bg-surface' : 'sticky top-0 z-10 bg-surface'
                }
              >
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
                  const open = () => {
                    setOpenId(h.hospitalId ?? null);
                    setOpenedName(h.name ?? '');
                  };
                  return (
                    // 줄을 누르면(또는 Enter) 그 병원 상세 통계가 큰 창으로 열린다
                    <tr
                      key={h.hospitalId}
                      className={cn(
                        'cursor-pointer hover:bg-surface',
                        h.rejectSpike && 'bg-urgent font-bold',
                      )}
                      aria-label={h.name}
                      aria-haspopup="dialog"
                      tabIndex={0}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          open();
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
                          <Maximize2
                            aria-hidden
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </ExpandableBox>
      )}
      <HospitalDetailDialog
        open={openId !== null}
        name={openedName}
        stat={opened}
        onChangeDays={setDays}
        all={hospitals}
        week={weekData?.hospitals?.find((x) => x.hospitalId === openId)}
        month={monthData?.hospitals?.find((x) => x.hospitalId === openId)}
        days={days}
        loadingBaseline={(days !== 7 && week.isPending) || (days !== 30 && month.isPending)}
        onClose={() => setOpenId(null)}
      />
    </section>
  );
}
