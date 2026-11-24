'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ApiError, apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import type { HospitalSocket } from '@/lib/realtime/hospitalSocket';
import { LicenseBanner } from '@/components/hospital/LicenseBanner';
import { Logo } from '@/components/hospital/Logo';
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
  return (
    <ShiftScreen
      // 상단 막대의 왼쪽. 알림·연결 상태는 ShiftScreen 이 알고 있어서 막대 자체는 거기서 그린다
      brand={
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-2">
            <Logo />
            <span className="text-[20px] font-extrabold tracking-[-0.01em]">SaveTime</span>
          </span>
          <h1 className="border-l border-line pl-4 text-[15px] font-semibold whitespace-nowrap text-muted-foreground">
            {shift ? '병원 · 응급실 이송 요청' : '근무 시작'}
          </h1>
          {/* 어느 병원·PC 인지 (담당자 이름은 근무 중일 때) */}
          <span className="text-[15px] text-muted-foreground">
            {[hospital?.name, shift?.staffName, pc?.name].filter(Boolean).join(' · ')}
          </span>
        </div>
      }
      hospitalName={hospital?.name ?? undefined}
      // 우리 병원 병상: 요청이 없어도 오른쪽 '우리 병원' 칸에 보여 준다 (SFR-118)
      beds={session.data.beds ?? null}
      // 근무 중일 때만, 근무마다 새로 그린다(key) → 닫아도 다음 근무 시작 때 다시 보인다 (SFR-168)
      notice={shift && <LicenseBanner key={shift.id} daysLeft={licenseDaysLeft} />}
      shift={shift ?? null}
      pause={{
        paused: session.data.paused ?? false,
        pausedAt: session.data.pausedAt ?? null,
      }}
      createSocket={createSocket}
    />
  );
}
