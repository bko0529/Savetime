'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import type { HospitalSocket } from '@/lib/realtime/hospitalSocket';
import { Chip } from '@/components/hospital/Chip';
import { EndShiftButton } from '@/components/hospital/EndShiftButton';
import { NewRequestOverlay } from '@/components/hospital/NewRequestOverlay';
import { IncomingList } from '@/components/hospital/IncomingList';
import { PauseControl } from '@/components/hospital/PauseControl';
import { EmptyRequestDetail, RequestDetail } from '@/components/hospital/RequestDetail';
import { RequestList } from '@/components/hospital/RequestList';
import { cn } from '@/lib/utils';
import { useHospitalAlarm, type AlarmState } from './useHospitalAlarm';
import { useIncoming } from './useIncoming';
import { useNewRequests } from './useNewRequests';
import { usePcRevoked } from './usePcRevoked';

type ShiftBody = ApiPaths['/hw/shifts']['post']['requestBody']['content']['application/json'];
type Shift = { id?: number; staffName?: string; alarmOn?: boolean };

export const STAFF_NAME_MAX = 40;

const cardClass = 'rounded-[16px] border border-line bg-card';
const tabClass = (on: boolean) =>
  cn(
    'h-[44px] rounded-full px-5 text-[17px] font-semibold transition',
    on ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-surface',
  );
const inputClass =
  'h-[56px] rounded-[10px] border-2 border-input px-4 text-xl outline-none focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/40';

// 근무 시작: 담당자 이름만 받는다 (SFR-117)
function StartShift({ onStarted }: { onStarted: () => void }) {
  const queryClient = useQueryClient();
  const [staffName, setStaffName] = useState('');
  const start = useMutation({
    mutationFn: (body: ShiftBody) =>
      apiFetch('/hw/shifts', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      onStarted();
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

// 알림이 꺼져 있을 때 왜 꺼졌는지에 맞춰 안내한다
function offMessage(alarm: AlarmState, startedHere: boolean): string {
  if (alarm.kind === 'turned_off' && alarm.reason === 'no_ack') {
    return '새 요청에 이 PC가 응답하지 않아 알림이 꺼졌어요. 다시 켜 주세요.';
  }
  if (alarm.kind === 'turned_off' && alarm.reason === 'resume_failed') {
    return '연결은 다시 됐지만 알림을 복구하지 못했어요. 알림 켜기를 다시 누르세요.';
  }
  // 새로고침하거나 다시 열면 브라우저가 소리를 막으므로 사람이 다시 눌러야 한다 (SFR-117)
  return startedHere ? '알림 켜기를 눌러야 새 요청을 받아요.' : '알림 켜기를 다시 누르세요.';
}

export function ShiftScreen({
  shift,
  pause = { paused: false, pausedAt: null },
  brand,
  notice,
  hospitalName,
  createSocket,
}: {
  shift: Shift | null;
  // 상단 막대 왼쪽(병원·PC 이름)과 막대 바로 아래 안내
  brand?: ReactNode;
  notice?: ReactNode;
  // 탭 줄 오른쪽 '새 이송 요청 n건 · 병원 이름'
  hospitalName?: string;
  // 병원 전체의 잠시 요청 중지 상태 (GET /hw/session, SFR-139)
  pause?: { paused: boolean; pausedAt: string | null };
  createSocket?: () => HospitalSocket;
}) {
  const { socket, connection, alarm, turnOn } = useHospitalAlarm(createSocket);
  usePcRevoked(socket);
  // 근무 중일 때만 요청을 받는다
  const incoming = useNewRequests(shift ? socket : null);
  const arriving = useIncoming(shift ? socket : null);
  const [startedHere, setStartedHere] = useState(false);
  // 상세는 다른 주소로 옮기지 않고 같은 화면에 연다. 주소를 바꾸면 화면이 새로 그려지며
  // 실시간 연결·알림 켜짐(탭 메모리에만 있음)이 끊기기 때문이다
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tab, setTab] = useState<'requests' | 'incoming'>('requests');
  // 고른 요청이 없으면 맨 위 요청을 오른쪽에 보여 준다. 요청이 하나도 없으면 빈 칸.
  // 고른 요청이 끝나 목록에서 빠져도 그대로 둬서 '이미 끝난 요청' 안내가 보이게 한다
  const shownId = selectedId ?? incoming.items[0]?.id ?? null;
  // 2분이 안 지나 아직 응답할 수 있는 요청
  const openWaiting = incoming.waiting.filter(
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
        <div className="flex flex-wrap items-center gap-[10px]">
          {shift !== null && alarm.kind === 'on' && (
            <Chip tone="success" className="px-4 py-2 text-[18px]">
              <span aria-hidden className="size-[10px] rounded-full bg-success-dot" />
              <span>🔔 알림 켜짐 · {shift.staffName} 님 근무 중</span>
            </Chip>
          )}
          {/* 알림이 꺼져 있으면 오른쪽 위에 작게: 이유 + '알림 켜기' (시안 2026-11-24) */}
          {shift !== null && alarm.kind !== 'on' && (
            <div className="flex items-center gap-2 rounded-full border border-danger-line bg-danger-soft py-1 pr-1 pl-3">
              <span aria-hidden>🔕</span>
              <p className="text-[14px] font-bold text-danger-strong">
                {offMessage(alarm, startedHere)}
              </p>
              <Button
                size="sm"
                className="h-8 rounded-full px-4 text-[14px]"
                onClick={() => turnOn.mutate()}
                disabled={turnOn.isPending || connection !== 'connected'}
              >
                {turnOn.isPending ? '켜는 중…' : '알림 켜기'}
              </Button>
            </div>
          )}
          {connection === 'connected' && (
            <Chip tone="success" className="border border-success-dot/40 bg-card">
              <span aria-hidden className="size-2 rounded-full bg-success-dot" />
              실시간 연결됨
            </Chip>
          )}
          {connection === 'disconnected' && (
            <Chip tone="danger" className="border border-danger-line">
              <span aria-hidden className="size-2 rounded-full bg-destructive" />
              연결 끊김
            </Chip>
          )}
          {shift !== null && (
            <EndShiftButton
              // 2분이 안 지나 아직 응답할 수 있는 요청만 센다
              waitingCount={openWaiting}
            />
          )}
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-[24px] px-[32px] pt-[24px] pb-[48px]">
        {notice}
        {turnOn.isError && (
          <p role="alert" className="text-right text-[15px] font-bold text-destructive">
            {errorText(turnOn.error)}
          </p>
        )}
        {/* 브라우저 알림 권한 안내(노란 띠)는 띄우지 않는다 (강욱 결정 2026-11-24). 권한이 없어도
            새 요청은 화면 덮개·알림음 반복·탭 제목으로 알린다 */}
        <NewRequestOverlay
          request={incoming.overlay}
          pendingCount={incoming.waiting.length}
          nowMs={incoming.nowMs}
          onConfirm={(id) => {
            // '확인'을 누르면 덮개를 닫고 그 요청의 상세를 바로 연다
            incoming.confirm(id);
            setSelectedId(id);
          }}
        />

        {shift === null && <StartShift onStarted={() => setStartedHere(true)} />}

        {shift !== null && (
          <>
            {/* 탭: 요청 · 도착 예정 · 잠시 요청 중지 (시안 2026-11-24). 오른쪽에 새 요청 수 */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div role="tablist" className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'requests'}
                  onClick={() => setTab('requests')}
                  className={tabClass(tab === 'requests')}
                >
                  요청 ({incoming.items.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'incoming'}
                  onClick={() => setTab('incoming')}
                  className={tabClass(tab === 'incoming')}
                >
                  도착 예정 ({arriving.items.length})
                </button>
                {!pause.paused && (
                  <PauseControl
                    paused={pause.paused}
                    pausedAt={pause.pausedAt}
                    waitingCount={openWaiting}
                    socket={socket}
                  />
                )}
              </div>
              {incoming.waiting.length > 0 && (
                <p className="flex items-center gap-2 text-[18px] font-extrabold">
                  <span aria-hidden className="size-3 rounded-full bg-destructive" />새 이송 요청{' '}
                  {incoming.waiting.length}건{hospitalName ? ` · ${hospitalName}` : ''}
                </p>
              )}
            </div>
            {/* 중지 중이면 탭 아래에 크게 (요청 다시 받기 버튼 포함) */}
            {pause.paused && (
              <PauseControl
                paused={pause.paused}
                pausedAt={pause.pausedAt}
                waitingCount={openWaiting}
                socket={socket}
              />
            )}

            {tab === 'requests' ? (
              // 왼쪽 요청 카드, 오른쪽 상세. 좁으면 상세가 아래로 내려간다
              <div className="grid items-start gap-6 lg:grid-cols-[minmax(320px,420px)_1fr]">
                <section aria-label="요청 목록" className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="flex items-center gap-2 text-[18px] font-extrabold">
                      <span aria-hidden className="h-4 w-[3px] rounded-full bg-destructive" />
                      응답 대기 {incoming.waiting.length}건 · 남은 시간 짧은 순
                    </h2>
                    {incoming.waiting.length > 0 && alarm.kind === 'on' && (
                      <Chip
                        tone="danger"
                        className="rounded-full border border-danger-line text-[14px]"
                      >
                        🔔 알림음 반복 중
                      </Chip>
                    )}
                  </div>
                  <RequestList
                    items={incoming.items}
                    nowMs={incoming.nowMs}
                    selectedId={shownId}
                    onOpen={setSelectedId}
                  />
                  <p className="text-[14px] text-muted-foreground">
                    이상 수치가 있어도 순서는 남은 시간 순 그대로예요 (앱은 위급도를 판정하지 않음).
                  </p>
                </section>
                <div className="min-w-0">
                  {shownId !== null ? (
                    <RequestDetail key={shownId} requestId={shownId} nowMs={incoming.nowMs} />
                  ) : (
                    <EmptyRequestDetail />
                  )}
                </div>
              </div>
            ) : (
              <section className={cn(cardClass, 'relative overflow-hidden')}>
                <h2 className="px-6 py-4 text-[24px] font-extrabold tracking-[-0.02em]">
                  도착 예정
                </h2>
                <span className="absolute top-5 right-6 text-[15px] text-muted-foreground">
                  구급차 위치는 표시하지 않아요
                </span>
                {arriving.isError && (
                  <p role="alert" className="px-6 pb-4 text-xl font-bold text-destructive">
                    {errorText(arriving.error)}
                  </p>
                )}
                <IncomingList
                  items={arriving.items}
                  notices={arriving.notices}
                  onDismiss={arriving.dismiss}
                  onOpen={(id) => {
                    setSelectedId(id);
                    setTab('requests');
                  }}
                />
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
