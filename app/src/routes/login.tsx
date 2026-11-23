import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { UserPlus, ChevronRight } from "lucide-react";
import { BigButton, Label, Notice, EcgLine, LogoMark } from "@/components/phone";
import { useAuth } from "@/lib/auth-store";
import { login } from "@/lib/auth-server";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "로그인 · 골든타임즈 구급대원" },
      { name: "description", content: "119 구급대원 전용 로그인. 근무 중에는 다시 묻지 않아요." },
      { property: "og:title", content: "로그인 · 골든타임즈" },
      { property: "og:description", content: "병원 승인 후 출발하는 이송" },
    ],
  }),
  component: Login,
});

/** SFR-018: 아이디/비밀번호. 로그인은 근무 동안 유지, 근무 종료 때 끝남 (자동 로그인 · 앱 잠금 없음) */
function Login() {
  useAuth();
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // 서버가 확인한다. 5번 틀리면 서버가 10분 잠그고 그 문구를 돌려준다 (SER-011)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr((await login(id, pw)) ?? "");
    setBusy(false);
  };

  return (
    <div className="surface-header relative mx-auto flex min-h-screen w-full max-w-[440px] flex-col overflow-hidden px-6 pb-8 pt-14 text-foreground">
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-10 size-64 rounded-full bg-accent/15 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute -left-20 top-40 size-56 rounded-full bg-primary/6 blur-3xl" />
      <EcgLine className="absolute right-0 top-24 w-52 text-accent/40" />

      <div className="relative flex flex-1 flex-col">
        <span className="grid size-16 place-items-center rounded-2xl bg-card shadow-[var(--shadow-card)]"><LogoMark className="size-11" /></span>
        <p className="mt-6 text-[11px] font-bold tracking-[0.18em] text-accent-deep uppercase">119 구급대원 전용</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight">골든타임즈</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">병원 승인 후 출발하는 이송</p>

        <form onSubmit={submit} className="elevate-lg mt-9 space-y-3.5 rounded-2xl bg-card p-5 text-card-foreground">
          <div><Label>아이디</Label><input className="field" value={id} onChange={(e) => setId(e.target.value)} placeholder="kimdoyun" autoComplete="username" autoCapitalize="none" /></div>
          <div><Label>비밀번호</Label><input className="field" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" autoComplete="current-password" /></div>
          {err && <Notice tone="warn">{err}</Notice>}
          <BigButton size="lg" type="submit" className="mt-1" disabled={busy}>{busy ? "확인 중…" : "로그인"}</BigButton>
          <p className="text-center text-xs text-muted-foreground">근무 중에는 앱을 다시 열어도 로그인을 묻지 않아요</p>
        </form>

        <Link to="/signup" className="tile mt-4 flex items-center gap-3 p-4 transition hover:bg-surface">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-deep"><UserPlus className="size-5" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-bold">처음이세요? 가입 신청</p>
            <p className="mt-0.5 text-xs text-muted-foreground">이름 · 소속 소방서 · 공무원증으로 신청해요</p>
          </div>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>

        <div className="mt-auto pt-8">
          <p className="text-center text-xs text-muted-foreground">
            비밀번호를 잊으면 소속 관리자에게 초기화를 요청하세요 · 5번 틀리면 10분 동안 잠겨요
          </p>
        </div>
      </div>
    </div>
  );
}
