import { useEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Ambulance, X, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useAuth, getAuth, setAuth, expiredInvites, type Incoming } from "@/lib/auth-store";

/**
 * SFR-159 · SFR-130: 팀 초대가 오면 폰 위 '팀 초대' 알림 배너(진동)로 알리고,
 * 탭하면 /invite 화면으로 들어간다. 초대는 5분 뒤 만료 처리. 초대 자체는 서버가 실시간으로 보낸다.
 */
export function InvitePush() {
  const a = useAuth();
  const nav = useNavigate();
  const path = useRouterState({ select: (r) => r.location.pathname });
  const [banner, setBanner] = useState<Incoming | null>(null);
  const seen = useRef<Set<string>>(new Set());

  // 초대는 서버 실시간 이벤트(team.invited)로 온다 (auth-server.ts)


  // 새 초대 도착 → 배너 + 진동, 6초 뒤 자동 숨김
  useEffect(() => {
    const fresh = a.incoming.find((i) => !seen.current.has(i.id));
    if (!fresh) return;
    seen.current.add(fresh.id);
    setBanner(fresh);
    try {
      navigator.vibrate?.([120, 60, 120]);
    } catch {
      /* 폰이 아니면 진동 없음 */
    }
    const t = setTimeout(() => setBanner((b) => (b && b.id === fresh.id ? null : b)), 6000);
    return () => clearTimeout(t);
  }, [a.incoming]);

  // 만료 정리: 5분 지난 초대는 지우고 안내
  useEffect(() => {
    const t = setInterval(() => {
      const patch = expiredInvites(getAuth());
      if (patch) {
        setAuth(patch);
        toast("초대가 만료됐어요");
      }
    }, 2000);
    return () => clearInterval(t);
  }, []);

  if (!banner) return null;

  return (
    <div className="push-in fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3">
      <div className="elevate-lg flex w-full max-w-[420px] items-center gap-3 overflow-hidden rounded-2xl border border-border bg-card/95 py-3 pr-2 pl-3 backdrop-blur-md">
        <span className="btn-solid-primary grid size-10 shrink-0 place-items-center rounded-xl text-primary-foreground"><Ambulance className="size-5" /></span>
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => {
            setBanner(null);
            nav({ to: "/invite" });
          }}
        >
          <p className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="font-extrabold text-foreground">골든타임즈</span>
            <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-accent" />지금</span>
          </p>
          <p className="mt-0.5 truncate text-sm font-bold">{banner.from.name} 대원이 팀 {banner.teamCode}에 초대했어요</p>
          <p className="truncate text-xs text-muted-foreground">5분 안에 수락해야 팀에 들어갈 수 있어요</p>
        </button>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        <button aria-label="알림 닫기" className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface" onClick={() => setBanner(null)}>
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
