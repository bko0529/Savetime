/**
 * 휴대폰의 전화 걸기 (tel:).
 * 길 안내는 다른 앱으로 넘기지 않고 앱 안 '길 안내' 페이지(app/navi.tsx, 카카오내비 내장)에서 한다 (D-137)
 */
import { Linking } from 'react-native';

export function callNumber(num: string | null | undefined) {
  const digits = (num ?? '').replace(/[^\d+]/g, '');
  if (digits) void Linking.openURL(`tel:${digits}`).catch(() => undefined);
}
