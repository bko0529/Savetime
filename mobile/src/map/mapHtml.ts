/**
 * 카카오 지도 JavaScript SDK 를 띄우는 작은 웹 페이지 (WebView 안에서 돈다, COR-003).
 *
 * 앱 ↔ 지도 대화
 * - 앱 → 지도: window.setData({ markers, me, selectedId }) 를 injectJavaScript 로 부른다
 * - 지도 → 앱: ReactNativeWebView.postMessage 로 {type:'ready'} · {type:'select', id} · {type:'fail', reason}
 *
 * 키는 카카오 콘솔의 '플랫폼 > Web 사이트 도메인'(http://localhost)에서만 동작한다.
 * WebView 를 baseUrl 'http://localhost' 로 열어서 그 도메인에서 부른 것으로 보이게 한다.
 */

export type MarkerTone = 'approved' | 'normal';
export type MapMarker = {
  id: string;
  lat: number;
  lng: number;
  /** 지도 위 이름표 (병원 이름) */
  label: string;
  /** 가까운 순서 번호 (이름표가 겹치지 않게 평소에는 번호만 보인다) */
  rank: number;
  tone: MarkerTone;
};
export type MapData = {
  markers: MapMarker[];
  me: { lat: number; lng: number } | null;
  selectedId: string | null;
};
export type MapColors = {
  ink: string;
  accent: string;
  success: string;
  card: string;
  text: string;
};

export const MAP_BASE_URL = 'http://localhost';

/** 키는 영문·숫자만 (주소에 그대로 들어가므로 이상한 글자는 막는다) */
export const validKey = (k: string | undefined): k is string =>
  !!k && /^[0-9a-zA-Z]{16,64}$/.test(k);

export function buildMapHtml(key: string, c: MapColors): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body, #map { margin: 0; padding: 0; width: 100%; height: 100%; }
  body { -webkit-user-select: none; font-family: -apple-system, 'Apple SD Gothic Neo', sans-serif; }
  .pin { transform: translate(-50%, -100%); display: flex; flex-direction: column; align-items: center; cursor: pointer; }
  .tag { max-width: 120px; padding: 4px 8px; border-radius: 999px; font-size: 12px; font-weight: 700;
         white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff;
         box-shadow: 0 2px 6px rgba(0,0,0,.25); }
  .dot { width: 28px; height: 28px; border-radius: 50%; color: #fff; font-size: 13px; font-weight: 800;
         display: flex; align-items: center; justify-content: center; border: 2px solid #fff;
         box-shadow: 0 2px 6px rgba(0,0,0,.3); }
  .tip { width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 7px solid; }
  .sel .tag { font-size: 13px; padding: 6px 10px; }
  .me { width: 16px; height: 16px; border-radius: 50%; background: #2F7BF6; border: 3px solid #fff;
        box-shadow: 0 0 0 6px rgba(47,123,246,.25); transform: translate(-50%, -50%); }
</style>
</head><body><div id="map"></div>
<script>
  var post = function (m) { try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) {} };
  window.onerror = function (msg) { post({ type: 'fail', reason: String(msg).slice(0, 80) }); };
  var COLORS = { approved: ${JSON.stringify(c.success)}, normal: ${JSON.stringify(c.ink)}, selected: ${JSON.stringify(c.accent)} };
  var map = null, overlays = [], pending = null, fitted = '';
  function esc(s) { return String(s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function draw(d) {
    overlays.forEach(function (o) { o.setMap(null); });
    overlays = [];
    var bounds = new kakao.maps.LatLngBounds(), n = 0;
    d.markers.forEach(function (m) {
      var sel = m.id === d.selectedId;
      var col = sel ? COLORS.selected : COLORS[m.tone];
      var el = document.createElement('div');
      el.className = 'pin' + (sel ? ' sel' : '');
      // 고른 병원·승인 병원만 이름표, 나머지는 번호 동그라미 (이름표가 겹치면 못 읽으므로)
      el.innerHTML = (sel || m.tone === 'approved')
        ? '<div class="tag" style="background:' + col + '">' + esc(m.label) + '</div>'
          + '<div class="tip" style="border-top-color:' + col + '"></div>'
        : '<div class="dot" style="background:' + col + '">' + m.rank + '</div>'
          + '<div class="tip" style="border-top-color:' + col + '"></div>';
      el.addEventListener('click', function () { post({ type: 'select', id: m.id }); });
      var pos = new kakao.maps.LatLng(m.lat, m.lng);
      var o = new kakao.maps.CustomOverlay({ position: pos, content: el, yAnchor: 0, zIndex: sel ? 10 : (m.tone === 'approved' ? 5 : 1) });
      o.setMap(map); overlays.push(o); bounds.extend(pos); n++;
    });
    if (d.me) {
      var meEl = document.createElement('div'); meEl.className = 'me';
      var mp = new kakao.maps.LatLng(d.me.lat, d.me.lng);
      var mo = new kakao.maps.CustomOverlay({ position: mp, content: meEl, zIndex: 20 });
      mo.setMap(map); overlays.push(mo); bounds.extend(mp); n++;
    }
    // 병원 목록이 바뀔 때만 다시 맞춘다 (고른 병원만 바뀌면 그쪽으로 옮기기만)
    var key = d.markers.map(function (m) { return m.id; }).join(',');
    if (key !== fitted && n > 0) { fitted = key; if (n === 1) map.setCenter(bounds.getSouthWest()); else map.setBounds(bounds, 40, 40, 40, 40); }
    var s = d.markers.filter(function (m) { return m.id === d.selectedId; })[0];
    if (s) map.panTo(new kakao.maps.LatLng(s.lat, s.lng));
  }
  window.setData = function (d) { if (map) draw(d); else pending = d; };
  var sdk = document.createElement('script');
  sdk.src = 'https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&appkey=${key}';
  sdk.onerror = function () { post({ type: 'fail', reason: 'sdk_load' }); };
  sdk.onload = function () {
    if (!window.kakao || !kakao.maps) { post({ type: 'fail', reason: 'sdk_missing' }); return; }
    kakao.maps.load(function () {
      map = new kakao.maps.Map(document.getElementById('map'), { center: new kakao.maps.LatLng(36.5, 127.8), level: 7 });
      if (pending) { draw(pending); pending = null; }
      post({ type: 'ready' });
    });
  };
  document.head.appendChild(sdk);
</script>
</body></html>`;
}
