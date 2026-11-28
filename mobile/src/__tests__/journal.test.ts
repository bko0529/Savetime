import { initialLog, mergePatient } from '../journal/form';
import { buildSheetHtml, esc } from '../journal/sheetHtml';
import { getJournal, KEEP_MS, listJournals, saveJournal } from '../journal/storage';
import type { JournalDraft } from '../transport/engine';
import { emptyPatient, UNKNOWN } from '../transport/patient';

// expo-sqlite 를 메모리 표로 흉내 (SQL 문장 종류만 보고 처리)
jest.mock('expo-sqlite', () => {
  const rows = new Map<string, { id: string; saved_at: number; data: string }>();
  const db = {
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string, ...a: unknown[]) => {
      if (sql.startsWith('DELETE'))
        for (const [k, r] of rows) if (r.saved_at < (a[0] as number)) rows.delete(k);
      if (sql.startsWith('INSERT'))
        rows.set(a[0] as string, {
          id: a[0] as string,
          saved_at: a[1] as number,
          data: a[2] as string,
        });
    }),
    getAllAsync: jest.fn(async () => [...rows.values()].sort((x, y) => y.saved_at - x.saved_at)),
    getFirstAsync: jest.fn(async (_s: string, id: string) => rows.get(id) ?? null),
  };
  return { openDatabaseAsync: jest.fn(async () => db) };
});

const draft: JournalDraft = {
  transportId: 't-1',
  agencyName: '천안동남소방서',
  safetyCenter: '신방119안전센터',
  crew: [
    { name: '이구급', rank: '소방사', role: 'driver' },
    { name: '김구조', rank: '소방교', role: 'care' },
  ],
  departedAt: '2026-11-26T05:10:00Z',
  arrivedAt: '2026-11-26T05:22:00Z',
  distanceKm: 6.4,
  sex: 'M',
  ageBand: '60대',
  chiefComplaint: '흉통',
  onsetAt: '30분 전',
  consciousness: 'V',
  vitals: { sbp: 150, dbp: 90, pulse: 110, resp: 22, temp: null, spo2: 93, glucose: null },
  history: '고혈압, 당뇨',
  ktas: 2,
  hospitalName: '순천향대 천안병원',
  reTransferReasons: [{ hospitalName: '단국대병원', reason: 'er_bed' }],
};

test('서버 초안은 이 폰의 빈 칸만 채운다 (이 폰에서 쓴 값은 그대로)', () => {
  const p = mergePatient({ ...emptyPatient, complaint: '가슴 통증', pulse: '' }, draft);
  expect(p).toMatchObject({
    complaint: '가슴 통증',
    sex: '남',
    age: '60대',
    consciousness: '말에 반응',
    bp: '150/90',
    pulse: '110',
    ktas: '2',
  });
});

test('일지 초기값: 실제 도착 병원·거리·팀원·재이송 사유를 서버 초안에서', () => {
  const f = initialLog({
    patient: emptyPatient,
    draft,
    me: { name: '김구조', rank: '소방교' },
    local: { hospitalName: '다른 병원', km: 9 },
  });
  expect(f).toMatchObject({
    station: '천안동남',
    center: '신방',
    hospital: '순천향대 천안병원',
    distance: '6.4',
    crew1: '김구조',
    driver: '이구급',
    driverRank: '소방사',
    bpS: '150',
    bpD: '90',
    avpu: 'V',
    reTransfer: '단국대병원(응급실 병상 부족)',
    selector: '병원 수용곤란 등',
  });
  expect(f.symptoms).toContain('흉통');
  expect(f.history).toEqual(['고혈압', '당뇨']);
});

test('초안이 없으면 이 폰 기록(확정 병원·시각)으로, 확인 불가는 빈칸', () => {
  const f = initialLog({
    patient: { ...emptyPatient, complaint: '두통', age: UNKNOWN },
    draft: null,
    me: { name: '김구조', agency: '서북소방서', safetyCenter: '서북119안전센터' },
    local: {
      hospitalName: '단국대병원',
      km: 3.2,
      arrivedAt: new Date(2026, 10, 26, 14, 5).getTime(),
    },
  });
  expect(f).toMatchObject({
    hospital: '단국대병원',
    distance: '3.2',
    arriveAt: '14:05',
    age: '',
    station: '서북',
    center: '서북',
    crew1: '김구조',
  });
});

test('일지 데이터에는 환자 성명·연락처·주소 칸이 없다 (SER-012)', () => {
  const f = initialLog({ patient: emptyPatient, draft, me: {}, local: {} });
  for (const k of Object.keys(f)) expect(k).not.toMatch(/name|phone|address|rrn/i);
});

test('서식 HTML: 고른 칸에 체크, 글자는 안전하게, 성명은 줄 때만', () => {
  const f = initialLog({ patient: emptyPatient, draft, me: {}, local: {} });
  const html = buildSheetHtml({ ...f, opinion: '<script>alert(1)</script>' });
  expect(html).toContain('[<b class="ck">✔</b>]흉통');
  expect(html).toContain('순천향대 천안병원');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  expect(buildSheetHtml(f, { patientName: '홍길동' })).toContain('홍길동');
  expect(buildSheetHtml(f)).not.toContain('홍길동');
  expect(esc(`"a' & b"`)).toBe('&quot;a&#39; &amp; b&quot;');
});

test('저장한 일지는 7일 보관, 지나면 지운다 (DAR-015)', async () => {
  const f = initialLog({ patient: emptyPatient, draft, me: {}, local: {} });
  const t0 = 1_800_000_000_000;
  await saveJournal('t-old', f, t0);
  await saveJournal('t-new', { ...f, hospital: '새 병원' }, t0 + 3 * 24 * 60 * 60_000);
  expect((await listJournals(t0 + 4 * 24 * 60 * 60_000)).map((j) => j.id)).toEqual([
    't-new',
    't-old',
  ]);
  expect(await getJournal('t-old', t0 + KEEP_MS + 1)).toBeNull();
  expect((await getJournal('t-new', t0 + KEEP_MS + 1))?.data.hospital).toBe('새 병원');
});
