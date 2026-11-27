/** 테스트에서는 진짜 WebView 대신 빈 칸 (onMessage 를 테스트가 직접 부를 수 있게 props 를 남긴다) */
import { forwardRef, useImperativeHandle } from 'react';
import { View } from 'react-native';

export const mockInjected: string[] = [];
export const WebView = forwardRef(function WebView(props: Record<string, unknown>, ref) {
  useImperativeHandle(ref, () => ({ injectJavaScript: (js: string) => mockInjected.push(js) }));
  return <View {...props} />;
});
export default WebView;
