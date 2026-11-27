/**
 * 전화 확인 (SFR-032 · SFR-033). 구성·문구는 Lovable call 화면 그대로.
 * 다른 병원 요청은 열어 둔 채 응급실에 직접 전화하고, 통화 결과를 고른다.
 * - 수용 확정 → 출발 / 연결 실패·확인 생략 + 사유 → 이 병원으로 출발 / 거절 → 다음 병원
 * - 통화 중 승인이 오면 위에 쌓이고, 눌러서 바로 확정할 수 있다
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CheckCircle2, Phone, PhoneOff, SkipForward, XCircle } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import {
  actions,
  hospital,
  loadHospitalDetail,
  now,
  openRemain,
  useEngine,
  type RejectReason,
  type Result,
} from '../../src/transport/engine';
import { capCount, RESPONSE_LIMIT_SEC } from '../../src/transport/hospitals';
import { mmss } from '../../src/transport/labels';
import { callNumber } from '../../src/transport/links';
import type { PhoneProceedReason } from '../../src/transport/types';
import { HospitalDetail } from '../../src/transport/ui/HospitalDetail';
import { ProgressStrip } from '../../src/transport/ui/ProgressStrip';
import {
  BigButton,
  Field,
  Notice,
  PhoneScreen,
  Pill,
  SectionTitle,
  Tile,
  Txt,
} from '../../src/ui/kit';
import { color, font, radius, text } from '../../src/ui/theme';

/** 병원 웹 거절과 같은 사유 목록 (SFR-044 · 119) */
const REJECT_REASONS: { k: RejectReason; l: string }[] = [
  { k: 'er_bed', l: '응급실 병상 부족' },
  { k: 'or_room', l: '수술실 부족' },
  { k: 'ward', l: '입원실 부족' },
  { k: 'icu', l: '중환자실 부족' },
  { k: 'no_specialist', l: '해당 전문의 부재' },
  { k: 'equipment', l: '의료장비 고장' },
  { k: 'etc', l: '기타' },
];

const PROCEED: { k: PhoneProceedReason; l: string }[] = [
  { k: 'no_answer', l: '전화 안 받음' },
  { k: 'busy', l: '통화 중' },
  { k: 'urgent', l: '환자가 급함' },
  { k: 'etc', l: '기타' },
];

export default function CallScreen() {
  const { hospitalId } = useLocalSearchParams<{ hospitalId: string }>();
  const router = useRouter();
  const e = useEngine();
  const h = hospital(hospitalId);
  const [proceed, setProceed] = useState<'fail' | 'skip' | null>(null);
  // 거절 사유 (SFR-044): 고르지 않고 넘어가도 된다. 기타면 20자
  const [rejecting, setRejecting] = useState(false);
  const [etcText, setEtcText] = useState('');
  const [detail, setDetail] = useState<string | null>(null);

  // 병원 상세(병상 3종·대표 전화·진료가능 항목)를 서버에서 읽는다 (SFR-007·033)
  useEffect(() => {
    if (hospitalId) void loadHospitalDetail(hospitalId);
  }, [hospitalId]);

  const run = async (p: Promise<Result>) => {
    const r = await p;
    if (!r.ok) Alert.alert('처리하지 못했어요', r.error);
  };
  const remain = RESPONSE_LIMIT_SEC - Math.floor((now() - e.roundSentAt) / 1000);
  const open = openRemain();
  const approved = e.hreqs.filter((r) => r.status === 'approved');
  const inPhone = e.status === 'phone_check';
  const cc = capCount(h);

  const back = () => (inPhone ? void run(actions.phoneDismiss()) : router.back());

  return (
    <PhoneScreen
      title="전화 확인"
      subtitle={`${h.name} · ${h.km}km · 약 ${h.min}분`}
      badge={
        <Pill tone="call" dot={false}>
          응급실 직통
        </Pill>
      }
      footer={
        <BigButton variant="outline" onPress={back}>
          ← 요청 화면으로
        </BigButton>
      }
    >
      <ProgressStrip />
      {open ? (
        <Notice tone="info">{`다른 병원 요청은 그대로 열려 있어요${remain > 0 ? ` (남은 ${mmss(remain)})` : ''}`}</Notice>
      ) : (
        <Notice tone="warn">열린 요청이 없어요 · 돌아가면 예비 추천이 보여요</Notice>
      )}

      {approved.length > 0 ? (
        <View
          style={{
            marginTop: 12,
            padding: 14,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: 'rgba(0,125,101,0.4)',
            backgroundColor: 'rgba(215,247,237,0.6)',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <CheckCircle2 size={16} color={color.success} />
            <Txt style={{ fontFamily: font.extrabold, fontSize: 14, color: color.success }}>
              통화 중 승인 {approved.length}곳 · 눌러서 바로 확정
            </Txt>
          </View>
          {approved.map((r) => (
            <Pressable
              key={r.hospitalId}
              onPress={() => setDetail(r.hospitalId)}
              accessibilityRole="button"
              accessibilityLabel={`${hospital(r.hospitalId).name} 승인 · 자세히`}
            >
              <Tile
                style={{
                  marginTop: 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 12,
                }}
              >
                <Txt style={{ flex: 1, fontFamily: font.bold, fontSize: 14 }} numberOfLines={1}>
                  {hospital(r.hospitalId).name} · {hospital(r.hospitalId).km}km
                </Txt>
                <Pill tone="ok">승인</Pill>
              </Tile>
            </Pressable>
          ))}
        </View>
      ) : null}

      <BigButton
        variant="accent"
        size="lg"
        style={{ marginTop: 16 }}
        onPress={() => callNumber(h.erPhone || h.phone)}
        icon={<Phone size={20} color={color.accentText} />}
        accessibilityLabel={`${h.name} 응급실에 전화`}
      >
        {`${h.name} 응급실에 전화`}
      </BigButton>
      <Tile style={{ marginTop: 10, padding: 14, gap: 6 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 6 }}>
          {[
            ['응급실', h.er ?? '정보 없음'],
            ['중환자실', h.icu ?? '정보 없음'],
            ['수술실', h.or ?? '정보 없음'],
            ['진료가능', `${cc.available}/${cc.total}`],
          ].map(([k, v]) => (
            <Txt key={k} style={{ width: '50%', fontSize: 12, color: color.muted }}>
              {k} <Txt style={{ fontFamily: font.bold, fontSize: 12 }}>{v}</Txt>
            </Txt>
          ))}
        </View>
        <Txt
          style={{
            paddingTop: 6,
            borderTopWidth: 1,
            borderTopColor: color.border,
            fontSize: 12,
            color: color.muted,
          }}
        >
          직통 {h.erPhone || '-'} · 대표 {h.mainPhone || '-'} · 병상 기준 {h.bedsAt || '없음'}
        </Txt>
      </Tile>

      <SectionTitle>통화 결과</SectionTitle>
      <BigButton
        variant="success"
        size="lg"
        onPress={() => void run(actions.phoneAccepted())}
        icon={<CheckCircle2 size={20} color={color.accentText} />}
      >
        수용 확정 → 출발
      </BigButton>
      <View style={{ marginTop: 8, flexDirection: 'row', gap: 8 }}>
        <BigButton
          variant="outline"
          style={{ flex: 1 }}
          onPress={() => setProceed('fail')}
          icon={<PhoneOff size={16} color={color.foreground} />}
        >
          연결 실패
        </BigButton>
        <BigButton
          variant="outline"
          style={{ flex: 1 }}
          onPress={() => setProceed('skip')}
          icon={<SkipForward size={16} color={color.foreground} />}
        >
          확인 생략
        </BigButton>
      </View>
      {proceed ? (
        <Tile style={{ marginTop: 8, padding: 14 }}>
          <Txt style={{ marginBottom: 10, fontFamily: font.bold, fontSize: 14 }}>
            {proceed === 'fail' ? '연결 실패' : '확인 생략'} 사유를 고르면 이 병원으로 출발해요
          </Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {PROCEED.map((p) => (
              <Pressable
                key={p.k}
                onPress={() =>
                  void run(actions.phoneProceed(p.k, proceed === 'skip' ? 'skipped' : 'no_answer'))
                }
                accessibilityRole="button"
                accessibilityLabel={p.l}
                style={{
                  width: '48.5%',
                  alignItems: 'center',
                  paddingVertical: 12,
                  borderRadius: radius.sm,
                  borderWidth: 1,
                  borderColor: color.border,
                  backgroundColor: color.card,
                }}
              >
                <Txt style={{ fontFamily: font.bold, fontSize: 14 }}>{p.l}</Txt>
              </Pressable>
            ))}
          </View>
        </Tile>
      ) : null}
      <BigButton
        variant="danger"
        size="lg"
        style={{ marginTop: 12 }}
        onPress={() => setRejecting(true)}
        icon={<XCircle size={20} color={color.accentText} />}
      >
        거절 → 다음 병원
      </BigButton>
      {rejecting ? (
        <Tile style={{ marginTop: 8, padding: 14, gap: 10 }}>
          <Txt style={{ fontFamily: font.bold, fontSize: 14 }}>거절 사유 (고르지 않아도 돼요)</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {REJECT_REASONS.map((r) => (
              <Pressable
                key={r.k}
                onPress={() => {
                  setRejecting(false);
                  void run(actions.phoneRejected(r.k, etcText));
                }}
                accessibilityRole="button"
                accessibilityLabel={`거절 사유 ${r.l}`}
                style={{
                  width: '48.5%',
                  alignItems: 'center',
                  paddingVertical: 12,
                  borderRadius: radius.sm,
                  borderWidth: 1,
                  borderColor: color.border,
                  backgroundColor: color.card,
                }}
              >
                <Txt style={{ fontFamily: font.bold, fontSize: 14 }}>{r.l}</Txt>
              </Pressable>
            ))}
          </View>
          <Field
            value={etcText}
            onChangeText={(t) => setEtcText(t.slice(0, 20))}
            placeholder="기타 사유 (20자, '기타'를 누르면 같이 보내요)"
            accessibilityLabel="기타 거절 사유"
          />
          <BigButton
            variant="ghost"
            size="sm"
            onPress={() => {
              setRejecting(false);
              void run(actions.phoneRejected());
            }}
          >
            사유 없이 다음 병원으로
          </BigButton>
        </Tile>
      ) : null}
      <Txt style={[text.caption, { marginTop: 12, color: color.muted }]}>
        출발하면 열려 있던 요청은 닫히고 병원 웹에 &quot;요청 종료&quot;가 떠요. 통화 중 승인이 오면
        진동으로 알려요.
      </Txt>

      {detail ? (
        <HospitalDetail
          h={hospital(detail)}
          approved
          note={[...e.hreqs].reverse().find((r) => r.hospitalId === detail)?.note}
          onClose={() => setDetail(null)}
          onConfirm={() => {
            const id = detail;
            setDetail(null);
            Alert.alert(
              `${hospital(id).name}으로 확정할까요?`,
              '확정하면 다른 병원 요청은 닫혀요',
              [
                { text: '취소', style: 'cancel' },
                { text: '확정', onPress: () => void run(actions.confirm(id)) },
              ],
            );
          }}
        />
      ) : null}
    </PhoneScreen>
  );
}
