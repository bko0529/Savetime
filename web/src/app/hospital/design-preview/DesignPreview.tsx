'use client';

import { useRef, useState } from 'react';
import type { OverlayRequest } from '@/components/hospital/NewRequestOverlay';
import { NewRequestToasts } from '@/components/hospital/NewRequestToasts';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTabTitleAlert } from '@/hooks/useTabTitleAlert';

// 시연용 가짜 요청. 환자 식별정보·구급대 소속은 넣지 않는다.
const SAMPLE_COMPLAINTS = ['흉통', '호흡곤란', '의식 저하', '복통', '두부 외상'];

type PreviewRequest = OverlayRequest;

// 디자인 시안 화면: 버튼·표·새 요청 작은 알림을 서버 없이 한곳에서 확인한다 (시연·디자인 확인용)
export function DesignPreview() {
  const [requests, setRequests] = useState<PreviewRequest[]>([]);
  useTabTitleAlert(requests.length);

  // 새 요청이 오면 오른쪽 위에 뜨는 작은 알림 (실제 근무 화면과 같은 부품)
  const [toasts, setToasts] = useState<OverlayRequest[]>([]);
  const nextId = useRef(101);

  function addRequest() {
    const id = nextId.current++;
    const request: PreviewRequest = {
      id,
      label: `R-${id}`,
      chiefComplaint: SAMPLE_COMPLAINTS[id % SAMPLE_COMPLAINTS.length],
      etaMin: 5 + (id % 10),
      respondUntil: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    };
    setRequests((prev) => [...prev, request]);
    setToasts((prev) => [request, ...prev].slice(0, 3));
  }

  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function respond(id: number) {
    setRequests((prev) => prev.filter((r) => r.id !== id));
    dismissToast(id);
  }

  return (
    <main className="flex flex-1 flex-col gap-10 p-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-bold">디자인 시안</h1>
        {requests.length > 0 && (
          <p className="text-2xl font-bold text-destructive">🔴 새 이송 요청 {requests.length}건</p>
        )}
      </header>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold">버튼</h2>
        <div className="flex flex-wrap items-center gap-4">
          <Button>승인</Button>
          <Button variant="destructive">거절</Button>
          <Button variant="outline">상세 보기</Button>
          <Button variant="secondary">근무 종료</Button>
          <Button disabled>처리 중</Button>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">요청 목록</h2>
          <Button variant="outline" onClick={addRequest}>
            새 요청 오게 하기
          </Button>
        </div>
        <Table className="text-lg">
          <TableHeader>
            <TableRow>
              <TableHead>요청</TableHead>
              <TableHead>주 증상</TableHead>
              <TableHead>도착 예상</TableHead>
              <TableHead>응답 마감</TableHead>
              <TableHead className="text-right">응답</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  들어온 요청이 없어요
                </TableCell>
              </TableRow>
            )}
            {requests.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-bold">{r.label}</TableCell>
                <TableCell>{r.chiefComplaint}</TableCell>
                <TableCell>{r.etaMin}분</TableCell>
                <TableCell>
                  {new Date(r.respondUntil).toLocaleTimeString('ko-KR', { hour12: false })}
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  <Button onClick={() => respond(r.id)}>승인</Button>
                  <Button variant="destructive" onClick={() => respond(r.id)}>
                    거절
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <NewRequestToasts toasts={toasts} onOpen={() => {}} onClose={dismissToast} />
    </main>
  );
}
