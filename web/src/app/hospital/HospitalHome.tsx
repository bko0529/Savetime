'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ApiError, apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import type { HospitalSocket } from '@/lib/realtime/hospitalSocket';
import { StatusScreen } from '@/components/brand/StatusScreen';
import { LicenseBanner } from '@/components/hospital/LicenseBanner';
import { Button } from '@/components/ui/button';
import { BrandLogo } from '@/components/brand/Brand';
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
    return (
      <StatusScreen title="확인 중…" heading={false}>
        이 PC가 등록된 병원 PC인지 확인하고 있어요.
      </StatusScreen>
    );
  }
  if (session.isError) {
    // 서버가 꺼졌거나 연결이 안 될 때: 빈 화면에 글자 한 줄 대신, 무엇이 문제인지와 다시 시도 버튼
    return (
      <StatusScreen
        eyebrow="연결 확인"
        tone="danger"
        title="병원 웹을 열지 못했어요"
        action={
          <Button
            size="lg"
            className="h-14 rounded-xl px-8 text-xl"
            disabled={session.isFetching}
            onClick={() => void session.refetch()}
          >
            {session.isFetching ? '다시 확인하는 중…' : '다시 시도'}
          </Button>
        }
      >
        <p role="alert" className="font-bold text-destructive">
          {errorText(session.error)}
        </p>
      </StatusScreen>
    );
  }

  const { hospital, pc, shift, licenseDaysLeft } = session.data;
  return (
    <ShiftScreen
      // 상단 막대의 왼쪽. 알림·연결 상태는 ShiftScreen 이 알고 있어서 막대 자체는 거기서 그린다
      brand={
        <div className="flex min-w-0 items-center gap-3">
          {/* 시안처럼 로고를 흰 상자 없이 크게 */}
          <BrandLogo className="size-12" />
          <p className="flex min-w-0 items-center gap-3 leading-tight">
            <span className="text-[26px] font-extrabold tracking-[-0.02em] text-[#14284B]">
              SaveTime
            </span>
            <span aria-hidden className="text-line">
              |
            </span>
            <span className="text-[17px] font-semibold text-muted-foreground">
              병원 · 응급실 이송 요청
            </span>
          </p>
          {/* 화면 제목은 보이지 않게, 화면 읽기 프로그램·탭 이동용으로만 둔다 */}
          <h1 className="sr-only">{shift ? '이송 요청' : '근무 시작'}</h1>
        </div>
      }
      // 근무 중일 때만, 근무마다 새로 그린다(key) → 닫아도 다음 근무 시작 때 다시 보인다 (SFR-168)
      notice={shift && <LicenseBanner key={shift.id} daysLeft={licenseDaysLeft} />}
      hospitalName={hospital?.name}
      pcName={pc?.name}
      shift={shift ?? null}
      pause={{
        paused: session.data.paused ?? false,
        pausedAt: session.data.pausedAt ?? null,
      }}
      createSocket={createSocket}
    />
  );
}
