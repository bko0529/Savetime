/**
 * - lucide-react-native 의 기본(.mjs)은 Jest 가 못 읽어서, 테스트에서만 CommonJS 판(require 조건)으로 바꾼다
 * - react-native-webview 는 테스트에서 진짜 웹 화면을 띄울 수 없어서 빈 칸으로 바꾼다 (__mocks__)
 */
module.exports = {
  preset: 'jest-expo',
  moduleNameMapper: {
    '^lucide-react-native$': require.resolve('lucide-react-native'),
    '^react-native-webview$': '<rootDir>/__mocks__/react-native-webview.tsx',
  },
};
