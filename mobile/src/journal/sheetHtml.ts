/**
 * 별지 제5호서식 구급활동일지 (A4) HTML. Lovable log-form-sheet.tsx 의 표를 그대로 옮겼다.
 * expo-print 가 이 HTML 로 휴대폰 안에서 PDF 를 만든다 (SFR-165). 서버로는 보내지 않는다.
 * 빨간 글씨·체크 = 앱 기록으로 채운 칸. 환자 성명은 화면에서 받은 값을 이 PDF 에만 넣고 저장하지 않는다 (SER-012).
 */
import type { LogData } from './form';

/** 사용자가 쓴 글자에 < > & " ' 가 있어도 표가 깨지지 않게 */
export function esc(s: string | undefined | null): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

const PAIN = ['두통', '흉통', '복통', '요통', '분만진통'];
const TRAUMA = ['골절', '탈구', '삠', '열상', '찰과상', '타박상', '절단', '압궤손상', '화상'];
const OTHER_SX = [
  '의식장애',
  '기도이물',
  '기침',
  '호흡곤란',
  '호흡정지',
  '두근거림',
  '가슴불편감',
  '심정지',
  '경련/발작',
  '실신',
  '오심',
  '구토',
  '설사',
  '변비',
  '배뇨장애',
  '객혈',
  '토혈',
  '혈변',
  '비출혈',
  '질출혈',
  '그 밖의 출혈',
  '고열',
  '저체온증',
  '어지러움',
  '마비',
  '전신쇠약',
  '정신장애',
  '그 밖의 이물질',
];
const HX = [
  '고혈압',
  '당뇨',
  '뇌혈관질환',
  '심장질환',
  '폐질환',
  '결핵',
  '간염',
  '간경화',
  '알레르기',
  '암',
  '신부전',
  '감염병',
];
const PLACE = [
  '집',
  '집단거주시설',
  '도로',
  '도로외 교통지역',
  '오락/문화/공공시설',
  '학교/교육시설',
  '운동시설',
  '상업시설',
  '의료관련시설',
  '공장/산업/건설시설',
  '일차산업장',
  '바다/강/산/논밭',
  '기타',
];
const AIRWAY = [
  '도수조작',
  '기도유지기(airway)',
  '기관삽관(Intubation)',
  '성문외 기도유지기',
  '흡인기',
  '기도폐쇄처치',
];
const GRADES = ['1급', '2급', '간호사', '구급교육', '기타'];

const bx = (on: boolean, label: string) =>
  `<span class="bx">[${on ? '<b class="ck">✔</b>' : '<i></i>'}]${esc(label)}</span>`;
const fill = (v?: string, w = 2.5) =>
  `<span class="fill" style="min-width:${w}em">${v ? esc(v) : '&nbsp;'}</span>`;
const H = (c: string, a = '') => `<td class="h" ${a}>${c}</td>`;
const C = (c: string, a = '') => `<td ${a}>${c}</td>`;
const many = (items: string[], on: (k: string) => boolean) =>
  items.map((k) => bx(on(k), k)).join('');

export function buildSheetHtml(f: LogData, opt: { patientName?: string } = {}): string {
  const sx = new Set(f.symptoms);
  const hx = new Set(f.history);
  const care = new Set(f.care);
  const crew: [string, string, string, string][] = [
    ['구급대원(1)', f.crew1Grade, f.crew1Rank, f.crew1],
    ['구급대원(2)', '', '', ''],
    ['운전요원', f.driverGrade, f.driverRank, f.driver],
    ['기 타', '', '', ''],
  ];
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>구급활동일지</title><style>
@page { size: A4; margin: 10mm; }
body { font-family: -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif; font-size: 9.5px; color: #0E1624; margin: 0; }
table { width: 100%; border-collapse: collapse; margin-top: -1px; }
td { border: 1px solid rgba(14,22,36,0.7); padding: 2px 4px; vertical-align: middle; line-height: 1.45; }
td.h { background: #EAEDF1; text-align: center; font-weight: 600; }
.bx { margin-right: 6px; white-space: nowrap; }
.bx i { display: inline-block; width: 0.7em; }
.ck { color: #B91C1E; }
.fill { display: inline-block; border-bottom: 1px dotted rgba(14,22,36,0.4); padding: 0 3px; color: #B91C1E; font-weight: 600; }
.title { text-align: center; font-size: 20px; font-weight: 700; letter-spacing: 0.5em; }
.c { text-align: center; } .w6 { width: 24px; } .small { font-size: 9px; } .muted { color: #666E7A; }
</style></head><body>
<p class="small">■ 119구조ㆍ구급에 관한 법률 시행규칙 [별지 제5호서식] &lt;개정 2024. 10. 4.&gt;</p>
<table><tbody>
<tr>${C(`${fill(f.station, 5)} 소방서 ${fill(f.center, 5)} 119구급대(안전센터)<br>전화) ${fill('', 7)}`, 'colspan="4"')}<td colspan="4" class="title">구급활동일지</td>${H('결재', 'rowspan="2"')}${C('119구급대장(센터장)', 'colspan="2" class="c" style="height:40px;vertical-align:top"')}</tr>
<tr>${H('차량번호')}${C(fill(f.carNo))}${H('구분')}${C(
    many(['특수일반', '특수특별', '항공구급'], (k) => f.kind === k),
    'colspan="5"',
  )}${C('', 'colspan="2"')}</tr>
</tbody></table>

<table><tbody>
<tr>${H('구급<br>출동', 'rowspan="11" class="h w6"')}${H('신고 일시')}${C(fill(f.callAt))}${H('신고자')}${C(`전화번호 ${fill('', 6)}`, 'colspan="2"')}${C(`신고방법 ${many(['일반전화', '휴대전화', '기타'], (k) => f.reportMethod === k)}`, 'colspan="3"')}</tr>
<tr>${H('출동 시각')}${C(fill(f.dispatchAt))}${H('환자<br>인적<br>사항', 'rowspan="3"')}${C(`성명 ${fill(opt.patientName, 6)} 나이 ${fill(f.age)} 성별 ${bx(f.sex === '남', '남')}${bx(f.sex === '여', '여')} 생년월일 ${fill('', 5)}`, 'colspan="5"')}</tr>
<tr>${H('현장 도착')}${C(fill(f.sceneAt))}${C(`주소 ${fill('', 20)} (Tel ${fill('', 6)})`, 'colspan="5"')}</tr>
<tr>${H('환자 접촉')}${C(fill(f.contactAt))}${C(bx(false, `외국인(국적: `) + fill('', 4) + ')', 'colspan="5"')}</tr>
<tr>${H('거리')}${C(`${fill(f.distance)} km`)}${H('보호자 등')}${C(`성명 ${fill('', 5)} 관계 ${fill('', 3)} 전화번호 ${fill('', 6)}`, 'colspan="5"')}</tr>
<tr>${H('현장 출발')}${C(fill(f.departAt))}${H('환자발생 위치')}${C(fill('', 20), 'colspan="5"')}</tr>
<tr>${H('병원 도착')}${C(fill(f.arriveAt))}${H('환자 발생<br>장소(택일)')}${C(
    many(PLACE, (k) => f.place === k),
    'colspan="5"',
  )}</tr>
<tr>${H('귀소 시각')}${C(fill(f.returnAt))}${H('환자 증상<br>(복수 선택<br>가능)', 'rowspan="4"')}${C(`■ 통증(${many(PAIN, (k) => sx.has(k))}${bx(false, '그 밖의 통증')})`, 'colspan="5"')}</tr>
<tr>${H('출동 유형', 'rowspan="3"')}${C(
    many(['정상', '오인', '거짓', '취소', '기타'], (k) => f.dispatchType === k),
    'rowspan="3"',
  )}${C(`■ 외상(${many(TRAUMA, (k) => sx.has(k))})`, 'colspan="5"')}</tr>
<tr>${C(
    many(OTHER_SX, (k) => sx.has(k)),
    'colspan="5"',
  )}</tr>
<tr>${C(`${bx(!!f.symptomEtc, '기타(')}${fill(f.symptomEtc, 10)})`, 'colspan="5"')}</tr>
</tbody></table>

<table><tbody>
<tr>${H('환자<br>발생<br>유형', 'rowspan="4" class="h w6"')}${C(bx(f.type === '질병', '질 병'))}${H(`병 력<br>${bx(!f.history.length && !f.historyEtc, '없음')}${bx(false, '미상')}`)}${C(`${many(HX, (k) => hx.has(k))}${bx(!!f.historyEtc, '기타(')}${fill(f.historyEtc, 6)})`, 'colspan="3"')}</tr>
<tr>${C(bx(f.type.startsWith('질병외'), '질병외'), 'rowspan="2"')}${C(`${bx(f.type.includes('교통사고'), '교통사고')} 사상자`)}${C(
    many(
      ['운전자', '동승자', '보행자', '자전거', '오토바이', '개인형 이동장치', '미상'],
      () => false,
    ),
    'colspan="3"',
  )}</tr>
<tr>${C(`${bx(f.type.includes('그 외 외상'), '그 외 외상')} ${bx(f.type.includes('비외상성'), '비외상성 손상')}`)}${C(
    many(
      [
        '낙상',
        '추락',
        '둔상',
        '관통상',
        '익수',
        '화상',
        '연기흡입',
        '중독',
        '온열손상',
        '한랭손상',
        '기타',
      ],
      () => false,
    ),
    'colspan="3"',
  )}</tr>
<tr>${C(`${bx(f.type === '기타', '기타')} ${many(['자연재해', '임산부', '신생아', '단순주취'], () => false)}`, 'colspan="5"')}</tr>
</tbody></table>

<table><tbody>
<tr>${H('환자<br>평가', 'rowspan="9" class="h w6"')}${H('의식상태')}${C(`1차 (${fill(f.vitalTime)}) ${many(['A', 'V', 'P', 'U'], (k) => f.avpu === k)} &nbsp; 2차 ( : ) ${many(['A', 'V', 'P', 'U'], () => false)}`, 'colspan="7"')}</tr>
<tr>${H('동공반응', 'rowspan="2"')}${C(`좌 ${many(['정상', '축동', '산동', '측정불가'], (k) => f.pupilL === k)} &nbsp; ${many(['반응', '무반응', '측정불가'], () => false)}`, 'colspan="7"')}</tr>
<tr>${C(`우 ${many(['정상', '축동', '산동', '측정불가'], (k) => f.pupilR === k)} &nbsp; ${many(['반응', '무반응', '측정불가'], () => false)}`, 'colspan="7"')}</tr>
<tr class="c">${H(`활력 징후<br>${bx(false, '불가')}${bx(false, '거부')}`, 'rowspan="3"')}${['시각', '혈압', '맥박', '호흡', '체온', 'SpO2', '혈당체크'].map((k) => H(k)).join('')}</tr>
<tr class="c">${C(fill(f.vitalTime))}${C(`${fill(f.bpS)}/${fill(f.bpD)} mmHg`)}${C(`${fill(f.pulse)} 회/min`)}${C(`${fill(f.resp)} 회/min`)}${C(`${fill(f.temp)} ℃`)}${C(`${fill(f.spo2)} %`)}${C(`${fill(f.glucose)} mg/dL`)}</tr>
<tr class="c">${C(' : ')}${C('/ mmHg')}${C('회/min')}${C('회/min')}${C('℃')}${C('%')}${C('mg/dL')}</tr>
<tr>${H('환자분류')}${C(`${['1', '2', '3', '4', '5'].map((k) => bx(f.ktas === k, `LEVEL ${k}`)).join('')} (${bx(false, '사망추정')})`, 'colspan="7"')}</tr>
<tr>${H('구급대원<br>평가소견', 'rowspan="2"')}${C(`ㆍ주 호소: ${fill(f.complaint, 18)} ㆍ발생시간(${bx(!!f.onset, '추정')}): ${fill(f.onset, 5)}`, 'colspan="7"')}</tr>
<tr>${C(fill(f.opinion, 40), 'colspan="7" style="height:32px;vertical-align:top"')}</tr>
</tbody></table>

<table><tbody>
<tr>${H('응급<br>처치', 'class="h w6"')}${C(
    `■ 기도확보: ${AIRWAY.map((k) => bx(k === '도수조작' && care.has('기도확보'), k)).join('')}<br>` +
      `■ 산소투여: ${fill(f.o2)} L/min(${many(['비관', '안면마스크', '비재호흡마스크', 'BVM', '산소소생기', '네뷸라이저', '기타'], () => false)}) ${care.has('산소투여') && !f.o2 ? '✔' : ''}<br>` +
      `■ CPR(${bx(care.has('CPR'), '실시')}${bx(false, '거부')}${bx(false, 'DNR')}${bx(false, '유보')}) ${bx(care.has('ECG'), 'ECG')} ■ AED(${bx(care.has('AED'), 'Shock')}${bx(false, 'Monitoring')})<br>` +
      `■ 순환보조(${bx(care.has('정맥로 확보'), '정맥로 확보')}${bx(false, '수액공급')}) ${bx(false, '약물투여')} ■ 고정(${bx(care.has('고정(목뼈)'), '목뼈')}${bx(false, '척추')}${bx(care.has('부목'), '부목')}${bx(false, '머리')})<br>` +
      `■ 상처처치(${bx(care.has('지혈'), '지혈')}${bx(care.has('상처 소독'), '상처 소독 처치')}) ${bx(false, '분만')} ${bx(care.has('보온'), '보온')}`,
  )}</tr>
<tr>${H('의료<br>지도')}${C(`${bx(false, '연결')}${bx(false, '미연결')} 요청시간 ${fill()} 요청방법 ${many(['일반전화', '휴대전화', '무전기'], () => false)} · 의료지도 의사 성명 ${fill('', 5)}`)}</tr>
</tbody></table>

<table class="c"><tbody>
<tr>${H('환자<br>이송', 'rowspan="3" class="h w6"')}${H('', 'style="width:32px"')}${H('이송 기관명')}${H('도착시간(거리)')}${H('의료기관 선정자 등')}${H('재이송 사유')}${H('환자 인수자')}</tr>
${[1, 2]
  .map((n) => {
    const first = n === 1;
    const name = first ? f.hospital : f.hospital2;
    return `<tr>${H(`${n}차`)}${C(`${fill(name, 8)}<br>${bx(!!name, '관할')}${bx(false, '타시ㆍ도')}`)}${C(`${fill(first ? f.hospitalArrive : '')}<br>(${fill(first ? f.distance : '')} km)`)}${C(
      many(
        ['구급대', '119상황실', '구급상황센터', '환자/보호자', '병원 수용곤란 등'],
        (k) => first && f.selector === k,
      ),
      'style="text-align:left"',
    )}${C(`■ 병상 부족(${many(['응급실', '수술실', '입원실', '중환자실'], () => false)}) ${bx(false, '전문의 부재')}${bx(false, '의료장비 고장')}${bx(first && !!f.reTransfer, '기타(')}${fill(first ? f.reTransfer : '', 5)})`, 'style="text-align:left"')}${C(
      many(['의사', '간호사', '응급구조사', '기타'], (k) => first && f.handover === k),
      'style="text-align:left"',
    )}</tr>`;
  })
  .join('')}
</tbody></table>

<table><tbody><tr>${H('미이송', 'class="h w6"')}${C(many(['취소', '타차량', '환자 없음', '현장처치', '이송거부', '이송거절', '경찰인계', '이송 불필요', '사망', '기타'], () => false))}</tr></tbody></table>

<table><tbody>
<tr>${H('출동<br>인원', 'rowspan="5" class="h w6"')}${H('의 사')}${C(`소속: ${fill('', 8)} 성명: ${fill('', 6)} (서명 또는 인)`, 'colspan="4"')}</tr>
${crew
  .map(
    ([role, grade, rank, name]) =>
      `<tr>${H(role)}${C(many(GRADES, (g) => grade === g))}${C(`계급 소방${fill(rank.replace(/^소방/, ''))}`)}${C(`성명 ${fill(name, 5)}`)}${C('(서명 또는 인)', 'class="muted" style="width:96px"')}</tr>`,
  )
  .join('')}
</tbody></table>
<p class="small muted" style="text-align:right">210mm×297mm[백상지(80g/㎡) 또는 중질지(80g/㎡)]</p>
</body></html>`;
}
