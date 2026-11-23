import { useEffect } from "react";
import { X, Phone, BedDouble, Stethoscope, ShieldAlert, CheckCircle2 } from "lucide-react";
import { BigButton, Pill } from "@/components/phone";
import { bedAvail, capCount, type Hospital } from "@/lib/hospitals";
import { loadHospitalDetail } from "@/lib/engine";
import { cn } from "@/lib/utils";

/**
 * S-07 병원 상세 (SFR-007): 진료과 · 연락처(직통/대표) · 병상 현황(응급실/중환자실/수술실) ·
 * 중증질환 진료가능 항목(공공 데이터 표기 그대로)을 한 화면에 보여 준다.
 */
export function HospitalDetail({
  h,
  approved,
  note,
  onClose,
  onConfirm,
  onPhone,
}: {
  h: Hospital;
  /** 승인 칸의 병원인가 (확정 버튼 표시) */
  approved?: boolean;
  /** 병원 메모 · 승인 취소 사유 등 */
  note?: string | undefined;
  onClose: () => void;
  /** '이 병원으로 확정' (SFR-111 확인은 부르는 쪽에서) */
  onConfirm?: () => void;
  /** 전화 확인 (SFR-032) */
  onPhone?: () => void;
}) {
  // 열 때 서버에서 진료과·진료가능 항목·대표 전화를 읽어 채운다 (SFR-007)
  useEffect(() => {
    if (h.id) void loadHospitalDetail(h.id);
  }, [h.id]);
  const cc = capCount(h);
  const beds = [
    { k: "응급실", v: h.er },
    { k: "중환자실", v: h.icu },
    { k: "수술실", v: h.or },
  ];
  const noBed = !h.er && !h.icu && !h.or;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-primary/45 backdrop-blur-sm" onClick={onClose}>
      <div
        className="elevate-lg max-h-[92vh] w-full max-w-[440px] overflow-y-auto rounded-t-2xl bg-card pb-8"
        onClick={(ev) => ev.stopPropagation()}
      >
        <span aria-hidden className="sticky top-0 z-10 block bg-card pt-3 pb-1">
          <span className="mx-auto block h-1 w-10 rounded-full bg-border-strong" />
        </span>

        <div className="flex items-start justify-between gap-3 px-5">
          <div className="min-w-0">
            <h3 className="text-xl font-extrabold tracking-tight">{h.name}</h3>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              <span className="chip border-0 bg-surface-2 py-0.5 text-[11px]">{h.km}km</span>
              <span className="chip border-0 bg-surface-2 py-0.5 text-[11px]">약 {h.min}분</span>
              <span className="truncate">{h.grade}</span>
            </p>
          </div>
          <button aria-label="닫기" onClick={onClose} className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-border">
            <X className="size-5" />
          </button>
        </div>
        {note && <p className="mx-5 mt-3 rounded-lg bg-info-soft px-3.5 py-2.5 text-sm font-semibold">{note}</p>}

        <div className="space-y-3 px-5 pt-4">
          {/* 병상 3종 분리 표시 (SFR-007) */}
          <div className="tile p-4">
            <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
              <BedDouble className="size-3.5" /> 병상 현황
            </p>
            <div className="mt-2.5 grid grid-cols-3 gap-2">
              {beds.map((b) => {
                const a = bedAvail(b.v);
                return (
                  <div key={b.k} className="well rounded-lg px-2 py-3 text-center">
                    <p className="text-[11px] text-muted-foreground">{b.k}</p>
                    <p className={cn("mt-1 text-lg leading-none font-extrabold tabular-nums", a === 0 && "text-destructive")}>
                      {a === null ? <span className="text-xs">정보 없음</span> : b.v}
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="mt-2.5 text-xs text-muted-foreground">
              {noBed ? "이 병원은 병상 정보가 없어요 · 전화로 확인하세요" : `참고용 정보 · 병상 기준 ${h.bedsAt}`}
            </p>
          </div>

          {/* 중증질환 진료가능 항목 (SFR-007·011) */}
          <div className="tile p-4">
            <p className="flex items-center justify-between text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
              <span className="flex items-center gap-1.5"><Stethoscope className="size-3.5" /> 중증질환 진료가능 항목</span>
              <span className="text-sm font-extrabold tracking-normal text-foreground tabular-nums">{cc.available}/{cc.total}</span>
            </p>
            {h.caps.length === 0 && cc.total > 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">불러오는 중…</p>
            ) : h.caps.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">공공 데이터에 없는 병원이에요 · 전화로 확인해야 알 수 있어요</p>
            ) : (
              <ul className="mt-2.5 space-y-1">
                {h.caps.map((c) => (
                  <li key={c.name} className="flex items-center justify-between gap-2 rounded-md px-1 py-1.5 text-sm odd:bg-surface/70">
                    <span className={cn(c.available ? "font-bold" : "text-muted-foreground line-through")}>{c.name}</span>
                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-extrabold", c.available ? "bg-success-soft text-success" : "bg-surface-2 text-muted-foreground")}>
                      {c.available ? "가능" : "불가"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 진료과 */}
          <div className="tile p-4">
            <p className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">진료과</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {h.depts.map((d) => (
                <span key={d} className="chip border-0 bg-surface-2">{d}</span>
              ))}
            </div>
          </div>

          {/* 연락처 · 전화하기 */}
          <div className="tile p-4">
            <p className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">연락처</p>
            <a href={`tel:${h.erPhone}`} className="btn-solid-accent mt-2.5 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[15px] font-bold text-accent-foreground">
              <Phone className="size-4.5" /> 응급실 직통 {h.erPhone}
            </a>
            {h.mainPhone && <a href={`tel:${h.mainPhone}`} className="tile mt-2 flex h-12 w-full items-center justify-center gap-2 px-4 text-[15px] font-bold transition hover:bg-surface">
              <Phone className="size-4.5 text-muted-foreground" /> 대표 {h.mainPhone}
            </a>}
          </div>

          <div className="space-y-2 pt-1">
            {approved && onConfirm && <BigButton variant="success" size="lg" className="text-lg" onClick={onConfirm}><CheckCircle2 className="size-5" /> 이 병원으로 확정</BigButton>}
            {onPhone && <BigButton variant={approved ? "outline" : "accent"} size="lg" className="text-lg" onClick={onPhone}><Phone className="size-5" /> 전화 확인</BigButton>}
          </div>

          <p className="flex items-start gap-1.5 pt-1 text-xs leading-relaxed text-muted-foreground">
            <ShieldAlert className="mt-px size-3.5 shrink-0" />
            병상 · 진료가능 항목은 공공 응급의료 데이터 기준으로, 실제와 다를 수 있어요.
          </p>
        </div>
      </div>
    </div>
  );
}
