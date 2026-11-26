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
        // 대원 앱 Lovable 시안: 로고 + 큰 화면 제목, 그 아래 작은 글씨로 병원·PC 이름
        <div className="flex min-w-0 items-center gap-3">
          <Logo />
          <div className="flex min-w-0 flex-col gap-0.5">
            {/* 근무를 시작한 뒤에도 '근무 시작'이면 지금 무엇을 하는 화면인지 헷갈린다 */}
            <h1 className="text-[28px] leading-tight font-extrabold tracking-[-0.02em] whitespace-nowrap">
              {shift ? '이송 요청' : '근무 시작'}
            </h1>
            <p className="text-[16px] text-muted-foreground">
              <span className="font-bold text-foreground">{hospital?.name}</span> · {pc?.name}
            </p>
          </div>
        </div>
      }
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
