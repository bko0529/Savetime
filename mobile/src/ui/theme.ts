/**
 * 색 · 글꼴 · 모서리. Lovable 웹앱(styles.css)의 oklch 색을 hex 로 그대로 옮겼다.
 * 웹의 그라디언트 버튼은 앱에서 단색(그라디언트의 가운데 색) + 그림자로 바꿨다.
 */
import type { TextStyle } from 'react-native';

const light = {
  background: '#F5F8FB',
  foreground: '#0E1624',
  card: '#FFFFFF',
  primary: '#1E2124',
  primaryText: '#FBFAF7',
  secondary: '#E9EDF2',
  muted: '#666E7A',
  accent: '#D81F23',
  accentButton: '#D41A24',
  accentText: '#FCFCFC',
  accentSoft: '#FFE9E5',
  accentDeep: '#A91518',
  success: '#007D65',
  successButton: '#007A63',
  successSoft: '#D7F7ED',
  warning: '#9D6300',
  warningSoft: '#FEEFCF',
  infoSoft: '#E7F2FC',
  infoText: '#252E3D',
  destructive: '#B91C1E',
  border: '#E0E4E8',
  borderStrong: '#CAD0D6',
  surface: '#F1F5F9',
  surface2: '#E7EEF3',
  headerTint: '#E7F2FA',
  /** 머리글·로그인 바탕 그라디언트 (Lovable --gradient-header: 흰색 → 옅은 파랑 → 옅은 분홍) */
  glowStart: '#FFFFFF',
  glowMid: '#F1F5FA',
  glowEnd: '#F3E8EA',
  /** 진한 글자색을 아주 옅게 깐 바탕 (아이콘 칸 등) */
  inkTint: 'rgba(30,33,36,0.08)',
  /** 아래 고정 버튼 줄 바탕 (살짝 비침) */
  footer: 'rgba(255,255,255,0.96)',
  /** 로고 가이드 고정 색 (어두운 화면에서는 남색 선이 안 보여 밝게) */
  logoNavy: '#14284B',
  logoRed: '#E60012',
  shadow: '#1A2233',
};
export type Palette = typeof light;

/**
 * 야간 구급차 안에서 눈부시지 않게 (QUR-005). 브랜드 색(남색·구급 빨강)은 그대로 두고 밝기만 뒤집었다.
 * 버튼 바탕(primary)은 어두운 화면에서 밝은 색으로 바꿔 대비를 유지한다
 */
const dark: Palette = {
  background: '#0F1216',
  foreground: '#E8ECF1',
  card: '#171B21',
  primary: '#E8ECF1',
  primaryText: '#0F1216',
  secondary: '#232932',
  muted: '#9AA3AE',
  accent: '#F0443A',
  accentButton: '#D93A30',
  accentText: '#FCFCFC',
  accentSoft: '#3A1A19',
  accentDeep: '#FF8A80',
  success: '#2BBF97',
  successButton: '#11896F',
  successSoft: '#10332A',
  warning: '#F0B44C',
  warningSoft: '#3A2D12',
  infoSoft: '#16283A',
  infoText: '#CFE3F5',
  destructive: '#F05252',
  border: '#2A3038',
  borderStrong: '#3A424C',
  surface: '#1C2128',
  surface2: '#232932',
  headerTint: '#16283A',
  glowStart: '#1A1F26',
  glowMid: '#14181D',
  glowEnd: '#21181A',
  inkTint: 'rgba(232,236,241,0.10)',
  footer: 'rgba(23,27,33,0.96)',
  logoNavy: '#DCE6F7',
  logoRed: '#FF3B3B',
  shadow: '#000000',
};

export type Scheme = 'light' | 'dark';
/**
 * 지금 쓰는 색. 화면은 color.xxx 를 그릴 때마다 읽으므로, 테마가 바뀌면 값만 바꿔 넣고 화면을 다시 그린다.
 * (파일을 불러올 때 색을 고정하는 StyleSheet 는 onSchemeChange 로 다시 만든다)
 */
export const color: Palette = { ...light };
let current: Scheme = 'light';
const listeners = new Set<() => void>();
export const currentScheme = () => current;
export function onSchemeChange(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export function applyScheme(sc: Scheme) {
  if (sc === current) return;
  current = sc;
  Object.assign(color, sc === 'dark' ? dark : light);
  shadow.card.shadowColor = color.shadow;
  shadow.card.shadowOpacity = sc === 'dark' ? 0.4 : 0.08;
  listeners.forEach((f) => f());
}

export const radius = { sm: 8, md: 12, lg: 16, xl: 20 } as const;

/** Pretendard 굵기별 이름 (app/_layout.tsx 에서 불러옴). RN 은 fontWeight 만으로 굵기 파일을 못 고른다 */
export const font = {
  regular: 'Pretendard-Regular',
  semibold: 'Pretendard-SemiBold',
  bold: 'Pretendard-Bold',
  extrabold: 'Pretendard-ExtraBold',
} as const;

export const text = {
  title: { fontFamily: font.extrabold, fontSize: 23, lineHeight: 29, letterSpacing: -0.4 },
  h2: { fontFamily: font.extrabold, fontSize: 18, lineHeight: 24 },
  body: { fontFamily: font.regular, fontSize: 14, lineHeight: 21 },
  small: { fontFamily: font.regular, fontSize: 13, lineHeight: 20 },
  caption: { fontFamily: font.regular, fontSize: 12, lineHeight: 18 },
  strong: { fontFamily: font.extrabold, fontSize: 14, lineHeight: 20 },
} satisfies Record<string, TextStyle>;

export const shadow = {
  card: {
    shadowColor: '#1A2233',
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  /** 떠 있는 카드 (알림 카드 · Lovable elevate-lg) */
  lift: {
    shadowColor: '#1A2233',
    shadowOpacity: 0.16,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
};
