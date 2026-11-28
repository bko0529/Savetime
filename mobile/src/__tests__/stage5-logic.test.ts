import * as SecureStore from 'expo-secure-store';
import { mmss, vitalWarnings } from '../transport/labels';
import { emptyPatient } from '../transport/patient';
import { loadPatient, patientStore, resetPatient, setPatient } from '../transport/patientStore';
import { routeForStatus } from '../transport/routing';

jest.mock('expo-secure-store', () => {
  const m = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => m.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void m.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void m.delete(k)),
  };
});

test('환자 정보는 휴대폰에 남고, 7일이 지나면 지운다 (DAR-015)', async () => {
  setPatient({ ...emptyPatient, complaint: '흉통' });
  await new Promise((r) => setTimeout(r, 0));
  patientStore.reset();
  await loadPatient();
  expect(patientStore.get().patient.complaint).toBe('흉통');

  patientStore.reset();
  await loadPatient(Date.now() + 8 * 24 * 60 * 60_000);
  expect(patientStore.get().patient.complaint).toBe('');
  expect(SecureStore.deleteItemAsync).toHaveBeenCalled();
});

test('새 이송 시작은 모든 칸을 비운다', () => {
  setPatient({ ...emptyPatient, complaint: '흉통' });
  resetPatient();
  expect(patientStore.get().patient).toEqual(emptyPatient);
});

test('이송 상태 → 화면 (도착하면 일지)', () => {
  expect(routeForStatus('requesting', null)).toBe('/request');
  expect(routeForStatus('fallback', null)).toBe('/request');
  expect(routeForStatus('phone_check', '101')).toBe('/call/101');
  expect(routeForStatus('phone_check', null)).toBeNull();
  expect(routeForStatus('moving', null)).toBe('/transport');
  expect(routeForStatus('arrived', null)).toBe('/log');
  expect(routeForStatus('cancelled', null)).toBeNull();
  expect(routeForStatus(null, null)).toBeNull();
});

test('활력징후 경고: 산소포화도 94 미만, 수축기 160 이상·90 미만, 맥박 120 초과·50 미만', () => {
  expect(vitalWarnings({ spo2: '89', bp: '170/95', pulse: '130' })).toEqual([
    '산소포화도 89%',
    '혈압 170/95',
    '맥박 130',
  ]);
  expect(vitalWarnings({ spo2: '98', bp: '120/80', pulse: '80' })).toEqual([]);
  expect(vitalWarnings({ spo2: '', bp: '', pulse: '' })).toEqual([]);
});

test('남은 시간 표시', () => {
  expect(mmss(120)).toBe('2:00');
  expect(mmss(9)).toBe('0:09');
  expect(mmss(-5)).toBe('0:00');
});
