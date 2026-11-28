/**
 * 휴대폰에 남기는 값 (expo-secure-store = iOS 키체인 · Android 키스토어로 암호화).
 * - refresh 토큰: 근무 동안(최대 14시간) 앱을 다시 열어도 로그인을 묻지 않으려고 저장. 일반 저장소에는 두지 않는다
 * - access 토큰: 15분짜리라 메모리에만 둔다 (앱을 다시 열면 refresh 로 새로 받음)
 * - 기기 ID: 앱 설치마다 고유한 값 (로그인 요청의 deviceId). 개인 정보가 아니다
 */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const REFRESH_KEY = 'savetime.refreshToken';
const DEVICE_KEY = 'savetime.deviceId';

export const loadRefreshToken = () => SecureStore.getItemAsync(REFRESH_KEY);
export const saveRefreshToken = (t: string) => SecureStore.setItemAsync(REFRESH_KEY, t);
export const clearRefreshToken = () => SecureStore.deleteItemAsync(REFRESH_KEY);

/** 무작위 16바이트(hex). 비밀 값이 아니라 '이 설치'를 구별하는 이름표라 Math.random 으로 충분하다 */
function randomId() {
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export async function getDeviceId(): Promise<string> {
  const saved = await SecureStore.getItemAsync(DEVICE_KEY);
  if (saved) return saved;
  const id = `${Platform.OS}-${randomId()}`;
  await SecureStore.setItemAsync(DEVICE_KEY, id);
  return id;
}
