/**
 * 병원 응답 대기 · 예비 추천 (SFR-108~113, SFR-032, SFR-161). 구성·문구는 Lovable request 화면 그대로.
 * - 승인 칸: 승인이 온 순서대로 쌓인다. 새 승인은 진동으로 알린다
 * - 칸을 누르고 있는 동안에는 목록이 움직이지 않는다 (잘못 누르기 방지)
 * - 남은 시간 2분은 서버 시각 기준 (규칙 6)
 * - 가까운 병원(거리순): 기다리는 중에도 전화 확인할 수 있다 (요청은 열어 둠)
 * - 확정 전에 한 번 더 묻는다. 확정하면 다른 병원 요청은 닫힌다
 */
import { useRouter } from 'expo-router';
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  MapPin,
  PhoneCall,
  RefreshCw,
} from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, View } from 'react-native';
import {
  actions,
  hospital,
  nearbyHospitals,
  noBedHospitals,
  now,
  refreshAll,
  useEngine,
  type Hreq,
  type Result,
} from '../src/transport/engine';
import {
  bedsLabel,
  capCount,
  maxRadiusFor,
  nextRadiusFor,
  RESPONSE_LIMIT_SEC,
  type Hospital,
} from '../src/transport/hospitals';
import { HospitalMap } from '../src/map/HospitalMap';
import { useNet } from '../src/offline/net';
import { mmss } from '../src/transport/labels';
import { CLOSE_LABEL, REASON_LABEL } from '../src/transport/types';
import { HospitalDetail } from '../src/transport/ui/HospitalDetail';
import { ProgressStrip } from '../src/transport/ui/ProgressStrip';
import {
  BigButton,
  IconTile,
  Notice,
  PhoneScreen,
  Pill,
  SectionTitle,
  Tile,
  Txt,
} from '../src/ui/kit';
import { color, font, radius, text } from '../src/ui/theme';

export default function RequestScreen() {
  const e = useEngine();
  const { online } = useNet();
  const router = useRouter();
  const [frozen, setFrozen] = useState<Hreq[] | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 승인 병원 지도와 승인 카드가 같이 강조하는 병원 (SFR-149) */
  const [selected, setSelected] = useState<string | null>(null);

  const t = now();
  const live = e.hreqs
    .filter((h) => h.status === 'approved')
    .sort((a, b) => (a.respondedAt ?? 0) - (b.respondedAt ?? 0));
  const approved = frozen ?? live;
  const nearest = [...approved].sort(
    (a, b) => hospital(a.hospitalId).km - hospital(b.hospitalId).km,
  )[0];
  const cur = e.hreqs.filter((h) => h.round === e.round);
  const waiting = cur.filter((h) => h.status === 'waiting').length;
  const rejected = cur.filter((h) => h.status === 'rejected').length;
  const remain = RESPONSE_LIMIT_SEC - Math.floor((t - e.roundSentAt) / 1000);
  const fallback = e.status === 'fallback';

  // 새 승인 안내 (진동·소리는 알림 모듈이 팀원 폰 모두에, SFR-130)
  const seen = useRef(0);
  useEffect(() => {
    if (live.length > seen.current) {
      const n = live[live.length - 1];
      if (n) setNotice(`새 승인 · ${hospital(n.hospitalId).name}`);
    }
    seen.current = live.length;
  }, [live.length]);

  const run = async (p: Promise<Result>) => {
    const r = await p;
    if (!r.ok) Alert.alert('처리하지 못했어요', r.error);
    return r.ok;
  };

  /** 병원 상세 → 전화 확인 (SFR-032). 상태가 phone_check 가 되면 전화 확인 화면으로 따라간다 */
  const phone = (id: string) => {
    setDetail(null);
    void run(actions.startPhone(id));
  };

  const confirm = (id: string) => {
    setDetail(null);
    const h = hospital(id);
    Alert.alert(
      `${h.name}으로 확정할까요?`,
      `약 ${h.min}분 · ${h.km}km\n확정하면 다른 병원 요청은 닫혀요`,
      [
        { text: '취소', style: 'cancel' },
        { text: '확정', onPress: () => void run(actions.confirm(id)) },
      ],
    );
  };

  const cancel = () =>
    Alert.alert('이송을 취소할까요?', '열린 요청이 모두 닫혀요.', [
      { text: '아니요', style: 'cancel' },
      { text: '이송 취소', style: 'destructive', onPress: () => void run(actions.cancel()) },
    ]);

  // 추천 카드 상위 5곳 (SFR-027, 서버가 고름): 승인 칸에 없는 병원 + 각 병원의 최근 요청 상태
  const withReq = (h: Hospital) => ({
    h,
    req: [...e.hreqs].reverse().find((r) => r.hospitalId === h.id),
  });
  const nearby = nearbyHospitals()
    .filter((h) => !live.some((a) => a.hospitalId === h.id))
    .map(withReq)
    .filter(({ h, req }) => !(e.excluded.includes(h.id) && req?.status !== 'waiting'));
  const noBed = noBedHospitals()
    .filter((h) => !e.excluded.includes(h.id))
    .map(withReq);
  // 1초 넘게 걸릴 때만 로딩 표시 (SFR-095)
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!e.nearbyLoading) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 1000);
    return () => clearTimeout(t);
  }, [e.nearbyLoading]);
  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = async () => {
    setRefreshing(true);
    await refreshAll();
    setRefreshing(false);
  };
  /** 승인 카드: 누르면 바로 '확정할까요?' (승인 → 확정 2번, QUR-003). 자세히 보기는 그 창에서 */
  const pickApproved = (id: string) => {
    setSelected(id);
    const h = hospital(id);
    Alert.alert(
      `${h.name}으로 확정할까요?`,
      `약 ${h.min}분 · ${h.km}km\n확정하면 다른 병원 요청은 닫혀요`,
      [
        { text: '취소', style: 'cancel' },
        { text: '자세히', onPress: () => setDetail(id) },
        { text: '확정', onPress: () => void run(actions.confirm(id)) },
      ],
    );
  };
  const excludedNames = e.excluded.map((id) => hospital(id).name);
  const nextRadius = nextRadiusFor(e.grade, e.radius) ?? undefined;
  // 서버가 자동으로 넓힐 경우: 승인이 한 번도 없이 닫혔고(전부 거절·2분·전달 0) 자동 넓히기가 켜져 있음
  const autoExpandSoon =
    e.autoExpand &&
    ['all_rejected', 'expired_no_approval', 'none_delivered'].includes(e.fallbackReason ?? '') &&
    nextRadiusFor(e.grade, e.radius) !== null;
  const subtitle = fallback
    ? `${cur.length}곳 응답 종료 · 반경 ${e.radius}km`
    : `${cur.length}곳 요청 · ${e.grade ? `${e.grade} 이상` : '모든 등급'} · 반경 ${e.radius}km`;
  const pct = Math.max(0, Math.min(1, remain / RESPONSE_LIMIT_SEC));
  const urgent = remain <= 30;

  return (
    <PhoneScreen
      title={fallback ? '예비 추천' : '병원 응답 대기'}
      subtitle={subtitle}
      badge={
        !fallback ? (
          <View
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: radius.sm,
              backgroundColor: urgent ? color.destructive : color.inkTint,
            }}
          >
            <Txt
              style={{
                fontFamily: font.extrabold,
                fontSize: 14,
                color: urgent ? color.accentText : color.primary,
              }}
            >
              {mmss(remain)}
            </Txt>
          </View>
        ) : undefined
      }
      footer={
        <>
          {fallback ? (
            nextRadius ? (
              <BigButton
                size="lg"
                onPress={() => void run(actions.expand())}
              >{`반경 넓혀 다시 요청 (${nextRadius}km)`}</BigButton>
            ) : (
              <Notice tone="warn">{`최대 반경(${maxRadiusFor(e.grade)}km)이에요 · 가까운 병원에 전화로 확인하세요`}</Notice>
            )
          ) : null}
          <BigButton variant="outline" onPress={cancel}>
            이송 취소
          </BigButton>
          <BigButton variant="ghost" size="sm" onPress={() => router.push('/patient')}>
            환자 정보 바꾸기
          </BigButton>
        </>
      }
    >
      <ProgressStrip />
      {fallback && e.fallbackReason ? (
        <View style={{ marginBottom: 16 }}>
          <Notice tone="warn">{`${REASON_LABEL[e.fallbackReason] ?? '승인한 병원이 없어요'} · 가까운 병원에 전화로 확인하세요`}</Notice>
        </View>
      ) : null}
      {/* 자동 넓히기 (D-142): 승인 0곳이면 서버가 몇 초 안에 넓혀 다시 요청한다 */}
      {fallback && autoExpandSoon ? (
        <View style={{ marginBottom: 16 }}>
          <Notice tone="info">곧 반경을 넓혀 새 병원에 자동으로 다시 요청해요</Notice>
        </View>
      ) : null}
      {!fallback && e.autoExpandedTo ? (
        <View style={{ marginBottom: 12 }}>
          <Notice tone="ok">{`승인한 병원이 없어 반경을 ${e.autoExpandedTo}km로 넓혀 새 병원에 다시 요청했어요`}</Notice>
        </View>
      ) : null}
      {!fallback && notice ? (
        <View style={{ marginBottom: 12, flexDirection: 'row' }}>
          <View style={{ flex: 1 }}>
            <Notice tone="ok">{`${notice} (진동)`}</Notice>
          </View>
        </View>
      ) : null}

      {/* 승인 칸: 누르고 있는 동안 목록을 멈춘다 */}
      <View
        onTouchStart={() => setFrozen(live)}
        onTouchEnd={() => setFrozen(null)}
        onTouchCancel={() => setFrozen(null)}
        style={{
          padding: 16,
          borderRadius: radius.md,
          borderWidth: 1,
          borderStyle: approved.length ? 'solid' : 'dashed',
          borderColor: approved.length ? 'rgba(0,125,101,0.4)' : color.borderStrong,
          backgroundColor: approved.length ? color.successSoft : color.card,
        }}
      >
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {approved.length > 0 ? <CheckCircle2 size={20} color={color.success} /> : null}
            <Txt
              style={{
                fontFamily: font.extrabold,
                fontSize: 18,
                color: approved.length ? color.success : color.muted,
              }}
            >
              승인 {approved.length}곳
            </Txt>
          </View>
          <Txt style={[text.caption, { color: color.muted }]}>
            {fallback ? '· 응답 종료' : approved.length ? '· 온 순서대로 쌓여요' : ''}
          </Txt>
        </View>
        {approved.length === 0 ? (
          <Txt style={[text.body, { marginTop: 8, color: color.muted }]}>
            승인이 오면 여기에 모여요 · 진동으로 알려요
          </Txt>
        ) : (
          <View style={{ marginTop: 12, gap: 8 }}>
            {approved.map((r) => {
              const h = hospital(r.hospitalId);
              const near = r.hospitalId === nearest?.hospitalId;
              const cc = capCount(h);
              return (
                <Pressable
                  key={`${r.hospitalId}-${r.round}`}
                  onPress={() => pickApproved(r.hospitalId)}
                  accessibilityRole="button"
                  accessibilityLabel={`${h.name} 승인 · 확정하기`}
                  style={{
                    flexDirection: 'row',
                    gap: 12,
                    padding: 14,
                    borderRadius: radius.sm,
                    borderWidth: 2,
                    borderColor: selected === r.hospitalId ? color.accent : 'transparent',
                    backgroundColor: color.card,
                  }}
                >
                  <View
                    style={{
                      width: 4,
                      borderRadius: 2,
                      backgroundColor: near ? color.accent : color.success,
                    }}
                  />
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Txt
                        style={{ fontFamily: font.extrabold, fontSize: 17, flexShrink: 1 }}
                        numberOfLines={1}
                      >
                        {h.name}
                      </Txt>
                      <Txt style={{ fontSize: 11, fontFamily: font.bold, color: color.muted }}>
                        {h.km}km
                      </Txt>
                      {r.recheck ? (
                        <Txt
                          style={{ fontSize: 11, fontFamily: font.bold, color: color.accentDeep }}
                        >
                          재확인
                        </Txt>
                      ) : null}
                    </View>
                    <Txt style={{ marginTop: 4, fontSize: 16, lineHeight: 22, color: color.muted }}>
                      약 {h.min}분 · 응급실 {h.er ?? '정보 없음'} · 진료가능 {cc.available}/
                      {cc.total}
                    </Txt>
                    <Txt
                      style={{
                        marginTop: 4,
                        fontFamily: font.semibold,
                        fontSize: 12,
                        color: color.foreground,
                      }}
                    >
                      {r.note ? `"${r.note}"` : '메모 없음'}
                    </Txt>
                  </View>
                  <View style={{ alignItems: 'flex-end', justifyContent: 'space-between' }}>
                    <Pill tone="ok">{near ? '가장 가까움' : '승인'}</Pill>
                    <ChevronRight size={16} color={color.muted} />
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
      {approved.length > 0 ? (
        <Txt style={[text.caption, { marginTop: 8, color: color.muted }]}>
          화면을 누르고 있는 동안에는 위치가 바뀌지 않아요. 손을 떼면 새 승인이 들어와요.
        </Txt>
      ) : null}

      {!fallback ? (
        <Tile style={{ marginTop: 12, padding: 16 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
            }}
          >
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Clock size={14} color={color.muted} />
                <Txt style={{ fontFamily: font.bold, fontSize: 11, color: color.muted }}>
                  남은 시간
                </Txt>
              </View>
              <Txt
                style={{
                  marginTop: 4,
                  fontFamily: font.extrabold,
                  fontSize: 30,
                  color: urgent ? color.destructive : color.foreground,
                }}
                accessibilityLabel={`남은 시간 ${mmss(remain)}`}
              >
                {mmss(remain)}
              </Txt>
            </View>
            <Txt style={{ fontFamily: font.semibold, fontSize: 12, color: color.muted }}>
              대기 {waiting} · 거절 {rejected}
            </Txt>
          </View>
          <View
            style={{
              marginTop: 12,
              height: 6,
              borderRadius: 3,
              overflow: 'hidden',
              backgroundColor: color.surface2,
            }}
          >
            <View
              style={{
                height: '100%',
                width: `${pct * 100}%`,
                borderRadius: 3,
                backgroundColor: urgent ? color.destructive : color.accent,
              }}
            />
          </View>
        </Tile>
      ) : null}

      {/* 승인 병원 지도 (SFR-149): 승인이 왔을 때만 승인 병원 + 내 위치. 예비 추천·승인 전에는 지도 없음 (D-136) */}
      {live.length > 0 ? (
        <HospitalMap
          approvedIds={live.map((r) => r.hospitalId)}
          selectedId={selected}
          onSelect={setSelected}
          onDetail={(id) => setDetail(id)}
          online={online}
        />
      ) : null}

      <SectionTitle
        hint={
          fallback
            ? '거절 · 승인 취소한 병원은 빠져요'
            : '기다리는 중에도 전화로 확인할 수 있어요 (요청은 열어 둬요)'
        }
      >
        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Txt style={{ fontFamily: font.extrabold, fontSize: 15 }}>가까운 병원 (거리순)</Txt>
          <Pressable
            onPress={() => void refreshNow()}
            disabled={refreshing}
            accessibilityRole="button"
            accessibilityLabel="새로고침"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: color.border,
              backgroundColor: color.card,
            }}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={color.muted} />
            ) : (
              <RefreshCw size={14} color={color.muted} />
            )}
            <Txt style={{ fontFamily: font.bold, fontSize: 12, color: color.muted }}>새로고침</Txt>
          </Pressable>
        </View>
      </SectionTitle>
      {slow ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}
          accessibilityLabel="불러오는 중"
        >
          <ActivityIndicator size="small" color={color.accent} />
          <Txt style={[text.caption, { color: color.muted }]}>병원 목록을 불러오는 중…</Txt>
        </View>
      ) : null}
      <View style={{ gap: 8 }}>
        {nearby.map(({ h, req }) => (
          <HospitalRow
            key={h.id}
            h={h}
            req={req}
            fallback={fallback}
            offline={!online || e.cachedAt !== null}
            onPress={() => setDetail(h.id)}
          />
        ))}
        {nearby.length === 0 && !e.nearbyLoading ? (
          <EmptyGuide
            noData={
              !online || e.cachedAt !== null || (e.emptyGuide === null && e.mapIds.length === 0)
            }
            onRefresh={() => void refreshNow()}
            guide={e.emptyGuide}
            nextRadius={nextRadius}
            fallback={fallback}
            onWiden={() => void run(actions.widenRecommend())}
          />
        ) : null}
      </View>
      {noBed.length > 0 ? (
        <>
          <SectionTitle hint="실시간 병상 정보가 없는 병원이에요. 전화로 확인하세요">
            병상 정보 없음 · 전화로 확인
          </SectionTitle>
          <View style={{ gap: 8 }}>
            {noBed.map(({ h, req }) => (
              <HospitalRow
                key={h.id}
                h={h}
                req={req}
                fallback={fallback}
                offline={!online || e.cachedAt !== null}
                onPress={() => setDetail(h.id)}
              />
            ))}
          </View>
        </>
      ) : null}
      {excludedNames.length > 0 ? (
        <Txt style={[text.caption, { marginTop: 12, color: color.muted }]}>
          거절 · 승인 취소한 {excludedNames.join(', ')}은 목록에서 빠져요
        </Txt>
      ) : null}

      {detail ? (
        <HospitalDetail
          h={hospital(detail)}
          approved={live.some((r) => r.hospitalId === detail)}
          note={[...e.hreqs].reverse().find((r) => r.hospitalId === detail)?.note}
          onClose={() => setDetail(null)}
          onConfirm={() => confirm(detail)}
          onPhone={() => phone(detail)}
        />
      ) : null}
    </PhoneScreen>
  );
}

/** 추천 카드 한 줄 (SFR-002): 병원명 · 거리 · 예상 이동시간 · 잔여 병상 · 진료가능 항목 수 · 데이터 기준 시각 */
function HospitalRow({
  h,
  req,
  fallback,
  offline,
  onPress,
}: {
  h: Hospital;
  req: Hreq | undefined;
  fallback: boolean;
  /** 오프라인·저장본이면 '참고용 정보 · 기준 HH:MM' (SFR-081 ③) */
  offline: boolean;
  onPress: () => void;
}) {
  const st = req?.status;
  const label = !req
    ? '요청 안 함'
    : st === 'waiting'
      ? '요청함'
      : st === 'closed' && req.closeReason
        ? CLOSE_LABEL[req.closeReason]
        : st === 'expired'
          ? '응답 없음'
          : st === 'delivery_failed'
            ? '전달 실패'
            : st === 'rejected'
              ? `거절${req.reason ? ` · ${req.reason}` : ''}`
              : '요청함';
  const isWaiting = st === 'waiting' && !fallback;
  const cc = capCount(h);
  const data = bedsLabel(h, offline);
  return (
    <Pressable
      onPress={onPress}
      disabled={isWaiting}
      accessibilityRole="button"
      accessibilityLabel={`${h.name} ${label}`}
      accessibilityState={{ disabled: isWaiting }}
    >
      <Tile
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          padding: 14,
          opacity: isWaiting ? 0.6 : 1,
        }}
      >
        <IconTile tone={isWaiting ? 'warn' : 'accent'} size={36}>
          <MapPin size={16} color={isWaiting ? color.warning : color.accentDeep} />
        </IconTile>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Txt style={{ fontFamily: font.bold, fontSize: 16, flexShrink: 1 }} numberOfLines={1}>
              {h.name}
            </Txt>
            <Txt style={{ fontSize: 12, fontFamily: font.bold, color: color.muted }}>{h.km}km</Txt>
          </View>
          <Txt
            style={{ marginTop: 2, fontSize: 16, lineHeight: 22, color: color.muted }}
            numberOfLines={2}
          >
            약 {h.min}분 · {h.er ? `응급실 ${h.er}` : '병상 정보 없음'} · 진료가능 {cc.available}/
            {cc.total} · {label}
          </Txt>
          {data ? (
            <Txt
              style={{
                marginTop: 2,
                fontSize: 11,
                color: h.stale || offline ? color.warning : color.muted,
              }}
            >
              {data}
            </Txt>
          ) : null}
        </View>
        {isWaiting ? (
          <Pill tone="wait">대기</Pill>
        ) : !h.er ? (
          <Pill tone="neutral">병상 없음 · 전화</Pill>
        ) : (
          <Pill tone="call" icon={<PhoneCall size={12} color={color.accentDeep} />}>
            전화 확인
          </Pill>
        )}
      </Tile>
    </Pressable>
  );
}

/** 추천 0건 안내 (SFR-029): 한 단계 넓혀 다시 찾기, 최대(40km · 대학병원급 80km)면 전화로 확인 */
function EmptyGuide({
  noData,
  onRefresh,
  guide,
  nextRadius,
  fallback,
  onWiden,
}: {
  /** 서버에도 휴대폰에도 병원 정보가 없음 (SFR-008) */
  noData: boolean;
  onRefresh: () => void;
  guide: 'expand_radius' | 'call_nearby' | null;
  nextRadius: number | undefined;
  fallback: boolean;
  onWiden: () => void;
}) {
  const canWiden = fallback && guide !== 'call_nearby' && !!nextRadius;
  if (noData && !guide) {
    return (
      <View
        style={{ gap: 10, padding: 14, borderRadius: radius.sm, backgroundColor: color.surface }}
      >
        <Txt style={[text.body, { color: color.muted }]}>불러올 수 있는 병원 정보가 없습니다</Txt>
        <BigButton variant="outline" size="sm" onPress={onRefresh}>
          새로고침
        </BigButton>
      </View>
    );
  }
  return (
    <View style={{ gap: 10, padding: 14, borderRadius: radius.sm, backgroundColor: color.surface }}>
      <Txt style={[text.body, { color: color.muted }]}>
        {canWiden
          ? `반경을 ${nextRadius}km로 넓혀 다시 찾을까요?`
          : '추천할 병원이 없어요 · 가까운 병원에 전화로 확인하세요'}
      </Txt>
      {canWiden ? (
        <BigButton variant="outline" size="sm" onPress={onWiden}>
          넓혀서 찾기
        </BigButton>
      ) : null}
    </View>
  );
}
