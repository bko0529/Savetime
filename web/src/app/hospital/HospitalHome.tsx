'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ApiError, apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import type { HospitalSocket } from '@/lib/realtime/hospitalSocket';
import { LicenseBanner } from '@/components/hospital/LicenseBanner';
import { ShiftScreen } from './ShiftScreen';

type Session = ApiPaths['/hw/session']['get']['responses'][200]['content']['application/json'];

// 등록 안 된 PC 는 병원 웹의 어떤 화면도 못 보고 키 입력 화면으로만 간다 (SFR-116).
// 쿠키는 httpOnly 라 화면에서 직접 읽을 수 없어서, 서버에 '이 PC 누구야?'(GET /hw/session)를 물어 판단한다.
function isUnregistered(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'PC_NOT_REGISTERED';
}

export function HospitalHome({ createSocket }: { createSocket?: () => HospitalSocket } = {}) {
  const router = useRouter();
  const session = useQuery({
    queryKey: ['hw', 'session'],
    queryFn: () => apiFetch<Session>('/hw/session'),
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
  });

  useEffect(() => {
    if (isUnregistered(session.error)) router.replace('/hospital/register');
  }, [session.error, router]);

  if (session.isPending || isUnregistered(session.error)) {
    return <p className="p-8 text-xl">확인 중…</p>;
  }
  if (session.isError) {
    return (
      <p role="alert" className="p-8 text-xl font-bold text-destructive">
        {errorText(session.error)}
      </p>
    );
  }

  const { hospital, pc, shift, licenseDaysLeft } = session.data;
  const paused = session.data.paused ?? false;
  return (
    <>
      {/* 대원 앱과 같은 위쪽 띠: 무슨 화면인지 + 어느 병원·PC 인지 + 지금 상태를 한 줄에 */}
      <header className="surface-header relative overflow-hidden border-b border-border/60 px-8 pt-6 pb-7">
        <EcgLine />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            {/* 근무를 시작한 뒤에도 '근무 시작'이면 지금 무엇을 하는 화면인지 헷갈린다 */}
            <h1 className="text-3xl font-extrabold tracking-tight">
              {shift ? '이송 요청' : '근무 시작'}
            </h1>
            <p className="text-lg text-muted-foreground">
              <span className="font-bold text-foreground">{hospital?.name}</span> · {pc?.name}
            </p>
          </div>
          <StatusChip shift={!!shift} paused={paused} />
        </div>
      </header>
      <div className="flex flex-col gap-6 p-8">
        {/* 근무 중일 때만, 근무마다 새로 그린다(key) → 닫아도 다음 근무 시작 때 다시 보인다 (SFR-168) */}
        {shift && <LicenseBanner key={shift.id} daysLeft={licenseDaysLeft} />}
        <ShiftScreen
          shift={shift ?? null}
          pause={{ paused, pausedAt: session.data.pausedAt ?? null }}
          createSocket={createSocket}
        />
      </div>
    </>
  );
}

// 지금 상태를 색 칩으로. 색만으로 구분하지 않게 글자도 같이 쓴다
export function StatusChip({ shift, paused }: { shift: boolean; paused: boolean }) {
  const [text, tone] = !shift
    ? ['근무 전', 'border-border-strong bg-surface text-muted-foreground']
    : paused
      ? ['요청 잠시 멈춤', 'border-warning/30 bg-warning-soft text-warning']
      : ['근무 중', 'border-success/30 bg-success-soft text-success'];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-lg font-bold ${tone}`}
    >
      <span aria-hidden className="size-2.5 rounded-full bg-current" />
      {text}
    </span>
  );
}

// 오른쪽 위 심전도 모양 선 (꾸밈용이라 화면 읽기 프로그램에는 숨긴다)
function EcgLine() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 160 40"
      className="pointer-events-none absolute right-8 bottom-2 h-10 w-48 text-brand/50"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      <path d="M0 24h62l6-10 6 22 7-30 6 18h18l4-6 4 6h47" />
    </svg>
  );
}
