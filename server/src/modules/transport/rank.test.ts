// SFR-098 추천 산출 순서를 DB 없이 표로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankHospitals, type Candidate } from './rank.js';

let nextId = 1;
function hospital(distanceKm: number, overrides: Partial<Candidate> & { er?: number | null } = {}) {
  const { er = 3, ...rest } = overrides;
  return {
    id: String(nextId++),
    distanceKm,
    grade: 3,
    beds: {
      er: { avail: er, total: 10 },
      icu: { avail: 1, total: 5 },
      or: { avail: 1, total: 3 },
    },
    anomaly: false,
    excluded: false,
    ...rest,
  } satisfies Candidate;
}

const options = { requestedGrade: null, radiusKm: 20 };
const ids = (list: { id: string }[]) => list.map((c) => c.id);

test('SFR-098 예시: 11곳 중 이상치 1곳·응급실 0개 2곳을 빼고 8곳 중 가까운 5곳', () => {
  const list = [
    hospital(1.0, { anomaly: true }),
    hospital(1.5, { er: 0 }),
    hospital(2.0),
    hospital(2.5, { er: 0 }),
    ...[3, 4, 5, 6, 7, 8, 9].map((km) => hospital(km)),
  ];
  const result = rankHospitals(list, options);
  assert.equal(list.length, 11);
  assert.deepEqual(
    result.items.map((c) => [c.distanceKm, c.rank]),
    [
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 4],
      [6, 5],
    ],
  );
  assert.equal(result.emptyGuide, null);
});

test('응급실 값이 비어 있으면 0개로 보고 제외한다 (SFR-089)', () => {
  const blank = hospital(1, { er: null });
  const result = rankHospitals([blank, hospital(2)], options);
  assert.ok(!ids(result.items).includes(blank.id));
  assert.ok(!ids(result.noBedInfo).includes(blank.id));
});

test('병상 정보가 전혀 없으면 빼지 않고 따로 거리순 최대 3곳 보여 준다', () => {
  const noRow = [1, 2, 3, 4].map((km) => hospital(km, { beds: null }));
  const allBlank = hospital(0.5, {
    beds: {
      er: { avail: null, total: null },
      icu: { avail: null, total: null },
      or: { avail: null, total: null },
    },
  });
  const ok = hospital(5);
  const result = rankHospitals([...noRow, allBlank, ok], options);
  assert.deepEqual(ids(result.items), [ok.id]);
  assert.deepEqual(ids(result.noBedInfo), [allBlank.id, noRow[0].id, noRow[1].id]);
});

test('등급을 고르면 그 등급 이상을 먼저, 그 안에서 거리순 (SFR-162, D-128)', () => {
  const near3 = hospital(1, { grade: 3 });
  const mid2 = hospital(2, { grade: 2 });
  const far1 = hospital(9, { grade: 1 });
  const near2 = hospital(1.5, { grade: 2 });

  const picked2 = rankHospitals([near3, mid2, far1, near2], { ...options, requestedGrade: 2 });
  assert.deepEqual(ids(picked2.items), [near2.id, mid2.id, far1.id, near3.id]);

  const picked1 = rankHospitals([near3, mid2, far1, near2], { ...options, requestedGrade: 1 });
  assert.deepEqual(ids(picked1.items), [far1.id, near3.id, near2.id, mid2.id]);

  const none = rankHospitals([near3, mid2, far1, near2], options);
  assert.deepEqual(ids(none.items), [near3.id, near2.id, mid2.id, far1.id]);
});

test('이번 이송의 제외 병원은 추천과 병상 정보 없음 묶음에서 모두 뺀다 (SFR-112)', () => {
  const excluded = hospital(1, { excluded: true });
  const excludedNoBeds = hospital(2, { excluded: true, beds: null });
  const result = rankHospitals([excluded, excludedNoBeds, hospital(3)], options);
  assert.equal(result.items.length, 1);
  assert.equal(result.noBedInfo.length, 0);
});

test('후보가 0곳이면 반경 넓히기를, 40km면 전화 확인을 안내한다 (SFR-029)', () => {
  const zero = [hospital(1, { er: 0 })];
  assert.equal(rankHospitals(zero, options).emptyGuide, 'expand_radius');
  assert.equal(rankHospitals([], { ...options, radiusKm: 40 }).emptyGuide, 'call_nearby');
});

test('거리가 같으면 ID 순으로 늘 같은 결과를 낸다', () => {
  const a = hospital(2);
  const b = hospital(2);
  assert.deepEqual(ids(rankHospitals([b, a], options).items), [a.id, b.id]);
});
