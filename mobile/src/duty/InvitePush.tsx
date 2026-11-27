/**
 * 팀 초대 알림 카드 (SFR-159 · SFR-130, Lovable invite-push.tsx).
 * 앱을 보고 있을 때 초대가 오면 화면 위에 휴대폰 알림 모양 카드가 내려오고 진동한다.
 * 6초 뒤 저절로 숨고, 누르면 초대 화면으로 간다 (근무 시작 전에만 수락할 수 있어서 그때만 이동).
 */
import { useRouter } from 'expo-router';
import { Ambulance, ChevronRight, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Vibration, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useStore } from '../state/store';
import { Txt } from '../ui/kit';
import { color, font, radius, shadow } from '../ui/theme';
import { teamStore, type Incoming } from './team';

export const BANNER_MS = 6000;

export function InvitePush({ canOpen }: { canOpen: boolean }) {
  const { incoming } = useStore(teamStore);
  const router = useRouter();
  const [banner, setBanner] = useState<Incoming | null>(null);
  // 이미 보여 준 초대는 다시 띄우지 않는다 (같은 초대 이벤트가 두 번 와도 한 번만)
  const seen = useRef(new Set<number>());

  useEffect(() => {
    const fresh = incoming.find((i) => !seen.current.has(i.inviteId));
    if (!fresh) return;
    seen.current.add(fresh.inviteId);
    setBanner(fresh);
    Vibration.vibrate([0, 120, 60, 120]);
    const t = setTimeout(
      () => setBanner((b) => (b && b.inviteId === fresh.inviteId ? null : b)),
      BANNER_MS,
    );
    return () => clearTimeout(t);
  }, [incoming]);

  if (!banner) return null;
  return (
    <SafeAreaView
      edges={['top']}
      pointerEvents="box-none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 70 }}
    >
      <View
        style={[
          {
            marginHorizontal: 12,
            marginTop: 8,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 12,
            paddingLeft: 12,
            paddingRight: 6,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: color.border,
            backgroundColor: color.card,
          },
          shadow.lift,
        ]}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.md,
            backgroundColor: color.primary,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ambulance size={20} color={color.primaryText} />
        </View>
        <Pressable
          style={{ flex: 1, minHeight: 48, justifyContent: 'center' }}
          accessibilityRole="button"
          accessibilityLabel={`${banner.fromName} 대원이 팀 ${banner.teamCode}에 초대했어요`}
          onPress={() => {
            setBanner(null);
            if (canOpen) router.push('/invite');
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Txt style={{ fontFamily: font.extrabold, fontSize: 11 }}>골든타임즈</Txt>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View
                style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color.accent }}
              />
              <Txt style={{ fontSize: 11, color: color.muted }}>지금</Txt>
            </View>
          </View>
          <Txt numberOfLines={1} style={{ marginTop: 2, fontFamily: font.bold, fontSize: 14 }}>
            {`${banner.fromName} 대원이 팀 ${banner.teamCode}에 초대했어요`}
          </Txt>
          <Txt numberOfLines={1} style={{ fontSize: 12, color: color.muted }}>
            {canOpen
              ? '5분 안에 수락해야 팀에 들어갈 수 있어요'
              : '이미 근무 중이라 수락할 수 없어요'}
          </Txt>
        </Pressable>
        <ChevronRight size={16} color={color.muted} />
        <Pressable
          onPress={() => setBanner(null)}
          accessibilityRole="button"
          accessibilityLabel="알림 닫기"
          hitSlop={8}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <X size={16} color={color.muted} />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
