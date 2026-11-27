/**
 * 이송 중 (SFR-034 · 036 · 121 · 144 · 153). 구성·문구는 Lovable transport 화면 그대로.
 * - 남은 시간: 서버가 담당 단말 값으로 계산한 분 (팀원 모두 같은 값)
 * - 응급실 입구 200m 안이거나 병원이 '도착 확인'을 누르면 도착 처리 버튼이 켜진다
 * - 확정 병원이 승인을 취소하면 경보(진동). 자동으로 다시 요청하지 않는다
 * - 목적지 변경은 길게 눌러서, 한 번만
 * - 병원에는 구급차 위치를 보내지 않고 도착 예상 시간만 보낸다
 */
import { useRouter } from 'expo-router';
import { AlertTriangle, MapPin, Navigation, Phone, Send, Timer } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, Pressable, Vibration, View } from 'react-native';
import { actions, hospital, latestReq, useEngine, type Result } from '../src/transport/engine';
import { callNumber, openRoute } from '../src/transport/links';
import type { DestChangeReason } from '../src/transport/types';
import { ProgressStrip } from '../src/transport/ui/ProgressStrip';
import { BigButton, Notice, PhoneScreen, Pill, Tile, Txt } from '../src/ui/kit';
import { color, font, radius, text } from '../src/ui/theme';

const DEST: { k: DestChangeReason; l: string }[] = [
  { k: 'patient_change', l: '환자 상태 변화' },
  { k: 'road', l: '도로 사정' },
  { k: 'hospital', l: '병원 사정' },
  { k: 'etc', l: '기타' },
];
const NEAR_M = 200;

export default function TransportScreen() {
  const e = useEngine();
  const router = useRouter();
  const h = e.confirmedId ? hospital(e.confirmedId) : null;
  const [manualNear, setManualNear] = useState(false);
  const [destOpen, setDestOpen] = useState(false);

  useEffect(() => setManualNear(false), [h?.id]);
  useEffect(() => {
    if (e.alert) Vibration.vibrate([0, 300, 100, 300]);
  }, [e.alert]);

  const run = async (p: Promise<Result>) => {
    const r = await p;
    if (!r.ok) Alert.alert('처리하지 못했어요', r.error);
    return r.ok;
  };

  if (!h) {
    return (
      <PhoneScreen title="이송 중" subtitle="목적지 병원을 불러오는 중이에요">
        <ProgressStrip />
      </PhoneScreen>
    );
  }
  const req = latestReq(h.id);
  const left = e.etaMin ?? h.min;
  const near = manualNear || e.arriveRequested || (e.remainingM !== null && e.remainingM <= NEAR_M);
  const go = near ? 1 : Math.min(1, Math.max(0, 1 - left / Math.max(h.min, 1)));
  const erPhone = e.confirmed?.erPhone ?? h.erPhone;
  const entrance = e.confirmed?.entrance ?? (h.lat && h.lng ? { lat: h.lat, lng: h.lng } : null);
  const note = e.confirmed?.memo ?? req?.note;
  const extraMemo = e.confirmed?.extraMemo;

  const cancel = () =>
    Alert.alert('이송을 취소할까요?', '확정 병원에도 취소가 전달돼요.', [
      { text: '아니요', style: 'cancel' },
      { text: '이송 취소', style: 'destructive', onPress: () => void run(actions.cancel()) },
    ]);

  return (
    <PhoneScreen
      title={near ? `${h.name} 응급실 입구` : `${h.name} · ${left}분 남음`}
      subtitle={
        near
          ? '응급실 입구 근처예요'
          : e.navIsMe
            ? '이송 중 · 이 폰이 경로 안내·위치 기록 담당'
            : '이송 중 · 경로 안내는 담당 폰에서'
      }
      badge={
        <Pill tone={near ? 'ok' : 'call'} dot={false}>
          {`${h.km}km`}
        </Pill>
      }
      footer={
        <>
          {near ? (
            <BigButton
              variant="success"
              size="lg"
              onPress={() => void run(actions.arrive(e.arriveRequested ? 'hospital' : 'button'))}
            >
              도착 처리
            </BigButton>
          ) : (
            <BigButton variant="outline" onPress={() => setManualNear(true)}>
              {`도착했어요 (입구 ${NEAR_M}m 안에서 켜져요)`}
            </BigButton>
          )}
          <BigButton variant="outline" onPress={cancel}>
            이송 취소
          </BigButton>
        </>
      }
    >
      <ProgressStrip />
      {e.arriveRequested ? (
        <View style={{ marginBottom: 12 }}>
          <Notice tone="ok">병원에서 도착 확인을 요청했어요 · 도착 처리를 눌러 주세요</Notice>
        </View>
      ) : null}
      {e.alert ? (
        <View
          style={{
            marginBottom: 16,
            padding: 16,
            borderRadius: radius.md,
            borderWidth: 2,
            borderColor: color.destructive,
            backgroundColor: 'rgba(185,28,30,0.08)',
          }}
          accessibilityRole="alert"
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={20} color={color.destructive} />
            <Txt
              style={{
                flex: 1,
                fontFamily: font.extrabold,
                fontSize: 15,
                color: color.destructive,
              }}
            >
              {e.alert}
            </Txt>
          </View>
          <Txt style={[text.body, { marginTop: 6, color: color.muted }]}>
            경로 안내는 그대로 유지돼요. 자동으로 다시 요청하지 않아요.
          </Txt>
          <BigButton
            variant="danger"
            style={{ marginTop: 12 }}
            onPress={() => void run(actions.reRequest())}
          >
            {`다시 요청 (현재 반경 ${e.radius}km)`}
          </BigButton>
        </View>
      ) : null}

      {/* 경로 안내: 진행 막대 + 카카오맵 길찾기 열기 (앱 안 내비 SDK 는 9단계) */}
      <View
        style={{
          height: 180,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: color.border,
          backgroundColor: color.surface,
          justifyContent: 'center',
          paddingHorizontal: 28,
        }}
      >
        <View style={{ height: 6, borderRadius: 3, backgroundColor: color.border }}>
          <View
            style={{
              width: `${go * 100}%`,
              height: 6,
              borderRadius: 3,
              backgroundColor: color.accent,
            }}
          />
        </View>
        <View style={{ position: 'absolute', left: 12, top: 78 }}>
          <Navigation size={22} color={color.primary} />
        </View>
        <View style={{ position: 'absolute', right: 10, top: 76 }}>
          <MapPin size={22} color={color.accentDeep} />
        </View>
        <Txt
          style={{
            position: 'absolute',
            bottom: 10,
            alignSelf: 'center',
            fontSize: 11,
            color: color.muted,
          }}
        >
          경로 안내 (운전 대원 폰 · 카카오맵 길찾기)
        </Txt>
      </View>
      {entrance ? (
        <BigButton
          variant="primary"
          style={{ marginTop: 10 }}
          onPress={() => void openRoute(entrance, h.name)}
          icon={<Navigation size={18} color={color.primaryText} />}
        >
          길 안내 열기 (카카오맵)
        </BigButton>
      ) : null}

      <Tile
        style={{
          marginTop: 16,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 16,
        }}
      >
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Timer size={14} color={color.muted} />
            <Txt style={{ fontFamily: font.bold, fontSize: 11, color: color.muted }}>남은 시간</Txt>
          </View>
          <Txt style={{ marginTop: 4, fontFamily: font.extrabold, fontSize: 30 }}>약 {left}분</Txt>
        </View>
        <Pill tone="ok">병원 화면에 1분마다 전달</Pill>
      </Tile>
      {note ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="info">{`병원 안내 · "${note}"`}</Notice>
        </View>
      ) : null}
      {extraMemo ? (
        <View style={{ marginTop: 8 }}>
          <Notice tone="warn">{`추가 메모 · "${extraMemo}"`}</Notice>
        </View>
      ) : null}
      {e.remainingM !== null ? (
        <Txt style={[text.caption, { marginTop: 8, color: color.muted }]}>
          입구까지 약{' '}
          {e.remainingM >= 1000 ? `${(e.remainingM / 1000).toFixed(1)}km` : `${e.remainingM}m`}
        </Txt>
      ) : null}

      {erPhone ? (
        <BigButton
          variant="outline"
          style={{ marginTop: 12 }}
          onPress={() => callNumber(erPhone)}
          icon={<Phone size={18} color={color.accentDeep} />}
        >
          {`${h.name} 응급실 직통 ${erPhone}`}
        </BigButton>
      ) : null}

      <View style={{ marginTop: 12, flexDirection: 'row', gap: 8 }}>
        <BigButton
          variant="outline"
          style={{ flex: 1 }}
          onPress={() => router.push('/patient')}
          icon={<Send size={16} color={color.foreground} />}
        >
          환자 정보 보내기
        </BigButton>
        <Pressable
          style={{ flex: 1 }}
          disabled={e.destChanged}
          delayLongPress={700}
          onLongPress={() => setDestOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="목적지 변경"
          accessibilityHint="길게 누르면 사유를 고를 수 있어요"
          accessibilityState={{ disabled: e.destChanged }}
        >
          <View
            style={{
              height: 48,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: color.borderStrong,
              backgroundColor: color.card,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: e.destChanged ? 0.45 : 1,
            }}
          >
            <Txt style={{ fontFamily: font.bold, fontSize: 15 }}>
              {e.destChanged ? '목적지 변경 (사용함)' : '목적지 변경 (길게)'}
            </Txt>
          </View>
        </Pressable>
      </View>
      {destOpen ? (
        <Tile style={{ marginTop: 8, padding: 14 }}>
          <Txt style={{ marginBottom: 10, fontFamily: font.bold, fontSize: 14 }}>
            변경 사유 (1번만 바꿀 수 있어요)
          </Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {DEST.map((d) => (
              <Pressable
                key={d.k}
                onPress={() => {
                  setDestOpen(false);
                  void run(actions.changeDestination(d.k));
                }}
                accessibilityRole="button"
                accessibilityLabel={d.l}
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
                <Txt style={{ fontFamily: font.bold, fontSize: 14 }}>{d.l}</Txt>
              </Pressable>
            ))}
          </View>
        </Tile>
      ) : null}
      <Txt style={[text.caption, { marginTop: 12, color: color.muted }]}>
        환자 상태가 바뀌면 &apos;환자 정보 보내기&apos;에서 고쳐서 보내면 확정 병원에 강조 표시돼요.
        병원에는 구급차 위치를 보내지 않고 도착 예상 시간만 보내요.
      </Txt>
    </PhoneScreen>
  );
}
