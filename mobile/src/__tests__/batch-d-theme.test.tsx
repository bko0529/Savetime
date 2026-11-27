import { fireEvent, render, screen } from '@testing-library/react-native';
import { Tile } from '../ui/kit';
import { applyScheme, color, currentScheme, onSchemeChange } from '../ui/theme';
import { effectiveScheme, setThemePref, themePrefStore } from '../ui/themePref';
import { Segmented } from '../ui/kit';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(),
}));

afterEach(() => applyScheme('light'));

test('어둡게 하면 색이 바뀌고, 다시 만들 스타일에 알린다 (QUR-005)', () => {
  const calls: string[] = [];
  const off = onSchemeChange(() => calls.push(currentScheme()));
  const lightBg = color.background;
  applyScheme('dark');
  expect(color.background).not.toBe(lightBg);
  expect(color.background).toBe('#0F1216');
  applyScheme('dark'); // 같은 값이면 아무 일 없음
  applyScheme('light');
  expect(color.background).toBe(lightBg);
  expect(calls).toEqual(['dark', 'light']);
  off();
});

test('공용 카드도 어두운 색으로 그려진다', async () => {
  applyScheme('dark');
  await render(<Tile>{null}</Tile>);
  const style = JSON.stringify(screen.toJSON());
  expect(style).toContain('#171B21'); // 어두운 카드 바탕
});

test('시스템 따름 / 밝게 / 어둡게 고르기', async () => {
  expect(effectiveScheme('system', 'dark')).toBe('dark');
  expect(effectiveScheme('system', null)).toBe('light');
  expect(effectiveScheme('light', 'dark')).toBe('light');
  const onChange = jest.fn((v: 'system' | 'light' | 'dark') => setThemePref(v));
  await render(
    <Segmented
      value="system"
      onChange={onChange}
      options={[
        { value: 'system', label: '휴대폰 설정' },
        { value: 'light', label: '밝게' },
        { value: 'dark', label: '어둡게' },
      ]}
    />,
  );
  await fireEvent.press(screen.getByRole('tab', { name: '어둡게' }));
  expect(themePrefStore.get().pref).toBe('dark');
});
