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
  const { socket, connection, alarm, turnOn } = useHospitalAlarm(createSocket);
  usePcRevoked(socket);
  // 근무 중일 때만 요청을 받는다
  const incoming = useNewRequests(shift ? socket : null);
  const arriving = useIncoming(shift ? socket : null);
  const [startedHere, setStartedHere] = useState(false);
  // 상세는 다른 주소로 옮기지 않고 같은 화면에 연다. 주소를 바꾸면 화면이 새로 그려지며
  // 실시간 연결·알림 켜짐(탭 메모리에만 있음)이 끊기기 때문이다
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // 요청 / 도착 예정 탭. 탭도 화면 안에서만 바꾼다 (주소를 바꾸면 알림 켜짐이 끊김)
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
        {/* 오른쪽은 작게: 담당자·PC, 알림·연결 상태, 근무 종료 */}
        <div className="flex flex-wrap items-center gap-[8px]">
          {/* 근무 중이면 '담당자 · PC', 근무 전이면 '병원 · PC' (어느 병원·PC 인지 늘 보이게) */}
          <span className="mr-1 text-[16px] font-semibold">
            {[shift ? shift.staffName : hospitalName, pcName].filter(Boolean).join(' · ')}
          </span>
          {shift !== null && alarm.kind === 'on' && (
            <Chip tone="success" className="border border-success-dot/40 py-0.5 text-[14px]">
              🔔 알림 켜짐
            </Chip>
          )}
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
              {incoming.waiting.length > 0 && (
                // 이모지 대신 빨간 점 + 연한 링 (탭 제목은 그대로 🔴)
                <p className="ml-auto flex items-center gap-2 text-[18px] font-extrabold text-destructive">
                  <span
                    aria-hidden
                    className="size-[12px] shrink-0 rounded-full bg-destructive shadow-[0_0_0_5px_var(--danger-soft)]"
                  />
                  <span>새 이송 요청 {incoming.waiting.length}건</span>
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
                    {/* 대기 요청이 있는 동안 소리가 반복된다 (useNewRequests) */}
                    {incoming.waiting.length > 0 && alarm.kind === 'on' && (
                      <Chip tone="danger" className="border border-danger-line py-0.5 text-[14px]">
                        🔔 알림음 반복 중
                      </Chip>
                    )}
                  </div>
                  <RequestList
                    items={incoming.items}
                    nowMs={incoming.nowMs}
                    selectedId={selectedId}
                    onOpen={setSelectedId}
                  />
                  <p className="text-[14px] leading-relaxed text-muted-foreground">
                    이상 수치가 있어도 순서는 남은 시간 순 그대로예요 (앱은 위급도를 판정하지 않음)
                  </p>
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
            )}
          </>
        )}
      </div>
    </div>
  );
}
