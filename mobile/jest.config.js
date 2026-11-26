/** lucide-react-native 의 기본(.mjs)은 Jest 가 못 읽어서, 테스트에서만 CommonJS 판(require 조건)으로 바꾼다 */
module.exports = {
  preset: 'jest-expo',
  moduleNameMapper: { '^lucide-react-native$': require.resolve('lucide-react-native') },
};
