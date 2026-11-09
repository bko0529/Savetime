// 카카오 지도 JavaScript SDK 불러오기 (기술정의서: 관리자 응급실 입구 좌표 지정, COR-003).
// npm 라이브러리 없이 카카오가 주는 스크립트를 한 번만 붙인다. 키는 NEXT_PUBLIC_KAKAO_JS_KEY
// (카카오 디벨로퍼스 'JavaScript 키', 등록한 도메인에서만 동작). 키가 없으면 지도 없이 좌표를 직접 입력한다

// 이 화면에서 쓰는 만큼만 타입을 적는다
export interface KakaoLatLng {
  getLat(): number;
  getLng(): number;
}
export interface KakaoMap {
  setCenter(latlng: KakaoLatLng): void;
  relayout(): void;
}
export interface KakaoMarker {
  setPosition(latlng: KakaoLatLng): void;
  setMap(map: KakaoMap | null): void;
}
export interface KakaoMaps {
  load(callback: () => void): void;
  LatLng: new (lat: number, lng: number) => KakaoLatLng;
  Map: new (container: HTMLElement, options: { center: KakaoLatLng; level: number }) => KakaoMap;
  Marker: new (options: { position: KakaoLatLng; map?: KakaoMap }) => KakaoMarker;
  event: {
    addListener(
      target: KakaoMap,
      type: 'click',
      handler: (e: { latLng: KakaoLatLng }) => void,
    ): void;
  };
}

declare global {
  interface Window {
    kakao?: { maps: KakaoMaps };
  }
}

const SDK_URL = 'https://dapi.kakao.com/v2/maps/sdk.js';

export function kakaoJsKey(): string | undefined {
  const key = process.env.NEXT_PUBLIC_KAKAO_JS_KEY?.trim();
  return key ? key : undefined;
}

// 여러 화면이 동시에 불러도 스크립트는 한 번만 붙인다
let loading: Promise<KakaoMaps> | null = null;

export function loadKakaoMaps(key: string): Promise<KakaoMaps> {
  if (window.kakao?.maps) {
    const maps = window.kakao.maps;
    return new Promise((resolve) => maps.load(() => resolve(maps)));
  }
  loading ??= new Promise<KakaoMaps>((resolve, reject) => {
    const script = document.createElement('script');
    // autoload=false: 스크립트가 온 뒤 kakao.maps.load 로 지도 기능을 마저 받는다 (Next.js 화면에서 권장 방식)
    script.src = `${SDK_URL}?appkey=${encodeURIComponent(key)}&autoload=false`;
    script.async = true;
    script.onload = () => {
      const maps = window.kakao?.maps;
      if (!maps) {
        reject(new Error('카카오 지도를 불러오지 못했어요'));
        return;
      }
      maps.load(() => resolve(maps));
    };
    script.onerror = () => reject(new Error('카카오 지도를 불러오지 못했어요'));
    document.head.appendChild(script);
  }).catch((err: unknown) => {
    // 실패하면 다음에 다시 시도할 수 있게 비운다
    loading = null;
    throw err;
  });
  return loading;
}

// 테스트용: 불러온 상태를 지운다
export function resetKakaoMapsForTest(): void {
  loading = null;
}
