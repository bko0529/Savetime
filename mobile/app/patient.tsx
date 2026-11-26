/**
 * 환자 정보 입력 (CR-007 필수 12개, SFR-004 · SFR-105 · SFR-163). 구성·문구는 Lovable patient 화면 그대로.
 * 3단계: ① 병원 등급 · 주 증상 · 성별·나이대 ② 의식 · 활력징후 ③ 통증 · 외상 · 선택 항목
 * - 필수 12개가 다 차면 어느 단계에서든 요청할 수 있다. 모르는 칸은 '확인 불가'로 보낼 수 있다
 * - 진행 중 이송이 있으면 같은 화면이 '변경 사항 보내기'가 된다 (SFR-105)
 * - 이름 · 주민번호 · 연락처 칸은 없다 (SER-012)
 */
import { useRouter } from 'expo-router';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  Hospital,
  Stethoscope,
  UserCheck,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { actions, previewTargets, useEngine } from '../src/transport/engine';
import { START_RADIUS, type Grade } from '../src/transport/hospitals';
import { vitalWarnings } from '../src/transport/labels';
import { filledCount, REQUIRED_FIELDS, UNKNOWN, type Patient } from '../src/transport/patient';
import { setPatient, usePatient } from '../src/transport/patientStore';
import { isActive } from '../src/transport/types';
import {
  BigButton,
  Chips,
  Field,
  Label,
  Notice,
  PhoneScreen,
  Pill,
  SectionTitle,
  Txt,
} from '../src/ui/kit';
import { color, font, radius, text } from '../src/ui/theme';

const GRADES: { g: Exclude<Grade, null>; sub: string; icon: LucideIcon }[] = [
  { g: '대학병원급', sub: '권역센터', icon: Building2 },
  { g: '종합병원급', sub: '지역센터', icon: Hospital },
  { g: '일반 병원', sub: '지역기관', icon: Stethoscope },
];
const CONSC = ['명료', '말에 반응', '통증에 반응', '무반응'] as const;
const AGES = [
  '10세 미만',
  '10대',
  '20대',
  '30대',
  '40대',
  '50대',
  '60대',
  '70대',
  '80대 이상',
] as const;
const KTAS = ['1', '2', '3', '4', '5'] as const;
const STEP_HINT = [
  '1단계 · 병원 등급 · 주 증상 · 성별·나이대',
  '2단계 · 의식 · 활력징후',
  '3단계 · 통증 · 외상 · 선택 항목',
];
const FOOT_HINT = [
  '필수 항목이 모두 채워지면 어느 단계에서든 요청할 수 있어요',
  '← 이전 단계로 돌아가 언제든 고칠 수 있어요',
  '이름 · 주민번호 · 연락처는 받지 않아요',
];

export default function PatientScreen() {
  const router = useRouter();
  const p = usePatient();
  const e = useEngine();
  const active = isActive(e.status);
  const [step, setStep] = useState(1);
  const [sending, setSending] = useState(false);
  const [targets, setTargets] = useState<number | null>(null);

  const set = <K extends keyof Patient>(k: K, v: Patient[K]) => setPatient({ ...p, [k]: v });
  const count = filledCount(p);
  const allDone = count === REQUIRED_FIELDS.length;
  const warnings = vitalWarnings(p);

  // 'n곳에 요청합니다': 서버가 지금 위치·등급으로 센다 (SFR-163)
  useEffect(() => {
    let alive = true;
    void previewTargets(p.grade).then((n) => alive && setTargets(n));
    return () => {
      alive = false;
    };
  }, [p.grade]);

  const send = async () => {
    setSending(true);
    const r = active ? await actions.updateAssessment(p) : await actions.create(p.grade, p);
    setSending(false);
    if (!r.ok) return Alert.alert('보내지 못했어요', r.error);
    if (active) Alert.alert('변경 사항을 병원에 보냈어요', '병원 화면에 강조 표시돼요');
    // 요청하면 이송 상태가 바뀌어 요청 화면으로 간다 (TransportRouter)
    router.back();
  };

  const fillUnknown = () => {
    const next = { ...p };
    REQUIRED_FIELDS.forEach((k) => {
      if (!String(next[k]).trim()) (next[k] as string) = UNKNOWN;
    });
    setPatient(next);
  };

  const field = (k: keyof Patient, label: string, ph: string, unit?: string) => (
    <View style={{ flex: 1 }}>
      <Label>{label}</Label>
      <View>
        <Field
          value={p[k] as string}
          placeholder={ph}
          onChangeText={(v) => set(k, v)}
          keyboardType={unit ? (k === 'bp' ? 'numbers-and-punctuation' : 'decimal-pad') : 'default'}
          style={unit ? { paddingRight: 56 } : undefined}
          accessibilityLabel={label}
        />
        {unit ? (
          <Txt
            style={{
              position: 'absolute',
              right: 14,
              top: 17,
              fontFamily: font.bold,
              fontSize: 11,
              color: color.muted,
            }}
            pointerEvents="none"
          >
            {unit}
          </Txt>
        ) : null}
      </View>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <PhoneScreen
        title={active ? '환자 정보 변경' : '환자 정보 입력'}
        subtitle={allDone ? '필수 12개 모두 입력됨' : `필수 12개 중 ${count}개 입력됨`}
        badge={
          <Pill tone={allDone ? 'ok' : 'wait'} dot={false}>
            {`${step}/3`}
          </Pill>
        }
        footer={
          <>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {step > 1 ? (
                <BigButton
                  variant="outline"
                  style={{ width: 96 }}
                  onPress={() => setStep(step - 1)}
                  icon={<ArrowLeft size={16} color={color.foreground} />}
                >
                  이전
                </BigButton>
              ) : null}
              {step < 3 ? (
                <BigButton variant="outline" style={{ flex: 1 }} onPress={() => setStep(step + 1)}>
                  {step === 1 ? '다음: 활력징후 →' : '다음: 통증 · 외상 →'}
                </BigButton>
              ) : null}
            </View>
            <BigButton size="lg" disabled={!allDone} busy={sending} onPress={() => void send()}>
              {active ? '변경 사항 보내기' : '병원에 요청'}
            </BigButton>
            <Txt style={[text.caption, { textAlign: 'center', color: color.muted }]}>
              {FOOT_HINT[step - 1]}
            </Txt>
          </>
        }
      >
        {/* 진행 점: 눌러서 단계로 바로 */}
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {[1, 2, 3].map((s) => (
            <Pressable
              key={s}
              onPress={() => setStep(s)}
              accessibilityRole="button"
              accessibilityLabel={`${s}단계`}
              style={{
                flex: 1,
                height: 6,
                borderRadius: 3,
                backgroundColor:
                  s === step ? color.accent : s < step ? 'rgba(30,33,36,0.7)' : color.borderStrong,
              }}
            />
          ))}
        </View>
        <Txt
          style={{
            marginTop: 8,
            marginBottom: 20,
            fontFamily: font.semibold,
            fontSize: 12,
            color: color.muted,
          }}
        >
          {STEP_HINT[step - 1]}
        </Txt>

        {step === 1 ? (
          <>
            <SectionTitle
              first
              hint="고른 등급 이상 병원에만 요청해요. 안 고르면 모든 병원에 요청해요."
            >
              병원 등급 (선택)
            </SectionTitle>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {GRADES.map(({ g, sub, icon: Icon }) => {
                const on = p.grade === g;
                return (
                  <Pressable
                    key={g}
                    onPress={() => set('grade', on ? null : g)}
                    accessibilityRole="button"
                    accessibilityLabel={g}
                    accessibilityState={{ selected: on }}
                    style={{
                      flex: 1,
                      alignItems: 'center',
                      gap: 4,
                      paddingVertical: 14,
                      borderRadius: radius.md,
                      borderWidth: 2,
                      borderColor: on ? color.accent : color.border,
                      backgroundColor: on ? color.accentSoft : color.card,
                    }}
                  >
                    <Icon size={20} color={on ? color.accentDeep : color.muted} />
                    <Txt
                      style={{
                        fontFamily: font.extrabold,
                        fontSize: 13,
                        color: on ? color.accentDeep : color.foreground,
                      }}
                    >
                      {g}
                    </Txt>
                    <Txt style={{ fontSize: 11, color: color.muted }}>{sub}</Txt>
                  </Pressable>
                );
              })}
            </View>

            <SectionTitle>주 증상 (필수)</SectionTitle>
            {field('complaint', '직접 입력하세요', '예: 갑작스러운 극심한 두통, 의식 저하')}

            <View style={{ marginTop: 16 }}>
              <Label>성별</Label>
              <Chips
                value={p.sex as '남'}
                options={['남', '여', UNKNOWN] as const}
                onChange={(v) => set('sex', v)}
              />
            </View>
            <View style={{ marginTop: 16 }}>
              <Label>나이대</Label>
              <Chips
                value={p.age as (typeof AGES)[number]}
                options={[...AGES, UNKNOWN] as const}
                onChange={(v) => set('age', v)}
              />
            </View>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <SectionTitle first>의식 수준</SectionTitle>
            <Chips
              value={p.consciousness as (typeof CONSC)[number]}
              options={[...CONSC, UNKNOWN] as const}
              onChange={(v) => set('consciousness', v)}
            />
            <View style={{ marginTop: 20, gap: 16 }}>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                {field('bp', '혈압', '160/95', 'mmHg')}
                {field('pulse', '맥박', '88', 'bpm')}
              </View>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                {field('resp', '호흡수', '20', '/min')}
                {field('spo2', '산소포화도', '89', '%')}
              </View>
            </View>
            {warnings.length > 0 ? (
              <View style={{ marginTop: 20 }}>
                <Notice tone="warn">
                  {warnings.join(' · ')} · 정상 범위 밖이라 병원 웹에 빨간색으로 보여요
                </Notice>
              </View>
            ) : null}
          </>
        ) : null}

        {step === 3 ? (
          <>
            <View style={{ gap: 16 }}>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                {field('painSite', '통증 부위', '머리')}
                {field('painScore', '통증 정도', '8', '/10')}
              </View>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                {field('onset', '증상 시작', '30분 전')}
                {field('trauma', '외상', '없음')}
              </View>
              {field('history', '과거력 (선택)', '고혈압, 당뇨')}
            </View>

            <SectionTitle hint="몰라도 요청할 수 있어요">선택 항목</SectionTitle>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {field('temp', '체온', '36.5', '℃')}
              {field('glucose', '혈당', '120', 'mg/dL')}
            </View>
            <View style={{ marginTop: 12 }}>
              <Label>KTAS</Label>
              <Chips
                value={p.ktas as (typeof KTAS)[number]}
                options={KTAS}
                onChange={(v) => set('ktas', p.ktas === v ? '' : v)}
              />
            </View>
            <BigButton
              variant="outline"
              style={{ marginTop: 16 }}
              onPress={fillUnknown}
              icon={<UserCheck size={16} color={color.foreground} />}
            >
              나머지 확인 불가로 보내기
            </BigButton>
            {!active ? (
              <View
                style={{
                  marginTop: 20,
                  padding: 14,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: color.border,
                  backgroundColor: color.surface,
                }}
              >
                <Txt style={text.strong}>
                  {p.grade ? `${p.grade} 이상 · ` : '모든 등급 · '}반경 {START_RADIUS}km 안{' '}
                  {targets ?? '-'}곳에 요청합니다
                </Txt>
                <Txt style={[text.caption, { marginTop: 4, color: color.muted }]}>
                  등급 바꾸기는 1단계에서
                </Txt>
              </View>
            ) : null}
          </>
        ) : null}

        {!allDone && step === 3 ? (
          <View style={{ marginTop: 16, flexDirection: 'row', gap: 6 }}>
            <AlertTriangle size={14} color={color.warning} style={{ marginTop: 2 }} />
            <Txt style={[text.caption, { flex: 1, color: color.warning }]}>
              빈 필수 칸: {REQUIRED_FIELDS.filter((k) => !String(p[k]).trim()).length}개 · 모르면
              &apos;확인 불가&apos;로 보내세요
            </Txt>
          </View>
        ) : null}
      </PhoneScreen>
    </KeyboardAvoidingView>
  );
}
