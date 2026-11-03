'use client';

import { useEffect } from 'react';

export const BLINK_MS = 1000;

export function alertTitle(count: number): string {
  return `🔴 새 이송 요청 ${count}건`;
}

// 다른 창을 보고 있어도 알아채도록 대기 요청이 있으면 탭 제목을 1초마다 바꾼다 (SFR-117).
// 대기 0건이 되거나 화면을 떠나면 원래 제목으로 돌려놓는다.
export function useTabTitleAlert(pendingCount: number) {
  useEffect(() => {
    if (pendingCount <= 0) return;

    const original = document.title;
    const alert = alertTitle(pendingCount);
    document.title = alert;
    const timer = setInterval(() => {
      document.title = document.title === alert ? original : alert;
    }, BLINK_MS);

    return () => {
      clearInterval(timer);
      document.title = original;
    };
  }, [pendingCount]);
}
