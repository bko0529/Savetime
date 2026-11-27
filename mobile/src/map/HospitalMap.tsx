/**
 * 병원 응답 대기 · 예비 추천 화면의 지도 칸.
 * - 추천 지도: 서버가 고른 병원 최대 15곳 + 내 위치 (SFR-027 · 094)
 * - 승인 병원은 초록 마커로 따로 보인다 (SFR-149)
 * - 마커를 누르면 아래 띠에 그 병원이 나오고 목록 카드도 강조된다. '자세히'로 병원 상세
 * - 지도를 못 그리면 지도를 접고 "목록으로 보여 드려요" (SFR-062). 오프라인이면 처음부터 목록만
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

/** 지도에 올리는 병원 수 상한 (SFR-027: 마커 15개) */
export const MAP_MAX = 15;

/** 지도에 올릴 마커: 승인 병원 먼저(초록), 그다음 추천 병원. 좌표 없는 병원은 뺀다 */
export function buildMarkers(mapIds: string[], approvedIds: string[]): MapMarker[] {
  const seen = new Set<string>();
  const out: MapMarker[] = [];
  const add = (id: string, tone: MapMarker['tone']) => {
    if (seen.has(id) || out.length >= MAP_MAX) return;
    const h = hospital(id);
    if (typeof h.lat !== 'number' || typeof h.lng !== 'number') return;
    seen.add(id);
    out.push({ id, lat: h.lat, lng: h.lng, label: h.name || '병원', rank: out.length + 1, tone });
  };
  approvedIds.forEach((id) => add(id, 'approved'));
  mapIds.forEach((id) => add(id, 'normal'));
  return out;
}

export function HospitalMap({
  mapIds,
  approvedIds,
  selectedId,
  onSelect,
  onDetail,
  online,
}: {
  mapIds: string[];
  approvedIds: string[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDetail: (id: string) => void;
  online: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [me, setMe] = useState<LatLng | null>(null);
  useEffect(() => {
    let alive = true;
    void currentLocation().then((at) => alive && setMe(at));
    return () => {
      alive = false;
    };
  }, []);

  const markers = buildMarkers(mapIds, approvedIds);
  if (markers.length === 0) return null;
  if (failed || !online || !mapAvailable()) {
    return (
      <View style={{ marginTop: 16 }}>
        <Notice tone="info">
          {online
            ? '지도를 불러오지 못했어요 · 아래 목록으로 보여 드려요'
            : '오프라인이라 지도를 보여 줄 수 없어요 · 아래 목록으로 보여 드려요'}
        </Notice>
      </View>
    );
  }

  const sel = selectedId && markers.some((m) => m.id === selectedId) ? selectedId : null;
  const h = sel ? hospital(sel) : null;
  const approved = sel ? approvedIds.includes(sel) : false;
  return (
    <View style={{ marginTop: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <MapPinned size={16} color={color.accent} />
        <Txt style={{ fontFamily: font.extrabold, fontSize: 15 }}>지도</Txt>
        <Txt style={{ fontSize: 12, color: color.muted }}>
          {`병원 ${markers.length}곳${approvedIds.length ? ` · 초록은 승인 ${approvedIds.length}곳` : ''}`}
        </Txt>
      </View>
      <KakaoMap
        data={{ markers, me, selectedId: sel }}
        onSelect={(id) => onSelect(id)}
        onFail={() => setFailed(true)}
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
          {approved ? <Pill tone="ok">승인</Pill> : null}
          <Txt style={{ fontFamily: font.bold, fontSize: 13, color: color.accentDeep }}>자세히</Txt>
          <ChevronRight size={16} color={color.accentDeep} />
        </Pressable>
      ) : (
        <Txt style={{ marginTop: 6, fontSize: 12, color: color.muted }}>
          마커를 누르면 병원을 볼 수 있어요
        </Txt>
      )}
    </View>
  );
}
