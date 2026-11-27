/**
 * 이송 상태가 바뀌면 맞는 화면으로 보낸다 (Lovable app-gate 의 '이송 건 상태 → 화면' 그대로).
 * 팀원이 다른 폰에서 요청·확정해도 같은 화면으로 따라간다. 처음 그릴 때는 움직이지 않는다 (앱을 켜면 홈에서 시작).
 * 환자 정보 입력 화면에서 요청하면 그 화면을 요청 화면으로 '바꿔' 연다 (뒤로 가기로 입력 화면이 다시 나오지 않게).
 */
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useEngine } from '../engine';
import { routeForStatus } from '../routing';

export function TransportRouter() {
  const e = useEngine();
  const router = useRouter();
  const path = usePathname();
  const pathRef = useRef(path);
  pathRef.current = path;
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
    if (!to) return;
    if (pathRef.current === '/patient') router.replace(to);
    else router.navigate(to);
  }, [e.status, e.phoneTarget, router]);

  return null;
}
