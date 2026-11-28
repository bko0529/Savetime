/**
 * 팀 QR 스캔으로 참여 (SFR-113). 카메라 권한은 이 화면에서 처음 묻는다.
 * 우리 앱 팀 QR(savetime:team:…)만 받는다. 한 번 읽으면 서버에 참여를 보내고, 실패하면 다시 찍을 수 있다.
 */
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Camera } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { joinTeam, parseTeamQr, type Role } from '../src/duty/team';
import { openSettings } from '../src/state/permissions';
import { BigButton, CenterMessage, Notice, PhoneScreen, Txt } from '../src/ui/kit';
import { color, font } from '../src/ui/theme';

export default function ScanScreen() {
  const router = useRouter();
  const { role } = useLocalSearchParams<{ role?: Role }>();
  const [perm, requestPerm] = useCameraPermissions();
  const [err, setErr] = useState('');
  const handling = useRef(false); // 카메라는 같은 QR 을 1초에 여러 번 읽는다 → 한 번만 처리

  const onScan = async (data: string) => {
    if (handling.current) return;
    const token = parseTeamQr(data);
    if (!token) return setErr('골든타임즈 팀 QR이 아니에요');
    handling.current = true;
    const e = await joinTeam({ qrToken: token }, role === '운전' ? '운전' : '처치');
    if (e) {
      setErr(e);
      handling.current = false;
      return;
    }
    router.back(); // 근무 시작 화면에 '팀 ○○○○에 참여했어요'가 보인다
  };

  const back = (
    <BigButton variant="outline" onPress={() => router.back()}>
      돌아가기
    </BigButton>
  );

  if (!perm) return null;
  if (!perm.granted) {
    return (
      <PhoneScreen
        title="QR 스캔"
        subtitle="팀원 화면의 QR을 찍어요"
        footer={
          <>
            {perm.canAskAgain ? (
              <BigButton size="lg" onPress={() => void requestPerm()}>
                카메라 허용
              </BigButton>
            ) : (
              <BigButton size="lg" onPress={() => void openSettings()}>
                설정으로 이동
              </BigButton>
            )}
            {back}
          </>
        }
      >
        <CenterMessage
          icon={<Camera size={28} color={color.warning} />}
          title="QR을 찍으려면 카메라가 필요해요"
          body="찍는 동안에만 카메라를 써요"
        />
      </PhoneScreen>
    );
  }

  return (
    <PhoneScreen title="QR 스캔" subtitle="팀원 화면의 QR을 네모 안에 맞춰 주세요" footer={back}>
      <View style={s.camWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => void onScan(data)}
        />
        <View style={s.frame} pointerEvents="none" />
      </View>
      {err ? (
        <View style={{ marginTop: 16 }}>
          <Notice tone="warn">{err}</Notice>
        </View>
      ) : (
        <Txt
          style={{
            marginTop: 16,
            textAlign: 'center',
            fontFamily: font.semibold,
            fontSize: 13,
            color: color.muted,
          }}
        >
          QR이 안 되면 4자리 코드로 참여할 수 있어요
        </Txt>
      )}
    </PhoneScreen>
  );
}

const s = StyleSheet.create({
  camWrap: {
    height: 340,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    width: 220,
    height: 220,
    borderRadius: 16,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.9)',
  },
});
