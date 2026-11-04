'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import type { HospitalSocket } from '@/lib/realtime/hospitalSocket';
import { NewRequestOverlay } from '@/components/hospital/NewRequestOverlay';
import { IncomingList } from '@/components/hospital/IncomingList';
import { RequestDetail } from '@/components/hospital/RequestDetail';
import { RequestList } from '@/components/hospital/RequestList';
import { useHospitalAlarm, type AlarmState } from './useHospitalAlarm';
import { useIncoming } from './useIncoming';
import { useNewRequests } from './useNewRequests';

type ShiftBody = ApiPaths['/hw/shifts']['post']['requestBody']['content']['application/json'];
type Shift = { id?: number; staffName?: string; alarmOn?: boolean };

export const STAFF_NAME_MAX = 40;

const inputClass =
  'h-14 rounded-lg border-2 border-input px-4 text-xl outline-none focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/40';

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
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-6" noValidate>
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
  createSocket,
}: {
  shift: Shift | null;
  createSocket?: () => HospitalSocket;
}) {
  const { socket, connection, alarm, turnOn } = useHospitalAlarm(createSocket);
  // 근무 중일 때만 요청을 받는다
  const incoming = useNewRequests(shift ? socket : null);
  const arriving = useIncoming(shift ? socket : null);
  const [startedHere, setStartedHere] = useState(false);
  // 상세는 다른 주소로 옮기지 않고 같은 화면에 연다. 주소를 바꾸면 화면이 새로 그려지며
  // 실시간 연결·알림 켜짐(탭 메모리에만 있음)이 끊기기 때문이다
  const [selectedId, setSelectedId] = useState<number | null>(null);

  return (
    <div className="flex flex-col gap-6">
      {incoming.waiting.length > 0 && (
        <p className="text-3xl font-extrabold text-destructive">
          🔴 새 이송 요청 {incoming.waiting.length}건
        </p>
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
      {connection === 'disconnected' && (
        <p
          role="alert"
          className="rounded-lg bg-destructive px-4 py-3 text-xl font-bold text-white"
        >
          서버 연결이 끊겼어요 · 다시 연결 중…
        </p>
      )}

      {shift === null ? (
        <StartShift onStarted={() => setStartedHere(true)} />
      ) : alarm.kind === 'on' ? (
        <p className="rounded-lg border-2 border-foreground px-4 py-3 text-2xl font-bold">
          🔔 알림 켜짐 · {shift.staffName} 님 근무 중
        </p>
      ) : (
        <div className="flex flex-col items-start gap-4">
          <p className="text-3xl font-bold text-destructive">{offMessage(alarm, startedHere)}</p>
          {turnOn.isError && (
            <p role="alert" className="text-lg font-bold text-destructive">
              {errorText(turnOn.error)}
            </p>
          )}
          <Button
            size="lg"
            onClick={() => turnOn.mutate()}
            disabled={turnOn.isPending || connection !== 'connected'}
          >
            {turnOn.isPending ? '켜는 중…' : '알림 켜기'}
          </Button>
        </div>
      )}

      {shift !== null && (
        <>
          <h2 className="text-2xl font-bold">요청 목록</h2>
          <RequestList
            items={incoming.items}
            nowMs={incoming.nowMs}
            selectedId={selectedId}
            onOpen={setSelectedId}
          />
          {selectedId !== null && (
            <RequestDetail
              key={selectedId}
              requestId={selectedId}
              nowMs={incoming.nowMs}
              onClose={() => setSelectedId(null)}
            />
          )}

          <h2 className="text-2xl font-bold">도착 예정</h2>
          {arriving.isError && (
            <p role="alert" className="text-xl font-bold text-destructive">
              {errorText(arriving.error)}
            </p>
          )}
          <IncomingList
            items={arriving.items}
            notices={arriving.notices}
            onDismiss={arriving.dismiss}
          />
        </>
      )}
    </div>
  );
}
