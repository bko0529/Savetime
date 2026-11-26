/**
 * 색 · 글꼴 · 모서리. Lovable 웹앱(styles.css)의 oklch 색을 hex 로 그대로 옮겼다.
 * 웹의 그라디언트 버튼은 앱에서 단색(그라디언트의 가운데 색) + 그림자로 바꿨다.
 */
import type { TextStyle } from 'react-native';

export const color = {
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
  /** 로고 가이드 고정 색 */
  logoNavy: '#14284B',
  logoRed: '#E60012',
} as const;

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
} as const;
