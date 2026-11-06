'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { useAdminApi } from '../useAdminApi';

type PcList =
  ApiPaths['/admin/hospitals/{id}/pcs']['get']['responses'][200]['content']['application/json'];
type Pc = PcList[number];

const timeText = (iso?: string) => (iso ? new Date(iso).toLocaleString('ko-KR') : '—');

// 병원 등록 PC 목록과 해제 (SFR-147, A-03). 90일 안 쓴 PC 는 서버가 자동으로 푼다
export function HospitalPcs({
  hospital,
  onClose,
}: {
  hospital: { id?: number; name?: string };
  onClose: () => void;
}) {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pc | null>(null);

  const pcs = useQuery({
    queryKey: ['admin', 'hospitals', hospital.id, 'pcs'],
    queryFn: () => api<PcList>(`/admin/hospitals/${hospital.id}/pcs`),
  });
  const release = useMutation({
    mutationFn: (pc: Pc) => api(`/admin/pcs/${pc.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setPending(null);
      // PC 목록·병원 목록의 PC 수·상단 알림 개수가 함께 바뀐다
      void queryClient.invalidateQueries({ queryKey: ['admin', 'hospitals'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'notifications'] });
    },
  });

  const items = pcs.data ?? [];

  return (
    <section
      aria-labelledby="pcs-title"
      className="flex flex-col gap-4 rounded-lg border-2 border-foreground p-6"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="pcs-title" className="text-2xl font-bold">
          {hospital.name} 등록 PC
        </h2>
        <Button variant="outline" onClick={onClose}>
          닫기
        </Button>
      </div>
      <p className="text-lg text-muted-foreground">90일 동안 쓰지 않은 PC는 자동으로 해제돼요.</p>
      {pcs.isError && (
        <p role="alert" className="text-lg font-bold text-destructive">
          {errorText(pcs.error)}
        </p>
      )}
      {pcs.isSuccess && items.length === 0 && (
        <p className="text-lg text-muted-foreground">등록된 PC가 없어요.</p>
      )}
      {items.length > 0 && (
        <table className="w-full border-collapse text-lg">
          <thead>
            <tr className="border-b-2 border-foreground text-left">
              <th className="p-3">PC 이름</th>
              <th className="p-3">등록 시각</th>
              <th className="p-3">마지막 사용</th>
              <th className="p-3">접속</th>
              <th className="p-3">
                <span className="sr-only">작업</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((pc) => (
              <tr key={pc.id} className="border-b">
                <td className="p-3 font-bold">{pc.name}</td>
                <td className="p-3 tabular-nums">{timeText(pc.registeredAt)}</td>
                <td className="p-3 tabular-nums">{timeText(pc.lastUsedAt)}</td>
                <td className="p-3">{pc.online ? '접속 중' : '—'}</td>
                <td className="p-3 text-right">
                  <Button variant="destructive" onClick={() => setPending(pc)}>
                    해제
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            release.reset();
            setPending(null);
          }
        }}
      >
        <DialogContent showCloseButton={false} className="gap-5 p-6 sm:max-w-lg">
          <DialogTitle className="text-2xl font-bold">{pending?.name} 해제</DialogTitle>
          <DialogDescription className="text-lg">
            이 PC에서 병원 웹이 바로 막혀요. 다시 쓰려면 라이선스 키로 새로 등록해야 해요.
          </DialogDescription>
          {release.isError && (
            <p role="alert" className="text-lg font-bold text-destructive">
              {errorText(release.error)}
            </p>
          )}
          <DialogFooter className="-mx-6 -mb-6 p-6">
            <Button
              variant="outline"
              size="lg"
              onClick={() => {
                release.reset();
                setPending(null);
              }}
            >
              취소
            </Button>
            <Button
              variant="destructive"
              size="lg"
              disabled={release.isPending}
              onClick={() => pending && release.mutate(pending)}
            >
              {release.isPending ? '처리 중…' : '해제'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
