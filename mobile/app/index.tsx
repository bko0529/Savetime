/**
 * 근무 중 홈 (Lovable index 그대로): 근무 상태 · 진행 중 이송 · 오늘의 팀 · 새 이송 시작.
 * 팀당 진행 중 이송은 1건이라, 진행 중이면 '진행 중 이송으로' 버튼만 보인다.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Ambulance,
  ArrowRight,
  BellRing,
  FileText,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useAuth } from '../src/auth/AuthProvider';
import { hhmm } from '../src/journal/form';
import { listJournals, type SavedJournal } from '../src/journal/storage';
import { fromServerRole, teamStore } from '../src/duty/team';
import { useStore } from '../src/state/store';
import { actions, hospital, useEngine } from '../src/transport/engine';
import { STATUS_LABEL } from '../src/transport/labels';
import { resetPatient } from '../src/transport/patientStore';
import { isActive } from '../src/transport/types';
import { routeForStatus } from '../src/transport/routing';
import {
  Avatar,
  BigButton,
  IconTile,
  PhoneScreen,
  Pill,
  SectionTitle,
  Tile,
  Txt,
} from '../src/ui/kit';
import { color, font, text } from '../src/ui/theme';

export default function HomeScreen() {
  const { state } = useAuth();
  const router = useRouter();
  const t = useStore(teamStore);
  const e = useEngine();
  // 이 휴대폰에 저장한 일지 (7일 보관, DAR-015). 홈에 돌아올 때마다 다시 읽는다
  const [journals, setJournals] = useState<SavedJournal[]>([]);
  useFocusEffect(
    useCallback(() => {
      listJournals()
        .then(setJournals)
        .catch(() => setJournals([]));
    }, []),
  );
  if (state.status !== 'signedIn') return null;
  const me = state.me;
  const team = t.team === 'loading' ? null : t.team;
  const active = isActive(e.status);

  const start = () => {
    resetPatient();
    actions.reset();
    router.push('/patient');
  };
  const resume = () => {
    const to = routeForStatus(e.status, e.phoneTarget);
    if (to) router.push(to);
  };

  const members = [...(team?.members ?? [])].sort((a, b) => Number(b.isMe) - Number(a.isMe));

  return (
    <PhoneScreen
      title="골든타임즈"
      subtitle={`${me.name ?? ''} ${me.rank ?? ''} · ${me.safetyCenter ?? ''}`}
      badge={
        <Pressable
          onPress={() => router.push('/settings')}
          accessibilityRole="button"
          accessibilityLabel="설정"
          style={{
            width: 36,
            height: 36,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(30,33,36,0.08)',
          }}
        >
          <Settings size={18} color={color.primary} />
        </Pressable>
      }
      footer={
        <>
          {active ? (
            <BigButton
              size="lg"
              onPress={resume}
              icon={<ArrowRight size={20} color={color.primaryText} />}
            >
              진행 중 이송으로
            </BigButton>
          ) : (
            <BigButton
              size="lg"
              onPress={start}
              icon={<Ambulance size={20} color={color.primaryText} />}
            >
              새 이송 시작
            </BigButton>
          )}
        </>
      }
    >
      {active ? (
        <Pressable
          onPress={resume}
          accessibilityRole="button"
          accessibilityLabel="진행 중 이송 이어서 보기"
        >
          <Tile
            style={{
              marginBottom: 12,
              padding: 16,
              borderWidth: 2,
              borderColor: color.accent,
              backgroundColor: color.accentSoft,
            }}
          >
            <Txt style={{ fontFamily: font.bold, fontSize: 11, color: color.accentDeep }}>
              진행 중 이송 · 팀당 1건
            </Txt>
            <Txt style={{ marginTop: 6, fontFamily: font.extrabold, fontSize: 18 }}>
              {STATUS_LABEL[e.status!]}
              {e.confirmedId ? ` · ${hospital(e.confirmedId).name}` : ''}
            </Txt>
            <View style={{ marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Txt style={{ fontFamily: font.semibold, fontSize: 12, color: color.accentDeep }}>
                이어서 보기
              </Txt>
              <ArrowRight size={14} color={color.accentDeep} />
            </View>
          </Tile>
        </Pressable>
      ) : null}

      <Tile
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 16,
        }}
      >
        <View>
          <Txt style={{ fontFamily: font.bold, fontSize: 11, color: color.muted }}>근무 상태</Txt>
          <Txt style={{ marginTop: 4, fontFamily: font.extrabold, fontSize: 18 }}>근무 중</Txt>
        </View>
        <Pill tone={active ? 'wait' : 'ok'}>{active ? '이송 중' : '출동 가능'}</Pill>
      </Tile>

      {t.incoming.length > 0 ? (
        <Tile
          style={{
            marginTop: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            padding: 16,
            borderWidth: 2,
            borderColor: color.accent,
            backgroundColor: color.accentSoft,
          }}
        >
          <BellRing size={20} color={color.accentDeep} />
          <Txt style={[text.body, { flex: 1 }]}>
            팀 초대 {t.incoming.length}건 · 이미 근무 중이라 수락할 수 없어요
          </Txt>
        </Tile>
      ) : null}

      <SectionTitle hint={`팀 코드 ${team?.code ?? '-'} · 팀당 진행 중 이송은 1건이에요`}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Users size={16} color={color.foreground} />
          <Txt style={{ fontFamily: font.extrabold, fontSize: 15 }}>오늘의 팀</Txt>
        </View>
      </SectionTitle>
      <Tile divided>
        {members.map((m) => (
          <View
            key={m.paramedicId}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 16,
              paddingVertical: 12,
            }}
          >
            <Avatar name={m.name ?? '?'} tone={m.isMe ? 'accent' : 'ink'} />
            <View style={{ flex: 1 }}>
              <Txt style={{ fontFamily: font.bold, fontSize: 15 }}>{m.name}</Txt>
              <Txt style={[text.caption, { color: color.muted }]}>
                {fromServerRole(m.role)}
                {m.isMe ? ' · 나' : ''}
              </Txt>
            </View>
            {m.isMe ? (
              <Pill tone="neutral" dot={false}>
                나
              </Pill>
            ) : null}
          </View>
        ))}
      </Tile>

      <SectionTitle hint="이 휴대폰에만 7일 동안 보관해요. 서버로는 보내지 않아요">
        구급활동일지
      </SectionTitle>
      {journals.length === 0 ? (
        <Tile style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 }}>
          <IconTile tone="accent">
            <FileText size={20} color={color.accentDeep} />
          </IconTile>
          <Txt style={[text.caption, { flex: 1, color: color.muted }]}>
            도착 처리하면 입력한 정보가 자동으로 채워져요
          </Txt>
        </Tile>
      ) : (
        <Tile divided>
          {journals.map((j) => (
            <Pressable
              key={j.id}
              onPress={() => router.push({ pathname: '/log', params: { id: j.id } })}
              accessibilityRole="button"
              accessibilityLabel={`${j.data.hospital || '이송'} 일지 보기`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 16,
                paddingVertical: 12,
              }}
            >
              <FileText size={18} color={color.accentDeep} />
              <View style={{ flex: 1 }}>
                <Txt style={{ fontFamily: font.bold, fontSize: 15 }} numberOfLines={1}>
                  {j.data.hospital || '병원 미입력'}
                </Txt>
                <Txt style={[text.caption, { color: color.muted }]} numberOfLines={1}>
                  {[
                    j.data.complaint,
                    `저장 ${new Date(j.savedAt).getMonth() + 1}/${new Date(j.savedAt).getDate()} ${hhmm(j.savedAt)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Txt>
              </View>
              <ArrowRight size={16} color={color.muted} />
            </Pressable>
          ))}
        </Tile>
      )}

      <View
        style={{
          marginTop: 24,
          flexDirection: 'row',
          gap: 8,
          padding: 14,
          borderRadius: 12,
          backgroundColor: color.surface,
        }}
      >
        <ShieldCheck size={16} color={color.success} style={{ marginTop: 1 }} />
        <Txt style={[text.caption, { flex: 1, color: color.muted }]}>
          환자 이름 · 주민번호 · 연락처는 받지 않아요. 본 서비스는 참고용이며 병원 수용을 보장하지
          않습니다.
        </Txt>
      </View>
    </PhoneScreen>
  );
}
