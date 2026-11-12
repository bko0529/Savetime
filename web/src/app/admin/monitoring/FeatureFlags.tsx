'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import type { ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { useAdminApi } from '../useAdminApi';

type Flags =
  ApiPaths['/admin/feature-flags']['get']['responses'][200]['content']['application/json'];
type FlagField = keyof Flags;

// 화면에 보여 줄 순서와 설명. 서버가 새 기능을 더해도 여기 없으면 보이지 않는다
const ITEMS: { field: FlagField; label: string; help: string }[] = [
  {
    field: 'journalAi',
    label: 'AI 일지 정리',
    help: "켜면 구급대원 앱 일지 초안에 'AI 정리'가 보여요. 서버에 AI 키가 있어야 동작해요 (SFR-167)",
  },
  {
    field: 'hospitalGrade',
    label: '병원 등급 선택',
    help: '켜면 구급대원이 요청할 때 병원 등급(1~3)을 고를 수 있어요 (SFR-163)',
  },
];

// 기능 토글 (QUR-013, A-02): 배포 없이 기능을 켜고 끈다. 앱·웹은 1분마다 설정을 다시 읽어 1분 안에 반영된다
export function FeatureFlags() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const flags = useQuery({
    queryKey: ['admin', 'feature-flags'],
    queryFn: () => api<Flags>('/admin/feature-flags'),
  });

  // 누른 기능 하나만 보낸다. 두 관리자가 동시에 다른 기능을 바꿔도 서로 덮어쓰지 않게
  const change = useMutation({
    mutationFn: ({ field, enabled }: { field: FlagField; enabled: boolean }) =>
      api<Flags>('/admin/feature-flags', {
        method: 'PUT',
        body: JSON.stringify({ [field]: enabled }),
      }),
    onSuccess: (next) => {
      // 응답은 바꾼 뒤 전체 값이라 그대로 화면에 쓴다
      queryClient.setQueryData(['admin', 'feature-flags'], next);
      // 바뀐 것은 작업 이력에 1줄 남는다 (SFR-091)
      void queryClient.invalidateQueries({ queryKey: ['admin', 'audit-logs'] });
    },
  });

  return (
    <section aria-labelledby="flags-title" className="flex flex-col gap-4">
      <h2 id="flags-title" className="text-2xl font-bold">
        기능 켜고 끄기
      </h2>
      <p className="text-lg text-muted-foreground">
        바꾸면 구급대원 앱과 병원 웹에 1분 안에 반영돼요.
      </p>
      {flags.isError && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(flags.error)}
        </p>
      )}
      {flags.data && (
        <ul className="flex flex-col gap-3">
          {ITEMS.map(({ field, label, help }) => {
            const on = flags.data[field];
            const busy = change.isPending && change.variables?.field === field;
            return (
              <li
                key={field}
                aria-label={label}
                className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
              >
                <div className="flex flex-col gap-1">
                  <p className="text-xl font-bold">
                    {label}{' '}
                    <span className={on ? 'text-green-700' : 'text-muted-foreground'}>
                      {on ? '켜짐' : '꺼짐'}
                    </span>
                  </p>
                  <p className="text-base text-muted-foreground">{help}</p>
                </div>
                <Button
                  size="lg"
                  variant={on ? 'outline' : 'default'}
                  disabled={change.isPending}
                  onClick={() => change.mutate({ field, enabled: !on })}
                >
                  {busy ? '바꾸는 중…' : on ? '끄기' : '켜기'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {change.isError && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(change.error)}
        </p>
      )}
    </section>
  );
}
