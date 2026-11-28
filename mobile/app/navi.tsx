/**
 * 길 안내 페이지 (SFR-031 · COR-003): 앱 안에 카카오내비를 내장한 화면. 다른 앱으로 넘어가지 않는다.
 * - 화면 대부분은 카카오내비(경로선 · 음성 안내 · 회전 안내 · 재탐색)
 * - 아래 띠: 병원 이름 · 남은 시간 · 도착 처리(입구 근처 · 병원 도착 확인 · 내비 도착 때 켜짐) · 이송 화면으로
 * - 시작하지 못하면 이유와 [다시 시도] (외부 앱으로 넘기지 않음, D-137)
 * - 병원을 확정한 폰과 운전 폰(경로 안내 담당)은 확정되면 이 페이지가 바로 열린다 (SFR-111 · SFR-157)
 *   출발지는 내 현재 위치, 목적지는 확정 병원 응급실 입구
 */
import { useRouter } from 'expo-router';
import { ArrowLeft, Flag, RotateCw } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KakaoNaviView, kakaoNaviReady, naviErrorText, type NaviTrip } from '../modules/kakao-navi';
import { getDeviceId } from '../src/auth/storage';
import { actions, hospital, useEngine } from '../src/transport/engine';
import { currentLocation } from '../src/transport/location';
import { BigButton, Txt } from '../src/ui/kit';
import { color, font, radius } from '../src/ui/theme';

type Phase = 'preparing' | 'loading' | 'ready' | 'arrived' | 'closed' | 'error';

export default function NaviScreen() {
  const e = useEngine();
  const router = useRouter();
  const h = e.confirmedId ? hospital(e.confirmedId) : null;
  const entrance = e.confirmed?.entrance ?? (h?.lat && h?.lng ? { lat: h.lat, lng: h.lng } : null);
  const [trip, setTrip] = useState<NaviTrip | null>(null);
  const [phase, setPhase] = useState<Phase>('preparing');
  const [error, setError] = useState<string | null>(null);
  // 다시 시도할 때마다 내비 화면 칸을 새로 만든다
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!h || !entrance) return;
    if (!KakaoNaviView || !kakaoNaviReady()) {
      setPhase('error');
      setError('이 앱 빌드에는 카카오내비가 없어요 (개발 빌드·배포 앱에서만 돼요)');
      return;
    }
    let alive = true;
    setPhase('preparing');
    void (async () => {
      const from = await currentLocation();
      if (!alive) return;
      if (!from) {
        setPhase('error');
        setError('내 위치를 찾지 못했어요. 위치 권한과 GPS 를 확인해 주세요');
        return;
      }
      setTrip({
        goalName: `${h.name} 응급실`,
        goalLat: entrance.lat,
        goalLng: entrance.lng,
        startLat: from.lat,
        startLng: from.lng,
        userKey: await getDeviceId(),
      });
      setPhase('loading');
    })();
    return () => {
      alive = false;
    };
    // 병원·입구가 바뀌거나(목적지 변경) 다시 시도할 때만 새로 시작
  }, [h?.id, entrance?.lat, entrance?.lng, attempt]);

  if (!h || !entrance) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: color.background, padding: 20 }}>
        <Txt style={{ fontFamily: font.bold, fontSize: 16 }}>확정한 병원이 없어요</Txt>
        <BigButton variant="outline" style={{ marginTop: 16 }} onPress={() => router.back()}>
          돌아가기
        </BigButton>
      </SafeAreaView>
    );
  }

  const near = e.arriveRequested || e.nearEntrance || phase === 'arrived';
  const left = e.etaMin ?? h.min;
  const arrive = async () => {
    const r = await actions.arrive(e.arriveRequested ? 'hospital' : 'button');
    if (!r.ok) Alert.alert('도착 처리를 하지 못했어요', r.error);
  };
  const retry = () => {
    setError(null);
    setTrip(null);
    setAttempt((a) => a + 1);
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {/* 카카오내비 (화면 대부분) */}
      <View style={{ flex: 1 }}>
        {KakaoNaviView && trip && phase !== 'error' && phase !== 'arrived' && phase !== 'closed' ? (
          <KakaoNaviView
            key={attempt}
            testID="kakao-navi"
            style={{ flex: 1 }}
            trip={trip}
            onReady={() => setPhase('ready')}
            onEnded={(ev) => setPhase(ev.nativeEvent.reason === 'arrived' ? 'arrived' : 'closed')}
            onError={(ev) => {
              setPhase('error');
              setError(naviErrorText(ev.nativeEvent));
            }}
          />
        ) : null}
        {phase !== 'ready' ? (
          <SafeAreaView
            edges={['top']}
            style={{
              position: 'absolute',
              inset: 0,
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              backgroundColor: phase === 'loading' ? 'transparent' : color.background,
            }}
            pointerEvents={phase === 'loading' ? 'none' : 'auto'}
          >
            {phase === 'error' ? (
              <>
                <Txt style={{ fontFamily: font.extrabold, fontSize: 18, textAlign: 'center' }}>
                  길 안내를 시작하지 못했어요
                </Txt>
                <Txt
                  style={{ marginTop: 8, fontSize: 15, color: color.muted, textAlign: 'center' }}
                >
                  {error}
                </Txt>
                <BigButton
                  style={{ marginTop: 20, alignSelf: 'stretch' }}
                  onPress={retry}
                  icon={<RotateCw size={18} color={color.primaryText} />}
                >
                  다시 시도
                </BigButton>
              </>
            ) : phase === 'arrived' || phase === 'closed' ? (
              <>
                <Flag size={36} color={phase === 'arrived' ? color.success : color.muted} />
                <Txt style={{ marginTop: 12, fontFamily: font.extrabold, fontSize: 18 }}>
                  {phase === 'arrived' ? '목적지에 도착했어요' : '길 안내를 끝냈어요'}
                </Txt>
                <Txt
                  style={{ marginTop: 6, fontSize: 15, color: color.muted, textAlign: 'center' }}
                >
                  {phase === 'arrived'
                    ? '아래 도착 처리를 눌러 주세요'
                    : '다시 안내받으려면 아래 다시 시도를 눌러 주세요'}
                </Txt>
                {phase === 'closed' ? (
                  <BigButton variant="outline" style={{ marginTop: 16 }} onPress={retry}>
                    다시 시도
                  </BigButton>
                ) : null}
              </>
            ) : (
              <Txt style={{ fontSize: 15, color: color.muted }}>
                {phase === 'preparing' ? '내 위치를 찾는 중…' : '카카오내비 경로를 받는 중…'}
              </Txt>
            )}
          </SafeAreaView>
        ) : null}
      </View>

      {/* 우리 앱 띠: 병원 · 남은 시간 · 도착 처리 · 이송 화면으로 */}
      <SafeAreaView
        edges={['bottom']}
        style={{
          backgroundColor: color.card,
          borderTopLeftRadius: radius.lg,
          borderTopRightRadius: radius.lg,
          paddingHorizontal: 16,
          paddingTop: 12,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Pressable
            // 확정하자마자 이 페이지로 왔으면 아래에는 요청 화면이 있다 → 이송 화면으로 바꿔 연다
            onPress={() => router.navigate('/transport')}
            accessibilityRole="button"
            accessibilityLabel="이송 화면으로"
            style={{
              width: 48,
              height: 48,
              borderRadius: radius.md,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: color.surface2,
            }}
          >
            <ArrowLeft size={20} color={color.foreground} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Txt style={{ fontFamily: font.extrabold, fontSize: 16 }} numberOfLines={1}>
              {h.name}
            </Txt>
            <Txt style={{ fontSize: 14, color: color.muted }}>
              {near ? '응급실 입구예요' : `약 ${left}분 남음 · 병원에 1분마다 전달`}
            </Txt>
          </View>
        </View>
        <BigButton
          variant={near ? 'success' : 'outline'}
          size="lg"
          disabled={!near}
          onPress={() => void arrive()}
        >
          {near ? '도착 처리' : '도착 처리 (입구 근처에서 켜져요)'}
        </BigButton>
      </SafeAreaView>
    </View>
  );
}
