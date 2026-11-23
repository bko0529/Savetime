import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Building2, Hospital, Stethoscope, AlertTriangle, ArrowLeft, ArrowRight, UserCheck } from "lucide-react";
import { PhoneScreen, BigButton, SectionTitle, Label, Notice, StepDots, Pill } from "@/components/phone";
import { useTransport, filledCount, REQUIRED_FIELDS, UNKNOWN, type Patient, type Grade } from "@/lib/transport-store";
import { START_RADIUS } from "@/lib/hospitals";
import { useEngine, actions, previewTargets } from "@/lib/engine";
import { ACTIVE } from "@/lib/domain/stateMachine";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/patient")({
  head: () => ({
    meta: [
      { title: "환자 정보 입력 · 골든타임즈" },
      { name: "description", content: "3단계로 환자 상태를 입력하고 병원에 요청해요." },
      { property: "og:title", content: "환자 정보 입력 · 골든타임즈" },
      { property: "og:description", content: "병원 등급, 주 증상, 활력징후, 통증·외상·과거력 입력" },
    ],
  }),
  component: PatientPage,
});

const GRADES: { g: Exclude<Grade, null>; sub: string; icon: typeof Building2 }[] = [
  { g: "대학병원급", sub: "권역센터", icon: Building2 },
  { g: "종합병원급", sub: "지역센터", icon: Hospital },
  { g: "일반 병원", sub: "지역기관", icon: Stethoscope },
];
const CONSC: { c: string; tone: string }[] = [
  { c: "명료", tone: "text-success" }, { c: "말에 반응", tone: "text-warning" },
  { c: "통증에 반응", tone: "text-warning" }, { c: "무반응", tone: "text-destructive" },
];

function PatientPage() {
  const { patient, setPatient } = useTransport();
  const [step, setStep] = useState(1);
  const nav = useNavigate();
  const e = useEngine();
  const active = !!e.status && ACTIVE.includes(e.status);
  const p = patient;
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    const r = active ? await actions.updateAssessment(p) : await actions.create(p.grade, p);
    setSending(false);
    if (!r.ok) { toast.error(r.error); return; }
    if (active) { toast.success("변경 사항을 병원에 보냈어요 · 강조 표시돼요"); nav({ to: e.status === "moving" ? "/transport" : "/request" }); }
  };
  const set = (k: keyof Patient, v: string | Grade) => setPatient({ ...p, [k]: v });
  const count = filledCount(p);
  const allDone = count === REQUIRED_FIELDS.length;
  // 'n곳에 요청합니다': 서버가 지금 위치·등급으로 센다 (SFR-163)
  const [targets, setTargets] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void previewTargets(p.grade).then((n) => alive && setTargets(n));
    return () => { alive = false; };
  }, [p.grade]);

  const fillUnknown = () => {
    const next = { ...p };
    REQUIRED_FIELDS.forEach((k) => {
      if (!String(next[k]).trim()) (next[k] as string) = UNKNOWN;
    });
    setPatient(next);
  };

  const spo2 = Number(p.spo2);
  const warnings: string[] = [];
  if (spo2 && spo2 < 94) warnings.push(`산소포화도 ${spo2}%`);
  const [sys] = p.bp.split("/").map(Number);
  if (sys && (sys >= 160 || sys < 90)) warnings.push(`혈압 ${p.bp}`);
  const pulse = Number(p.pulse);
  if (pulse && (pulse > 120 || pulse < 50)) warnings.push(`맥박 ${pulse}`);

  const text = (k: keyof Patient, ph?: string, mode?: "numeric" | "text") => (
    <input className="field" value={p[k] as string} placeholder={ph} inputMode={mode} onChange={(e) => set(k, e.target.value)} />
  );
  /** 숫자 칸: 단위를 칸 안에 붙임 (혈압 mmHg · 맥박 bpm …) */
  const num = (k: keyof Patient, ph: string, unit: string) => (
    <div className="relative">
      <input className="field pr-14 tabular-nums" value={p[k] as string} placeholder={ph} inputMode="numeric" onChange={(ev) => set(k, ev.target.value)} />
      <span className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-[11px] font-bold text-muted-foreground">{unit}</span>
    </div>
  );

  return (
    <PhoneScreen
      title="환자 정보 입력"
      subtitle={allDone ? "필수 12개 모두 입력됨" : `필수 12개 중 ${count}개 입력됨`}
      badge={<Pill tone={allDone ? "ok" : "wait"} dot={false}>{step}/3</Pill>}
      footer={
        <>
          <div className="flex gap-2">
            {step > 1 && (
              <BigButton variant="outline" className="w-24 shrink-0" onClick={() => setStep(step - 1)}><ArrowLeft className="size-4" /> 이전</BigButton>
            )}
            {step < 3 && (
              <BigButton variant="outline" onClick={() => setStep(step + 1)}>
                {step === 1 ? "다음: 활력징후" : "다음: 통증 · 외상"} <ArrowRight className="size-4" />
              </BigButton>
            )}
          </div>
          <BigButton size="lg" className="mt-2" disabled={!allDone || sending} onClick={() => void send()}>
            {active ? "변경 사항 보내기" : "병원에 요청"}
          </BigButton>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {step === 1 && "필수 항목이 모두 채워지면 어느 단계에서든 요청할 수 있어요"}
            {step === 2 && "← 이전 단계로 돌아가 언제든 고칠 수 있어요"}
            {step === 3 && "이름 · 주민번호 · 연락처는 받지 않아요"}
          </p>
        </>
      }
    >
      <StepDots step={step} total={3} onJump={setStep} />
      <p className="mt-2 mb-5 text-xs font-semibold text-muted-foreground">
        {step === 1 && "1단계 · 병원 등급 · 주 증상 · 성별·나이대"}
        {step === 2 && "2단계 · 의식 · 활력징후"}
        {step === 3 && "3단계 · 통증 · 외상 · 선택 항목"}
      </p>

      {step === 1 && (
        <>
          <SectionTitle hint="고른 등급 이상 병원에만 요청해요. 안 고르면 모든 병원에 요청해요.">병원 등급 (선택)</SectionTitle>
          <div className="grid grid-cols-3 gap-2">
            {GRADES.map(({ g, sub, icon: Icon }) => {
              const on = p.grade === g;
              return (
                <button key={g} onClick={() => set("grade", on ? null : g)} aria-pressed={on}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-xl border-2 px-2 py-3.5 text-center transition",
                    on ? "border-accent bg-accent-soft text-accent-deep shadow-[var(--shadow-accent)]" : "border-border bg-card text-foreground hover:border-border-strong",
                  )}>
                  <Icon className={cn("size-5", on ? "text-accent-deep" : "text-muted-foreground")} />
                  <span className="text-[13px] leading-tight font-extrabold">{g}</span>
                  <span className="text-[11px] opacity-70">{sub}</span>
                </button>
              );
            })}
          </div>

          <SectionTitle>주 증상 (필수)</SectionTitle>
          <Label>직접 입력하세요</Label>
          {text("complaint", "예: 갑작스러운 극심한 두통, 의식 저하")}

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <Label>성별</Label>
              <div className="grid grid-cols-2 gap-1.5">
                {["남", "여"].map((s) => (
                  <button key={s} onClick={() => set("sex", s)} aria-pressed={p.sex === s}
                    className={cn("field text-center font-bold transition", p.sex === s && "border-accent bg-accent-soft text-accent-deep")}>{s}</button>
                ))}
              </div>
            </div>
            <div>
              <Label>나이대</Label>
              <select className="field" value={p.age} onChange={(e) => set("age", e.target.value)}>
                <option value="">선택</option>
                {["10세 미만", "10대", "20대", "30대", "40대", "50대", "60대", "70대", "80대 이상"].map((a) => <option key={a}>{a}</option>)}
              </select>
            </div>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <SectionTitle>의식 수준</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {CONSC.map(({ c, tone }) => (
              <button key={c} onClick={() => set("consciousness", c)} aria-pressed={p.consciousness === c}
                className={cn("chip px-4 py-2 text-sm", p.consciousness === c ? cn("chip-on", tone) : "hover:bg-surface-2")}>{c}</button>
            ))}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-x-3 gap-y-4">
            <div><Label>혈압</Label>{num("bp", "160/95", "mmHg")}</div>
            <div><Label>맥박</Label>{num("pulse", "88", "bpm")}</div>
            <div><Label>호흡수</Label>{num("resp", "20", "/min")}</div>
            <div><Label>산소포화도</Label>{num("spo2", "89", "%")}</div>
          </div>
          {warnings.length > 0 && (
            <div className="mt-5">
              <Notice tone="warn" icon={<AlertTriangle className="size-4" />}>{warnings.join(" · ")} · 정상 범위 밖이라 병원 웹에 빨간색으로 보여요</Notice>
            </div>
          )}
        </>
      )}

      {step === 3 && (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            <div><Label>통증 부위</Label>{text("painSite", "머리")}</div>
            <div><Label>통증 정도</Label>{num("painScore", "8", "/10")}</div>
            <div><Label>증상 시작</Label>{text("onset", "30분 전")}</div>
            <div><Label>외상</Label>{text("trauma", "없음")}</div>
          </div>
          <div className="mt-4"><Label>과거력 (선택)</Label>{text("history", "고혈압, 당뇨")}</div>

          <SectionTitle hint="몰라도 요청할 수 있어요">선택 항목</SectionTitle>
          <div className="grid grid-cols-3 gap-2">
            <div><Label>체온</Label>{num("temp", "36.5", "℃")}</div>
            <div><Label>혈당</Label>{num("glucose", "120", "mg/dL")}</div>
            <div>
              <Label>KTAS</Label>
              <select className="field" value={p.ktas} onChange={(e) => set("ktas", e.target.value)}>
                <option value="">-</option>
                {["1", "2", "3", "4", "5"].map((k) => <option key={k}>{k}</option>)}
              </select>
            </div>
          </div>
          <BigButton variant="outline" className="mt-4" onClick={fillUnknown}>
            <UserCheck className="size-4" /> 나머지 확인 불가로 보내기
          </BigButton>
          <div className="mt-5 rounded-xl border border-border bg-surface px-4 py-3.5">
            <p className="text-sm font-extrabold">{p.grade ? `${p.grade} 이상 · ` : "모든 등급 · "}반경 {START_RADIUS}km 안 {targets ?? "-"}곳에 요청합니다</p>
            <p className="mt-1 text-xs text-muted-foreground">등급 바꾸기는 1단계에서</p>
          </div>
        </>
      )}
    </PhoneScreen>
  );
}
