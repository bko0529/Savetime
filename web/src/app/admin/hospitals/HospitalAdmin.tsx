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
import type { ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import type { components } from '@/lib/api/schema';
import { useAdminApi } from '../useAdminApi';
import { HospitalPcs } from './HospitalPcs';

type HospitalList =
  ApiPaths['/admin/hospitals']['get']['responses'][200]['content']['application/json'];
type Issued =
  ApiPaths['/admin/hospitals/{id}/account']['post']['responses'][201]['content']['application/json'];
export type AdminHospital = components['schemas']['AdminHospital'];

type PendingKind = 'issue' | 'suspend' | 'reissue' | 'revoke';
type Pending = { kind: PendingKind; hospital: AdminHospital } | null;

// 폐기·재발급은 사유가 꼭 있어야 한다 (SFR-146). 서버와 같은 60자
export const KEY_REASON_MAX = 60;
const needsReason = (kind: PendingKind | undefined) => kind === 'reissue' || kind === 'revoke';

function accountText(h: AdminHospital): string {
  // 키를 폐기했지만 계정은 살아 있는 병원: 재발급해야 다시 쓸 수 있다
  if (!h.license) return h.accountActive ? '키 폐기됨' : '계정 없음';
  return h.accountActive ? '사용 중' : '정지됨';
}

const DIALOG_TEXT: Record<PendingKind, { title: string; body: string; button: string }> = {
  issue: {
    title: '계정 발급',
    body: '병원 계정과 라이선스 키(유효 1년)를 만들어요. 키 전체는 발급 직후 한 번만 보여요.',
    button: '발급',
  },
  suspend: {
    title: '계정 정지',
    body: '이 병원의 모든 등록 PC에서 병원 웹이 바로 막히고, 새 요청도 받지 않아요.',
    button: '정지',
  },
  reissue: {
    title: '키 재발급',
    body: '지금 키를 폐기하고 새 키(유효 1년)를 만들어요. 등록된 PC는 모두 막히고, 새 키로 다시 등록해야 해요.',
    button: '재발급',
  },
  revoke: {
    title: '키 폐기',
    body: '키를 폐기하면 등록된 PC가 모두 바로 막혀요. 새 키는 만들지 않아요.',
    button: '폐기',
  },
};

// 병원 관리 (SFR-123·146, A-03): 공공 데이터 병원을 찾아 계정·라이선스 키를 발급하고, 정지·키 폐기·재발급한다
export function HospitalAdmin() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  // 등록 PC 목록을 펼친 병원 (SFR-147)
  const [pcsOf, setPcsOf] = useState<AdminHospital | null>(null);
  // 발급 직후 한 번만 보여 줄 키. 창을 닫으면 지워서 다시 볼 수 없다
  const [issued, setIssued] = useState<{ name: string; key: string } | null>(null);

  const list = useQuery({
    queryKey: ['admin', 'hospitals', query],
    queryFn: () =>
      api<HospitalList>(`/admin/hospitals${query ? `?q=${encodeURIComponent(query)}` : ''}`),
  });

  const act = useMutation({
    mutationFn: async ({ p, reason }: { p: NonNullable<Pending>; reason: string }) => {
      const id = p.hospital.id;
      if (p.kind === 'issue') {
        return api<Issued>(`/admin/hospitals/${id}/account`, { method: 'POST' });
      }
      if (p.kind === 'reissue') {
        return api<Issued>(`/admin/hospitals/${id}/license-keys`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      }
      if (p.kind === 'revoke') {
        await api(`/admin/license-keys/${p.hospital.license?.id}/revoke`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        return null;
      }
      await api(`/admin/hospitals/${id}/suspend`, { method: 'POST' });
      return null;
    },
    onSuccess: (result, { p }) => {
      setPending(null);
      if (result?.licenseKey) setIssued({ name: p.hospital.name ?? '', key: result.licenseKey });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'hospitals'] });
    },
  });

  function search(e: FormEvent) {
    e.preventDefault();
    setQuery(input.trim());
  }

  const items = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold">병원 관리</h1>
      <form onSubmit={search} className="flex max-w-xl gap-3" role="search">
        <input
          aria-label="병원 이름"
          placeholder="병원 이름 (예: 천안)"
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
        <p className="text-lg text-muted-foreground">찾는 병원이 없어요.</p>
      )}
      {items.length > 0 && (
        <table className="w-full border-collapse text-lg">
          <thead>
            <tr className="border-b-2 border-foreground text-left">
              <th className="p-3">병원</th>
              <th className="p-3">계정</th>
              <th className="p-3">등록 PC</th>
              <th className="p-3">라이선스 키</th>
              <th className="p-3">
                <span className="sr-only">작업</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((h) => (
              <tr key={h.id} className="border-b">
                <td className="p-3 font-bold">{h.name}</td>
                <td className="p-3">{accountText(h)}</td>
                <td className="p-3 tabular-nums">
                  {h.pcCount}/{h.pcLimit}
                  {(h.pcCount ?? 0) > 0 && (
                    <Button
                      variant="link"
                      className="ml-2 text-lg"
                      aria-label={`${h.name} 등록 PC 보기`}
                      onClick={() => setPcsOf(h)}
                    >
                      PC 보기
                    </Button>
                  )}
                </td>
                {/* 발급 뒤에는 앞 4자리만 보여 준다 (SFR-123) */}
                <td className="p-3 font-mono">
                  {h.license ? `${h.license.prefix}-····  (${h.license.daysLeft}일 남음)` : '—'}
                </td>
                <td className="p-3">
                  <div className="flex justify-end gap-2">
                    {!h.license && !h.accountActive && (
                      <Button onClick={() => setPending({ kind: 'issue', hospital: h })}>
                        계정 발급
                      </Button>
                    )}
                    {/* 키 폐기·재발급 (SFR-146): 키가 있거나, 폐기됐지만 계정이 살아 있으면 재발급 */}
                    {(h.license || h.accountActive) && (
                      <Button
                        variant="outline"
                        onClick={() => setPending({ kind: 'reissue', hospital: h })}
                      >
                        키 재발급
                      </Button>
                    )}
                    {h.license && (
                      <Button
                        variant="outline"
                        onClick={() => setPending({ kind: 'revoke', hospital: h })}
                      >
                        키 폐기
                      </Button>
                    )}
                    {h.license && h.accountActive && (
                      <Button
                        variant="destructive"
                        onClick={() => setPending({ kind: 'suspend', hospital: h })}
                      >
                        정지
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pcsOf && <HospitalPcs key={pcsOf.id} hospital={pcsOf} onClose={() => setPcsOf(null)} />}

      <ConfirmDialog
        pending={pending}
        busy={act.isPending}
        error={act.isError ? errorText(act.error) : null}
        onConfirm={(reason) => pending && act.mutate({ p: pending, reason })}
        onCancel={() => {
          act.reset();
          setPending(null);
        }}
      />
      <IssuedKeyDialog issued={issued} onClose={() => setIssued(null)} />
    </div>
  );
}

function ConfirmDialog({
  pending,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  pending: Pending;
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const text = pending ? DIALOG_TEXT[pending.kind] : null;
  const withReason = needsReason(pending?.kind);
  // 사유가 필요한 작업은 사유를 써야 확인 버튼이 눌린다
  const blocked = busy || (withReason && reason.trim() === '');
  const cancel = () => {
    setReason('');
    onCancel();
  };
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && cancel()}>
      <DialogContent showCloseButton={false} className="gap-5 p-6 sm:max-w-lg">
        <DialogTitle className="text-2xl font-bold">
          {pending?.hospital.name} {text?.title}
        </DialogTitle>
        <DialogDescription className="text-lg">{text?.body}</DialogDescription>
        {withReason && (
          <label className="flex flex-col gap-2">
            <span className="text-lg font-bold">사유 (작업 이력에 남아요)</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={KEY_REASON_MAX}
              placeholder="예: 키 유출 의심, 병원 탈퇴"
              className="h-12 rounded-lg border-2 border-input px-3 text-lg"
            />
          </label>
        )}
        {error && (
          <p role="alert" className="text-lg font-bold text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="-mx-6 -mb-6 p-6">
          <Button variant="outline" size="lg" onClick={cancel}>
            취소
          </Button>
          <Button
            size="lg"
            variant={pending?.kind === 'issue' ? 'default' : 'destructive'}
            disabled={blocked}
            onClick={() => {
              onConfirm(reason.trim());
              setReason('');
            }}
          >
            {busy ? '처리 중…' : text?.button}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 발급한 키는 이 창에서 딱 한 번 보여 준다. 닫으면 화면 메모리에서도 지운다 (COR-013 키 전달 절차)
function IssuedKeyDialog({
  issued,
  onClose,
}: {
  issued: { name: string; key: string } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open={issued !== null}
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent showCloseButton={false} className="gap-5 p-6 sm:max-w-lg">
        <DialogTitle className="text-2xl font-bold">{issued?.name} 라이선스 키</DialogTitle>
        <DialogDescription className="text-lg font-bold text-destructive">
          이 창을 닫으면 키 전체를 다시 볼 수 없어요. 병원 담당자에게 정해진 방법으로 전달해 주세요.
        </DialogDescription>
        <p
          aria-label="라이선스 키"
          className="rounded-lg border-2 border-foreground bg-muted p-4 text-center font-mono text-2xl font-bold tracking-wider break-all"
        >
          {issued?.key}
        </p>
        <DialogFooter className="-mx-6 -mb-6 p-6">
          <Button
            variant="outline"
            size="lg"
            onClick={() => {
              if (!issued) return;
              void navigator.clipboard?.writeText(issued.key).then(() => setCopied(true));
            }}
          >
            {copied ? '복사됨' : '복사'}
          </Button>
          <Button
            size="lg"
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            확인했어요
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
