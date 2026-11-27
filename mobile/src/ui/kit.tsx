/**
 * 구급대원 앱 공용 부품. Lovable components/phone.tsx 를 React Native 로 옮겼다.
 * 모든 화면이 이 부품을 쓰므로 여기서 색·여백을 고치면 전체가 같이 바뀐다.
 */
import type { ReactNode } from 'react';
import { Check } from 'lucide-react-native';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { color, font, onSchemeChange, radius, shadow, text } from './theme';

/** 글자: 기본 글꼴을 Pretendard 로 */
export function Txt({ style, ...props }: TextProps) {
  return <Text {...props} style={[{ fontFamily: font.regular, color: color.foreground }, style]} />;
}

/** 심전도선: 머리글을 가로지르는 생명선 */
export function EcgLine({
  width = 176,
  tint = color.accent,
  opacity = 0.45,
}: {
  width?: number;
  tint?: string;
  opacity?: number;
}) {
  return (
    <Svg
      width={width}
      height={(width * 40) / 220}
      viewBox="0 0 220 40"
      fill="none"
      opacity={opacity}
    >
      <Path
        d="M0 22 H52 L62 22 68 10 74 32 80 4 87 36 93 22 H128 L136 22 141 15 146 27 151 22 H220"
        stroke={tint}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** 골든타임즈 심볼 (로고 가이드 색 고정) */
export function LogoMark({ size = 44 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" fill="none" accessibilityLabel="골든타임즈">
      <Path
        d="M24 14A14 14 0 1 1 10 28H31M20 7.5H28M24 7.5V14"
        stroke={color.logoNavy}
        strokeWidth={4.5}
        strokeLinecap="round"
      />
      <Path d="M24 21V35" stroke={color.logoRed} strokeWidth={4.5} strokeLinecap="round" />
    </Svg>
  );
}

/**
 * 한 화면: 머리글(제목·부제·오른쪽 표시) + 스크롤 내용 + 아래 고정 버튼.
 * accent = 긴급·주의 화면이라 머리글을 신호색으로.
 */
export function PhoneScreen({
  title,
  subtitle,
  badge,
  footer,
  accent = false,
  children,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  footer?: ReactNode;
  accent?: boolean;
  children: ReactNode;
}) {
  const fg = accent ? color.accentText : color.foreground;
  return (
    <SafeAreaView style={s.screen} edges={['top', 'left', 'right']}>
      <View style={[s.header, accent && s.headerAccent]}>
        <View style={s.headerEcg} pointerEvents="none">
          <EcgLine tint={accent ? color.accentText : color.accent} opacity={accent ? 0.3 : 0.45} />
        </View>
        <View style={s.headerRow}>
          <View style={{ flex: 1 }}>
            <Txt style={[text.title, { color: fg }]} accessibilityRole="header">
              {title}
            </Txt>
            {subtitle ? (
              <Txt
                style={[
                  text.body,
                  { marginTop: 6, color: accent ? 'rgba(252,252,252,0.75)' : color.muted },
                ]}
              >
                {subtitle}
              </Txt>
            ) : null}
          </View>
          {badge ? <View style={{ paddingTop: 2 }}>{badge}</View> : null}
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>

      {footer ? (
        <SafeAreaView edges={['bottom']} style={s.footer}>
          {footer}
        </SafeAreaView>
      ) : null}
    </SafeAreaView>
  );
}

type ButtonVariant = 'primary' | 'outline' | 'success' | 'danger' | 'accent' | 'ghost';
const btnBg = (): Record<ButtonVariant, string> => ({
  primary: color.primary,
  outline: color.card,
  success: color.successButton,
  danger: color.destructive,
  accent: color.accentButton,
  ghost: 'transparent',
});
const btnFg = (): Record<ButtonVariant, string> => ({
  primary: color.primaryText,
  outline: color.foreground,
  success: color.accentText,
  danger: color.accentText,
  accent: color.accentText,
  ghost: color.muted,
});

export function BigButton({
  children,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  busy,
  icon,
  accessibilityLabel,
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  /** 서버 응답을 기다리는 중: 돌아가는 표시 + 다시 못 누름 */
  busy?: boolean;
  icon?: ReactNode;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  // 핵심 버튼은 장갑 낀 손으로도 누르게 48 이상 (QUR-006)
  const h = { sm: 48, md: 52, lg: 56 }[size];
  const fs = { sm: 14, md: 15, lg: 16 }[size];
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={
        accessibilityLabel ?? (typeof children === 'string' ? children : undefined)
      }
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => [
        s.button,
        { height: h, backgroundColor: btnBg()[variant] },
        variant === 'outline' && s.buttonOutline,
        variant !== 'outline' && variant !== 'ghost' && shadow.card,
        disabled && (variant === 'primary' ? s.buttonDisabledPrimary : s.buttonDisabled),
        pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={btnFg()[variant]} />
      ) : (
        <View style={s.buttonInner}>
          {icon}
          <Txt
            style={{
              fontFamily: font.bold,
              fontSize: fs,
              color: disabled && variant === 'primary' ? color.muted : btnFg()[variant],
            }}
          >
            {children}
          </Txt>
        </View>
      )}
    </Pressable>
  );
}

export type Tone = 'wait' | 'call' | 'ok' | 'neutral' | 'danger';
const toneStyle = (): Record<Tone, { bg: string; fg: string; border: string }> => ({
  wait: { bg: color.warningSoft, fg: color.warning, border: 'rgba(157,99,0,0.25)' },
  call: { bg: color.accentSoft, fg: color.accentDeep, border: 'rgba(216,31,35,0.25)' },
  ok: { bg: color.successSoft, fg: color.success, border: 'rgba(0,125,101,0.25)' },
  neutral: { bg: color.surface2, fg: color.muted, border: color.border },
  danger: { bg: 'rgba(185,28,30,0.1)', fg: color.destructive, border: 'rgba(185,28,30,0.25)' },
});

/** 상태 표시: 점이 같이 가서 색만 봐도 읽힘 */
export function Pill({
  tone,
  children,
  dot = true,
  icon,
}: {
  tone: Tone;
  children: ReactNode;
  dot?: boolean;
  icon?: ReactNode;
}) {
  const t = toneStyle()[tone];
  return (
    <View style={[s.pill, { backgroundColor: t.bg, borderColor: t.border }]}>
      {dot && !icon ? <View style={[s.dot, { backgroundColor: t.fg }]} /> : null}
      {icon}
      <Txt style={{ fontFamily: font.bold, fontSize: 12, color: t.fg }}>{children}</Txt>
    </View>
  );
}

const noticeStyle = () =>
  ({
    warn: { bg: color.warningSoft, fg: color.warning, border: 'rgba(157,99,0,0.3)' },
    ok: { bg: color.successSoft, fg: color.success, border: 'rgba(0,125,101,0.3)' },
    info: { bg: color.infoSoft, fg: color.infoText, border: 'rgba(202,208,214,0.6)' },
    error: { bg: color.accentSoft, fg: color.accentDeep, border: 'rgba(216,31,35,0.3)' },
  }) as const;

/** 안내 상자: 왼쪽에 신호 점 */
export function Notice({
  tone,
  children,
}: {
  tone: keyof ReturnType<typeof noticeStyle>;
  children: ReactNode;
}) {
  const t = noticeStyle()[tone];
  return (
    <View
      style={[s.notice, { backgroundColor: t.bg, borderColor: t.border }]}
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
    >
      <View style={[s.dot, { width: 8, height: 8, marginTop: 6, backgroundColor: t.fg }]} />
      <Txt
        style={{ flex: 1, fontFamily: font.semibold, fontSize: 14, lineHeight: 21, color: t.fg }}
      >
        {children}
      </Txt>
    </View>
  );
}

const iconTone = () =>
  ({
    accent: { bg: color.accentSoft, fg: color.accentDeep },
    ink: { bg: color.inkTint, fg: color.primary },
    warn: { bg: color.warningSoft, fg: color.warning },
    ok: { bg: color.successSoft, fg: color.success },
  }) as const;
export type IconTone = keyof ReturnType<typeof iconTone>;
export const iconColor = (tone: IconTone) => iconTone()[tone].fg;

/** 카드 안 머리 아이콘. round = 큰 원 (빈 화면 가운데) */
export function IconTile({
  tone = 'accent',
  size = 44,
  round,
  children,
}: {
  tone?: IconTone;
  size?: number;
  round?: boolean;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: round ? size / 2 : Math.min(16, size / 2.75),
        backgroundColor: iconTone()[tone].bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </View>
  );
}

/** 흰 카드 (선으로 나눈 목록 칸) */
export function Tile({
  children,
  style,
  divided,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  divided?: boolean;
}) {
  if (!divided) return <View style={[s.tile, style]}>{children}</View>;
  const items = (Array.isArray(children) ? children : [children]).filter(Boolean);
  return (
    <View style={[s.tile, style]}>
      {items.map((c, i) => (
        <View key={i} style={i > 0 ? s.divider : undefined}>
          {c}
        </View>
      ))}
    </View>
  );
}

/** 카드 안의 값 한 줄 (설정 · 신청 내역) */
export function KeyVal({
  label,
  value,
  valueStyle,
}: {
  label: ReactNode;
  value: ReactNode;
  valueStyle?: StyleProp<TextStyle>;
}) {
  return (
    <View style={s.keyval}>
      <Txt style={[text.body, { color: color.muted }]}>{label}</Txt>
      <Txt style={[{ fontFamily: font.bold, fontSize: 14, textAlign: 'right' }, valueStyle]}>
        {value}
      </Txt>
    </View>
  );
}

/** 입력 칸 위 작은 제목 */
export function Label({ children }: { children: ReactNode }) {
  return <Txt style={s.label}>{children}</Txt>;
}

/** 빈 화면 가운데: 큰 아이콘 + 제목 + 설명 */
export function CenterMessage({
  icon,
  title,
  body,
  tone = 'warn',
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  tone?: IconTone;
}) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 56 }}>
      <IconTile tone={tone} size={64} round>
        {icon}
      </IconTile>
      <Txt style={[text.h2, { marginTop: 20, textAlign: 'center' }]}>{title}</Txt>
      {body ? (
        <Txt style={[text.body, { marginTop: 6, color: color.muted, textAlign: 'center' }]}>
          {body}
        </Txt>
      ) : null}
    </View>
  );
}

/** 입력 칸 */
export function Field({ style, ...props }: TextInputProps) {
  return (
    <TextInput placeholderTextColor={color.borderStrong} {...props} style={[s.field, style]} />
  );
}

/** 구역 제목: 빨간 막대 + 제목 + 설명 한 줄 */
export function SectionTitle({
  children,
  hint,
  first,
}: {
  children: ReactNode;
  hint?: string;
  first?: boolean;
}) {
  return (
    <View style={{ marginTop: first ? 0 : 32, marginBottom: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 3.5, height: 14, borderRadius: 2, backgroundColor: color.accent }} />
        {typeof children === 'string' ? (
          <Txt style={{ fontFamily: font.extrabold, fontSize: 15 }}>{children}</Txt>
        ) : (
          children
        )}
      </View>
      {hint ? (
        <Txt style={[text.caption, { marginTop: 6, paddingLeft: 11, color: color.muted }]}>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

/** 체크 상자 + 문구 (필수 동의 등) */
export function CheckRow({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      onPress={() => onChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      style={s.checkRow}
    >
      <View style={[s.checkBox, checked && s.checkBoxOn]}>
        {checked ? <Check size={14} color={color.accentText} /> : null}
      </View>
      <View style={{ flex: 1 }}>{children}</View>
    </Pressable>
  );
}

/** 여러 개 중 하나 고르기 (계급 · 역할) */
export function Chips<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable
            key={o}
            onPress={() => onChange(o)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={[s.chip, on && s.chipOn]}
          >
            <Txt
              style={{
                fontFamily: font.bold,
                fontSize: 14,
                color: on ? color.primaryText : color.foreground,
              }}
            >
              {o}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 이름 두 글자만 넣은 칸 (팀원 · 대원 목록) */
export function Avatar({
  name,
  tone = 'ink',
}: {
  name: string;
  tone?: 'ink' | 'accent' | 'muted';
}) {
  const t = {
    ink: { bg: color.primary, fg: color.primaryText },
    accent: { bg: color.accentSoft, fg: color.accentDeep },
    muted: { bg: color.surface2, fg: color.muted },
  }[tone];
  return (
    <View style={[s.avatar, { backgroundColor: t.bg }]}>
      <Txt style={{ fontFamily: font.extrabold, fontSize: 14, color: t.fg }}>
        {name.slice(0, 2)}
      </Txt>
    </View>
  );
}

/** 맞붙은 선택 (팀 만들기/참여, 처치/운전) */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  small,
}: {
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <View style={[s.segment, small && { padding: 3, borderRadius: radius.sm }]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            disabled={o.disabled}
            accessibilityRole="tab"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: on, disabled: !!o.disabled }}
            style={[
              s.segmentItem,
              small && { paddingVertical: 6, paddingHorizontal: 10, flex: 0, borderRadius: 6 },
              on && s.segmentOn,
              o.disabled && { opacity: 0.35 },
            ]}
          >
            <Txt
              style={{
                fontFamily: font.bold,
                fontSize: small ? 12 : 14,
                color: on ? (small ? color.accentDeep : color.foreground) : color.muted,
              }}
            >
              {o.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

// 테마(밝게/어둡게)가 바뀌면 색이 들어간 스타일을 다시 만든다 (QUR-005)
let s = makeStyles();
onSchemeChange(() => {
  s = makeStyles();
});
function makeStyles() {
  return StyleSheet.create({
    avatar: {
      width: 40,
      height: 40,
      borderRadius: radius.lg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    segment: {
      flexDirection: 'row',
      gap: 4,
      padding: 4,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface2,
    },
    segmentItem: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: radius.sm,
    },
    segmentOn: { backgroundColor: color.card, ...shadow.card },
    field: {
      height: 52,
      paddingHorizontal: 14,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.card,
      fontFamily: font.regular,
      fontSize: 16,
      color: color.foreground,
    },
    checkRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      borderRadius: radius.md,
      backgroundColor: color.surface,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    checkBox: {
      width: 20,
      height: 20,
      marginTop: 1,
      borderRadius: 5,
      borderWidth: 1.5,
      borderColor: color.borderStrong,
      backgroundColor: color.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkBoxOn: { backgroundColor: color.accent, borderColor: color.accent },
    chip: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.card,
    },
    chipOn: { backgroundColor: color.primary, borderColor: color.primary },
    screen: { flex: 1, backgroundColor: color.background },
    header: {
      overflow: 'hidden',
      paddingHorizontal: 20,
      paddingTop: 24,
      paddingBottom: 28,
      backgroundColor: color.card,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    headerAccent: { backgroundColor: color.accentButton, borderBottomColor: color.accentDeep },
    headerEcg: { position: 'absolute', right: -16, bottom: 4 },
    headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    content: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 48 },
    footer: {
      paddingHorizontal: 20,
      paddingTop: 14,
      paddingBottom: 6,
      gap: 8,
      backgroundColor: color.footer,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
    },
    button: {
      borderRadius: radius.lg,
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
    },
    buttonInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    buttonOutline: { borderWidth: 1, borderColor: color.borderStrong },
    buttonDisabled: { opacity: 0.45 },
    buttonDisabledPrimary: { backgroundColor: color.secondary, shadowOpacity: 0, elevation: 0 },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      borderWidth: 1,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    dot: { width: 6, height: 6, borderRadius: 4 },
    notice: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      borderWidth: 1,
      borderRadius: radius.sm,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    tile: {
      backgroundColor: color.card,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: color.border,
      ...shadow.card,
    },
    divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border },
    keyval: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    label: {
      marginBottom: 6,
      fontFamily: font.bold,
      fontSize: 11,
      letterSpacing: 0.5,
      color: color.muted,
    },
  });
}
