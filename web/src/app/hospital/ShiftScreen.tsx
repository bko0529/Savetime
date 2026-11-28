'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import type { HospitalSocket } from '@/lib/realtime/hospitalSocket';
import { Chip } from '@/components/hospital/Chip';
import { EndShiftButton } from '@/components/hospital/EndShiftButton';
import { IncomingList } from '@/components/hospital/IncomingList';
import { NewRequestToasts } from '@/components/hospital/NewRequestToasts';
import { PauseControl } from '@/components/hospital/PauseControl';
import { RequestDetail } from '@/components/hospital/RequestDetail';
import { RequestList } from '@/components/hospital/RequestList';
import { cn } from '@/lib/utils';
import { useHospitalRealtime } from './useHospitalRealtime';
import { useIncoming } from './useIncoming';
import { useNewRequests } from './useNewRequests';
import { usePcRevoked } from './usePcRevoked';

type ShiftBody = ApiPaths['/hw/shifts']['post']['requestBody']['content']['application/json'];
type Shift = { id?: number; staffName?: string; alarmOn?: boolean };

export const STAFF_NAME_MAX = 40;

const cardClass = 'rounded-[16px] border border-line bg-card';
const inputClass =
  'h-[56px] rounded-[10px] border-2 border-input px-4 text-xl outline-none focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/40';

// 근무 시작: 담당자 이름만 받는다 (SFR-117)
function StartShift() {
  const queryClient = useQueryClient();
  const [staffName, setStaffName] = useState('');
  const start = useMutation({
    mutationFn: (body: ShiftBody) =>
      apiFetch('/hw/shifts', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hw', 'session'] });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (staffName.trim() === '' || start.isPending) return;
    start.mutate({ staffName: staffName.trim() });
  }

  return (
    <form
      onSubmit={submit}
      className={cn(cardClass, 'mx-auto mt-12 flex w-full max-w-[560px] flex-col gap-6 p-8')}
      noValidate
    >
      <label className="flex flex-col gap-2">
        <span className="text-xl font-bold">담당자 이름</span>
        <input
          className={inputClass}
          value={staffName}
          onChange={(e) => setStaffName(e.target.value)}
          maxLength={STAFF_NAME_MAX}
          autoFocus
        />
      </label>
      {start.isError && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(start.error)}
        </p>
      )}
      <Button type="submit" size="lg" disabled={staffName.trim() === '' || start.isPending}>
        {start.isPending ? '시작 중…' : '근무 시작'}
      </Button>
    </form>
  );
}

export function ShiftScreen({
  shift,
  pause = { paused: false, pausedAt: null },
  brand,
  hospitalName,
  pcName,
  notice,
  createSocket,
}: {
  shift: Shift | null;
  // 탭 줄 오른쪽 '새 이송 요청 N건 · 병원 이름'과 위쪽 막대 오른쪽 '담당자 · PC 이름'
  hospitalName?: string;
  pcName?: string;
  // 상단 막대 왼쪽(병원·PC 이름)과 막대 바로 아래 안내
  brand?: ReactNode;
  notice?: ReactNode;
  // 병원 전체의 잠시 요청 중지 상태 (GET /hw/session, SFR-139)
  pause?: { paused: boolean; pausedAt: string | null };
  createSocket?: () => HospitalSocket;
}) {
  // 근무 중이면 연결되자마자 자동으로 요청을 받는다. '알림 켜기'를 누를 필요가 없다
  const { socket, connection } = useHospitalRealtime(createSocket, shift?.id ?? null);
  usePcRevoked(socket);
  // 근무 중일 때만 요청을 받는다
  const incoming = useNewRequests(shift ? socket : null);
  const arriving = useIncoming(shift ? socket : null);
  // 상세는 다른 주소로 옮기지 않고 같은 화면에 연다. 주소를 바꾸면 화면이 새로 그려지며
  // 실시간 연결이 끊겼다 다시 붙기 때문이다
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // 이 탭에서 연 요청. 아직 안 연 대기 요청 카드는 깜빡여서 새 요청이 한눈에 보이게 한다.
  // 화면 표시용이라 탭 메모리에만 둔다 (새로고침하면 대기 요청이 다시 깜빡임)
  const [seenIds, setSeenIds] = useState<ReadonlySet<number>>(new Set());
  const openRequest = (id: number) => {
    setSelectedId(id);
    setSeenIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };
  const newCount = incoming.waiting.filter((r) => !seenIds.has(r.id)).length;
  // 요청 / 도착 예정 탭. 탭도 화면 안에서만 바꾼다 (주소를 바꾸면 실시간 연결이 다시 붙음)
  const [tab, setTab] = useState<'requests' | 'incoming'>('requests');
  // 2분이 안 지난 대기 요청만 서버가 거절(요청 중지)로 바꾼다
  const waitingInTime = incoming.waiting.filter(
    (r) => Date.parse(r.respondUntil) > incoming.nowMs,
  ).length;

  return (
    <div className="flex flex-1 flex-col">
      {/* 연결이 끊기면 새 요청을 못 받으니 화면 맨 위에 크게, 내려도 보이게 고정한다 (SFR-122).
          다시 붙으면 목록을 새로 받아 놓친 요청을 불러온다 (useNewRequests) */}
      {connection === 'disconnected' && (
        <p
          role="alert"
          className="sticky top-0 z-40 bg-destructive px-8 py-[18px] text-[26px] font-extrabold text-white"
        >
          연결 끊김 — 새 요청을 받을 수 없어요
        </p>
      )}
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line bg-card px-[32px] py-[14px]">
        {brand}
        {/* 오른쪽은 작게: 담당자·PC, 연결 상태, 근무 종료 */}
        <div className="flex flex-wrap items-center gap-[8px]">
          {/* 근무 중이면 '담당자 · PC', 근무 전이면 '병원 · PC' (어느 병원·PC 인지 늘 보이게) */}
          <span className="mr-1 text-[16px] font-semibold">
            {[shift ? shift.staffName : hospitalName, pcName].filter(Boolean).join(' · ')}
          </span>
          {connection === 'connected' && (
            <Chip
              tone="success"
              className="border border-success-dot/40 bg-card py-0.5 text-[14px]"
            >
              <span aria-hidden className="size-2 rounded-full bg-success-dot" />
              실시간 연결됨
            </Chip>
          )}
          {connection === 'disconnected' && (
            <Chip tone="danger" className="border border-danger-line py-0.5 text-[14px]">
              <span aria-hidden className="size-2 rounded-full bg-destructive" />
              연결 끊김
            </Chip>
          )}
          {/* 근무 중일 때만 '근무 종료' */}
          {shift !== null && <EndShiftButton staffName={shift.staffName} />}
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-[20px] px-[32px] pt-[20px] pb-[48px]">
        {notice}

        {shift === null && <StartShift />}
        {shift !== null && (
          <>
            {/* 탭 줄: 요청 / 도착 예정 / 잠시 요청 중지, 오른쪽에 새 요청 알림 (시안) */}
            <div className="flex flex-wrap items-center gap-3">
              <div role="tablist" aria-label="화면 고르기" className="flex items-center gap-2">
                {(
                  [
                    ['requests', `요청 (${incoming.items.length})`],
                    ['incoming', `도착 예정 (${arriving.items.length})`],
                  ] as const
                ).map(([key, text]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    onClick={() => setTab(key)}
                    className={cn(
                      'h-[44px] rounded-[10px] px-5 text-[18px] font-bold transition-colors',
                      tab === key
                        ? 'bg-foreground text-background'
                        : 'border border-line bg-card text-foreground hover:bg-surface',
                    )}
                  >
                    {text}
                  </button>
                ))}
              </div>
              {!pause.paused && (
                <PauseControl
                  paused={false}
                  pausedAt={null}
                  waitingCount={waitingInTime}
                  socket={socket}
                  className="ml-0 h-[44px] text-[17px]"
                />
              )}
              {/* 아직 안 연 새 요청이 있을 때만, 깜빡이며 보여 준다. 다 열어 보면 사라진다
                  (응답 대기 건수는 왼쪽 목록 위, 탭 제목 🔴 은 응답 전까지 그대로) */}
              {newCount > 0 && (
                <p
                  role="status"
                  className="request-new-blink-text ml-auto flex items-center gap-2 text-[18px] font-extrabold text-destructive"
                >
                  <span
                    aria-hidden
                    className="size-[12px] shrink-0 rounded-full bg-destructive shadow-[0_0_0_5px_var(--danger-soft)]"
                  />
                  <span>새 이송 요청 {newCount}건</span>
                  {hospitalName && (
                    <span className="font-semibold text-muted-foreground">· {hospitalName}</span>
                  )}
                </p>
              )}
            </div>
            {/* 멈춘 상태는 모든 PC 에 크게 보여야 해서 탭 줄 아래 넓은 상자로 */}
            {pause.paused && (
              <PauseControl
                paused
                pausedAt={pause.pausedAt}
                waitingCount={waitingInTime}
                socket={socket}
              />
            )}

            {tab === 'requests' ? (
              // 왼쪽 요청 카드 목록, 오른쪽 상세. 좁으면 상세가 아래로 내려간다
              <div className="flex flex-wrap items-start gap-[24px]">
                <section
                  aria-label="응답 대기"
                  className="flex w-full flex-col gap-3 lg:w-[400px] lg:shrink-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-[18px] font-extrabold">
                      응답 대기 {incoming.waiting.length}건
                      <span className="font-semibold text-muted-foreground">
                        {' '}
                        · 남은 시간 짧은 순
                      </span>
                    </h2>
                    {newCount > 0 && (
                      <Chip tone="danger" className="border border-danger-line py-0.5 text-[14px]">
                        새 요청 {newCount}건
                      </Chip>
                    )}
                  </div>
                  <RequestList
                    items={incoming.items}
                    nowMs={incoming.nowMs}
                    selectedId={selectedId}
                    onOpen={openRequest}
                    seenIds={seenIds}
                  />
                </section>
                <div className="min-w-[min(100%,480px)] flex-1">
                  {selectedId !== null ? (
                    <RequestDetail
                      key={selectedId}
                      requestId={selectedId}
                      nowMs={incoming.nowMs}
                      onClose={() => setSelectedId(null)}
                    />
                  ) : (
                    <p className="rounded-[16px] border border-dashed border-line px-6 py-16 text-center text-[18px] text-muted-foreground">
                      왼쪽에서 요청을 누르면 환자 정보가 여기 보여요
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <section className={cn(cardClass, 'relative overflow-hidden')}>
                <h2 className="px-6 py-4 text-[24px] font-extrabold tracking-[-0.02em]">
                  도착 예정
                </h2>
                {arriving.isError && (
                  <p role="alert" className="px-6 pb-4 text-xl font-bold text-destructive">
                    {errorText(arriving.error)}
                  </p>
                )}
                <IncomingList
                  items={arriving.items}
                  notices={arriving.notices}
                  onDismiss={arriving.dismiss}
                />
              </section>
            )}
          </>
        )}
      </div>
      {/* 새 요청이 오면 오른쪽 위에 작게 떴다가 사라진다. 누르면 그 요청 상세가 열린다 */}
      {shift !== null && (
        <NewRequestToasts
          toasts={incoming.toasts}
          onOpen={(id) => {
            setTab('requests');
            openRequest(id);
          }}
          onClose={incoming.dismissToast}
        />
      )}
    </div>
  );
}
