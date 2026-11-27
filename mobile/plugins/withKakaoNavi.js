/**
 * 카카오내비 SDK(iOS) 빌드 설정 (Expo config plugin). `npx expo prebuild` 때 Info.plist 를 고친다.
 * - KakaoNaviAppKey: 네이티브 앱 키. .env.local 의 KAKAO_NATIVE_APP_KEY 를 빌드할 때만 넣는다 (자바스크립트 번들에는 안 들어감, 커밋 안 함)
 * - 네트워크 예외: 공식 가이드는 '모든 http 허용'을 권하지만, 보안을 위해 kakao.com 하위 도메인만 연다
 * - 백그라운드 오디오: 화면이 꺼져도 음성 안내가 이어지게
 */
const { withInfoPlist } = require('expo/config-plugins');

module.exports = function withKakaoNavi(config, { appKey } = {}) {
  return withInfoPlist(config, (c) => {
    const p = c.modResults;
    if (appKey) p.KakaoNaviAppKey = appKey;

    const ats = p.NSAppTransportSecurity ?? {};
    const domains = ats.NSExceptionDomains ?? {};
    domains['kakao.com'] = {
      NSIncludesSubdomains: true,
      NSExceptionAllowsInsecureHTTPLoads: true,
      NSExceptionRequiresForwardSecrecy: false,
      NSTemporaryExceptionMinimumTLSVersion: 'TLSv1.0',
    };
    p.NSAppTransportSecurity = { ...ats, NSExceptionDomains: domains };

    const modes = new Set(p.UIBackgroundModes ?? []);
    modes.add('audio');
    p.UIBackgroundModes = [...modes];
    return c;
  });
};
