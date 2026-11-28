'use client';

import { useQuery } from '@tanstack/react-query';
import { ApiError, apiFetch, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import type { Assessment } from '@/lib/assessment/labels';
import { AssessmentRows } from './AssessmentRows';
import { detailKey } from './detailKey';

type Detail =
  ApiPaths['/hw/requests/{requestId}']['get']['responses'][200]['content']['application/json'];

// 도착 예정 줄을 펼쳤을 때 보이는 환자 평가 전체.
// 요청 상세와 같은 API·같은 캐시를 쓴다 → 펼칠 때 열람 기록이 남고(SFR-137),
// 이미 상세에서 본 요청이면 다시 받지 않는다. 도착 1시간 뒤에는 서버가 막는다 (SER-014)
export function IncomingPatient({ requestId }: { requestId: number }) {
  const detail = useQuery({
    queryKey: detailKey(requestId),
    queryFn: () => apiFetch<Detail>(`/hw/requests/${requestId}`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (detail.isPending) return <p className="text-[17px]">불러오는 중…</p>;
  if (detail.isError) {
    return (
      <p role="alert" className="text-[17px] font-bold text-muted-foreground">
        {detail.error instanceof ApiError && detail.error.code === 'REQUEST_CLOSED'
          ? '환자 정보는 도착 후 1시간까지만 볼 수 있어요.'
          : errorText(detail.error)}
      </p>
    );
  }
  return (
    <AssessmentRows
      assessment={(detail.data.assessment ?? {}) as Assessment}
      abnormalFields={detail.data.abnormalFields}
      skip={['sex', 'ageBand']}
      // 넓은 표 안이라 두세 칸으로 나눠 한눈에
      className="grid gap-x-8 sm:grid-cols-2 xl:grid-cols-3"
      rowClassName="last:border-b"
    />
  );
}
