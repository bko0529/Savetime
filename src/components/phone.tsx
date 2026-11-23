import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 심전도선: 머리글을 가로지르는 생명선 — 흐르듯 그어졌다 사라짐 */
export function EcgLine({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 220 40" fill="none" className={cn("pointer-events-none", className)}>
      <path
        d="M0 22 H52 L62 22 68 10 74 32 80 4 87 36 93 22 H128 L136 22 141 15 146 27 151 22 H220"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="ecg-flow"
      />
    </svg>
  );
}

/**
 * 구급대원 앱 한 화면: 남색 머리(그라디언트) + 내용 + 아래 고정 버튼.
 * 모든 화면이 이 뼈대를 쓰므로 여기서 색·그림자·여백을 정리하면 전체가 같이 바뀐다.
 */
export function PhoneScreen({
  title,
  subtitle,
  children,
  footer,
  dim,
  badge,
  accent = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  dim?: boolean;
  /** 머리글 오른쪽에 얹는 작은 표시 (상태 · 시간 등) */
  badge?: ReactNode;
  /** 긴급·주의 화면: 머리를 신호색으로 */
  accent?: boolean;
}) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[440px] flex-col bg-background">
      <header
        className={cn(
          "surface-header relative overflow-hidden border-b border-border/50 px-5 pb-7 pt-6",
          accent ? "bg-[image:var(--gradient-accent)] text-primary-foreground" : "text-foreground",
          dim && "opacity-60",
        )}
      >
        {/* 머리글 안 빛 두 개 + 생명선 */}
        <span aria-hidden className="pointer-events-none absolute -right-12 -top-20 size-52 rounded-full bg-accent/15 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute -left-16 top-2 size-36 rounded-full bg-primary/6 blur-3xl" />
        <EcgLine className={cn("absolute -right-4 bottom-1 w-44", accent ? "text-primary-foreground/30" : "text-accent/45")} />
        <div className="relative flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[23px] leading-tight font-extrabold tracking-[-0.02em]">{title}</h1>
            {subtitle && <p className={cn("mt-1.5 text-sm leading-snug", accent ? "text-primary-foreground/70" : "text-muted-foreground")}>{subtitle}</p>}
          </div>
          {badge && <div className="shrink-0 pt-0.5">{badge}</div>}
        </div>
      </header>

      <main className="flex-1 px-5 pb-12 pt-6">{children}</main>

      {footer && (
        <footer className="sticky bottom-0 z-30 border-t border-border/60 bg-card/80 px-5 pb-[max(1.15rem,env(safe-area-inset-bottom))] pt-3.5 backdrop-blur-xl">
          {footer}
        </footer>
      )}
    </div>
  );
}

/** 구역 제목: 작게 빼고 아래 칸과 선으로 묶음 */
export function SectionTitle({ children, hint, action }: { children: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-8 mb-3 first:mt-0">
      <div className="flex items-end justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[15px] font-extrabold tracking-[-0.01em] text-foreground">
          <span className="h-3.5 w-[3.5px] shrink-0 rounded-full bg-accent shadow-[var(--shadow-accent)]" />
          {children}
        </h2>
        {action}
      </div>
      {hint && <p className="mt-1.5 pl-[11px] text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="mb-1.5 block text-[11px] font-bold tracking-wide text-muted-foreground uppercase">{children}</span>;
}

type Tone = "wait" | "call" | "ok" | "neutral" | "danger";
const toneCls: Record<Tone, string> = {
  wait: "bg-warning-soft text-warning border-warning/25",
  call: "bg-accent-soft text-accent-deep border-accent/25",
  ok: "bg-success-soft text-success border-success/25",
  neutral: "bg-surface-2 text-muted-foreground border-border",
  danger: "bg-destructive/10 text-destructive border-destructive/25",
};
/** 상태 표시: 점이 같이 가서 색만 봐도 읽힘 */
export function Pill({ tone, children, dot = true, className }: { tone: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold tracking-[-0.01em]",
        toneCls[tone],
        className,
      )}
    >
      {dot && <span aria-hidden className={cn("size-1.5 rounded-full bg-current", tone === "call" && "heartbeat")} />}
      {children}
    </span>
  );
}

const noticeCls = {
  warn: "bg-warning-soft text-warning border-warning/30",
  ok: "bg-success-soft text-success border-success/30",
  info: "bg-info-soft text-secondary-foreground border-border-strong/60",
} as const;

/** 안내: 왼쪽에 신호 줄 */
export function Notice({ tone, children, icon }: { tone: "warn" | "ok" | "info"; children: ReactNode; icon?: ReactNode }) {
  return (
    <div className={cn("flex items-start gap-2.5 overflow-hidden rounded-lg border px-3.5 py-3 text-sm font-semibold", noticeCls[tone])}>
      {icon ? <span className="mt-px shrink-0">{icon}</span> : <span aria-hidden className="mt-1 size-2 shrink-0 rounded-full bg-current" />}
      <span className="flex-1 leading-relaxed">{children}</span>
    </div>
  );
}

const btnV = {
  primary: "btn-solid-primary text-primary-foreground",
  outline: "border border-border-strong bg-card text-foreground hover:bg-surface",
  success: "btn-solid-success text-success-foreground",
  danger: "bg-destructive text-destructive-foreground shadow-[var(--shadow-accent)]",
  accent: "btn-solid-accent text-accent-foreground",
  ghost: "text-muted-foreground hover:bg-surface",
} as const;

export function BigButton({
  variant = "primary",
  className,
  size = "md",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "success" | "danger" | "accent" | "ghost";
  size?: "sm" | "md" | "lg";
}) {
  const h = { sm: "h-10 text-sm", md: "h-12 text-[15px]", lg: "h-14 text-base" }[size];
  return (
    <button
      className={cn(
        "inline-flex w-full items-center justify-center gap-1.5 rounded-2xl font-bold tracking-[-0.01em] transition",
        "active:translate-y-px active:scale-[0.99] disabled:cursor-not-allowed disabled:shadow-none",
        variant === "outline" && "disabled:border-border disabled:bg-surface disabled:text-muted-foreground/60",
        variant === "primary" && "disabled:bg-muted disabled:text-muted-foreground/50",
        (variant === "accent" || variant === "success") && "disabled:opacity-45",
        h,
        btnV[variant],
        className,
      )}
      {...props}
    />
  );
}

/** 두 개 이상 맞붙는 선택 (팀 만들기/참여, 역할 고르기) */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  className?: string;
}) {
  return (
    <div className={cn("flex gap-1 rounded-2xl border border-border/70 bg-surface-2 p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "flex-1 rounded-lg px-3 py-2.5 text-sm font-bold transition",
            value === o.value ? "bg-card text-foreground shadow-[var(--shadow-card)]" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 이름 두 글자만 넣은 원 (팀원 · 대원 목록) */
export function Avatar({ name, tone = "ink", className }: { name: string; tone?: "ink" | "accent" | "muted"; className?: string }) {
  const t = { ink: "bg-primary text-primary-foreground", accent: "bg-accent-soft text-accent-deep", muted: "bg-surface-2 text-muted-foreground" }[tone];
  return (
    <span className={cn("grid size-10 shrink-0 place-items-center rounded-2xl text-sm font-extrabold shadow-[var(--shadow-card)]", t, className)}>
      {name.slice(0, 2)}
    </span>
  );
}

/** 카드 안 머리 아이콘 (권한 · 초대 · 기록) */
export function IconTile({ children, tone = "accent", className }: { children: ReactNode; tone?: "accent" | "ink" | "warn" | "ok"; className?: string }) {
  const t = {
    accent: "bg-accent-soft text-accent-deep",
    ink: "bg-primary/8 text-primary",
    warn: "bg-warning-soft text-warning",
    ok: "bg-success-soft text-success",
  }[tone];
  return <span className={cn("grid size-11 shrink-0 place-items-center rounded-2xl", t, className)}>{children}</span>;
}

/** 3단계 입력 같은 진행 점 ( patient 화면 ) */
export function StepDots({ step, total, onJump }: { step: number; total: number; onJump?: (s: number) => void }) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: total }, (_, i) => i + 1).map((s) => (
        <button
          key={s}
          onClick={() => onJump?.(s)}
          aria-label={`${s}단계`}
          className={cn(
            "h-1.5 flex-1 rounded-full transition",
            s === step ? "bg-accent shadow-[var(--shadow-accent)]" : s < step ? "bg-primary/70" : "bg-border-strong",
          )}
        />
      ))}
    </div>
  );
}

/** 카드 안의 값 한 줄 (설정 · 신청 내역) */
export function KeyVal({ label, value, tone = "default" }: { label: ReactNode; value: ReactNode; tone?: "default" | "danger" }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3.5">
      <span className={cn("text-sm", tone === "danger" ? "font-bold text-destructive" : "text-muted-foreground")}>{label}</span>
      <span className={cn("text-right text-sm font-bold", tone === "danger" ? "text-destructive" : "text-foreground")}>{value}</span>
    </div>
  );
}

/** 골든타임즈 심볼: 스톱워치 선이 십자 가로획이 되고, 빨간 세로획이 십자를 완성 (로고 가이드 색 고정) */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" strokeLinecap="round" aria-label="골든타임즈" className={className}>
      <path d="M24 14A14 14 0 1 1 10 28H31M20 7.5H28M24 7.5V14" stroke="#14284B" strokeWidth="4.5" />
      <path d="M24 21V35" stroke="#E60012" strokeWidth="4.5" />
    </svg>
  );
}
