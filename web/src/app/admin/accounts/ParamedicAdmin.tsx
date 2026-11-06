'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import { useAdminApi } from '../useAdminApi';

type ParamedicList =
  ApiPaths['/admin/paramedics']['get']['responses'][200]['content']['application/json'];
type Paramedic = NonNullable<ParamedicList['items']>[number];
type SuspendBody = NonNullable<
  ApiPaths['/admin/paramedics/{id}/suspend']['post']['requestBody']
>['content']['application/json'];
type SuspendReason = SuspendBody['reason'];

// 정지 사유 4가지 (SFR-151)
export const SUSPEND_REASONS: { value: SuspendReason; label: string }[] = [
  { value: 'retired', label: '퇴직' },
  { value: 'phone_lost', label: '폰 분실' },
  { value: 'misuse', label: '부정 사용' },
  { value: 'etc', label: '기타' },
];
const ETC_MAX = 50;

const STATUS_TEXT: Record<string, string> = {
  approved: '사용 중',
  suspended: '정지됨',
  pending: '승인 대기',
  rejected: '반려',
};

type Pending = { kind: 'suspend' | 'unsuspend'; paramedic: Paramedic } | null;

// 서버가 '진행 중 이송이 있어요'로 한 번 멈췄는지 (그다음 정지는 확인을 붙여 보낸다)
const needsConfirm = (error: unknown) =>
  error instanceof ApiError && error.code === 'ACTIVE_TRANSPORT_CONFIRM_REQUIRED';

// 대원 계정 정지·해제 (SFR-151, A-01). 정지하면 대원 앱이 바로 로그아웃되고 다시 로그인할 수 없다
export function ParamedicAdmin() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending>(null);

  const list = useQuery({
    queryKey: ['admin', 'paramedics', query],
    queryFn: () =>
      api<ParamedicList>(`/admin/paramedics${query ? `?q=${encodeURIComponent(query)}` : ''}`),
  });

  const act = useMutation({
    mutationFn: async ({ p, body }: { p: NonNullable<Pending>; body?: SuspendBody }) => {
      const id = p.paramedic.id;
      if (p.kind === 'suspend') {
        await api(`/admin/paramedics/${id}/suspend`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
      } else {
        await api(`/admin/paramedics/${id}/unsuspend`, { method: 'POST' });
      }
    },
    onSuccess: () => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'paramedics'] });
    },
  });

  function search(e: FormEvent) {
    e.preventDefault();
    setQuery(input.trim());
  }
  function close() {
    act.reset();
    setPending(null);
  }

  const items = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold">대원 계정</h1>
      <form onSubmit={search} className="flex max-w-xl gap-3" role="search">
        <input
          aria-label="이름 또는 사번"
          placeholder="이름 또는 사번"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={40}
          className="h-12 flex-1 rounded-lg border-2 border-input px-3 text-lg"
        />
        <Button type="submit" size="lg">
          검색
        </Button>
      </form>

      {list.isError && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(list.error)}
        </p>
      )}
      {list.isSuccess && items.length === 0 && (
        <p className="text-lg text-muted-foreground">찾는 대원이 없어요.</p>
      )}
      {items.length > 0 && (
        <table className="w-full border-collapse text-lg">
          <thead>
            <tr className="border-b-2 border-foreground text-left">
              <th className="p-3">이름</th>
              <th className="p-3">사번</th>
              <th className="p-3">소속</th>
              <th className="p-3">상태</th>
              <th className="p-3">
                <span className="sr-only">작업</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className="border-b">
                <td className="p-3 font-bold">{p.name}</td>
                <td className="p-3 tabular-nums">{p.employeeNo}</td>
                <td className="p-3">
                  {p.agencyName} · {p.safetyCenter}
                </td>
                <td className="p-3">
                  {STATUS_TEXT[p.status ?? ''] ?? p.status}
                  {p.hasActiveTransport && (
                    <span className="ml-2 font-bold text-destructive">· 이송 중</span>
                  )}
                </td>
                <td className="p-3 text-right">
                  {p.status === 'approved' && (
                    <Button
                      variant="destructive"
                      onClick={() => setPending({ kind: 'suspend', paramedic: p })}
                    >
                      정지
                    </Button>
                  )}
                  {p.status === 'suspended' && (
                    <Button
                      variant="outline"
                      onClick={() => setPending({ kind: 'unsuspend', paramedic: p })}
                    >
                      정지 해제
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pending?.kind === 'suspend' && (
        <SuspendDialog
          key={pending.paramedic.id}
          paramedic={pending.paramedic}
          busy={act.isPending}
          error={act.error}
          onSubmit={(body) => act.mutate({ p: pending, body })}
          onCancel={close}
        />
      )}
      <Dialog open={pending?.kind === 'unsuspend'} onOpenChange={(open) => !open && close()}>
        <DialogContent showCloseButton={false} className="gap-5 p-6 sm:max-w-lg">
          <DialogTitle className="text-2xl font-bold">
            {pending?.paramedic.name} 정지 해제
          </DialogTitle>
          <DialogDescription className="text-lg">
            다시 로그인해서 쓸 수 있어요. 팀과 이송은 되돌리지 않아요.
          </DialogDescription>
          {act.isError && (
            <p role="alert" className="text-lg font-bold text-destructive">
              {errorText(act.error)}
            </p>
          )}
          <DialogFooter className="-mx-6 -mb-6 p-6">
            <Button variant="outline" size="lg" onClick={close}>
              취소
            </Button>
            <Button
              size="lg"
              disabled={act.isPending}
              onClick={() => pending && act.mutate({ p: pending })}
            >
              {act.isPending ? '처리 중…' : '정지 해제'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SuspendDialog({
  paramedic,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  paramedic: Paramedic;
  busy: boolean;
  error: Error | null;
  onSubmit: (body: SuspendBody) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState<SuspendReason | null>(null);
  const [etcText, setEtcText] = useState('');
  // 서버가 진행 중 이송이 있다고 멈추면 경고를 보여 주고, 다시 누를 때 확인을 붙인다
  const warned = needsConfirm(error);
  const ready = reason !== null && (reason !== 'etc' || etcText.trim() !== '');

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false} className="gap-5 p-6 sm:max-w-lg">
        <DialogTitle className="text-2xl font-bold">{paramedic.name} 계정 정지</DialogTitle>
        <DialogDescription className="text-lg">
          대원 앱이 바로 로그아웃되고, 다시 로그인할 수 없어요. 팀에서도 빠져요.
        </DialogDescription>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-lg font-bold">사유</legend>
          {SUSPEND_REASONS.map((r) => (
            <label key={r.value} className="flex items-center gap-3 text-lg">
              <input
                type="radio"
                name="suspend-reason"
                value={r.value}
                checked={reason === r.value}
                onChange={() => setReason(r.value)}
                className="size-5"
              />
              {r.label}
            </label>
          ))}
          {reason === 'etc' && (
            <input
              aria-label="기타 사유"
              value={etcText}
              onChange={(e) => setEtcText(e.target.value)}
              maxLength={ETC_MAX}
              className="h-12 rounded-lg border-2 border-input px-3 text-lg"
            />
          )}
        </fieldset>
        {warned && (
          <p
            role="alert"
            className="rounded-lg bg-destructive px-4 py-3 text-lg font-bold text-white"
          >
            진행 중 이송 1건이 있어요. 팀의 마지막 대원이면 이송이 &apos;취소&apos;로 끝나요.
          </p>
        )}
        {error && !warned && (
          <p role="alert" className="text-lg font-bold text-destructive">
            {errorText(error)}
          </p>
        )}
        <DialogFooter className="-mx-6 -mb-6 p-6">
          <Button variant="outline" size="lg" onClick={onCancel}>
            취소
          </Button>
          <Button
            variant="destructive"
            size="lg"
            disabled={!ready || busy}
            onClick={() =>
              reason &&
              onSubmit({
                reason,
                etcText: reason === 'etc' ? etcText.trim() : null,
                ...(warned ? { confirmCancelActive: true } : {}),
              })
            }
          >
            {busy ? '처리 중…' : warned ? '그래도 정지' : '정지'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
