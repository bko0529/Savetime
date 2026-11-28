/** 대학병원급 반경 (D-141): 40km 로 시작해 60 · 80km 까지, 다른 등급은 10~40km */
import { maxRadiusFor, nextRadiusFor, radiusChoices, startRadiusFor } from '../transport/hospitals';

test('대학병원급은 40·60·80km, 40km 부터', () => {
  expect(radiusChoices('대학병원급')).toEqual([40, 60, 80]);
  expect(startRadiusFor('대학병원급')).toBe(40);
  expect(maxRadiusFor('대학병원급')).toBe(80);
});

test('다른 등급·안 고름은 10~40km, 20km 부터', () => {
  for (const g of ['종합병원급', '일반 병원', null] as const) {
    expect(radiusChoices(g)).toEqual([10, 20, 30, 40]);
    expect(startRadiusFor(g)).toBe(20);
    expect(maxRadiusFor(g)).toBe(40);
  }
});

test('한 단계씩 넓히고, 등급의 최대면 더 못 넓힌다', () => {
  expect(nextRadiusFor('대학병원급', 40)).toBe(60);
  expect(nextRadiusFor('대학병원급', 60)).toBe(80);
  expect(nextRadiusFor('대학병원급', 80)).toBeNull();
  expect(nextRadiusFor('종합병원급', 30)).toBe(40);
  expect(nextRadiusFor('종합병원급', 40)).toBeNull();
  expect(nextRadiusFor(null, 40)).toBeNull();
});
