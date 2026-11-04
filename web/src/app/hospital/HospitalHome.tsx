'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ApiError, apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';

type Session = ApiPaths['/hw/session']['get']['responses'][200]['content']['application/json'];

// 등록 안 된 PC 는 병원 웹의 어떤 화면도 못 보고 키 입력 화면으로만 간다 (SFR-116).
// 쿠키는 httpOnly 라 화면에서 직접 읽을 수 없어서, 서버에 '이 PC 누구야?'(GET /hw/session)를 물어 판단한다.
function isUnregistered(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'PC_NOT_REGISTERED';
}

export function HospitalHome() {
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
    return <p className="text-xl">확인 중…</p>;
  }
  if (session.isError) {
    return (
      <p role="alert" className="text-xl font-bold text-destructive">
        {errorText(session.error)}
      </p>
    );
  }

  const { hospital, pc } = session.data;
  return (
    <div className="flex flex-col gap-2 text-xl">
      <p>
        <span className="font-bold">{hospital?.name}</span> · {pc?.name}
      </p>
      <p className="text-muted-foreground">근무 시작·알림 켜기는 다음 단계에서 추가돼요.</p>
    </div>
  );
}
