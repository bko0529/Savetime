/**
 * 이송 상태가 바뀌면 맞는 화면으로 보낸다 (Lovable app-gate 의 '이송 건 상태 → 화면' 그대로).
 * - 앱을 켜고 서버에서 진행 중 이송을 처음 읽었을 때:
 *   진행 중이면 그 상태 화면으로 바로 (SFR-133), 없으면 환자 정보 입력이 첫 화면 (SFR-107)
 * - 그 뒤에는 팀원이 다른 폰에서 요청·확정해도 같은 화면으로 따라간다
 * - 이동 중: 길 안내 담당 폰·병원을 확정한 폰은 앱 안 길 안내 페이지(카카오내비)로 바로, 나머지 팀원 폰은 이송 화면
 * - 환자 정보 입력 화면에서 요청하면 그 화면을 요청 화면으로 '바꿔' 연다 (뒤로 가기로 입력 화면이 다시 나오지 않게)
 */
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useEngine } from '../engine';
import { routeForStatus } from '../routing';
import { isActive } from '../types';

export function TransportRouter() {
  const e = useEngine();
  const router = useRouter();
  const path = usePathname();
  const pathRef = useRef(path);
  pathRef.current = path;
  const prev = useRef<string | null>(null);

  useEffect(() => {
    // 서버에서 아직 안 읽었으면 기다린다 (홈이 잠깐 보였다가 바뀌지 않게)
    if (!e.loaded) return;
    const navHere = e.navIsMe || e.confirmedHere;
    const key = `${e.status}:${e.phoneTarget}:${navHere}`;
    if (prev.current === null) {
      // 앱을 켠 뒤 처음: 진행 중 이송이면 그 화면, 아니면 환자 정보 입력
      prev.current = key;
      const to = isActive(e.status) ? routeForStatus(e.status, e.phoneTarget, navHere) : '/patient';
      if (to && pathRef.current === '/') router.navigate(to);
      return;
    }
    if (key === prev.current) return;
    prev.current = key;
    if (!e.status) return;
    if (e.status === 'cancelled') {
      router.dismissTo('/');
      return;
    }
    const to = routeForStatus(e.status, e.phoneTarget, navHere);
    if (!to) return;
    // 길 안내 페이지에서 이송 화면으로 돌아온 뒤에는 다시 끌고 가지 않는다 (상태가 바뀔 때만 이동)
    if (pathRef.current === '/patient') router.replace(to);
    else router.navigate(to);
  }, [e.loaded, e.status, e.phoneTarget, e.navIsMe, e.confirmedHere, router]);

  return null;
}
