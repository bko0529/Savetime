'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { errorText } from '@/lib/api/errorText';
import type { components } from '@/lib/api/schema';
import { kakaoJsKey, loadKakaoMaps, type KakaoMarker } from '@/lib/map/kakaoMaps';
import { useAdminApi } from '../useAdminApi';

type AdminHospital = components['schemas']['AdminHospital'];
type Point = { lat: number; lng: number };
type MapState = 'off' | 'loading' | 'ready' | 'failed';

// 공공 데이터 좌표도 없을 때 지도의 처음 가운데 (천안)
const FALLBACK_CENTER: Point = { lat: 36.815, lng: 127.1139 };

// 대한민국 안 좌표만 (서버도 같은 범위로 막는다, isInKorea)
const inKorea = (p: Point) => p.lat >= 33 && p.lat <= 39 && p.lng >= 124 && p.lng <= 132;
const fixed6 = (n: number) => n.toFixed(6);

const inputClass = 'h-12 w-full rounded-lg border-2 border-input px-3 text-lg tabular-nums';

// 응급실 입구 좌표 지정 (SFR-145, A-03). 지도에서 입구를 눌러 찍고 저장한다.
// 저장하면 이 병원의 도착 판정(앱 목적지·병원 웹 도착 확인 200m)이 이 좌표로 바뀐다.
// 지도 키가 없거나 지도를 못 불러오면 위도·경도를 직접 넣는다
export function EntranceDialog({
  hospital,
  onClose,
}: {
  hospital: AdminHospital;
  onClose: () => void;
}) {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const start = hospital.entrance ?? null;
  const [lat, setLat] = useState(start ? fixed6(start.lat) : '');
  const [lng, setLng] = useState(start ? fixed6(start.lng) : '');
  const [mapState, setMapState] = useState<MapState>(kakaoJsKey() ? 'loading' : 'off');
  const mapBox = useRef<HTMLDivElement | null>(null);
  const marker = useRef<KakaoMarker | null>(null);

  const point: Point | null =
    lat.trim() !== '' && lng.trim() !== '' && Number.isFinite(+lat) && Number.isFinite(+lng)
      ? { lat: +lat, lng: +lng }
      : null;
  const valid = point !== null && inKorea(point);

  // 지도: 입구(없으면 병원 좌표)를 가운데에 두고, 누른 곳으로 핀을 옮긴다
  useEffect(() => {
    const key = kakaoJsKey();
    if (!key) return;
    let cancelled = false;
    loadKakaoMaps(key)
      .then((maps) => {
        if (cancelled || !mapBox.current) return;
        const center = start ?? hospital.location ?? FALLBACK_CENTER;
        const map = new maps.Map(mapBox.current, {
          center: new maps.LatLng(center.lat, center.lng),
          // 3 ≈ 건물 입구를 구분할 수 있는 확대
          level: 3,
        });
        if (start) {
          marker.current = new maps.Marker({
            position: new maps.LatLng(start.lat, start.lng),
            map,
          });
        }
        maps.event.addListener(map, 'click', (e) => {
          if (marker.current) marker.current.setPosition(e.latLng);
          else marker.current = new maps.Marker({ position: e.latLng, map });
          setLat(fixed6(e.latLng.getLat()));
          setLng(fixed6(e.latLng.getLng()));
        });
        setMapState('ready');
      })
      .catch(() => {
        if (!cancelled) setMapState('failed');
      });
    return () => {
      cancelled = true;
      marker.current?.setMap(null);
      marker.current = null;
    };
    // 일부러 빈 목록: 창을 열 때 한 번만 지도를 만든다 (처음 입구·병원 좌표는 창이 열린 동안 바뀌지 않음)
  }, []);

  const save = useMutation({
    mutationFn: (p: Point) =>
      api(`/admin/hospitals/${hospital.id}/entrance`, { method: 'PUT', body: JSON.stringify(p) }),
    onSuccess: () => {
      // 목록의 '입구 좌표 없음'·작업 이력이 바뀐다
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="gap-5 p-6 sm:max-w-3xl">
        <DialogTitle className="text-2xl font-bold">{hospital.name} 응급실 입구</DialogTitle>
        <DialogDescription className="text-lg">
          {mapState === 'off' || mapState === 'failed'
            ? '응급실 입구의 위도·경도를 넣어 주세요.'
            : '지도에서 응급실 입구를 눌러 찍어 주세요.'}{' '}
          저장하면 이 병원의 도착 판정이 이 좌표로 바뀌어요.
        </DialogDescription>

        {mapState !== 'off' && (
          <div
            ref={mapBox}
            role="application"
            aria-label="응급실 입구를 찍을 지도"
            className="h-80 w-full rounded-lg border-2 border-input bg-muted"
          />
        )}
        {mapState === 'loading' && (
          <p className="text-lg text-muted-foreground">지도 불러오는 중…</p>
        )}
        {mapState === 'failed' && (
          <p role="alert" className="text-lg font-bold text-destructive">
            지도를 불러오지 못했어요. 위도·경도를 직접 넣어 주세요.
          </p>
        )}

        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-lg font-bold">위도</span>
            <input
              inputMode="decimal"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="예: 36.812345"
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-lg font-bold">경도</span>
            <input
              inputMode="decimal"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              placeholder="예: 127.123456"
              className={inputClass}
            />
          </label>
        </div>
        {point && !valid && (
          <p role="alert" className="text-lg font-bold text-destructive">
            대한민국 안의 좌표만 저장할 수 있어요.
          </p>
        )}
        {save.isError && (
          <p role="alert" className="text-lg font-bold text-destructive">
            {errorText(save.error)}
          </p>
        )}

        <DialogFooter className="-mx-6 -mb-6 p-6">
          <Button variant="outline" size="lg" onClick={onClose}>
            취소
          </Button>
          <Button
            size="lg"
            disabled={!valid || save.isPending}
            onClick={() => point && save.mutate(point)}
          >
            {save.isPending ? '저장 중…' : '저장'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
