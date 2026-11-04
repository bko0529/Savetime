'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

// 이 일수 이하로 남으면 배너를 띄운다 / 빨간색 / 닫기 버튼을 없앤다 (SFR-168, D-126)
export const LICENSE_WARN_DAYS = 30;
export const LICENSE_RED_DAYS = 7;
export const LICENSE_STICKY_DAYS = 1;

// 라이선스 키 만료 안내 (SFR-168). 근무를 시작할 때마다 보여 준다.
// 닫은 상태는 이 컴포넌트에만 두고, 부모가 근무가 바뀔 때 key 를 바꿔 새로 그리므로
// 다음 근무 시작 때 다시 보인다. 남은 일수는 서버가 DB 시각으로 계산해 준다 (규칙 6)
export function LicenseBanner({ daysLeft }: { daysLeft: number | undefined }) {
  const [closed, setClosed] = useState(false);
  if (daysLeft === undefined || daysLeft > LICENSE_WARN_DAYS || closed) return null;

  const red = daysLeft <= LICENSE_RED_DAYS;
  const closable = daysLeft > LICENSE_STICKY_DAYS;
  return (
    <div
      role="status"
      className={`flex items-center justify-between gap-4 rounded-lg px-4 py-3 text-xl font-bold ${
        red ? 'bg-destructive text-white' : 'border-2 border-foreground bg-muted'
      }`}
    >
      <p>라이선스 키가 {daysLeft}일 뒤 만료돼요 · 관리자에게 재발급을 요청하세요</p>
      {closable && (
        <Button
          variant={red ? 'secondary' : 'outline'}
          onClick={() => setClosed(true)}
          aria-label="만료 안내 닫기"
        >
          닫기
        </Button>
      )}
    </div>
  );
}
