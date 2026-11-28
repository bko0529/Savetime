/**
 * 카카오내비 SDK(iOS) 빌드 설정 (Expo config plugin). `npx expo prebuild` 때 Info.plist 를 고친다.
 * - KakaoNaviAppKey: 네이티브 앱 키. .env.local 의 KAKAO_NATIVE_APP_KEY 를 빌드할 때만 넣는다 (자바스크립트 번들에는 안 들어감, 커밋 안 함)
 * - 네트워크 예외: 공식 가이드는 '모든 http 허용'을 권하지만, 보안을 위해 kakao.com 하위 도메인만 연다
 * - 백그라운드 오디오·위치: 화면이 꺼져도 음성 안내가 이어지고, 카카오내비 위치 엔진이 백그라운드 위치로 켜진다
 *   (위치 모드가 없으면 SDK 시작 때 iOS 가 앱을 강제 종료함 — CLClientIsBackgroundable 검사). 이동 중 위치 기록(SFR-079)에도 필요
 * - Podfile: SDK 가 쓰는 Realm 을 Swift 에서 읽을 수 있게 모듈 헤더를 켠다 (안 켜면 pod install 이 막힘)
 * - Podfile: 카카오내비 SDK(KNSDK.framework)는 동적 프레임워크라, SDK 가 기대하는 의존 라이브러리만
 *   동적 프레임워크로 만든다 (나머지 앱 라이브러리는 Expo 기본인 정적 그대로). 안 하면 앱이 켜지자마자 꺼짐
 */
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withInfoPlist } = require('expo/config-plugins');

const REALM_LINES = [
  '  # 카카오내비 SDK 가 쓰는 Realm 을 Swift 에서 읽을 수 있게 (모듈 헤더)',
  "  pod 'Realm', :modular_headers => true",
  "  pod 'RealmSwift', :modular_headers => true",
].join('\n');

/** KNSDK-UI 1.12.14 의 의존 라이브러리 (Podfile.lock 기준) */
const DYNAMIC_PODS = [
  'KakaoSDKCommon',
  'Alamofire',
  'LocationCocoaPod',
  'Realm',
  'RealmSwift',
  'RNCryptor',
];
const DYNAMIC_HOOK = [
  '',
  '# 카카오내비 SDK 가 찾는 의존 라이브러리만 동적 프레임워크로 (withKakaoNavi 플러그인)',
  'pre_install do |installer|',
  `  dynamic = ${JSON.stringify(DYNAMIC_PODS)}`,
  '  installer.pod_targets.each do |pod|',
  '    next unless dynamic.include?(pod.name)',
  '    def pod.build_type',
  '      Pod::BuildType.dynamic_framework',
  '    end',
  '  end',
  'end',
  '',
].join('\n');

function withRealmModularHeaders(config) {
  return withDangerousMod(config, [
    'ios',
    (c) => {
      const file = path.join(c.modRequest.platformProjectRoot, 'Podfile');
      const src = fs.readFileSync(file, 'utf8');
      let out = src;
      if (!out.includes("pod 'Realm', :modular_headers")) {
        out = out.replace(/^(\s*use_expo_modules!.*)$/m, `$1\n${REALM_LINES}`);
      }
      if (!out.includes('Pod::BuildType.dynamic_framework')) out += DYNAMIC_HOOK;
      if (out !== src) fs.writeFileSync(file, out);
      return c;
    },
  ]);
}

module.exports = function withKakaoNavi(config, { appKey } = {}) {
  config = withRealmModularHeaders(config);
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
    modes.add('location');
    p.UIBackgroundModes = [...modes];
    return c;
  });
};
