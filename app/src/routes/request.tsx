import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Clock, PhoneCall, MapPin, ChevronRight, BellRing } from "lucide-react";
import { PhoneScreen, BigButton, SectionTitle, Pill, Notice, IconTile } from "@/components/phone";
import { ProgressStrip } from "@/components/progress";
import { useEngine, actions, now, hospital, nearbyHospitals, phoneCandidates, REASON_LABEL, CLOSE_LABEL, type Hreq, type Result } from "@/lib/engine";
import { RESPONSE_LIMIT_SEC, RADIUS_STEPS, capCount } from "@/lib/hospitals";
import { HospitalDetail } from "@/components/hospital-detail";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/request")({
  head: () => ({
    meta: [
      { title: "병원 응답 대기 · 골든타임즈" },
      { name: "description", content: "여러 응급실에 동시에 요청하고 2분 안에 승인을 받아요." },
      { property: "og:title", content: "병원 응답 대기 · 골든타임즈" },
      { property: "og:description", content: "승인 칸, 거리순 추천, 예비 추천, 확정" },
    ],
  }),
  component: RequestPage,
});

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.max(0, sec) % 60).padStart(2, "0")}`;

function RequestPage() {
  const e = useEngine();
  const nav = useNavigate();
  const [pick, setPick] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<Hreq[] | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    if (!e.status) nav({ to: "/" });
  }, [e.status, nav]);

  const t = now();
  const live = e.hreqs.filter((h) => h.status === "approved").sort((a, b) => (a.respondedAt ?? 0) - (b.respondedAt ?? 0));
  const approved = frozen ?? live;
  const nearest = [...approved].sort((a, b) => hospital(a.hospitalId).km - hospital(b.hospitalId).km)[0];
  const cur = e.hreqs.filter((h) => h.round === e.round);
  const waiting = cur.filter((h) => h.status === "waiting").length;
  const rejected = cur.filter((h) => h.status === "rejected").length;
  const remain = RESPONSE_LIMIT_SEC - Math.floor((t - e.roundSentAt) / 1000);
  const fallback = e.status === "fallback";

  // 새 승인 알림 (진동)
  const seen = useRef(0);
  useEffect(() => {
    if (live.length > seen.current) {
      const n = live[live.length - 1];
      if (n) toast.success(`새 승인 · ${hospital(n.hospitalId).name}`);
      navigator.vibrate?.(300);
    }
    seen.current = live.length;
  }, [live.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (p: Promise<Result>) => { const r = await p; if (!r.ok) toast.error(r.error); return r.ok; };

  /** 병원 상세 → 전화 확인 (SFR-032) */
  const phone = (id: string) => {
    setDetail(null);
    void run(actions.startPhone(id)).then((ok) => {
      if (ok) void nav({ to: "/call/$hospitalId", params: { hospitalId: id } });
    });
  };

  // 거리순 목록: 승인 칸에 없는 병원 + 각 병원의 최근 요청 상태
  const nearby = nearbyHospitals().filter((h) => !live.some((a) => a.hospitalId === h.id)).map((h) => {
    const req = [...e.hreqs].reverse().find((r) => r.hospitalId === h.id);
    return { h, req };
  }).filter(({ h, req }) => !(e.excluded.includes(h.id) && req?.status !== "waiting"));
  const excludedNames = e.excluded.map((id) => hospital(id).name);
  const canExpand = RADIUS_STEPS.indexOf(e.radius) < RADIUS_STEPS.length - 1;
  const lastNewRadius = phoneCandidates().length;

  const subtitle = fallback
    ? `${cur.length}곳 응답 종료 · 반경 ${e.radius}km`
    : `${cur.length}곳 요청 · ${e.grade ? `${e.grade} 이상` : "모든 등급"} · 반경 ${e.radius}km`;
  const pct = Math.max(0, Math.min(1, remain / RESPONSE_LIMIT_SEC));

  return (
    <PhoneScreen
      title={fallback ? "예비 추천" : "병원 응답 대기"}
      subtitle={subtitle}
      badge={!fallback && <span className={cn("rounded-lg bg-primary/8 px-2.5 py-1.5 text-sm font-extrabold text-primary tabular-nums", remain <= 30 && "bg-destructive text-destructive-foreground")}>{mmss(Math.max(0, remain))}</span>}
      footer={
        <div className="space-y-2">
          {fallback && (canExpand ? (
            <BigButton size="lg" onClick={() => run(actions.expand())}>반경 넓혀 다시 요청 ({RADIUS_STEPS[RADIUS_STEPS.indexOf(e.radius) + 1]}km)</BigButton>
          ) : (
            <Notice tone="warn">최대 반경(40km)이에요 · 가까운 병원에 전화로 확인하세요</Notice>
          ))}
          <BigButton variant="outline" onClick={() => window.confirm("이송을 취소할까요? 열린 요청이 모두 닫혀요.") && run(actions.cancel())}>이송 취소</BigButton>
        </div>
      }
    >
      <ProgressStrip />
      {fallback && e.fallbackReason && (
        <div className="mb-4"><Notice tone="warn">{REASON_LABEL[e.fallbackReason] ?? "승인한 병원이 없어요"} · 가까운 병원에 전화로 확인하세요</Notice></div>
      )}
      {!fallback && live.length > 0 && (
        <div className="rise-in mb-3"><Notice tone="ok" icon={<BellRing className="size-4" />}>새 승인 · {hospital(live[live.length - 1]!.hospitalId).name} (진동)</Notice></div>
      )}

      {/* 승인 칸 */}
      <div
        onPointerDown={() => setFrozen(live)}
        onPointerUp={() => setFrozen(null)}
        onPointerLeave={() => setFrozen(null)}
        className={cn("rounded-xl border p-4 transition", approved.length ? "border-success/40 bg-success-soft/60 shadow-[var(--shadow-card)]" : "border-dashed border-border-strong bg-card")}
      >
        <div className="flex items-baseline justify-between gap-2">
          <h2 className={cn("flex items-center gap-2 text-lg font-extrabold tracking-tight", approved.length ? "text-success" : "text-muted-foreground")}>
            {approved.length > 0 && <CheckCircle2 className="size-5" />}
            승인 {approved.length}곳
          </h2>
          <span className="text-xs text-muted-foreground">{fallback ? "· 응답 종료" : approved.length ? "· 온 순서대로 쌓여요" : ""}</span>
        </div>
        {approved.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">승인이 오면 여기에 모여요 · 진동으로 알려요</p>
        ) : (
          <div className="mt-3 space-y-2">
            {approved.map((r) => {
              const h = hospital(r.hospitalId);
              const near = r.hospitalId === nearest?.hospitalId;
              return (
                <button key={r.hospitalId + r.round} onClick={() => setDetail(r.hospitalId)}
                  className="flex w-full items-stretch gap-3 overflow-hidden rounded-lg bg-card p-3.5 text-left shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-lift)]">
                  <span aria-hidden className={cn("w-1 shrink-0 rounded-full", near ? "bg-accent" : "bg-success")} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 font-extrabold">
                      <span className="truncate">{h.name}</span>
                      <span className="chip shrink-0 border-0 bg-surface-2 py-0.5 text-[11px]">{h.km}km</span>
                      {r.recheck && <span className="text-[11px] font-bold text-accent-deep">재확인</span>}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">약 {h.min}분 · 응급실 {h.er ?? "정보 없음"} · 진료가능 {capCount(h).available}/{capCount(h).total}</p>
                    <p className="mt-1 text-xs font-semibold text-foreground/70">{r.note ? `"${r.note}"` : "메모 없음"}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end justify-between gap-2">
                    <Pill tone="ok">{near ? "가장 가까움" : "승인"}</Pill>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {approved.length > 0 && <p className="mt-2 text-xs text-muted-foreground">👆 화면을 누르고 있는 동안에는 위치가 바뀌지 않아요. 손을 떼면 새 승인이 들어와요.</p>}

      {!fallback && (
        <div className="tile mt-3 p-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-muted-foreground uppercase"><Clock className="size-3.5" /> 남은 시간</p>
              <p className={cn("mt-1 text-3xl leading-none font-extrabold tabular-nums", remain <= 30 ? "text-destructive" : "text-foreground")}>{mmss(Math.max(0, remain))}</p>
            </div>
            <p className="text-xs font-semibold text-muted-foreground">대기 {waiting} · 거절 {rejected}</p>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className={cn("h-full rounded-full transition-[width] duration-500", remain <= 30 ? "bg-destructive" : "bg-accent")} style={{ width: `${pct * 100}%` }} />
          </div>
        </div>
      )}

      <SectionTitle hint={fallback ? "거절 · 승인 취소한 병원은 빠져요" : "기다리는 중에도 전화로 확인할 수 있어요 (요청은 열어 둬요)"}>가까운 병원 (거리순)</SectionTitle>
      <div className="space-y-2">
        {nearby.map(({ h, req }) => {
          const st = req?.status;
          const label = !req ? "요청 안 함" : st === "waiting" ? "요청함" : st === "closed" && req.closeReason ? CLOSE_LABEL[req.closeReason] : st === "expired" ? "응답 없음" : st === "delivery_failed" ? "전달 실패" : "요청함";
          const isWaiting = st === "waiting" && !fallback;
          return (
            <button
              key={h.id}
              disabled={isWaiting}
              onClick={() => setDetail(h.id)}
              className="tile flex w-full items-center gap-3 p-3.5 text-left transition hover:bg-surface disabled:opacity-60"
            >
              <IconTile tone={isWaiting ? "warn" : "accent"} className="size-9 rounded-lg"><MapPin className="size-4" /></IconTile>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 font-bold">
                  <span className="truncate">{h.name}</span>
                  <span className="chip shrink-0 border-0 bg-surface-2 py-0.5 text-[11px]">{h.km}km</span>
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">약 {h.min}분 · {h.er ? `응급실 ${h.er}` : "병상 정보 없음"} · 진료가능 {capCount(h).available}/{capCount(h).total} · {label}</p>
              </div>
              {isWaiting ? <Pill tone="wait">대기</Pill> : !h.er ? <Pill tone="neutral">병상 없음 · 전화</Pill> : <Pill tone="call"><PhoneCall className="size-3" /> 전화 확인</Pill>}
            </button>
          );
        })}
        {nearby.length === 0 && <p className="rounded-lg bg-surface px-4 py-3 text-sm text-muted-foreground">반경 안에 남은 병원이 없어요{lastNewRadius ? "" : " · 반경을 넓혀 보세요"}</p>}
      </div>
      {excludedNames.length > 0 && <p className="mt-3 text-xs text-muted-foreground">거절 · 승인 취소한 {excludedNames.join(", ")}은 목록에서 빠져요</p>}


      {pick && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-primary/45 backdrop-blur-sm sm:items-center" onClick={() => setPick(null)}>
          <div className="elevate-lg w-full max-w-[440px] rounded-t-2xl bg-card p-5 pb-8 sm:rounded-2xl sm:pb-5" onClick={(ev) => ev.stopPropagation()}>
            <span aria-hidden className="mx-auto mb-4 block h-1 w-10 rounded-full bg-border-strong sm:hidden" />
            <h3 className="text-lg font-extrabold tracking-tight">{hospital(pick).name}으로 확정할까요?</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">약 {hospital(pick).min}분 · {hospital(pick).km}km</p>
            <p className="mt-2 text-sm text-muted-foreground">확정하면 다른 병원 요청은 닫혀요</p>
            <div className="mt-5 flex gap-2">
              <BigButton variant="outline" onClick={() => setPick(null)}>취소</BigButton>
              <BigButton variant="success" onClick={() => { void run(actions.confirm(pick)); setPick(null); }}>확정</BigButton>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <HospitalDetail
          h={hospital(detail)}
          approved={live.some((r) => r.hospitalId === detail)}
          note={[...e.hreqs].reverse().find((r) => r.hospitalId === detail)?.note}
          onClose={() => setDetail(null)}
          onConfirm={() => { setPick(detail); setDetail(null); }}
          onPhone={() => phone(detail)}
        />
      )}
    </PhoneScreen>
  );
}
