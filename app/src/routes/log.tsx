import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Pencil, Check, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { PhoneScreen, BigButton, Label } from "@/components/phone";
import { useTransport, fmtTime, UNKNOWN } from "@/lib/transport-store";
import { mergePatient, applyAiSuggestions } from "@/lib/journal";
import { AiOrganize } from "@/components/ai-organize";
import { cn } from "@/lib/utils";
import { actions, loadJournalDraft } from "@/lib/engine";
import { getAuth, currentAccount, useAuth } from "@/lib/auth-store";
import { LogFormSheet, type LogData } from "@/components/log-form-sheet";

export const Route = createFileRoute("/log")({
  head: () => ({
    meta: [
      { title: "구급활동일지 · 골든타임즈" },
      { name: "description", content: "이송 중 입력한 정보로 자동 작성된 구급활동일지를 확인하고 고쳐요." },
      { property: "og:title", content: "구급활동일지 · 골든타임즈" },
      { property: "og:description", content: "119구조·구급에 관한 법률 시행규칙 별지 제5호서식 기반" },
    ],
  }),
  component: LogPage,
});

const AVPU: Record<string, string> = { 명료: "A", "말에 반응": "V", "통증에 반응": "P", 무반응: "U" };
const SYMPTOMS = ["두통", "흉통", "복통", "요통", "의식장애", "호흡곤란", "심정지", "경련/발작", "실신", "오심", "구토", "어지러움", "마비", "전신쇠약", "고열"];
const HISTORY = ["고혈압", "당뇨", "뇌혈관질환", "심장질환", "폐질환", "결핵", "간염", "알레르기", "암", "신부전"];
const TYPES = ["질병", "질병외 · 교통사고", "질병외 · 그 외 외상", "질병외 · 비외상성 손상", "기타"];
const PLACES = ["집", "집단거주시설", "도로", "오락/문화/공공시설", "학교/교육시설", "상업시설", "의료관련시설", "공장/산업/건설시설", "기타"];
const CARE = ["기도확보", "산소투여", "CPR", "ECG", "AED", "정맥로 확보", "고정(목뼈)", "부목", "지혈", "상처 소독", "보온"];
const SELECTOR = ["구급대", "119상황실", "구급상황센터", "환자/보호자", "병원 수용곤란 등"];

const v = (s: string) => (s && s !== UNKNOWN ? s : "");

function LogPage() {
  const t = useTransport();
  const [filled, setFilled] = useState(false);
  // 병원이 '도착 확인'을 눌러 끝났거나 팀원 폰이면 이 폰에는 병원·시각·환자 정보가 없다. 서버 초안으로 빈칸을 채운 뒤 그린다
  useEffect(() => {
    if (!t.ready || filled) return;
    let alive = true;
    void loadJournalDraft().then((d) => {
      if (!alive) return;
      if (d) {
        t.setPatient(mergePatient(t.patient, d));
        t.setTimeline({
          ...t.timeline,
          ...(t.timeline.departAt || !d.departedAt ? {} : { departAt: new Date(d.departedAt) }),
          ...(t.timeline.arriveAt || !d.arrivedAt ? {} : { arriveAt: new Date(d.arrivedAt) }),
        });
        // 이송 기관은 서버가 아는 실제 도착 병원, 거리는 위치 기록으로 잰 실제 거리를 쓴다 (없으면 이 폰 값)
        if (d.hospitalName) {
          t.setConfirmed({
            id: t.confirmed?.id ?? "",
            name: d.hospitalName,
            km: d.distanceKm ?? t.confirmed?.km ?? 0,
            min: t.confirmed?.min ?? 0,
            ...(t.confirmed?.note ? { note: t.confirmed.note } : {}),
          });
        }
      }
      setFilled(true);
    });
    return () => {
      alive = false;
    };
  }, [t.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  return t.ready && filled ? <LogBody /> : null;
}

function LogBody() {
  const t = useTransport();
  const nav = useNavigate();
  const p = t.patient;
  const tl = t.timeline;
  const symptomGuess = SYMPTOMS.filter((s) => p.complaint.includes(s.replace("/발작", "")) || (s === "두통" && p.painSite.includes("머리")) || (s === "의식장애" && p.complaint.includes("의식")));
  const [bpS, bpD] = v(p.bp).split("/");

  const [sheet, setSheet] = useState(false);
  const { journalAi } = useAuth().featureFlags;
  const st = getAuth();
  const me = currentAccount(st);
  const drv = st.duty?.members.find((m) => m.role === "운전");
  const [f, setF] = useState<LogData>({
    station: me?.orgName.replace(/소방서$/, "") ?? "", center: me?.center.replace(/119안전센터$/, "") ?? "", carNo: "", kind: "특수일반", returnAt: "", reportMethod: "휴대전화", hospital2: "",
    callAt: fmtTime(tl.callAt), dispatchAt: fmtTime(tl.dispatchAt), sceneAt: fmtTime(tl.sceneAt), contactAt: fmtTime(tl.contactAt),
    departAt: fmtTime(tl.departAt), arriveAt: fmtTime(tl.arriveAt), distance: t.confirmed ? String(t.confirmed.km) : "",
    dispatchType: "정상",
    sex: v(p.sex), age: v(p.age), place: "집",
    symptoms: symptomGuess, symptomEtc: "",
    history: HISTORY.filter((h) => p.history.includes(h)), historyEtc: "",
    type: "질병",
    avpu: AVPU[p.consciousness] ?? "",
    pupilL: "정상", pupilR: "정상",
    vitalTime: fmtTime(tl.contactAt), bpS: bpS ?? "", bpD: bpD ?? "", pulse: v(p.pulse), resp: v(p.resp), temp: v(p.temp), spo2: v(p.spo2), glucose: v(p.glucose),
    ktas: v(p.ktas), complaint: v(p.complaint), onset: v(p.onset), opinion: [p.painSite && `통증 부위 ${v(p.painSite)}`, p.painScore && `통증 ${v(p.painScore)}/10`, p.trauma && `외상 ${v(p.trauma)}`].filter(Boolean).join(" · "),
    care: [] as string[], o2: "",
    hospital: t.confirmed?.name ?? "", hospitalArrive: fmtTime(tl.arriveAt), selector: "구급대", handover: "의사",
    reTransfer: t.rejectedNames.length ? "병원 수용곤란 (전화 거절)" : "",
    crew1: me?.name ?? "", crew1Rank: me?.rank ?? "", crew1Grade: "1급", driver: drv?.name ?? "", driverRank: drv?.rank ?? "", driverGrade: "2급",
  });
  const set = <K extends keyof typeof f>(k: K, val: (typeof f)[K]) => setF({ ...f, [k]: val });
  const toggle = (k: "symptoms" | "history" | "care", item: string) =>
    set(k as "symptoms", f[k].includes(item) ? f[k].filter((x) => x !== item) : [...f[k], item]);

  const inp = (k: keyof typeof f, ph = "", cls = "") => (
    <input className={cn("field py-2.5 text-base", cls)} placeholder={ph} value={f[k] as string} onChange={(e) => set(k, e.target.value as never)} />
  );
  const chips = (k: "symptoms" | "history" | "care", items: string[]) => (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <button key={i} onClick={() => toggle(k, i)} aria-pressed={f[k].includes(i)} className={cn("chip py-2", f[k].includes(i) ? "chip-on" : "hover:bg-surface-2")}>{i}</button>
      ))}
    </div>
  );
  const radio = (k: keyof typeof f, items: string[]) => (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <button key={i} onClick={() => set(k, i as never)} aria-pressed={f[k] === i} className={cn("chip py-2", f[k] === i ? "border-primary bg-primary font-bold text-primary-foreground" : "hover:bg-surface-2")}>{i}</button>
      ))}
    </div>
  );

  const save = () => {
    toast.success("구급활동일지를 저장했어요 (시연)");
    t.reset();
    actions.reset();
    nav({ to: "/" });
  };

  return (
    <PhoneScreen
      title="구급활동일지"
      subtitle="별지 제5호서식 · 앱에서 입력한 내용이 자동으로 채워져요"
      footer={<div className="space-y-2"><BigButton onClick={() => setSheet(true)}>제출용 서식으로 보기 · 인쇄</BigButton><button onClick={save} className="w-full py-2 text-sm font-semibold text-muted-foreground">저장하고 홈으로</button></div>}
    >
      {sheet && <LogFormSheet f={f} onClose={() => setSheet(false)} />}
      <div className="mb-4 flex items-start gap-2.5 rounded-xl bg-info-soft px-4 py-3 text-sm">
        <Sparkles className="mt-px size-4 shrink-0 text-accent-deep" />
        <span className="leading-relaxed"><b>자동</b> 표시가 있는 칸은 이송 중 기록으로 채웠어요. 각 칸의 <b>수정</b>을 눌러 고칠 수 있어요.</span>
      </div>

      {/* 관리자가 'AI 일지 정리'를 켰을 때만 (QUR-013, 앱이 1분마다 설정을 다시 읽음) */}
      {journalAi && <AiOrganize onApply={(s) => setF(applyAiSuggestions(f, s))} />}

      <Section title="구급출동" auto note="신고·출동·현장 도착·환자 접촉 시각은 앱이 알 수 없어서 비워 뒀어요. 수정을 눌러 직접 적어 주세요.">
        {(edit) => edit ? (
          <div className="grid grid-cols-2 gap-2">
            {([["callAt", "신고 일시"], ["dispatchAt", "출동 시각"], ["sceneAt", "현장 도착"], ["contactAt", "환자 접촉"], ["departAt", "현장 출발"], ["arriveAt", "병원 도착"]] as const).map(([k, l]) => (
              <div key={k}><Label>{l}</Label>{inp(k, "00:00")}</div>
            ))}
            <div><Label>거리 (km)</Label>{inp("distance")}</div>
            <div><Label>귀소 시각</Label>{inp("returnAt", "00:00")}</div>
            <div><Label>차량번호</Label>{inp("carNo")}</div>
            <div className="col-span-2"><Label>소방서</Label>{inp("station")}</div>
            <div className="col-span-2"><Label>안전센터</Label>{inp("center")}</div>
            <div className="col-span-2"><Label>구분</Label>{radio("kind", ["특수일반", "특수특별", "항공구급"])}</div>
            <div className="col-span-2"><Label>신고방법</Label>{radio("reportMethod", ["일반전화", "휴대전화", "기타"])}</div>
            <div className="col-span-2"><Label>출동 유형</Label>{radio("dispatchType", ["정상", "오인", "거짓", "취소", "기타"])}</div>
          </div>
        ) : (
          <Rows rows={[["신고", f.callAt], ["출동", f.dispatchAt], ["현장 도착", f.sceneAt], ["환자 접촉", f.contactAt], ["현장 출발", f.departAt], ["병원 도착", f.arriveAt], ["귀소", f.returnAt], ["거리", f.distance && `${f.distance}km`], ["출동 유형", f.dispatchType]]} />
        )}
      </Section>

      <Section title="환자 인적사항" auto note="이름 · 주민번호 · 연락처는 앱에 저장하지 않아요. 필요하면 종이 일지에 따로 적어요.">
        {(edit) => edit ? (
          <div className="space-y-3">
            <div><Label>성별</Label>{radio("sex", ["남", "여"])}</div>
            <div><Label>나이대</Label>{inp("age")}</div>
            <div><Label>환자 발생 장소</Label>{radio("place", PLACES)}</div>
          </div>
        ) : <Rows rows={[["성별", f.sex], ["나이대", f.age], ["발생 장소", f.place]]} />}
      </Section>

      <Section title="환자 증상 · 병력" auto>
        {(edit) => edit ? (
          <div className="space-y-3">
            <div><Label>증상 (복수 선택)</Label>{chips("symptoms", SYMPTOMS)}</div>
            <div><Label>그 밖의 증상</Label>{inp("symptomEtc")}</div>
            <div><Label>병력</Label>{chips("history", HISTORY)}</div>
            <div><Label>기타 병력</Label>{inp("historyEtc")}</div>
          </div>
        ) : <Rows rows={[["증상", [...f.symptoms, f.symptomEtc].filter(Boolean).join(", ")], ["병력", [...f.history, f.historyEtc].filter(Boolean).join(", ") || (p.history ? p.history : "없음")]]} />}
      </Section>

      <Section title="환자 발생 유형">
        {(edit) => edit ? radio("type", TYPES) : <Rows rows={[["유형", f.type]]} />}
      </Section>

      <Section title="환자 평가" auto>
        {(edit) => edit ? (
          <div className="space-y-3">
            <div><Label>의식 상태 (AVPU)</Label>{radio("avpu", ["A", "V", "P", "U"])}</div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>동공 좌</Label>{radio("pupilL", ["정상", "축동", "산동", "측정불가"])}</div>
              <div><Label>동공 우</Label>{radio("pupilR", ["정상", "축동", "산동", "측정불가"])}</div>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div><Label>시각</Label>{inp("vitalTime")}</div>
              <div><Label>수축기</Label>{inp("bpS")}</div>
              <div><Label>이완기</Label>{inp("bpD")}</div>
              <div><Label>맥박</Label>{inp("pulse")}</div>
              <div><Label>호흡</Label>{inp("resp")}</div>
              <div><Label>체온</Label>{inp("temp")}</div>
              <div><Label>SpO2</Label>{inp("spo2")}</div>
              <div><Label>혈당</Label>{inp("glucose")}</div>
            </div>
            <div><Label>환자분류 (LEVEL)</Label>{radio("ktas", ["1", "2", "3", "4", "5"])}</div>
            <div><Label>주 호소</Label>{inp("complaint")}</div>
            <div><Label>발생 시간</Label>{inp("onset")}</div>
            <div><Label>구급대원 평가소견</Label>{inp("opinion")}</div>
          </div>
        ) : (
          <Rows rows={[
            ["의식", f.avpu], ["동공", `좌 ${f.pupilL} · 우 ${f.pupilR}`],
            ["활력징후", `${f.vitalTime} · 혈압 ${f.bpS || "-"}/${f.bpD || "-"} · 맥박 ${f.pulse || "-"} · 호흡 ${f.resp || "-"} · 체온 ${f.temp || "-"} · SpO2 ${f.spo2 || "-"}% · 혈당 ${f.glucose || "-"}`],
            ["환자분류", f.ktas && `LEVEL ${f.ktas}`], ["주 호소", f.complaint], ["발생", f.onset], ["평가소견", f.opinion],
          ]} />
        )}
      </Section>

      <Section title="응급처치">
        {(edit) => edit ? (
          <div className="space-y-3">
            {chips("care", CARE)}
            <div><Label>산소투여 (L/min)</Label>{inp("o2")}</div>
          </div>
        ) : <Rows rows={[["처치", f.care.join(", ")], ["산소", f.o2 && `${f.o2} L/min`]]} />}
      </Section>

      <Section title="환자 이송" auto>
        {(edit) => edit ? (
          <div className="space-y-3">
            <div><Label>이송 기관명</Label>{inp("hospital")}</div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>도착 시간</Label>{inp("hospitalArrive")}</div>
              <div><Label>거리 (km)</Label>{inp("distance")}</div>
            </div>
            <div><Label>의료기관 선정자</Label>{radio("selector", SELECTOR)}</div>
            <div><Label>재이송 사유</Label>{inp("reTransfer", "없음")}</div>
            <div><Label>2차 이송 기관 (재이송 시)</Label>{inp("hospital2")}</div>
            <div><Label>환자 인수자</Label>{radio("handover", ["의사", "간호사", "응급구조사", "기타"])}</div>
          </div>
        ) : <Rows rows={[["이송 기관", f.hospital], ["도착", f.hospitalArrive], ["선정자", f.selector], ["재이송 사유", f.reTransfer || "없음"], ["인수자", f.handover]]} />}
      </Section>

      <Section title="출동 인원">
        {(edit) => edit ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2"><div><Label>구급대원(1) 성명</Label>{inp("crew1")}</div><div><Label>계급</Label>{inp("crew1Rank")}</div></div>
            <div><Label>자격</Label>{radio("crew1Grade", ["1급", "2급", "간호사", "구급교육", "기타"])}</div>
            <div className="grid grid-cols-2 gap-2"><div><Label>운전요원 성명</Label>{inp("driver")}</div><div><Label>계급</Label>{inp("driverRank")}</div></div>
            <div><Label>자격</Label>{radio("driverGrade", ["1급", "2급", "간호사", "구급교육", "기타"])}</div>
          </div>
        ) : <Rows rows={[["구급대원", `${f.crew1} · ${f.crew1Rank} · ${f.crew1Grade}`], ["운전요원", `${f.driver} · ${f.driverRank} · ${f.driverGrade}`]]} />}
      </Section>
    </PhoneScreen>
  );
}

function Section({ title, auto, note, children }: { title: string; auto?: boolean; note?: string; children: (edit: boolean) => ReactNode }) {
  const [edit, setEdit] = useState(false);
  return (
    <section className="tile mb-3 overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface/70 px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-[15px] font-extrabold tracking-tight">
          <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent" />
          {title}
          {auto && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-extrabold text-accent-deep">자동</span>}
        </h2>
        <button onClick={() => setEdit(!edit)} className={cn("inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-bold transition", edit ? "btn-solid-primary text-primary-foreground" : "border border-border bg-card text-muted-foreground hover:bg-surface")}>
          {edit ? <><Check className="size-3.5" /> 완료</> : <><Pencil className="size-3.5" /> 수정</>}
        </button>
      </div>
      <div className="p-4">{children(edit)}</div>
      {note && <p className="border-t border-border bg-surface/60 px-4 py-2.5 text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}

function Rows({ rows }: { rows: [string, string | undefined | false][] }) {
  return (
    <dl className="text-sm">
      {rows.map(([k, val]) => (
        <div key={k} className="flex gap-3 border-b border-dashed border-border py-2 last:border-0">
          <dt className="w-20 shrink-0 text-muted-foreground">{k}</dt>
          <dd className={cn("flex-1 font-semibold", !val && "font-normal text-muted-foreground/60")}>{val || "미입력"}</dd>
        </div>
      ))}
    </dl>
  );
}
