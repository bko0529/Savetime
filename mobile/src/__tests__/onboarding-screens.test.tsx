import { fireEvent, render, screen } from '@testing-library/react-native';
import PermissionsScreen from '../../app/permissions';
import WelcomeScreen from '../../app/welcome';
import { consentStore } from '../state/consent';
import { permissionStore } from '../state/permissions';

const mockSetConsent = jest.fn();
jest.mock('../state/consent', () => {
  const actual = jest.requireActual('../state/consent');
  return { ...actual, setConsent: (...a: unknown[]) => mockSetConsent(...a) };
});
const mockRequestLocation = jest.fn();
const mockOpenSettings = jest.fn();
jest.mock('../state/permissions', () => {
  const actual = jest.requireActual('../state/permissions');
  return {
    ...actual,
    // 화면이 켜질 때 휴대폰에 묻는 부분은 빼고, 테스트가 넣은 값을 그대로 보여 준다
    usePermissions: () => require('../state/store').useStore(actual.permissionStore),
    requestLocation: (...a: unknown[]) => mockRequestLocation(...a),
    openSettings: (...a: unknown[]) => mockOpenSettings(...a),
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  consentStore.reset();
  permissionStore.reset();
});

test('위치 동의 화면: 안내 5개와 동의 버튼', async () => {
  consentStore.set({ consent: 'unknown' });
  await render(<WelcomeScreen />);
  for (const k of ['수집 목적', '보관 항목', '보관 기간', '병원 제공', '길찾기 서비스'])
    expect(screen.getByText(k)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '동의하고 계속' }));
  expect(mockSetConsent).toHaveBeenCalledWith('agreed');
});

test('동의 안 함이면 다시 동의하기만 보인다', async () => {
  consentStore.set({ consent: 'refused' });
  await render(<WelcomeScreen />);
  expect(screen.getByText('위치 동의가 있어야 사용할 수 있어요')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '다시 동의하기' }));
  expect(mockSetConsent).toHaveBeenCalledWith('unknown');
});

test('권한 화면: 위치부터 묻는다', async () => {
  permissionStore.set({ location: 'unknown', notify: 'unknown' });
  await render(<PermissionsScreen />);
  expect(screen.getByText('0/2')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '앱 사용 중 허용' }));
  expect(mockRequestLocation).toHaveBeenCalled();
});

test('위치를 다시 못 물으면 설정으로 이동', async () => {
  permissionStore.set({ location: 'denied', notify: 'unknown', locationCanAsk: false });
  await render(<PermissionsScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '설정으로 이동' }));
  expect(mockOpenSettings).toHaveBeenCalled();
  expect(mockRequestLocation).not.toHaveBeenCalled();
});

test('위치 거부 후 다시 물을 수 있으면 다시 허용하기', async () => {
  permissionStore.set({ location: 'denied', notify: 'unknown', locationCanAsk: true });
  await render(<PermissionsScreen />);
  await fireEvent.press(screen.getByRole('button', { name: '다시 허용하기' }));
  expect(mockRequestLocation).toHaveBeenCalled();
});
