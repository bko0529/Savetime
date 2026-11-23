import type { ReactNode } from "react";
import { X, Printer } from "lucide-react";

/** 별지 제5호서식 구급활동일지를 원본 서식 그대로(A4) 그리고, 앱 기록으로 체크/기입한다. */
export type LogData = {
  station: string; center: string; carNo: string; kind: string;
  callAt: string; dispatchAt: string; sceneAt: string; contactAt: string; departAt: string; arriveAt: string; returnAt: string;
  distance: string; dispatchType: string; reportMethod: string;
  sex: string; age: string; place: string;
  symptoms: string[]; symptomEtc: string; history: string[]; historyEtc: string; type: string;
  avpu: string; pupilL: string; pupilR: string;
  vitalTime: string; bpS: string; bpD: string; pulse: string; resp: string; temp: string; spo2: string; glucose: string;
  ktas: string; complaint: string; onset: string; opinion: string;
  care: string[]; o2: string;
  hospital: string; hospitalArrive: string; selector: string; handover: string; reTransfer: string;
  hospital2: string;
  crew1: string; crew1Rank: string; crew1Grade: string; driver: string; driverRank: string; driverGrade: string;
};

const PAIN = ["두통", "흉통", "복통", "요통", "분만진통"];
const TRAUMA = ["골절", "탈구", "삠", "열상", "찰과상", "타박상", "절단", "압궤손상", "화상"];
const OTHER_SX = ["의식장애", "기도이물", "기침", "호흡곤란", "호흡정지", "두근거림", "가슴불편감", "심정지", "경련/발작", "실신", "오심", "구토", "설사", "변비", "배뇨장애", "객혈", "토혈", "혈변", "비출혈", "질출혈", "그 밖의 출혈", "고열", "저체온증", "어지러움", "마비", "전신쇠약", "정신장애", "그 밖의 이물질"];
const HX = ["고혈압", "당뇨", "뇌혈관질환", "심장질환", "폐질환", "결핵", "간염", "간경화", "알레르기", "암", "신부전", "감염병"];
const PLACE = ["집", "집단거주시설", "도로", "도로외 교통지역", "오락/문화/공공시설", "학교/교육시설", "운동시설", "상업시설", "의료관련시설", "공장/산업/건설시설", "일차산업장", "바다/강/산/논밭", "기타"];
const AIRWAY = ["도수조작", "기도유지기(airway)", "기관삽관(Intubation)", "성문외 기도유지기", "흡인기", "기도폐쇄처치"];
const GRADES = ["1급", "2급", "간호사", "구급교육", "기타"];

function Bx({ on, children }: { on?: boolean; children: ReactNode }) {
  return <span className="mr-1.5 whitespace-nowrap">[{on ? <b className="text-destructive">✔</b> : <span className="inline-block w-[0.7em]" />}]{children}</span>;
}
const Fill = ({ children, w }: { children?: ReactNode; w?: string }) => (
  <span className="inline-block border-b border-dotted border-foreground/40 px-1 font-semibold text-destructive" style={{ minWidth: w ?? "2.5em" }}>{children || "\u00a0"}</span>
);
const H = ({ children, rs, cs, className = "" }: { children?: ReactNode; rs?: number; cs?: number; className?: string }) => (
  <td rowSpan={rs} colSpan={cs} className={`border border-foreground/70 bg-muted/60 px-1 text-center font-semibold ${className}`}>{children}</td>
);
const C = ({ children, rs, cs, className = "" }: { children?: ReactNode; rs?: number; cs?: number; className?: string }) => (
  <td rowSpan={rs} colSpan={cs} className={`border border-foreground/70 px-1 py-[2px] align-middle leading-snug ${className}`}>{children}</td>
);

export function LogFormSheet({ f, onClose }: { f: LogData; onClose: () => void }) {
  const sx = new Set(f.symptoms);
  const hx = new Set(f.history);
  const care = new Set(f.care);
  const lvl = f.ktas;
  const disease = f.type === "질병";
  const nonDisease = f.type.startsWith("질병외");
  const rowsCrew: [string, string, string, string][] = [
    ["구급대원(1)", f.crew1Grade, f.crew1Rank, f.crew1],
    ["구급대원(2)", "", "", ""],
    ["운전요원", f.driverGrade, f.driverRank, f.driver],
    ["기 타", "", "", ""],
  ];

  return (
    <div className="print-root fixed inset-0 z-50 flex flex-col bg-muted">
      <div className="no-print flex items-center gap-2 border-b bg-card px-4 py-3">
        <button onClick={onClose} aria-label="닫기" className="grid size-9 place-items-center rounded-lg bg-surface-2 text-muted-foreground transition hover:bg-border"><X className="size-5" /></button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-extrabold">제출용 서식 (별지 제5호서식)</p>
          <p className="truncate text-xs text-muted-foreground">빨간 글씨·체크는 앱 기록으로 채운 칸이에요.</p>
        </div>
        <button onClick={() => window.print()} className="btn-solid-primary inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2.5 text-sm font-bold text-primary-foreground">
          <Printer className="size-4" /> 인쇄 · PDF
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="print-sheet mx-auto w-[794px] bg-card p-6 text-[9.5px] text-foreground shadow">
          <p className="text-[9px]">■ 119구조ㆍ구급에 관한 법률 시행규칙 [별지 제5호서식] &lt;개정 2024. 10. 4.&gt;</p>
          <table className="w-full border-collapse">
            <tbody>
              <tr>
                <C cs={4}><Fill w="5em">{f.station}</Fill> 소방서 <Fill w="5em">{f.center}</Fill> 119구급대(안전센터)<br />전화) <Fill w="7em" /></C>
                <td colSpan={4} className="border border-foreground/70 text-center text-[20px] font-bold tracking-[0.5em]">구급활동일지</td>
                <H rs={2}>결재</H>
                <C cs={2} className="h-10 text-center align-top">119구급대장(센터장)</C>
              </tr>
              <tr>
                <H>차량번호</H><C><Fill>{f.carNo}</Fill></C>
                <H>구분</H>
                <C cs={5}>{["특수일반", "특수특별", "항공구급"].map((k) => <Bx key={k} on={f.kind === k}>{k}</Bx>)}</C>
                <C cs={2} />
              </tr>
            </tbody>
          </table>

          <table className="mt-[-1px] w-full border-collapse">
            <tbody>
              <tr>
                <H rs={11} className="w-6">구급<br />출동</H>
                <H>신고 일시</H><C><Fill>{f.callAt}</Fill></C>
                <H>신고자</H><C cs={2}>전화번호 <Fill w="6em" /></C>
                <C cs={3}>신고방법 {["일반전화", "휴대전화", "기타"].map((k) => <Bx key={k} on={f.reportMethod === k}>{k}</Bx>)}</C>
              </tr>
              <tr>
                <H>출동 시각</H><C><Fill>{f.dispatchAt}</Fill></C>
                <H rs={3}>환자<br />인적<br />사항</H>
                <C cs={5}>성명 <Fill w="6em" /> 나이 <Fill>{f.age}</Fill> 성별 <Bx on={f.sex === "남"}>남</Bx><Bx on={f.sex === "여"}>여</Bx> 생년월일 <Fill w="5em" /></C>
              </tr>
              <tr><H>현장 도착</H><C><Fill>{f.sceneAt}</Fill></C><C cs={5}>주소 <Fill w="20em" /> (Tel <Fill w="6em" />)</C></tr>
              <tr><H>환자 접촉</H><C><Fill>{f.contactAt}</Fill></C><C cs={5}><Bx>외국인(국적: <Fill w="4em" />)</Bx></C></tr>
              <tr><H>거리</H><C><Fill>{f.distance}</Fill> km</C><H>보호자 등</H><C cs={5}>성명 <Fill w="5em" /> 관계 <Fill w="3em" /> 전화번호 <Fill w="6em" /></C></tr>
              <tr><H>현장 출발</H><C><Fill>{f.departAt}</Fill></C><H>환자발생 위치</H><C cs={5}><Fill w="20em" /></C></tr>
              <tr>
                <H>병원 도착</H><C><Fill>{f.arriveAt}</Fill></C>
                <H>환자 발생<br />장소(택일)</H>
                <C cs={5}>{PLACE.map((k) => <Bx key={k} on={f.place === k}>{k}</Bx>)}</C>
              </tr>
              <tr>
                <H>귀소 시각</H><C><Fill>{f.returnAt}</Fill></C>
                <H rs={4}>환자 증상<br />(복수 선택<br />가능)</H>
                <C cs={5}>■ 통증({PAIN.map((k) => <Bx key={k} on={sx.has(k)}>{k}</Bx>)}<Bx>그 밖의 통증</Bx>)</C>
              </tr>
              <tr>
                <H rs={3}>출동 유형</H>
                <C rs={3}>{["정상", "오인", "거짓", "취소", "기타"].map((k) => <Bx key={k} on={f.dispatchType === k}>{k}</Bx>)}</C>
                <C cs={5}>■ 외상({TRAUMA.map((k) => <Bx key={k} on={sx.has(k)}>{k}</Bx>)})</C>
              </tr>
              <tr><C cs={5}>{OTHER_SX.map((k) => <Bx key={k} on={sx.has(k)}>{k}</Bx>)}</C></tr>
              <tr><C cs={5}><Bx on={!!f.symptomEtc}>기타(<Fill w="10em">{f.symptomEtc}</Fill>)</Bx></C></tr>
            </tbody>
          </table>

          <table className="mt-[-1px] w-full border-collapse">
            <tbody>
              <tr>
                <H rs={4} className="w-6">환자<br />발생<br />유형</H>
                <C><Bx on={disease}>질 병</Bx></C>
                <H>병 력<br /><span className="font-normal"><Bx on={!f.history.length && !f.historyEtc}>없음</Bx><Bx>미상</Bx></span></H>
                <C cs={3}>{HX.map((k) => <Bx key={k} on={hx.has(k)}>{k}</Bx>)}<Bx on={!!f.historyEtc}>기타(<Fill w="6em">{f.historyEtc}</Fill>)</Bx></C>
              </tr>
              <tr>
                <C rs={2}><Bx on={nonDisease}>질병외</Bx></C>
                <C><Bx on={f.type.includes("교통사고")}>교통사고</Bx> 사상자</C>
                <C cs={3}>{["운전자", "동승자", "보행자", "자전거", "오토바이", "개인형 이동장치", "미상"].map((k) => <Bx key={k}>{k}</Bx>)}</C>
              </tr>
              <tr>
                <C><Bx on={f.type.includes("그 외 외상")}>그 외 외상</Bx> <Bx on={f.type.includes("비외상성")}>비외상성 손상</Bx></C>
                <C cs={3}>{["낙상", "추락", "둔상", "관통상", "익수", "화상", "연기흡입", "중독", "온열손상", "한랭손상", "기타"].map((k) => <Bx key={k}>{k}</Bx>)}</C>
              </tr>
              <tr><C cs={5}><Bx on={f.type === "기타"}>기타</Bx> {["자연재해", "임산부", "신생아", "단순주취"].map((k) => <Bx key={k}>{k}</Bx>)}</C></tr>
            </tbody>
          </table>

          <table className="mt-[-1px] w-full border-collapse">
            <tbody>
              <tr>
                <H rs={9} className="w-6">환자<br />평가</H>
                <H>의식상태</H>
                <C cs={7}>1차 (<Fill>{f.vitalTime}</Fill>) {["A", "V", "P", "U"].map((k) => <Bx key={k} on={f.avpu === k}>{k}</Bx>)} &nbsp; 2차 ( : ) {["A", "V", "P", "U"].map((k) => <Bx key={k}>{k}</Bx>)}</C>
              </tr>
              {(["좌", "우"] as const).map((s) => (
                <tr key={s}>
                  {s === "좌" && <H rs={2}>동공반응</H>}
                  <C cs={7}>{s} {["정상", "축동", "산동", "측정불가"].map((k) => <Bx key={k} on={(s === "좌" ? f.pupilL : f.pupilR) === k}>{k}</Bx>)} &nbsp; <Bx>반응</Bx><Bx>무반응</Bx><Bx>측정불가</Bx></C>
                </tr>
              ))}
              <tr className="text-center">
                <H rs={3}>활력 징후<br /><span className="font-normal"><Bx>불가</Bx><Bx>거부</Bx></span></H>
                <H>시각</H><H>혈압</H><H>맥박</H><H>호흡</H><H>체온</H><H>SpO2</H><H>혈당체크</H>
              </tr>
              <tr className="text-center">
                <C><Fill>{f.vitalTime}</Fill></C><C><Fill>{f.bpS}</Fill>/<Fill>{f.bpD}</Fill> mmHg</C><C><Fill>{f.pulse}</Fill> 회/min</C>
                <C><Fill>{f.resp}</Fill> 회/min</C><C><Fill>{f.temp}</Fill> ℃</C><C><Fill>{f.spo2}</Fill> %</C><C><Fill>{f.glucose}</Fill> mg/dL</C>
              </tr>
              <tr className="text-center"><C> : </C><C>/ mmHg</C><C>회/min</C><C>회/min</C><C>℃</C><C>%</C><C>mg/dL</C></tr>
              <tr>
                <H>환자분류</H>
                <C cs={7}>{["1", "2", "3", "4", "5"].map((k) => <Bx key={k} on={lvl === k}>LEVEL {k}</Bx>)} (<Bx>사망추정</Bx>)</C>
              </tr>
              <tr>
                <H rs={2}>구급대원<br />평가소견</H>
                <C cs={7}>ㆍ주 호소: <Fill w="18em">{f.complaint}</Fill> ㆍ발생시간(<Bx on={!!f.onset}>추정</Bx>): <Fill w="5em">{f.onset}</Fill></C>
              </tr>
              <tr><C cs={7} className="h-8 align-top"><Fill w="40em">{f.opinion}</Fill></C></tr>
            </tbody>
          </table>

          <table className="mt-[-1px] w-full border-collapse">
            <tbody>
              <tr>
                <H className="w-6">응급<br />처치</H>
                <C>
                  ■ 기도확보: {AIRWAY.map((k) => <Bx key={k} on={k === "도수조작" && care.has("기도확보")}>{k}</Bx>)}<br />
                  ■ 산소투여: <Fill>{f.o2}</Fill> L/min({["비관", "안면마스크", "비재호흡마스크", "BVM", "산소소생기", "네뷸라이저", "기타"].map((k) => <Bx key={k}>{k}</Bx>)}) {care.has("산소투여") && !f.o2 ? "✔" : ""}<br />
                  ■ CPR(<Bx on={care.has("CPR")}>실시</Bx><Bx>거부</Bx><Bx>DNR</Bx><Bx>유보</Bx>) <Bx on={care.has("ECG")}>ECG</Bx> ■ AED(<Bx on={care.has("AED")}>Shock</Bx><Bx>Monitoring</Bx>)<br />
                  ■ 순환보조(<Bx on={care.has("정맥로 확보")}>정맥로 확보</Bx><Bx>수액공급</Bx>) <Bx>약물투여</Bx> ■ 고정(<Bx on={care.has("고정(목뼈)")}>목뼈</Bx><Bx>척추</Bx><Bx on={care.has("부목")}>부목</Bx><Bx>머리</Bx>)<br />
                  ■ 상처처치(<Bx on={care.has("지혈")}>지혈</Bx><Bx on={care.has("상처 소독")}>상처 소독 처치</Bx>) <Bx>분만</Bx> <Bx on={care.has("보온")}>보온</Bx>
                </C>
              </tr>
              <tr>
                <H>의료<br />지도</H>
                <C><Bx>연결</Bx><Bx>미연결</Bx> 요청시간 <Fill /> 요청방법 <Bx>일반전화</Bx><Bx>휴대전화</Bx><Bx>무전기</Bx> · 의료지도 의사 성명 <Fill w="5em" /></C>
              </tr>
            </tbody>
          </table>

          <table className="mt-[-1px] w-full border-collapse text-center">
            <tbody>
              <tr>
                <H rs={3} className="w-6">환자<br />이송</H>
                <H className="w-8" /><H>이송 기관명</H><H>도착시간(거리)</H><H>의료기관 선정자 등</H><H>재이송 사유</H><H>환자 인수자</H>
              </tr>
              {[1, 2].map((n) => {
                const first = n === 1;
                const name = first ? f.hospital : f.hospital2;
                return (
                  <tr key={n}>
                    <H>{n}차</H>
                    <C><Fill w="8em">{name}</Fill><br /><Bx on={!!name}>관할</Bx><Bx>타시ㆍ도</Bx></C>
                    <C><Fill>{first ? f.hospitalArrive : ""}</Fill><br />(<Fill>{first ? f.distance : ""}</Fill> km)</C>
                    <C className="text-left">{["구급대", "119상황실", "구급상황센터", "환자/보호자", "병원 수용곤란 등"].map((k) => <Bx key={k} on={first && f.selector === k}>{k}</Bx>)}</C>
                    <C className="text-left">■ 병상 부족(<Bx>응급실</Bx><Bx>수술실</Bx><Bx>입원실</Bx><Bx>중환자실</Bx>) <Bx>전문의 부재</Bx><Bx>의료장비 고장</Bx><Bx on={first && !!f.reTransfer}>기타(<Fill w="5em">{first ? f.reTransfer : ""}</Fill>)</Bx></C>
                    <C className="text-left">{["의사", "간호사", "응급구조사", "기타"].map((k) => <Bx key={k} on={first && f.handover === k}>{k}</Bx>)}</C>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <table className="mt-[-1px] w-full border-collapse">
            <tbody>
              <tr><H className="w-6">미이송</H><C>{["취소", "타차량", "환자 없음", "현장처치", "이송거부", "이송거절", "경찰인계", "이송 불필요", "사망", "기타"].map((k) => <Bx key={k}>{k}</Bx>)}</C></tr>
            </tbody>
          </table>

          <table className="mt-[-1px] w-full border-collapse">
            <tbody>
              <tr><H rs={5} className="w-6">출동<br />인원</H><H>의 사</H><C cs={4}>소속: <Fill w="8em" /> 성명: <Fill w="6em" /> (서명 또는 인)</C></tr>
              {rowsCrew.map(([role, grade, rank, name]) => (
                <tr key={role}>
                  <H>{role}</H>
                  <C>{GRADES.map((g) => <Bx key={g} on={grade === g}>{g}</Bx>)}</C>
                  <C>계급 소방<Fill>{rank.replace(/^소방/, "")}</Fill></C>
                  <C>성명 <Fill w="5em">{name}</Fill></C>
                  <C className="w-24 text-muted-foreground">(서명 또는 인)</C>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-right text-[8px] text-muted-foreground">210mm×297mm[백상지(80g/㎡) 또는 중질지(80g/㎡)]</p>
        </div>
      </div>
    </div>
  );
}
