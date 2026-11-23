import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Smartphone, Hospital, ShieldCheck, Monitor, X } from "lucide-react";

// 시연용: 구급대원 앱과 병원·관리자 웹 화면을 바로 오가는 고정 버튼
const items = [
  { to: "/", label: "구급대원 앱", icon: Smartphone, match: (p: string) => !/^\/(hospital|admin|web)(\/|$)/.test(p) },
  { to: "/hospital/design-preview", label: "병원 웹", icon: Hospital, match: (p: string) => p.startsWith("/hospital") },
  { to: "/admin/login", label: "관리자 웹", icon: ShieldCheck, match: (p: string) => p.startsWith("/admin") },
] as const;

export function PreviewSwitcher() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  return (
    <div className="fixed right-3 top-1/2 z-[100] flex -translate-y-1/2 flex-col items-end gap-2">
      {open && (
        <nav aria-label="화면 전환" className="flex flex-col gap-1 rounded-2xl border border-border bg-card/95 p-1.5 shadow-lg backdrop-blur">
          {items.map(({ to, label, icon: Icon, match }) => {
            const active = match(path);
            return (
              <Link
                key={to}
                to={to}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-semibold transition ${
                  active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted"
                }`}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            );
          })}
        </nav>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "화면 전환 닫기" : "웹 화면 보기"}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-primary px-3 py-2 text-xs font-bold text-primary-foreground shadow-lg transition hover:opacity-90"
      >
        {open ? <X className="size-4" /> : <Monitor className="size-4" />}
        {open ? "닫기" : "웹 보기"}
      </button>
    </div>
  );
}
