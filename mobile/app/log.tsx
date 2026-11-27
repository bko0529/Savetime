/**
 * S-13 구급활동일지 (SFR-164 · 165, DAR-015). 구성·문구는 Lovable log 화면 그대로.
 * - 이송이 끝나면: 이 폰의 환자 정보 + 서버 일지 초안으로 칸을 자동으로 채운다 ('자동' 표시)
 * - 칸마다 '수정'으로 고친다. '저장하고 홈으로'를 누르면 이 휴대폰에 7일 보관한다 (서버로는 안 보냄)
 * - 제출용 서식(별지 제5호서식) PDF 는 휴대폰 안에서 만들어 공유·인쇄한다
 * - 환자 성명은 PDF 에만 넣는 칸이다. 저장하지 않고 서버로도 보내지 않는다 (SER-012)
 * - ?id=… 로 열면 저장해 둔 일지를 다시 본다
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Check, FileDown, Pencil, Printer, Sparkles } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { useAuth } from '../src/auth/AuthProvider';
import { printSheet, sharePdf } from '../src/journal/exportPdf';
import {
  CARE,
  GRADES,
  HISTORY,
  initialLog,
  PLACES,
  SELECTOR,
  SYMPTOMS,
  TYPES,
  type LogData,
} from '../src/journal/form';
import { getJournal, saveJournal } from '../src/journal/storage';
import { actions, getEngine, hospital, loadJournalDraft } from '../src/transport/engine';
import { usePatient, resetPatient } from '../src/transport/patientStore';
import { BigButton, Field, Label, PhoneScreen, Tile, Txt } from '../src/ui/kit';
import { color, font, radius, text } from '../src/ui/theme';

export default function LogScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { state } = useAuth();
  const patient = usePatient();
  const [f, setF] = useState<LogData | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (id) {
        const j = await getJournal(id);
        if (alive) setF(j?.data ?? null);
        if (alive) setSavedId(j?.id ?? null);
        return;
      }
      // 병원이 '도착 확인'을 눌러 끝났거나 팀원 폰이면 이 폰에는 병원·시각·환자 정보가 없다 → 서버 초안으로 채운다
      const draft = await loadJournalDraft();
      const e = getEngine();
      const me = state.status === 'signedIn' ? state.me : {};
      const h = e.confirmedId ? hospital(e.confirmedId) : null;
      const at = (to: string) => e.history.find((x) => x.to === to)?.at;
      if (!alive) return;
      setF(
        initialLog({
          patient,
          draft,
          me,
          local: {
            hospitalName: h?.name,
            km: h?.km,
            departedAt: at('moving'),
            arrivedAt: at('arrived'),
          },
        }),
      );
    })();
    return () => {
      alive = false;
    };
  }, [id]); // 처음 한 번만 채운다 (고친 값을 덮어쓰지 않게)

  if (!f) {
    return (
      <PhoneScreen
        title="구급활동일지"
        subtitle={
          id ? '저장한 일지를 찾을 수 없어요 (7일이 지나면 지워져요)' : '일지를 채우는 중이에요'
        }
      >
        <View />
      </PhoneScreen>
    );
  }
  return <LogBody f={f} setF={setF} savedId={savedId} />;
}

function LogBody({
  f,
  setF,
  savedId,
}: {
  f: LogData;
  setF: (f: LogData) => void;
  savedId: string | null;
}) {
  const router = useRouter();
  const [patientName, setPatientName] = useState(''); // PDF 에만, 저장 안 함
  const [busy, setBusy] = useState<'pdf' | 'print' | 'save' | null>(null);
  const set = <K extends keyof LogData>(k: K, val: LogData[K]) => setF({ ...f, [k]: val });
  const toggle = (k: 'symptoms' | 'history' | 'care', item: string) =>
    set(k, f[k].includes(item) ? f[k].filter((x) => x !== item) : [...f[k], item]);

  const inp = (k: keyof LogData, label: string, ph = '') => (
    <View style={{ flex: 1 }}>
      <Label>{label}</Label>
      <Field
        value={f[k] as string}
        placeholder={ph}
        onChangeText={(t) => set(k, t as never)}
        accessibilityLabel={label}
        style={{ height: 44 }}
      />
    </View>
  );
  const chips = (k: 'symptoms' | 'history' | 'care', items: string[]) => (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {items.map((i) => (
        <Chip key={i} on={f[k].includes(i)} label={i} onPress={() => toggle(k, i)} />
      ))}
    </View>
  );
  const radio = (k: keyof LogData, items: string[]) => (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {items.map((i) => (
        <Chip key={i} on={f[k] === i} solid label={i} onPress={() => set(k, i as never)} />
      ))}
    </View>
  );

  const pdf = async (kind: 'pdf' | 'print') => {
    setBusy(kind);
    try {
      if (kind === 'pdf') await sharePdf(f, patientName.trim() || undefined);
      else await printSheet(f, patientName.trim() || undefined);
    } catch (e) {
      Alert.alert('PDF를 만들지 못했어요', e instanceof Error ? e.message : '다시 시도해 주세요');
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    const tid = savedId ?? getEngine().transportId ?? `local-${Date.now()}`;
    try {
      await saveJournal(tid, f);
    } catch {
      setBusy(null);
      return Alert.alert('저장하지 못했어요', '다시 시도해 주세요');
    }
    setBusy(null);
    if (!savedId) {
      // 이송 기록을 비우고 홈으로 (서버의 이송 건은 그대로)
      resetPatient();
      actions.reset();
    }
    Alert.alert('구급활동일지를 저장했어요', '이 휴대폰에 7일 동안 보관해요');
    router.dismissTo('/');
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <PhoneScreen
        title="구급활동일지"
        subtitle="별지 제5호서식 · 앱에서 입력한 내용이 자동으로 채워져요"
        footer={
          <>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <BigButton
                style={{ flex: 1 }}
                busy={busy === 'pdf'}
                onPress={() => void pdf('pdf')}
                icon={<FileDown size={18} color={color.primaryText} />}
              >
                PDF 공유
              </BigButton>
              <BigButton
                variant="outline"
                style={{ flex: 1 }}
                busy={busy === 'print'}
                onPress={() => void pdf('print')}
                icon={<Printer size={18} color={color.foreground} />}
              >
                인쇄
              </BigButton>
            </View>
            <BigButton variant="success" busy={busy === 'save'} onPress={() => void save()}>
              {savedId ? '고친 내용 저장하고 홈으로' : '저장하고 홈으로'}
            </BigButton>
          </>
        }
      >
        <View
          style={{
            marginBottom: 16,
            flexDirection: 'row',
            gap: 10,
            padding: 14,
            borderRadius: radius.md,
            backgroundColor: color.infoSoft,
          }}
        >
          <Sparkles size={16} color={color.accentDeep} style={{ marginTop: 2 }} />
          <Txt style={[text.body, { flex: 1 }]}>
            <Txt style={{ fontFamily: font.bold }}>자동</Txt> 표시가 있는 칸은 이송 중 기록으로
            채웠어요. 각 칸의 <Txt style={{ fontFamily: font.bold }}>수정</Txt>을 눌러 고칠 수
            있어요.
          </Txt>
        </View>

        <Section title="구급출동" auto>
          {(edit) =>
            edit ? (
              <View style={{ gap: 10 }}>
                <Pair>
                  {inp('callAt', '신고 일시', '00:00')}
                  {inp('dispatchAt', '출동 시각', '00:00')}
                </Pair>
                <Pair>
                  {inp('sceneAt', '현장 도착', '00:00')}
                  {inp('contactAt', '환자 접촉', '00:00')}
                </Pair>
                <Pair>
                  {inp('departAt', '현장 출발', '00:00')}
                  {inp('arriveAt', '병원 도착', '00:00')}
                </Pair>
                <Pair>
                  {inp('distance', '거리 (km)')}
                  {inp('returnAt', '귀소 시각', '00:00')}
                </Pair>
                {inp('carNo', '차량번호')}
                {inp('station', '소방서')}
                {inp('center', '안전센터')}
                <Label>구분</Label>
                {radio('kind', ['특수일반', '특수특별', '항공구급'])}
                <Label>신고방법</Label>
                {radio('reportMethod', ['일반전화', '휴대전화', '기타'])}
                <Label>출동 유형</Label>
                {radio('dispatchType', ['정상', '오인', '거짓', '취소', '기타'])}
              </View>
            ) : (
              <Rows
                rows={[
                  ['신고', f.callAt],
                  ['출동', f.dispatchAt],
                  ['현장 도착', f.sceneAt],
                  ['환자 접촉', f.contactAt],
                  ['현장 출발', f.departAt],
                  ['병원 도착', f.arriveAt],
                  ['귀소', f.returnAt],
                  ['거리', f.distance && `${f.distance}km`],
                  ['출동 유형', f.dispatchType],
                ]}
              />
            )
          }
        </Section>

        <Section
          title="환자 인적사항"
          auto
          note="이름 · 주민번호 · 연락처는 앱에 저장하지 않아요. 성명은 아래 칸에 넣으면 PDF에만 들어가요."
        >
          {(edit) =>
            edit ? (
              <View style={{ gap: 10 }}>
                <Label>성별</Label>
                {radio('sex', ['남', '여'])}
                {inp('age', '나이대')}
                <Label>환자 발생 장소</Label>
                {radio('place', PLACES)}
              </View>
            ) : (
              <Rows
                rows={[
                  ['성별', f.sex],
                  ['나이대', f.age],
                  ['발생 장소', f.place],
                ]}
              />
            )
          }
        </Section>

        <Section title="환자 증상 · 병력" auto>
          {(edit) =>
            edit ? (
              <View style={{ gap: 10 }}>
                <Label>증상 (복수 선택)</Label>
                {chips('symptoms', SYMPTOMS)}
                {inp('symptomEtc', '그 밖의 증상')}
                <Label>병력</Label>
                {chips('history', HISTORY)}
                {inp('historyEtc', '기타 병력')}
              </View>
            ) : (
              <Rows
                rows={[
                  ['증상', [...f.symptoms, f.symptomEtc].filter(Boolean).join(', ')],
                  ['병력', [...f.history, f.historyEtc].filter(Boolean).join(', ') || '없음'],
                ]}
              />
            )
          }
        </Section>

        <Section title="환자 발생 유형">
          {(edit) => (edit ? radio('type', TYPES) : <Rows rows={[['유형', f.type]]} />)}
        </Section>

        <Section title="환자 평가" auto>
          {(edit) =>
            edit ? (
              <View style={{ gap: 10 }}>
                <Label>의식 상태 (AVPU)</Label>
                {radio('avpu', ['A', 'V', 'P', 'U'])}
                <Label>동공 좌</Label>
                {radio('pupilL', ['정상', '축동', '산동', '측정불가'])}
                <Label>동공 우</Label>
                {radio('pupilR', ['정상', '축동', '산동', '측정불가'])}
                <Pair>
                  {inp('vitalTime', '시각', '00:00')}
                  {inp('pulse', '맥박')}
                </Pair>
                <Pair>
                  {inp('bpS', '수축기')}
                  {inp('bpD', '이완기')}
                </Pair>
                <Pair>
                  {inp('resp', '호흡')}
                  {inp('temp', '체온')}
                </Pair>
                <Pair>
                  {inp('spo2', 'SpO2')}
                  {inp('glucose', '혈당')}
                </Pair>
                <Label>환자분류 (LEVEL)</Label>
                {radio('ktas', ['1', '2', '3', '4', '5'])}
                {inp('complaint', '주 호소')}
                {inp('onset', '발생 시간')}
                {inp('opinion', '구급대원 평가소견')}
              </View>
            ) : (
              <Rows
                rows={[
                  ['의식', f.avpu],
                  ['동공', `좌 ${f.pupilL} · 우 ${f.pupilR}`],
                  [
                    '활력징후',
                    `${f.vitalTime || '-'} · 혈압 ${f.bpS || '-'}/${f.bpD || '-'} · 맥박 ${f.pulse || '-'} · 호흡 ${f.resp || '-'} · 체온 ${f.temp || '-'} · SpO2 ${f.spo2 || '-'}% · 혈당 ${f.glucose || '-'}`,
                  ],
                  ['환자분류', f.ktas && `LEVEL ${f.ktas}`],
                  ['주 호소', f.complaint],
                  ['발생', f.onset],
                  ['평가소견', f.opinion],
                ]}
              />
            )
          }
        </Section>

        <Section title="응급처치">
          {(edit) =>
            edit ? (
              <View style={{ gap: 10 }}>
                {chips('care', CARE)}
                {inp('o2', '산소투여 (L/min)')}
              </View>
            ) : (
              <Rows
                rows={[
                  ['처치', f.care.join(', ')],
                  ['산소', f.o2 && `${f.o2} L/min`],
                ]}
              />
            )
          }
        </Section>

        <Section title="환자 이송" auto>
          {(edit) =>
            edit ? (
              <View style={{ gap: 10 }}>
                {inp('hospital', '이송 기관명')}
                <Pair>
                  {inp('hospitalArrive', '도착 시간', '00:00')}
                  {inp('distance', '거리 (km)')}
                </Pair>
                <Label>의료기관 선정자</Label>
                {radio('selector', SELECTOR)}
                {inp('reTransfer', '재이송 사유', '없음')}
                {inp('hospital2', '2차 이송 기관 (재이송 시)')}
                <Label>환자 인수자</Label>
                {radio('handover', ['의사', '간호사', '응급구조사', '기타'])}
              </View>
            ) : (
              <Rows
                rows={[
                  ['이송 기관', f.hospital],
                  ['도착', f.hospitalArrive],
                  ['선정자', f.selector],
                  ['재이송 사유', f.reTransfer || '없음'],
                  ['인수자', f.handover],
                ]}
              />
            )
          }
        </Section>

        <Section title="출동 인원" auto>
          {(edit) =>
            edit ? (
              <View style={{ gap: 10 }}>
                <Pair>
                  {inp('crew1', '구급대원(1) 성명')}
                  {inp('crew1Rank', '계급')}
                </Pair>
                <Label>자격</Label>
                {radio('crew1Grade', GRADES)}
                <Pair>
                  {inp('driver', '운전요원 성명')}
                  {inp('driverRank', '계급')}
                </Pair>
                <Label>자격</Label>
                {radio('driverGrade', GRADES)}
              </View>
            ) : (
              <Rows
                rows={[
                  ['구급대원', [f.crew1, f.crew1Rank, f.crew1Grade].filter(Boolean).join(' · ')],
                  ['운전요원', [f.driver, f.driverRank, f.driverGrade].filter(Boolean).join(' · ')],
                ]}
              />
            )
          }
        </Section>

        <Tile style={{ padding: 16, gap: 8 }}>
          <Txt style={{ fontFamily: font.extrabold, fontSize: 15 }}>
            PDF에만 넣는 환자 성명 (선택)
          </Txt>
          <Field
            value={patientName}
            onChangeText={setPatientName}
            placeholder="종이로 쓸 거면 비워 두세요"
            accessibilityLabel="PDF에만 넣는 환자 성명"
          />
          <Txt style={[text.caption, { color: color.muted }]}>
            이 칸은 저장하지 않고 서버로도 보내지 않아요. 화면을 닫으면 지워져요.
          </Txt>
        </Tile>
      </PhoneScreen>
    </KeyboardAvoidingView>
  );
}

function Pair({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', gap: 8 }}>{children}</View>;
}

function Chip({
  on,
  label,
  onPress,
  solid,
}: {
  on: boolean;
  label: string;
  onPress: () => void;
  solid?: boolean;
}) {
  const bg = on ? (solid ? color.primary : color.accentSoft) : color.card;
  const fg = on ? (solid ? color.primaryText : color.accentDeep) : color.foreground;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={solid ? 'radio' : 'checkbox'}
      accessibilityLabel={label}
      accessibilityState={solid ? { selected: on } : { checked: on }}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: on ? (solid ? color.primary : color.accent) : color.border,
        backgroundColor: bg,
      }}
    >
      <Txt style={{ fontFamily: on ? font.bold : font.semibold, fontSize: 13, color: fg }}>
        {label}
      </Txt>
    </Pressable>
  );
}

function Section({
  title,
  auto,
  note,
  children,
}: {
  title: string;
  auto?: boolean;
  note?: string;
  children: (edit: boolean) => ReactNode;
}) {
  const [edit, setEdit] = useState(false);
  return (
    <Tile style={{ marginBottom: 12, overflow: 'hidden' }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: color.border,
          backgroundColor: 'rgba(241,245,249,0.7)',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 3, height: 14, borderRadius: 2, backgroundColor: color.accent }} />
          <Txt style={{ fontFamily: font.extrabold, fontSize: 15 }}>{title}</Txt>
          {auto ? (
            <View
              style={{
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 999,
                backgroundColor: color.accentSoft,
              }}
            >
              <Txt style={{ fontFamily: font.extrabold, fontSize: 11, color: color.accentDeep }}>
                자동
              </Txt>
            </View>
          ) : null}
        </View>
        <Pressable
          onPress={() => setEdit(!edit)}
          accessibilityRole="button"
          accessibilityLabel={`${title} ${edit ? '완료' : '수정'}`}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: radius.sm,
            borderWidth: edit ? 0 : 1,
            borderColor: color.border,
            backgroundColor: edit ? color.primary : color.card,
          }}
        >
          {edit ? (
            <Check size={14} color={color.primaryText} />
          ) : (
            <Pencil size={14} color={color.muted} />
          )}
          <Txt
            style={{
              fontFamily: font.bold,
              fontSize: 12,
              color: edit ? color.primaryText : color.muted,
            }}
          >
            {edit ? '완료' : '수정'}
          </Txt>
        </Pressable>
      </View>
      <View style={{ padding: 16 }}>{children(edit)}</View>
      {note ? (
        <Txt
          style={[
            text.caption,
            {
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderTopWidth: 1,
              borderTopColor: color.border,
              backgroundColor: 'rgba(241,245,249,0.6)',
              color: color.muted,
            },
          ]}
        >
          {note}
        </Txt>
      ) : null}
    </Tile>
  );
}

function Rows({ rows }: { rows: [string, string | undefined | false][] }) {
  return (
    <View>
      {rows.map(([k, val], i) => (
        <View
          key={k}
          style={{
            flexDirection: 'row',
            gap: 12,
            paddingVertical: 8,
            borderBottomWidth: i < rows.length - 1 ? 1 : 0,
            borderBottomColor: color.border,
            borderStyle: 'dashed',
          }}
        >
          <Txt style={{ width: 72, fontSize: 14, color: color.muted }}>{k}</Txt>
          <Txt
            style={{
              flex: 1,
              fontSize: 14,
              fontFamily: val ? font.semibold : font.regular,
              color: val ? color.foreground : color.borderStrong,
            }}
          >
            {val || '미입력'}
          </Txt>
        </View>
      ))}
    </View>
  );
}
