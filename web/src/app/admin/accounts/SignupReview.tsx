'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError, NETWORK_ERROR, type ApiPaths } from '@/lib/api/client';
import { errorText } from '@/lib/api/errorText';
import type { components } from '@/lib/api/schema';
import { bearer, useAdminAuth } from '../AdminAuth';
import { useAdminApi } from '../useAdminApi';

type SignupList =
  ApiPaths['/admin/signups']['get']['responses'][200]['content']['application/json'];
type Signup = components['schemas']['SignupItem'];
type RejectBody = NonNullable<
  ApiPaths['/admin/signups/{id}/reject']['post']['requestBody']
>['content']['application/json'];
type RejectReason = NonNullable<RejectBody['reason']>;

// 반려 사유 (SFR-083)
export const REJECT_REASONS: { value: RejectReason; label: string }[] = [
  { value: 'photo_unclear', label: '사진 불명확' },
  { value: 'info_mismatch', label: '정보 불일치' },
  { value: 'agency_unverified', label: '소속 확인 불가' },
  { value: 'etc', label: '기타' },
];
const ETC_MAX = 50;

const timeText = (iso?: string) => (iso ? new Date(iso).toLocaleString('ko-KR') : '—');

// 공무원증 사진은 관리자 토큰을 붙여 받아야 해서 <img src> 로 바로 걸 수 없다.
// 받아서 이 탭 메모리(blob URL)로만 보여 주고, 창을 닫으면 바로 버린다. 디스크·캐시에 남기지 않는다 (SER-015).
// 한 번 열 때 한 번만 받는다: 받을 때마다 서버 작업 이력에 '열람'이 1건씩 남기 때문
function useSignupPhoto(signupId: number | undefined) {
  const { tokens, signOut } = useAdminAuth();
  const [state, setState] = useState<{ url: string | null; error: unknown }>({
    url: null,
    error: null,
  });

  useEffect(() => {
    if (signupId === undefined) return;
    let url: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/admin/signups/${signupId}/photo`, {
          headers: bearer(tokens),
          cache: 'no-store',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: { code?: string; message?: string };
          } | null;
          const err = new ApiError(
            res.status,
            body?.error?.code ?? 'UNKNOWN',
            body?.error?.message ?? '사진을 불러오지 못했어요',
          );
          if (err.code === 'TOKEN_EXPIRED' || err.code === 'TOKEN_REVOKED') signOut();
          throw err;
        }
        const blob = await res.blob();
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setState({ url, error: null });
      } catch (error) {
        if (cancelled) return;
        setState({
          url: null,
          error:
            error instanceof ApiError
              ? error
              : new ApiError(0, NETWORK_ERROR, '서버에 연결할 수 없어요'),
        });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // 일부러 signupId 만 본다: 토큰이 바뀌어도 다시 받지 않는다 (열람 기록이 또 남지 않게)
  }, [signupId]);

  return state;
}

// 가입 승인·반려 (SFR-083, A-01). 신청 정보와 공무원증 사진을 나란히 보고 결정한다.
// 결정하면 서버가 사진을 바로 지우고 확인자·시각만 남긴다
export function SignupReview() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<Signup | null>(null);

  const list = useQuery({
    queryKey: ['admin', 'signups'],
    queryFn: () => api<SignupList>('/admin/signups'),
  });
  const decide = useMutation({
    mutationFn: async ({ id, reject }: { id: number; reject?: RejectBody }) => {
      if (reject) {
        await api(`/admin/signups/${id}/reject`, {
          method: 'POST',
          body: JSON.stringify(reject),
        });
      } else {
        await api(`/admin/signups/${id}/approve`, { method: 'POST' });
      }
    },
    onSuccess: () => {
      setOpen(null);
      // 대기 목록·작업 이력·상단 알림 개수가 함께 바뀐다
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });

  function close() {
    decide.reset();
    setOpen(null);
  }

  const items = list.data?.items ?? [];

  return (
    <section aria-labelledby="signups-title" className="flex flex-col gap-4">
      <h2 id="signups-title" className="text-2xl font-bold">
        가입 승인 대기 {list.isSuccess && <span className="tabular-nums">{items.length}건</span>}
      </h2>
      {list.isError && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(list.error)}
        </p>
      )}
      {list.isSuccess && items.length === 0 && (
        <p className="text-lg text-muted-foreground">기다리는 가입 신청이 없어요.</p>
      )}
      {items.length > 0 && (
        <table className="w-full border-collapse text-lg">
          <thead>
            <tr className="border-b-2 border-foreground text-left">
              <th className="p-3">이름</th>
              <th className="p-3">소속</th>
              <th className="p-3">사번</th>
              <th className="p-3">신청 시각</th>
              <th className="p-3">
                <span className="sr-only">작업</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} className="border-b">
                <td className="p-3 font-bold">
                  {s.name} <span className="font-normal">{s.rank}</span>
                  {s.resubmitted && (
                    <span className="ml-2 text-base font-bold text-destructive">다시 신청</span>
                  )}
                </td>
                <td className="p-3">
                  {s.agencyName} · {s.safetyCenter}
                </td>
                <td className="p-3 tabular-nums">{s.employeeNo}</td>
                <td className="p-3 tabular-nums">{timeText(s.createdAt)}</td>
                <td className="p-3 text-right">
                  <Button onClick={() => setOpen(s)} aria-label={`${s.name} 신청 확인`}>
                    사진 보고 확인
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && (
        <ReviewDialog
          key={open.id}
          signup={open}
          busy={decide.isPending}
          error={decide.isError ? errorText(decide.error) : null}
          onApprove={() => open.id !== undefined && decide.mutate({ id: open.id })}
          onReject={(reject) => open.id !== undefined && decide.mutate({ id: open.id, reject })}
          onClose={close}
        />
      )}
    </section>
  );
}

function ReviewDialog({
  signup,
  busy,
  error,
  onApprove,
  onReject,
  onClose,
}: {
  signup: Signup;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onReject: (body: RejectBody) => void;
  onClose: () => void;
}) {
  const photo = useSignupPhoto(signup.id);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<RejectReason | null>(null);
  const [etcText, setEtcText] = useState('');
  const rejectReady = reason !== null && (reason !== 'etc' || etcText.trim() !== '');

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="gap-5 p-6 sm:max-w-3xl">
        <DialogTitle className="text-2xl font-bold">{signup.name} 가입 신청</DialogTitle>
        <DialogDescription className="text-lg">
          공무원증 사진과 신청 정보가 맞는지 확인하세요. 승인·반려하면 사진은 바로 지워져요.
        </DialogDescription>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="flex min-h-48 items-center justify-center rounded-lg border-2 border-input bg-muted">
            {photo.url ? (
              // blob URL 이라 next/image 최적화를 쓰지 않는다
              <img
                src={photo.url}
                alt={`${signup.name} 공무원증 사진`}
                className="max-h-96 w-full object-contain"
              />
            ) : photo.error ? (
              <p role="alert" className="p-4 text-lg font-bold text-destructive">
                {errorText(photo.error)}
              </p>
            ) : (
              <p className="text-lg text-muted-foreground">사진 불러오는 중…</p>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-lg">
            <dt className="font-bold">이름</dt>
            <dd>{signup.name}</dd>
            <dt className="font-bold">계급</dt>
            <dd>{signup.rank}</dd>
            <dt className="font-bold">소속기관</dt>
            <dd>
              {signup.agencyName} ({signup.agencyCode})
            </dd>
            <dt className="font-bold">안전센터</dt>
            <dd>{signup.safetyCenter}</dd>
            <dt className="font-bold">사번</dt>
            <dd className="tabular-nums">{signup.employeeNo}</dd>
            <dt className="font-bold">신청</dt>
            <dd className="tabular-nums">
              {timeText(signup.createdAt)}
              {signup.resubmitted && ' (다시 신청)'}
            </dd>
          </dl>
        </div>

        {rejecting && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-lg font-bold">반려 사유</legend>
            {REJECT_REASONS.map((r) => (
              <label key={r.value} className="flex items-center gap-3 text-lg">
                <input
                  type="radio"
                  name="reject-reason"
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
        )}
        {error && (
          <p role="alert" className="text-lg font-bold text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className="-mx-6 -mb-6 p-6">
          <Button variant="outline" size="lg" onClick={onClose}>
            닫기
          </Button>
          {rejecting ? (
            <Button
              variant="destructive"
              size="lg"
              disabled={!rejectReady || busy}
              onClick={() =>
                reason && onReject({ reason, etcText: reason === 'etc' ? etcText.trim() : null })
              }
            >
              {busy ? '처리 중…' : '반려 보내기'}
            </Button>
          ) : (
            <>
              <Button variant="destructive" size="lg" onClick={() => setRejecting(true)}>
                반려
              </Button>
              <Button size="lg" disabled={busy || !photo.url} onClick={onApprove}>
                {busy ? '처리 중…' : '승인'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
