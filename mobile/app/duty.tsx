/**
 * 근무 시작 (SFR-113 · SFR-159). 구성·문구는 Lovable duty 화면 그대로.
 * 팀 만들기(4자리 코드 · QR · 목록 초대) 또는 참여(코드 · QR 스캔). 팀은 최대 4명, 운전은 1명.
 * 팀원이 들어오거나 역할을 바꾸면 실시간 이벤트로 목록이 바뀐다.
 */
import { useRouter } from 'expo-router';
import { BellRing, Clock, LogOut, QrCode, Search, UserPlus, Users } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { serverNow } from '../src/api/client';
import { useAuth } from '../src/auth/AuthProvider';
import {
  createTeam,
  fromServerRole,
  INVITE_MS,
  QR_PREFIX,
  joinTeam,
  listColleagues,
  MEMO_MAX,
  saveMemo,
  sendInvite,
  setMyRole,
  startDuty,
  TEAM_MAX,
  teamStore,
  type Colleague,
  type Role,
} from '../src/duty/team';
import { useStore } from '../src/state/store';
import {
  Avatar,
  BigButton,
  Field,
  Label,
  Notice,
  PhoneScreen,
  Pill,
  SectionTitle,
  Segmented,
  Tile,
  Txt,
} from '../src/ui/kit';
import { color, font, radius, text } from '../src/ui/theme';

const mmss = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

export default function DutyScreen() {
  const { state, logout } = useAuth();
  const router = useRouter();
  const t = useStore(teamStore);
  const team = t.team === 'loading' ? null : t.team;
  const [mode, setMode] = useState<'new' | 'join'>(team && !t.isCreator ? 'join' : 'new');
  const [code, setCode] = useState('');
  const [role, setRole] = useState<Role>('처치');
  const [sent, setSent] = useState<Record<number, number>>({}); // paramedicId → 보낸 시각(서버 기준)
  const [pool, setPool] = useState<Colleague[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(serverNow());
  // 나만 보는 대원 메모 (SFR-143)
  const [memoFor, setMemoFor] = useState<number | null>(null);
  const [memoText, setMemoText] = useState('');
  const storeMemo = async () => {
    if (memoFor === null) return;
    const e = await saveMemo(memoFor, memoText);
    if (e) return setErr(e);
    setPool((l) =>
      l.map((x) => (x.paramedicId === memoFor ? { ...x, myMemo: memoText.trim() || null } : x)),
    );
    setMemoFor(null);
  };

  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(id);
  }, []);

  // 같은 소방서 대원 목록 (근무 중 먼저, 이름으로 찾으면 소방서 전체). 입력을 멈추고 0.3초 뒤에 읽는다
  const memberCount = team?.members?.length ?? 0;
  useEffect(() => {
    if (mode !== 'new' || !team) return;
    const id = setTimeout(() => {
      listColleagues(q)
        .then(setPool)
        .catch(() => setPool([]));
    }, 300);
    return () => clearTimeout(id);
  }, [q, mode, team, memberCount]);

  if (state.status !== 'signedIn') return null;
  const me = state.me;
  const members = (team?.members ?? []).filter((m) => !m.isMe);
  const shownRole: Role = team ? fromServerRole(team.members?.find((m) => m.isMe)?.role) : role;
  const driverTaken = members.some((m) => m.role === 'driver');
  const pending = Object.entries(sent).filter(
    ([id, at]) => now - at < INVITE_MS && !members.some((m) => String(m.paramedicId) === id),
  );
  const full = members.length + 1 + (mode === 'new' ? pending.length : 0) >= TEAM_MAX;

  const switchMode = (m: 'new' | 'join') => {
    if (m === mode) return;
    // 팀에서 나오면 서버가 근무를 끝낸다(로그아웃). 그래서 팀이 생긴 뒤에는 바꿀 수 없다
    if (team) return setErr('이미 팀이 있어요. 다른 팀으로 가려면 로그아웃한 뒤 다시 로그인하세요');
    setErr('');
    setMode(m);
  };

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setErr((await fn()) ?? '');
    setBusy(false);
  };

  const join = (c: string) => {
    if (!/^\d{4}$/.test(c)) return setErr('팀원 화면의 4자리 코드를 입력해 주세요');
    void run(() => joinTeam({ code: c }, role));
  };

  const invite = async (p: Colleague) => {
    if (full) return setErr(`팀은 최대 ${TEAM_MAX}명이에요`);
    const e = await sendInvite(p.paramedicId!);
    if (e) return setErr(e);
    setErr('');
    setSent((l) => ({ ...l, [p.paramedicId!]: serverNow() }));
  };

  const pickMyRole = async (r: Role) => {
    if (r === '운전' && driverTaken)
      return setErr('이미 운전 대원이 있어요. 운전은 팀에 1명이에요');
    setErr('');
    setRole(r);
    if (team) {
      const e = await setMyRole(r);
      if (e) setErr(e);
    }
  };

  // 팀원 없이 바로 시작해도 된다: 팀이 없으면 만들고 시작
  const start = async () => {
    if (mode === 'join' && !team) return setErr('팀 코드를 입력하거나 QR을 스캔해 주세요');
    if (!team) {
      setBusy(true);
      const e = await createTeam(role);
      setBusy(false);
      if (e) return setErr(e);
    }
    await startDuty();
  };

  // 이미 우리 팀인 대원은 위 '오늘의 팀'에 있으니 목록에서 뺀다
  const others = pool.filter((c) => !members.some((m) => m.paramedicId === c.paramedicId));
  const shown = q.trim() ? others : others.filter((c) => c.onDuty);

  return (
    <PhoneScreen
      title="근무 시작"
      subtitle={`${me.name ?? ''} ${me.rank ?? ''} · ${me.agency ?? ''} ${me.safetyCenter ?? ''}`}
      badge={
        <Pill tone="neutral" dot={false}>
          {`${members.length + 1}/${TEAM_MAX}명`}
        </Pill>
      }
      footer={
        <>
          <BigButton size="lg" busy={busy} onPress={() => void start()}>
            {mode === 'new' ? '팀 만들고 근무 시작' : '이 팀으로 근무 시작'}
          </BigButton>
          <BigButton
            variant="ghost"
            size="sm"
            onPress={() => void logout()}
            icon={<LogOut size={16} color={color.muted} />}
          >
            로그아웃
          </BigButton>
        </>
      }
    >
      {t.incoming.length > 0 ? (
        <Pressable
          onPress={() => router.push('/invite')}
          accessibilityRole="button"
          accessibilityLabel="받은 팀 초대 보기"
        >
          <Tile
            style={{
              marginBottom: 16,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              padding: 16,
              borderWidth: 2,
              borderColor: color.accent,
              backgroundColor: color.accentSoft,
            }}
          >
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 16,
                backgroundColor: color.accent,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <BellRing size={20} color={color.accentText} />
            </View>
            <View style={{ flex: 1 }}>
              <Txt style={text.strong}>팀 초대 {t.incoming.length}건 · 확인</Txt>
              <Txt
                style={[text.caption, { marginTop: 2, color: color.accentDeep }]}
                numberOfLines={1}
              >
                {t.incoming.map((i) => `${i.fromName} 대원 · 팀 ${i.teamCode}`).join(', ')} · 5분
                안에 수락해야 들어갈 수 있어요
              </Txt>
            </View>
          </Tile>
        </Pressable>
      ) : null}

      {t.notice ? (
        <View style={{ marginBottom: 16 }}>
          <Notice tone="info">{t.notice}</Notice>
        </View>
      ) : null}

      <Segmented
        value={mode}
        onChange={switchMode}
        options={[
          { value: 'new', label: '팀 만들기' },
          { value: 'join', label: '팀 참여' },
        ]}
      />

      {mode === 'new' ? (
        <Tile
          style={{
            marginTop: 16,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 16,
            padding: 16,
          }}
        >
          <View style={{ padding: 10, borderRadius: radius.md, backgroundColor: color.surface }}>
            {team?.qrToken ? (
              <QRCode
                value={`${QR_PREFIX}${team.qrToken}`}
                size={92}
                color={color.foreground}
                backgroundColor={color.surface}
              />
            ) : (
              <View style={{ width: 92, height: 92 }} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Txt style={[text.caption, { color: color.muted }]}>
              팀원에게 코드나 QR을 보여 주세요
            </Txt>
            {team?.code ? (
              <Txt
                style={{
                  marginTop: 4,
                  fontFamily: font.extrabold,
                  fontSize: 36,
                  lineHeight: 40,
                  letterSpacing: 8,
                }}
                accessibilityLabel={`팀 코드 ${team.code}`}
              >
                {team.code}
              </Txt>
            ) : (
              <BigButton
                size="sm"
                busy={busy}
                onPress={() => void run(() => createTeam(role))}
                style={{ marginTop: 8, width: 'auto', paddingHorizontal: 16 }}
              >
                팀 코드 만들기
              </BigButton>
            )}
            <Txt style={[text.caption, { marginTop: 8, color: color.muted }]}>
              {team?.code
                ? '팀원이 없어도 바로 시작할 수 있어요'
                : '코드를 만들어야 팀원이 들어오고 초대할 수 있어요'}
            </Txt>
          </View>
        </Tile>
      ) : team ? (
        <View style={{ marginTop: 16 }}>
          <Notice tone="ok">팀 {team.code}에 참여했어요</Notice>
        </View>
      ) : (
        <View style={{ marginTop: 16 }}>
          <Label>팀원이 보여준 4자리 팀 코드</Label>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field
              style={{
                flex: 1,
                textAlign: 'center',
                fontFamily: font.extrabold,
                fontSize: 24,
                letterSpacing: 10,
              }}
              keyboardType="number-pad"
              maxLength={4}
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, ''))}
              placeholder="4821"
              accessibilityLabel="팀 코드"
            />
            <BigButton
              busy={busy}
              onPress={() => join(code)}
              style={{ width: 'auto', height: 52, paddingHorizontal: 20 }}
            >
              참여
            </BigButton>
          </View>
          <Pressable
            onPress={() => router.push({ pathname: '/scan', params: { role } })}
            accessibilityRole="button"
            accessibilityLabel="QR 스캔으로 참여"
          >
            <Tile
              style={{
                marginTop: 8,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: 12,
              }}
            >
              <QrCode size={20} color={color.accentDeep} />
              <Txt style={{ fontFamily: font.bold, fontSize: 14 }}>QR 스캔으로 참여</Txt>
            </Tile>
          </Pressable>
          <Txt style={[text.caption, { marginTop: 6, color: color.muted }]}>
            카메라 권한은 QR 스캔할 때 물어요
          </Txt>
        </View>
      )}

      <SectionTitle hint={`최대 ${TEAM_MAX}명 · 운전은 1명 (운전 폰은 주행 중 입력 잠금)`}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Users size={16} color={color.foreground} />
          <Txt style={{ fontFamily: font.extrabold, fontSize: 15 }}>
            오늘의 팀 ({members.length + 1}명)
          </Txt>
        </View>
      </SectionTitle>
      <Tile divided>
        <Row
          avatar={<Avatar name={me.name ?? '나'} tone="accent" />}
          title={
            <>
              {me.name}{' '}
              <Txt style={{ fontFamily: font.semibold, fontSize: 12, color: color.muted }}>나</Txt>
            </>
          }
          sub={`${me.rank ?? ''} · ${me.safetyCenter ?? ''}`}
          right={
            <Segmented
              small
              value={shownRole}
              onChange={(r) => void pickMyRole(r)}
              options={[
                { value: '처치', label: '처치' },
                { value: '운전', label: '운전', disabled: driverTaken && shownRole !== '운전' },
              ]}
            />
          }
        />
        {members.map((m) => (
          <Row
            key={m.paramedicId}
            avatar={<Avatar name={m.name ?? '?'} />}
            title={m.name}
            sub={m.rank}
            right={
              <Pill tone="neutral" dot={false}>
                {fromServerRole(m.role)}
              </Pill>
            }
          />
        ))}
        {mode === 'new'
          ? pending.map(([id, at]) => {
              const c = pool.find((x) => String(x.paramedicId) === id);
              return (
                <Row
                  key={`p${id}`}
                  avatar={<Avatar name={c?.name ?? '?'} tone="muted" />}
                  title={<Txt style={{ color: color.muted }}>{c?.name ?? '초대한 대원'}</Txt>}
                  sub="초대 보냄 · 수락 대기"
                  right={
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Clock size={12} color={color.muted} />
                      <Txt style={{ fontFamily: font.bold, fontSize: 12, color: color.muted }}>
                        {mmss(Math.max(0, INVITE_MS - (now - at)))}
                      </Txt>
                    </View>
                  }
                />
              );
            })
          : null}
        {members.length === 0 && pending.length === 0 ? (
          <Txt style={[text.body, { padding: 16, color: color.muted }]}>
            아직 팀원이 없어요. 아래 목록에서 초대하거나 바로 시작할 수 있어요.
          </Txt>
        ) : null}
      </Tile>

      {mode === 'new' ? (
        <>
          <SectionTitle hint="지금 근무 중인 우리 소방서 대원이 먼저 보여요. 없으면 이름으로 찾으세요">
            대원 목록에서 초대
          </SectionTitle>
          <View>
            <View style={{ position: 'absolute', left: 14, top: 18, zIndex: 1 }}>
              <Search size={16} color={color.muted} />
            </View>
            <Field
              style={{ paddingLeft: 40 }}
              value={q}
              onChangeText={setQ}
              placeholder="이름으로 소방서 전체 검색"
              accessibilityLabel="대원 이름 검색"
            />
          </View>
          <Tile divided style={{ marginTop: 8 }}>
            {shown.length === 0 ? (
              <Txt style={[text.body, { padding: 16, color: color.muted }]}>
                {!team
                  ? '팀 코드를 만들면 대원을 초대할 수 있어요'
                  : q.trim()
                    ? '찾는 대원이 없어요'
                    : '지금 근무 중인 대원이 없어요. 이름으로 찾아보세요'}
              </Txt>
            ) : null}
            {shown.map((c) => {
              const wasSent =
                c.inviteStatus === 'sent' || pending.some(([id]) => id === String(c.paramedicId));
              return (
                <Row
                  key={c.paramedicId}
                  avatar={<Avatar name={c.name ?? '?'} tone={c.onDuty ? 'ink' : 'muted'} />}
                  title={
                    <>
                      {c.name}{' '}
                      <Txt style={{ fontFamily: font.semibold, fontSize: 12, color: color.muted }}>
                        {c.rank} · 사번 끝 {c.employeeNoTail}
                      </Txt>
                    </>
                  }
                  sub={`${c.safetyCenter ?? ''}${c.onDuty ? ' · 근무 중' : ''}`}
                  memo={
                    <Pressable
                      onPress={() => {
                        setMemoFor(c.paramedicId!);
                        setMemoText(c.myMemo ?? '');
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`${c.name} 메모 ${c.myMemo ? '고치기' : '쓰기'}`}
                      hitSlop={8}
                    >
                      <Txt
                        style={{ fontSize: 12, color: c.myMemo ? color.accentDeep : color.muted }}
                      >
                        {c.myMemo ? `메모 · ${c.myMemo}` : '+ 메모'}
                      </Txt>
                    </Pressable>
                  }
                  right={
                    c.inTeam ? (
                      <Pill tone="neutral" dot={false}>
                        다른 팀
                      </Pill>
                    ) : wasSent ? (
                      <Pill tone="wait">보냄</Pill>
                    ) : (
                      <Pressable
                        onPress={() => void invite(c)}
                        disabled={full || !team}
                        accessibilityRole="button"
                        accessibilityLabel={`${c.name} 초대`}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 4,
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          borderRadius: radius.sm,
                          backgroundColor: color.primary,
                          opacity: full || !team ? 0.4 : 1,
                        }}
                      >
                        <UserPlus size={14} color={color.primaryText} />
                        <Txt
                          style={{ fontFamily: font.bold, fontSize: 13, color: color.primaryText }}
                        >
                          초대
                        </Txt>
                      </Pressable>
                    )
                  }
                />
              );
            })}
          </Tile>
          {memoFor !== null ? (
            <Tile style={{ marginTop: 8, padding: 14, gap: 8 }}>
              <Txt style={{ fontFamily: font.bold, fontSize: 14 }}>
                {pool.find((x) => x.paramedicId === memoFor)?.name ?? '대원'} 메모 (나만 보여요,{' '}
                {MEMO_MAX}자)
              </Txt>
              <Field
                value={memoText}
                onChangeText={(t) => setMemoText(t.slice(0, MEMO_MAX))}
                placeholder="예: 3센터 운전 담당"
                accessibilityLabel="대원 메모"
              />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <BigButton
                  variant="outline"
                  size="sm"
                  style={{ flex: 1 }}
                  onPress={() => setMemoFor(null)}
                >
                  취소
                </BigButton>
                <BigButton size="sm" style={{ flex: 1 }} onPress={() => void storeMemo()}>
                  메모 저장
                </BigButton>
              </View>
            </Tile>
          ) : null}
          <Txt style={[text.caption, { marginTop: 6, color: color.muted }]}>
            초대받은 대원이 &apos;수락&apos;해야 팀원이 돼요. 초대는 5분 뒤 만료돼요.
          </Txt>
        </>
      ) : null}

      {err ? (
        <View style={{ marginTop: 16 }}>
          <Notice tone="warn">{err}</Notice>
        </View>
      ) : null}
      <Txt style={[text.caption, { marginTop: 20, color: color.muted }]}>
        근무를 마치거나 로그아웃하면 나만 팀에서 빠져요. 근무 시작 후 14시간이 지나면 자동으로
        근무가 끝나요.
      </Txt>
    </PhoneScreen>
  );
}

function Row({
  avatar,
  title,
  sub,
  memo,
  right,
}: {
  avatar: ReactNode;
  title: ReactNode;
  sub?: string;
  /** 이름 아래 작게: 나만 보는 메모 (SFR-143) */
  memo?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}
    >
      {avatar}
      <View style={{ flex: 1 }}>
        <Txt style={{ fontFamily: font.bold, fontSize: 15 }} numberOfLines={1}>
          {title}
        </Txt>
        {sub ? (
          <Txt style={[text.caption, { color: color.muted }]} numberOfLines={1}>
            {sub}
          </Txt>
        ) : null}
        {memo}
      </View>
      {right}
    </View>
  );
}
