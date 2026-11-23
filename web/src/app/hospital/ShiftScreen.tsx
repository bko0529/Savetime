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
import { NotificationPermissionGuide } from '@/components/hospital/NotificationPermissionGuide';
import { IncomingList } from '@/components/hospital/IncomingList';
import { PauseControl } from '@/components/hospital/PauseControl';
import { RequestDetail } from '@/components/hospital/RequestDetail';
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
  createSocket,
}: {
  shift: Shift | null;
  // 상단 막대 왼쪽(병원·PC 이름)과 막대 바로 아래 안내
  brand?: ReactNode;
  notice?: ReactNode;
  // 병원 전체의 잠시 요청 중지 상태 (GET /hw/session, SFR-139)
  pause?: { paused: boolean; pausedAt: string | null };
  createSocket?: () => HospitalSocket;
}) {
  const { socket, connection, alarm, turnOn, notificationBlocked } = useHospitalAlarm(createSocket);
  usePcRevoked(socket);
  // 근무 중일 때만 요청을 받는다
  const incoming = useNewRequests(shift ? socket : null);
  const arriving = useIncoming(shift ? socket : null);
  const [startedHere, setStartedHere] = useState(false);
  // 상세는 다른 주소로 옮기지 않고 같은 화면에 연다. 주소를 바꾸면 화면이 새로 그려지며
  // 실시간 연결·알림 켜짐(탭 메모리에만 있음)이 끊기기 때문이다
  const [selectedId, setSelectedId] = useState<number | null>(null);

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
              waitingCount={
                incoming.waiting.filter((r) => Date.parse(r.respondUntil) > incoming.nowMs).length
              }
            />
          )}
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-[24px] px-[32px] pt-[24px] pb-[48px]">
        {notice}
        {/* 알림 권한이 없으면 허용할 때까지 위에 계속 (SFR-136). 근무 중일 때만 */}
        {shift !== null && notificationBlocked && (
          <NotificationPermissionGuide reason={notificationBlocked} />
        )}
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
        {shift !== null && alarm.kind !== 'on' && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-[14px] border-2 border-destructive bg-danger-soft px-6 py-4">
            <div className="flex flex-col gap-2">
              <p className="text-[26px] font-extrabold text-danger-strong">
                {offMessage(alarm, startedHere)}
              </p>
              {turnOn.isError && (
                <p role="alert" className="text-lg font-bold text-destructive">
                  {errorText(turnOn.error)}
                </p>
              )}
            </div>
            <Button
              size="lg"
              className="h-[64px] rounded-[12px]"
              onClick={() => turnOn.mutate()}
              disabled={turnOn.isPending || connection !== 'connected'}
            >
              {turnOn.isPending ? '켜는 중…' : '알림 켜기'}
            </Button>
          </div>
        )}

        {shift !== null && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-4">
              {incoming.waiting.length > 0 && (
                <p className="text-[30px] font-extrabold tracking-[-0.02em] text-destructive">
                  🔴 새 이송 요청 {incoming.waiting.length}건
                </p>
              )}
              <PauseControl
                paused={pause.paused}
                pausedAt={pause.pausedAt}
                // 2분이 안 지난 대기 요청만 서버가 거절(요청 중지)로 바꾼다
                waitingCount={
                  incoming.waiting.filter((r) => Date.parse(r.respondUntil) > incoming.nowMs).length
                }
                socket={socket}
              />
            </div>

            {/* 목록과 상세를 나란히, 좁으면 상세가 목록 아래로 내려간다 */}
            <div className="flex flex-wrap items-start gap-[24px]">
              <section
                className={cn(cardClass, 'min-w-[min(100%,560px)] flex-[1.5] overflow-hidden')}
              >
                <div className="flex items-baseline justify-between gap-3 px-6 py-4">
                  <h2 className="text-[24px] font-extrabold tracking-[-0.02em]">요청 목록</h2>
                  <span className="text-[15px] text-muted-foreground">남은 시간 짧은 순</span>
                </div>
                <RequestList
                  items={incoming.items}
                  nowMs={incoming.nowMs}
                  selectedId={selectedId}
                  onOpen={setSelectedId}
                />
              </section>
              {selectedId !== null && (
                <div className="min-w-[min(100%,400px)] flex-1">
                  <RequestDetail
                    key={selectedId}
                    requestId={selectedId}
                    nowMs={incoming.nowMs}
                    onClose={() => setSelectedId(null)}
                  />
                </div>
              )}
            </div>

            <section className={cn(cardClass, 'relative overflow-hidden')}>
              <h2 className="px-6 py-4 text-[24px] font-extrabold tracking-[-0.02em]">도착 예정</h2>
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
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
