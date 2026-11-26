/**
 * 이송 상태가 바뀌면 맞는 화면으로 보낸다 (Lovable app-gate 의 '이송 건 상태 → 화면' 그대로).
 * 팀원이 다른 폰에서 요청·확정해도 같은 화면으로 따라간다. 처음 그릴 때는 움직이지 않는다 (앱을 켜면 홈에서 시작).
 */
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useEngine } from '../engine';
import { routeForStatus } from '../routing';

export function TransportRouter() {
  const e = useEngine();
  const router = useRouter();
  const prev = useRef<string>('');

  useEffect(() => {
    const key = `${e.status}:${e.phoneTarget}`;
    if (key === prev.current) return;
    const first = prev.current === '';
    prev.current = key;
    if (first || !e.status) return;
    if (e.status === 'cancelled') {
      router.dismissTo('/');
      return;
    }
    const to = routeForStatus(e.status, e.phoneTarget);
    if (to) router.navigate(to);
  }, [e.status, e.phoneTarget, router]);

  return null;
}
