# 카카오내비 길찾기 SDK with UI(KNSDK-UI)를 앱에서 부르는 작은 연결 모듈 (COR-003)
Pod::Spec.new do |s|
  s.name           = 'KakaoNavi'
  s.version        = '1.0.0'
  s.summary        = 'Savetime: Kakao Navi SDK (KNSDK-UI) bridge'
  s.author         = 'Savetime'
  s.homepage       = 'https://developers.kakaomobility.com/'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # 카카오모빌리티 공식 CocoaPods 의 최신 (1.12.20 이후는 SPM 으로만 배포됨)
  s.dependency 'KNSDK-UI', '1.12.14'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,swift}'
  s.public_header_files = '**/*.h'
end
