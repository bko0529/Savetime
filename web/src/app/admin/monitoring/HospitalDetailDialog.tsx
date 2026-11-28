'use client';

import { REJECT_REASONS } from '@/components/hospital/RejectReasonDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { components } from '@/lib/api/schema';
import { cn } from '@/lib/utils';
import {
  comparableCount,
  diffOf,
  METRICS,
  valueText,
  weightedAverage,
  type MetricKey,
} from './compareStats';

type HospitalStat = components['schemas']['HospitalStat'];
export type Days = 0 | 7 | 30;

export const periodText = (d: Days) => (d === 0 ? '전체 기간' : `최근 ${d}일`);

// 거절 사유 이름 (병원 웹 거절 창과 같은 말) + 요청 중지 자동 거절
export const REASON_LABEL: Record<string, string> = {
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

export const percent = (v?: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
// '1분 10초' · '45초'
export function durationText(sec?: number | null): string {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}분${s ? ` ${s}초` : ''}` : `${s}초`;
}

const TONE: Record<string, string> = {
  good: 'bg-success-soft text-success-strong',
  bad: 'bg-danger-soft text-destructive',
  same: 'bg-surface text-muted-foreground',
};

type Bar = { label: string; value: number | null | undefined; main?: boolean };

// 막대 그래프 한 줄 묶음 (라이브러리 없이 HTML 막대). 비율은 0~100%, 시간은 가장 긴 값 기준
function Bars({
  metric,
  bars,
  wide = false,
}: {
  metric: (typeof METRICS)[number];
  bars: Bar[];
  // 병원 이름처럼 긴 이름표면 이름 칸을 넓게
  wide?: boolean;
}) {
  const values = bars.map((b) => b.value ?? 0);
  const max = metric.kind === 'rate' ? 1 : Math.max(...values, 1) * 1.1;
  return (
    <div className="flex flex-col gap-1.5">
      {bars.map((b) => (
        <div
          key={b.label}
          className={cn(
            'grid items-center gap-2 text-sm',
            wide ? 'grid-cols-[150px_1fr_64px]' : 'grid-cols-[88px_1fr_64px]',
          )}
        >
          <span className={cn('truncate', b.main ? 'font-bold' : 'text-muted-foreground')}>
            {b.label}
          </span>
          <span className="h-3.5 overflow-hidden rounded-full bg-border/50">
            <span
              className={cn(
                'block h-full rounded-full',
                b.main ? 'bg-foreground' : 'bg-muted-foreground/45',
              )}
              style={{ width: `${b.value == null ? 0 : Math.min(100, (b.value / max) * 100)}%` }}
            />
          </span>
          <span className={cn('text-right tabular-nums', b.main && 'font-bold')}>
            {valueText(metric, b.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

// 비교 카드: 지표마다 막대 2개(이 병원 · 비교 대상)와 차이 칩
function CompareChart({
  title,
  note,
  mineLabel,
  otherLabel,
  mine,
  other,
}: {
  title: string;
  note: string;
  mineLabel: string;
  otherLabel: string;
  mine: (key: MetricKey) => number | null | undefined;
  other: (key: MetricKey) => number | null | undefined;
}) {
  return (
    <section aria-label={title} className="well flex flex-col gap-3 px-5 py-4">
      <div>
        <h3 className="text-lg font-extrabold">{title}</h3>
        <p className="text-sm text-muted-foreground">{note}</p>
      </div>
      {METRICS.map((m) => {
        const d = diffOf(m, mine(m.key), other(m.key));
        return (
          <div key={m.key} className="flex flex-col gap-1.5 border-t border-border/60 pt-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[15px] font-bold">
                {m.label}
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  ({m.better === 'high' ? '높을수록 좋음' : '낮을수록 좋음'})
                </span>
              </span>
              <span
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-sm font-bold tabular-nums',
                  d ? TONE[d.tone] : TONE.same,
                )}
              >
                {d?.text ?? '비교 불가'}
              </span>
            </div>
            <Bars
              metric={m}
              bars={[
                { label: mineLabel, value: mine(m.key), main: true },
                { label: otherLabel, value: other(m.key) },
              ]}
            />
          </div>
        );
      })}
    </section>
  );
}

// 전체 병원 중 이 병원 위치: 응답률·평균 응답 시간을 병원마다 막대로, 이 병원만 진하게
function Ranking({ mine, all }: { mine: HospitalStat; all: HospitalStat[] }) {
  const list = all.filter((h) => !h.sampleTooSmall);
  if (list.length < 2) return null;
  return (
    <section aria-label="전체 병원 중 위치" className="well flex flex-col gap-3 px-5 py-4">
      <h3 className="text-lg font-extrabold">전체 병원 중 위치</h3>
      <div className="grid gap-5 lg:grid-cols-2">
        {(['responseRate', 'avgResponseSec'] as MetricKey[]).map((key) => {
          const metric = METRICS.find((m) => m.key === key)!;
          // 좋은 순서로 (응답률은 높은 순, 시간은 짧은 순)
          const sorted = [...list].sort((a, b) => {
            const av = a[key] ?? (metric.better === 'high' ? -1 : Infinity);
            const bv = b[key] ?? (metric.better === 'high' ? -1 : Infinity);
            return metric.better === 'high' ? bv - av : av - bv;
          });
          const rank = sorted.findIndex((h) => h.hospitalId === mine.hospitalId) + 1;
          return (
            <div key={key} className="flex flex-col gap-2">
              <p className="text-[15px] font-bold">
                {metric.label}
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {rank > 0 ? `${sorted.length}곳 중 ${rank}위` : ''}
                </span>
              </p>
              <Bars
                metric={metric}
                wide
                bars={sorted.map((h) => ({
                  label: h.name ?? '',
                  value: h[key],
                  main: h.hospitalId === mine.hospitalId,
                }))}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

// 거절 사유: 사유별 막대(모든 출처 합) + 출처별 내역
function RejectChart({ stat }: { stat: HospitalStat }) {
  const totals = new Map<string, number>();
  for (const { key } of SOURCE_LABEL) {
    for (const [reason, n] of Object.entries(stat.rejectBySource?.[key] ?? {})) {
      totals.set(reason, (totals.get(reason) ?? 0) + n);
    }
  }
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(...rows.map(([, n]) => n), 1);
  return (
    <section aria-label="거절 사유" className="well flex flex-col gap-3 px-5 py-4">
      <h3 className="text-lg font-extrabold">거절 사유</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">이 기간에 거절이 없어요.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map(([reason, n]) => (
            <div
              key={reason}
              className="grid grid-cols-[150px_1fr_48px] items-center gap-2 text-sm"
            >
              <span className="truncate">{REASON_LABEL[reason] ?? reason}</span>
              <span className="h-3.5 overflow-hidden rounded-full bg-border/50">
                <span
                  className="block h-full rounded-full bg-destructive/70"
                  style={{ width: `${(n / max) * 100}%` }}
                />
              </span>
              <span className="text-right font-bold tabular-nums">{n}건</span>
            </div>
          ))}
        </div>
      )}
      <dl aria-label={`${stat.name} 출처별 거절 사유`} className="grid gap-2 pt-1 sm:grid-cols-2">
        {SOURCE_LABEL.map(({ key, label }) => {
          const counts = Object.entries(stat.rejectBySource?.[key] ?? {});
          const total = counts.reduce((s, [, n]) => s + n, 0);
          return (
            <div key={key} className="flex flex-col text-sm">
              <dt className="font-bold">
                {label} {total}건
              </dt>
              <dd className="text-muted-foreground">
                {counts.length === 0
                  ? '—'
                  : counts
                      .map(([reason, n]) => `${REASON_LABEL[reason] ?? reason} ${n}`)
                      .join(' · ')}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

// 병원 상세 큰 창 (SFR-106): 핵심 숫자 + 평소·전체 평균 비교 그래프 + 전체 중 위치 + 거절 사유
export function HospitalDetailDialog({
  open,
  name,
  onChangeDays,
  stat,
  all,
  week,
  month,
  days,
  loadingBaseline,
  onClose,
}: {
  open: boolean;
  name: string;
  // 창 안의 기간 버튼 (바꾸면 표와 창이 함께 그 기간으로)
  onChangeDays: (d: Days) => void;
  stat: HospitalStat | null;
  all: HospitalStat[];
  week: HospitalStat | undefined;
  month: HospitalStat | undefined;
  days: Days;
  loadingBaseline: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <DialogTitle className="text-2xl font-extrabold">{name} 상세 통계</DialogTitle>
        {stat?.sampleTooSmall && (
          <span className="text-sm text-muted-foreground">
            · 표본 부족 (요청 10건 미만이라 비율은 참고만)
          </span>
        )}
        {stat?.rejectSpike && (
          <span className="rounded-full bg-destructive px-2.5 py-0.5 text-xs font-bold text-white">
            거절 급증 (최근 7일이 30일보다 20%p 이상 높음)
          </span>
        )}
      </div>
      {/* 창 안에서도 기간을 바꾼다 */}
      <div role="group" aria-label="상세 기간" className="mr-8 flex gap-1.5">
        {([7, 30, 0] as Days[]).map((d) => (
          <Button
            key={d}
            size="sm"
            variant={days === d ? 'default' : 'outline'}
            aria-pressed={days === d}
            onClick={() => onChangeDays(d)}
          >
            {d === 0 ? '전체' : `최근 ${d}일`}
          </Button>
        ))}
      </div>
    </div>
  );
  if (!stat) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="gap-5 p-6 sm:max-w-6xl">
          {header}
          <DialogDescription className="text-base">
            {periodText(days)} 동안 이 병원이 받은 요청이 없어요. 다른 기간을 골라 보세요.
          </DialogDescription>
        </DialogContent>
      </Dialog>
    );
  }
  const tiles: [string, string][] = [
    ['받은 요청', `${stat.requests ?? 0}건`],
    ['응답률', percent(stat.responseRate)],
    ['평균 응답 시간', durationText(stat.avgResponseSec)],
    ['승인 취소율', percent(stat.approvalCancelRate)],
    ['수용 불가', `${stat.unacceptableCount ?? 0}건`],
    ['요청 → 첫 승인', durationText(stat.avgRequestToFirstApprovalSec)],
    ['요청 → 출발', durationText(stat.avgRequestToDepartSec)],
    ['가장 많은 거절 사유', stat.topRejectReason ? REASON_LABEL[stat.topRejectReason] : '—'],
  ];
  const others = comparableCount(all);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto p-6 sm:max-w-6xl">
        {header}
        <DialogDescription className="sr-only">
          병원 응답 통계와 평소·전체 평균 비교
        </DialogDescription>

        <dl aria-label={`${stat.name} 상세`} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {tiles.map(([label, value]) => (
            <div key={label} className="well flex flex-col gap-0.5 px-4 py-3">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-xl font-extrabold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="grid gap-4 lg:grid-cols-2" aria-label={`${stat.name} 비교`}>
          {loadingBaseline ? (
            <p className="well px-5 py-4 text-sm text-muted-foreground">평소 통계를 불러오는 중…</p>
          ) : week && month ? (
            <CompareChart
              title="이 병원 평소와 비교"
              note="최근 7일을 이 병원의 평소(최근 30일)와 비교해요"
              mineLabel="최근 7일"
              otherLabel="평소(30일)"
              mine={(k) => week[k]}
              other={(k) => month[k]}
            />
          ) : (
            <p className="well px-5 py-4 text-sm text-muted-foreground">
              평소와 비교할 기간의 기록이 없어요.
            </p>
          )}
          {others >= 2 ? (
            <CompareChart
              title="전체 병원 평균과 비교"
              note={`${periodText(days)}, 요청 10건 이상인 병원 ${others}곳의 평균 (요청 수로 가중)`}
              mineLabel="이 병원"
              otherLabel="전체 평균"
              mine={(k) => stat[k]}
              other={(k) => weightedAverage(all, k)}
            />
          ) : (
            <p className="well px-5 py-4 text-sm text-muted-foreground">
              전체 평균과 비교하려면 요청 10건 이상인 병원이 2곳 이상 있어야 해요. 지금은 {others}
              곳이에요.
            </p>
          )}
        </div>

        <Ranking mine={stat} all={all} />
        <RejectChart stat={stat} />
      </DialogContent>
    </Dialog>
  );
}
