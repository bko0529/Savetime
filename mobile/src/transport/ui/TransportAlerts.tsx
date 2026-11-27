/**
 * 병원 경보 두 가지를 화면 어디에서나 띄운다 (닫은 PR #109 그대로)
 * - 추가 메모(SFR-140): 위쪽 배너 + 진동. 누르면 이송 화면, 10초 뒤 저절로 닫힘
 * - 수용 불가(SFR-158): 화면 전체 빨간 경보 + 진동. '다시 요청하기'는 직전 환자 정보를 채워 환자 입력 화면으로
 *   (그 병원은 서버가 다음 요청에서 자동으로 뺀다)
 */
import { useRouter } from 'expo-router';
import { AlertTriangle, MessageSquareText, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Modal, Pressable, Vibration, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../api/client';
import { mergePatient } from '../../journal/form';
import { BigButton, Txt } from '../../ui/kit';
import { color, font, radius, shadow, text } from '../../ui/theme';
import { actions, type JournalDraft } from '../engine';
import { hospitalAlerts, unacceptableText, useHospitalAlerts } from '../hospitalAlerts';
import { emptyPatient } from '../patient';
import { setPatient } from '../patientStore';

export function TransportAlerts() {
  const { memo, unacceptable } = useHospitalAlerts();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!memo) return;
    Vibration.vibrate([0, 200, 80, 200]);
    const t = setTimeout(() => hospitalAlerts.clearMemo(), 10_000);
    return () => clearTimeout(t);
  }, [memo]);

  useEffect(() => {
    if (unacceptable) Vibration.vibrate([0, 400, 120, 400, 120, 400]);
  }, [unacceptable]);

  // 직전 이송의 환자 정보를 서버 일지 초안(도착 후 10분 동안 팀원이 볼 수 있음)으로 다시 채운다.
  // 이 폰에서 이미 '저장하고 홈으로'를 눌러 비웠어도 이어서 쓸 수 있게
  const reRequest = async () => {
    if (!unacceptable || busy) return;
    setBusy(true);
    try {
      const d = await api<JournalDraft>(
        'GET',
        `/transports/${unacceptable.transportId}/journal-draft`,
      );
      setPatient(mergePatient(emptyPatient, d));
    } catch {
      /* 초안을 못 받으면 이 폰에 남은 환자 정보로 */
    }
    actions.reset();
    actions.continueFrom(unacceptable.transportId);
    hospitalAlerts.clearUnacceptable();
    setBusy(false);
    router.navigate('/patient');
  };

  return (
    <>
      {memo ? (
        <SafeAreaView
          edges={['top']}
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 50,
            paddingHorizontal: 12,
            paddingTop: 8,
          }}
        >
          <View
            accessibilityRole="alert"
            style={[
              {
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                padding: 10,
                paddingLeft: 12,
                borderRadius: radius.lg,
                borderWidth: 1,
                borderColor: 'rgba(157,99,0,0.4)',
                backgroundColor: 'rgba(255,255,255,0.97)',
              },
              shadow.card,
            ]}
          >
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                backgroundColor: 'rgba(157,99,0,0.15)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <MessageSquareText size={20} color={color.warning} />
            </View>
            <Pressable
              style={{ flex: 1 }}
              onPress={() => {
                hospitalAlerts.clearMemo();
                router.navigate('/transport');
              }}
              accessibilityRole="button"
              accessibilityLabel={`${memo.hospitalName} 추가 메모 보기`}
            >
              <Txt style={{ fontFamily: font.extrabold, fontSize: 13 }}>
                {memo.hospitalName} 추가 메모
              </Txt>
              <Txt style={[text.body, { marginTop: 2, color: color.muted }]} numberOfLines={1}>
                {memo.memo ?? '이송 화면에서 확인하세요'}
              </Txt>
            </Pressable>
            <Pressable
              onPress={() => hospitalAlerts.clearMemo()}
              accessibilityRole="button"
              accessibilityLabel="추가 메모 닫기"
              style={{ padding: 8 }}
            >
              <X size={16} color={color.muted} />
            </Pressable>
          </View>
        </SafeAreaView>
      ) : null}

      <Modal
        visible={!!unacceptable}
        transparent
        animationType="fade"
        onRequestClose={() => hospitalAlerts.clearUnacceptable()}
      >
        <View
          style={{
            flex: 1,
            justifyContent: 'flex-end',
            padding: 12,
            backgroundColor: 'rgba(14,22,36,0.5)',
          }}
        >
          {unacceptable ? (
            <SafeAreaView
              edges={['bottom']}
              style={{ borderRadius: radius.xl, overflow: 'hidden', backgroundColor: color.card }}
              accessibilityRole="alert"
              accessibilityLabel="수용 불가"
            >
              <View style={{ padding: 20, backgroundColor: color.accentButton }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <AlertTriangle size={16} color="rgba(252,252,252,0.8)" />
                  <Txt
                    style={{ fontFamily: font.bold, fontSize: 14, color: 'rgba(252,252,252,0.8)' }}
                  >
                    도착 후 수용 불가
                  </Txt>
                </View>
                <Txt
                  style={{
                    marginTop: 4,
                    fontFamily: font.extrabold,
                    fontSize: 24,
                    color: color.accentText,
                  }}
                >
                  {unacceptable.hospitalName}
                </Txt>
                <Txt
                  style={{
                    marginTop: 4,
                    fontFamily: font.bold,
                    fontSize: 18,
                    color: color.accentText,
                  }}
                >
                  {unacceptableText(unacceptable.reason)}
                </Txt>
              </View>
              <View style={{ padding: 20, gap: 8 }}>
                <Txt style={[text.body, { color: color.muted }]}>
                  직전 환자 정보로 다시 요청해요. 이 병원은 요청 대상에서 빠져요.
                </Txt>
                <BigButton size="lg" variant="danger" busy={busy} onPress={() => void reRequest()}>
                  다시 요청하기
                </BigButton>
                <BigButton variant="outline" onPress={() => hospitalAlerts.clearUnacceptable()}>
                  닫기
                </BigButton>
              </View>
            </SafeAreaView>
          ) : null}
        </View>
      </Modal>
    </>
  );
}
