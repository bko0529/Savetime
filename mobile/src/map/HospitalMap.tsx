/**
 * 승인 병원 지도 (SFR-149): 병원 응답 대기 화면에서 승인이 왔을 때만, 승인 병원 위치와 내 위치를 보여 준다.
 * - 승인 카드를 누르면 지도에서 그 병원이 강조된다 (빨간 이름표)
 * - 마커를 누르면 지도 아래 띠에 그 병원이 나오고 '자세히'로 병원 상세
 * - 지도를 못 그리면 지도를 접고 "승인 병원 목록으로 보여 드려요". 인터넷이 돌아오면 다시 불러온다 (SFR-062)
 * 예비 추천·승인 전 요청 화면에는 지도를 두지 않는다 (D-136, 2026-11-28)
 */
import { ChevronRight, MapPinned } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { hospital } from '../transport/engine';
import { currentLocation, type LatLng } from '../transport/location';
import { Notice, Pill, Txt } from '../ui/kit';
import { color, font, radius } from '../ui/theme';
import { KakaoMap, mapAvailable } from './KakaoMap';
import type { MapMarker } from './mapHtml';

/** 지도에 올릴 승인 병원 마커 (승인 온 순서). 좌표 없는 병원은 뺀다 */
export function buildMarkers(approvedIds: string[]): MapMarker[] {
  const out: MapMarker[] = [];
  for (const id of new Set(approvedIds)) {
    const h = hospital(id);
    if (typeof h.lat !== 'number' || typeof h.lng !== 'number') continue;
    out.push({
      id,
      lat: h.lat,
      lng: h.lng,
      label: h.name || '병원',
      rank: out.length + 1,
      tone: 'approved',
    });
  }
  return out;
}

export function HospitalMap({
  approvedIds,
  selectedId,
  onSelect,
  onDetail,
  online,
}: {
  approvedIds: string[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDetail: (id: string) => void;
  online: boolean;
}) {
  const [failed, setFailed] = useState(false);
  // 실패한 뒤 인터넷이 다시 붙으면 지도를 다시 불러온다 (SFR-062 ②)
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (online && failed) {
      setFailed(false);
      setAttempt((a) => a + 1);
    }
    // online 이 바뀔 때만 본다 (failed 를 넣으면 실패하자마자 다시 시도해 버린다)
  }, [online]);
  const [me, setMe] = useState<LatLng | null>(null);
  useEffect(() => {
    let alive = true;
    void currentLocation().then((at) => alive && setMe(at));
    return () => {
      alive = false;
    };
  }, []);

  const markers = buildMarkers(approvedIds);
  if (markers.length === 0) return null;
  if (failed || !online || !mapAvailable()) {
    return (
      <View style={{ marginTop: 12 }}>
        <Notice tone="info">
          {online
            ? '지도를 불러오지 못했어요 · 승인 병원 목록으로 보여 드려요'
            : '오프라인이라 지도를 보여 줄 수 없어요 · 승인 병원 목록으로 보여 드려요'}
        </Notice>
      </View>
    );
  }

  const sel = selectedId && markers.some((m) => m.id === selectedId) ? selectedId : null;
  const h = sel ? hospital(sel) : null;
  return (
    <View style={{ marginTop: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <MapPinned size={16} color={color.success} />
        <Txt style={{ fontFamily: font.extrabold, fontSize: 15 }}>승인 병원 지도</Txt>
        <Txt
          style={{ fontSize: 12, color: color.muted }}
        >{`${markers.length}곳 · 파란 점은 내 위치`}</Txt>
      </View>
      <KakaoMap
        key={attempt}
        data={{ markers, me, selectedId: sel }}
        onSelect={(id) => onSelect(id)}
        onFail={() => setFailed(true)}
        height={200}
      />
      {h && sel ? (
        <Pressable
          onPress={() => onDetail(sel)}
          accessibilityRole="button"
          accessibilityLabel={`${h.name} 자세히`}
          style={{
            marginTop: 8,
            minHeight: 48,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: color.accent,
            backgroundColor: color.accentSoft,
          }}
        >
          <View style={{ flex: 1 }}>
            <Txt style={{ fontFamily: font.bold, fontSize: 16 }} numberOfLines={1}>
              {h.name}
            </Txt>
            <Txt style={{ fontSize: 13, color: color.muted }}>
              {`${h.km}km · 약 ${h.min}분 · ${h.er ? `응급실 ${h.er}` : '병상 정보 없음'}`}
            </Txt>
          </View>
          <Pill tone="ok">승인</Pill>
          <Txt style={{ fontFamily: font.bold, fontSize: 13, color: color.accentDeep }}>자세히</Txt>
          <ChevronRight size={16} color={color.accentDeep} />
        </Pressable>
      ) : (
        <Txt style={{ marginTop: 6, fontSize: 12, color: color.muted }}>
          마커나 승인 카드를 누르면 지도에서 그 병원을 강조해요
        </Txt>
      )}
    </View>
  );
}
