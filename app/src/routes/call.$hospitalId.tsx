import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Phone, CheckCircle2, PhoneOff, SkipForward, XCircle, Info } from "lucide-react";
import { toast } from "sonner";
import { PhoneScreen, BigButton, SectionTitle, Notice, Pill, IconTile } from "@/components/phone";
import { ProgressStrip } from "@/components/progress";
import { RESPONSE_LIMIT_SEC, capCount } from "@/lib/hospitals";
import { HospitalDetail } from "@/components/hospital-detail";
import { useEngine, actions, now, hospital, openRemain, loadHospitalDetail, type Result } from "@/lib/engine";
import type { PhoneProceedReason } from "@/lib/domain/stateMachine";

export const Route = createFileRoute("/call/$hospitalId")({
  head: () => ({
    meta: [
      { title: "전화 확인 · 골든타임즈" },
      { name: "description", content: "요청을 열어 둔 채 응급실에 직접 전화로 확인해요." },
      { property: "og:title", content: "전화 확인 · 골든타임즈" },
      { property: "og:description", content: "응급실 원터치 전화와 통화 결과 기록" },
    ],
  }),
  component: CallPage,
});

const PROCEED: { k: PhoneProceedReason; l: string }[] = [
  { k: "no_answer", l: "전화 안 받음" }, { k: "busy", l: "통화 중" }, { k: "urgent", l: "환자가 급함" }, { k: "etc", l: "기타" },
];

function CallPage() {
  const { hospitalId } = Route.useParams();
  const e = useEngine();
  const h = hospital(hospitalId);
  // 병원 상세(병상 3종·대표 전화·진료가능 항목)를 서버에서 읽는다 (SFR-007·033)
  useEffect(() => {
    void loadHospitalDetail(hospitalId);
  }, [hospitalId]);
  const nav = useNavigate();
  const [proceed, setProceed] = useState<"fail" | "skip" | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    if (!e.status) nav({ to: "/" });
  }, [e.status, nav]);

  const run = async (p: Promise<Result>) => { const r = await p; if (!r.ok) toast.error(r.error); };
  const remain = RESPONSE_LIMIT_SEC - Math.floor((now() - e.roundSentAt) / 1000);
  const open = openRemain();
  const approved = e.hreqs.filter((r) => r.status === "approved");
  const inPhone = e.status === "phone_check";

  return (
    <PhoneScreen
      title="전화 확인"
      subtitle={`${h.name} · ${h.km}km · 약 ${h.min}분`}
      badge={<Pill tone="call" dot={false} className="bg-primary/8 text-primary">응급실 직통</Pill>}
      footer={<BigButton variant="outline" onClick={() => (inPhone ? void run(actions.phoneDismiss()) : nav({ to: "/request" }))}>← 요청 화면으로</BigButton>}
    >
      <ProgressStrip />
      {open ? (
        <Notice tone="info" icon={<Info className="size-4" />}>다른 병원 요청은 그대로 열려 있어요{remain > 0 ? ` (남은 ${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, "0")})` : ""}</Notice>
      ) : (
        <Notice tone="warn">열린 요청이 없어요 · 돌아가면 예비 추천이 보여요</Notice>
      )}

      {approved.length > 0 && (
        <div className="mt-3 rounded-xl border border-success/40 bg-success-soft/60 p-3.5 shadow-[var(--shadow-card)]">
          <p className="flex items-center gap-1.5 text-sm font-extrabold text-success"><CheckCircle2 className="size-4" /> 통화 중 승인 {approved.length}곳 · 눌러서 바로 확정</p>
          {approved.map((r) => (
            <button key={r.hospitalId} className="tile mt-2.5 flex w-full items-center justify-between gap-2 p-3 text-left transition hover:bg-surface" onClick={() => setDetail(r.hospitalId)}>
              <span className="min-w-0 truncate font-bold">{hospital(r.hospitalId).name} · {hospital(r.hospitalId).km}km</span>
              <Pill tone="ok">승인</Pill>
            </button>
          ))}
        </div>
      )}

      <a href={`tel:${h.phone}`} className="mt-4 block">
        <BigButton variant="accent" size="lg" className="text-lg"><Phone className="size-5" /> {h.name} 응급실에 전화</BigButton>
      </a>
      <div className="tile mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 p-3.5 text-xs">
        <span className="text-muted-foreground">응급실 <b className="text-foreground">{h.er ?? "정보 없음"}</b></span>
        <span className="text-muted-foreground">중환자실 <b className="text-foreground">{h.icu ?? "정보 없음"}</b></span>
        <span className="text-muted-foreground">수술실 <b className="text-foreground">{h.or ?? "정보 없음"}</b></span>
        <span className="text-muted-foreground">진료가능 <b className="text-foreground">{capCount(h).available}/{capCount(h).total}</b></span>
        <span className="col-span-2 border-t pt-2 text-muted-foreground">직통 {h.erPhone} · 대표 {h.mainPhone} · 병상 기준 {h.bedsAt || "없음"}</span>
      </div>

      <SectionTitle>통화 결과</SectionTitle>
      <BigButton variant="success" size="lg" className="text-lg" onClick={() => run(actions.phoneAccepted())}><CheckCircle2 className="size-5" /> 수용 확정 → 출발</BigButton>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <BigButton variant="outline" onClick={() => setProceed("fail")}><PhoneOff className="size-4" /> 연결 실패</BigButton>
        <BigButton variant="outline" onClick={() => setProceed("skip")}><SkipForward className="size-4" /> 확인 생략</BigButton>
      </div>
      {proceed && (
        <div className="tile rise-in mt-2 p-3.5">
          <p className="mb-2.5 text-sm font-bold">{proceed === "fail" ? "연결 실패" : "확인 생략"} 사유를 고르면 이 병원으로 출발해요</p>
          <div className="grid grid-cols-2 gap-1.5">
            {PROCEED.map((p) => (
              <button key={p.k} className="chip justify-center py-2.5 text-sm hover:bg-surface-2" onClick={() => void run(actions.phoneProceed(p.k, proceed === "skip" ? "skipped" : "no_answer"))}>{p.l}</button>
            ))}
          </div>
        </div>
      )}
      <BigButton variant="danger" size="lg" className="mt-3 text-lg" onClick={() => run(actions.phoneRejected())}><XCircle className="size-5" /> 거절 → 다음 병원</BigButton>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        출발하면 열려 있던 요청은 닫히고 병원 웹에 "요청 종료"가 떠요. 통화 중 승인이 오면 진동으로 알려요.
      </p>

      {detail && (
        <HospitalDetail
          h={hospital(detail)}
          approved
          note={[...e.hreqs].reverse().find((r) => r.hospitalId === detail)?.note}
          onClose={() => setDetail(null)}
          onConfirm={() => { setDetail(null); if (window.confirm(`${hospital(detail).name}으로 확정할까요?`)) void run(actions.confirm(detail)); }}
        />
      )}
    </PhoneScreen>
  );
}
