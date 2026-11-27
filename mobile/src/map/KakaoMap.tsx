/**
 * 앱 안 카카오 지도 (COR-003 · SFR-027 · 094 · 149). WebView 안에서 카카오 지도 JavaScript SDK 를 띄운다.
 *
 * - 마커를 누르면 onSelect(id) → 화면이 그 병원 카드를 강조한다 (마커-카드 연동, SFR-094)
 * - 고른 병원이 바뀌면 지도가 그쪽으로 움직인다
 * - 지도를 못 그리면 (키 없음 · 인터넷 끊김 · 도메인 미등록 · 8초 안에 안 뜸) onFail → 화면은 목록만 보여 준다 (SFR-062)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { color, radius } from '../ui/theme';
import { buildMapHtml, MAP_BASE_URL, validKey, type MapData } from './mapHtml';

/** 이 시간 안에 지도가 다 뜨지 않으면 실패로 본다 */
export const MAP_READY_MS = 8000;

/** 카카오 JavaScript 키 (빌드할 때 .env.local 값이 들어간다) */
const mapKey = () => process.env.EXPO_PUBLIC_KAKAO_JS_KEY;
/** 지도 키가 있는지 (없으면 지도 자리를 아예 만들지 않는다) */
export const mapAvailable = () => validKey(mapKey());

export function KakaoMap({
  data,
  onSelect,
  onFail,
  height = 220,
  style,
}: {
  data: MapData;
  onSelect: (id: string) => void;
  onFail: (reason: string) => void;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  // 라이브러리 타입이 기본값(undefined)이면 props 가 never 가 돼서 object 로 지정한다
  const ref = useRef<WebView<object>>(null);
  const [ready, setReady] = useState(false);
  const failed = useRef(false);
  const fail = (reason: string) => {
    if (failed.current) return;
    failed.current = true;
    onFail(reason);
  };
  // 키·색은 처음 한 번만 넣는다 (페이지를 다시 읽으면 지도가 깜빡이므로 데이터는 setData 로)
  const html = useMemo(() => {
    const key = mapKey();
    return validKey(key)
      ? buildMapHtml(key, {
          ink: color.primary,
          accent: color.accent,
          success: color.success,
          card: color.card,
          text: color.foreground,
        })
      : null;
  }, []);

  useEffect(() => {
    if (!html) return fail('no_key');
    const t = setTimeout(() => {
      if (!ready) fail('timeout');
    }, MAP_READY_MS);
    return () => clearTimeout(t);
  }, [html, ready]);

  // 병원·내 위치·고른 병원이 바뀌면 지도에 다시 그린다
  const json = JSON.stringify(data);
  useEffect(() => {
    if (ready) ref.current?.injectJavaScript(`window.setData(${json}); true;`);
  }, [ready, json]);

  if (!html) return null;
  const onMessage = (ev: WebViewMessageEvent) => {
    let m: { type?: string; id?: string; reason?: string };
    try {
      m = JSON.parse(ev.nativeEvent.data);
    } catch {
      return;
    }
    if (m.type === 'ready') setReady(true);
    else if (m.type === 'select' && typeof m.id === 'string') onSelect(m.id);
    else if (m.type === 'fail') fail(m.reason ?? 'error');
  };

  return (
    <View
      style={[
        {
          height,
          borderRadius: radius.md,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: color.border,
          backgroundColor: color.surface,
        },
        style,
      ]}
      accessibilityLabel="병원 지도"
    >
      <WebView<object>
        ref={ref}
        testID="kakao-map"
        originWhitelist={['*']}
        source={{ html, baseUrl: MAP_BASE_URL }}
        onMessage={onMessage}
        onError={() => fail('webview')}
        onHttpError={() => fail('http')}
        javaScriptEnabled
        scrollEnabled={false}
        // 지도 안에서 다른 페이지로 가지 않게 (카카오 로고 등을 눌러도)
        onShouldStartLoadWithRequest={(r: { url: string }) =>
          r.url.startsWith(MAP_BASE_URL) || r.url === 'about:blank'
        }
        style={{ backgroundColor: 'transparent' }}
      />
    </View>
  );
}
