import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { consentStore, loadConsent, setConsent } from '../state/consent';
import { checkPermissions, permissionStore, requestLocation } from '../state/permissions';

jest.mock('expo-secure-store', () => {
  const m = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => m.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void m.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void m.delete(k)),
  };
});
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
}));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

const perm = (status: string, canAskAgain = true) => ({
  status,
  granted: status === 'granted',
  canAskAgain,
});

test('동의는 휴대폰에 저장되고 다시 켜도 남는다', async () => {
  await loadConsent();
  expect(consentStore.get().consent).toBe('unknown');
  await setConsent('agreed');
  consentStore.reset();
  await loadConsent();
  expect(consentStore.get().consent).toBe('agreed');
  await setConsent('unknown');
  expect(SecureStore.deleteItemAsync).toHaveBeenCalled();
});

test('권한은 휴대폰 값을 그대로 읽는다 (undetermined = 아직 안 물어봄)', async () => {
  jest
    .mocked(Location.getForegroundPermissionsAsync)
    .mockResolvedValue(perm('undetermined') as never);
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue(perm('denied') as never);
  await checkPermissions();
  expect(permissionStore.get()).toMatchObject({ location: 'unknown', notify: 'denied' });
});

test('위치를 다시 못 물으면(canAskAgain=false) 설정으로 보내야 함을 기록', async () => {
  jest
    .mocked(Location.requestForegroundPermissionsAsync)
    .mockResolvedValue(perm('denied', false) as never);
  await requestLocation();
  expect(permissionStore.get()).toMatchObject({ location: 'denied', locationCanAsk: false });
});
