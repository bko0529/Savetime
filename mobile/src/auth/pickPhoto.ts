/**
 * 공무원증 사진 찍기 · 고르기 (expo-image-picker). 카메라·사진 권한은 이때 처음 묻는다 (SFR-092).
 * quality 0.7 로 줄이면 iOS 의 HEIC 사진도 JPEG 로 바뀐다 → 서버는 jpg·png 만 받는다 (5MB 이하).
 */
import * as ImagePicker from 'expo-image-picker';
import type { Photo } from './signupForm';

export type PickResult = { photo: Photo } | { error: string } | null;

export async function pickPhoto(source: 'camera' | 'library'): Promise<PickResult> {
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    quality: 0.7,
    allowsEditing: false,
  };
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted)
      return { error: '카메라 권한이 없어요. 설정에서 카메라를 허용하거나 앨범에서 골라 주세요' };
  }
  const r =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  if (r.canceled || !r.assets[0]) return null;
  const a = r.assets[0];
  const type = a.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  return {
    photo: {
      uri: a.uri,
      name: a.fileName ?? (type === 'image/png' ? 'id-card.png' : 'id-card.jpg'),
      type,
      size: a.fileSize,
    },
  };
}
