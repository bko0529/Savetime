/**
 * app.json 에 빌드할 때만 필요한 값을 더한다.
 * 카카오 네이티브 앱 키는 .env.local 의 KAKAO_NATIVE_APP_KEY (Expo CLI 가 읽어 줌, 커밋하지 않음)
 */
module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...(config.plugins ?? []),
    ['./plugins/withKakaoNavi', { appKey: process.env.KAKAO_NATIVE_APP_KEY }],
  ],
});
