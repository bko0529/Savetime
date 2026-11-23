import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { QrCode, Search, UserPlus, LogOut, BellRing, Clock, Users } from "lucide-react";
import { PhoneScreen, BigButton, Label, Notice, SectionTitle, Pill, Segmented, Avatar, IconTile } from "@/components/phone";
import { useAuth, getAuth, currentAccount, TEAM_MAX, INVITE_MS, driverTaken, type Role } from "@/lib/auth-store";
import {
  createTeam, joinTeam, startDuty, setMyRole, listColleagues, sendInvite, type OnDuty,
} from "@/lib/auth-server";
import { leave } from "@/lib/duty";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/duty")({
  head: () => ({
    meta: [
      { title: "근무 시작 · 골든타임즈" },
      { name: "description", content: "4자리 팀 코드 · QR · 대원 목록으로 오늘의 팀을 맺고 운전 · 처치 역할을 나눠요." },
      { property: "og:title", content: "근무 시작 · 골든타임즈" },
      { property: "og:description", content: "근무마다 팀 맺기, 운전은 팀에 1명" },
    ],
  }),
  component: DutyPage,
});

/**
 * SFR-113 · 159: 팀 만들기(4자리 코드 · QR · 목록 초대) 또는 참여(코드 · QR). 팀은 최대 4명, 운전은 1명.
 * 팀은 서버가 만든다: '팀 코드 만들기'를 누르면 서버에 팀이 생기고 코드·QR 이 나온다 → 팀원이 코드로 들어오거나 초대를 수락하면
 * 실시간으로 목록에 나타난다 → '근무 시작'을 누르면 홈으로. 역할은 각자 자기 것만 바꾼다 (운전 1명은 서버가 지킨다).
 * 서버에서 팀을 나오는 것 = 근무 종료 = 로그아웃이라, 팀이 생긴 뒤에는 만들기 ↔ 참여를 바꿀 수 없다
 */
function DutyPage() {
  const a = useAuth();
  const me = currentAccount(a);
  const duty = a.duty;
  const [mode, setMode] = useState<"new" | "join">(duty && !duty.isCreator ? "join" : "new");
  const [code, setCode] = useState("");
  const [role, setRole] = useState<Role>(duty?.role ?? "처치");
  const [sent, setSent] = useState<Record<number, number>>({}); // paramedicId → 보낸 시각
  const [pool, setPool] = useState<OnDuty[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);


  // 같은 소방서 대원 목록 (근무 중 먼저, 이름으로 검색하면 소방서 전체). 입력을 멈추고 0.3초 뒤에 읽는다
  useEffect(() => {
    if (mode !== "new" || !a.duty) return;
    const t = setTimeout(() => {
      listColleagues(q).then(setPool).catch(() => setPool([]));
    }, 300);
    return () => clearTimeout(t);
  }, [q, mode, a.duty, a.duty?.members.length]);

  if (!me) return null;
  const members = duty?.members ?? [];
  const teamCode = duty?.teamCode ?? "";
  const pending = Object.entries(sent).filter(([id, at]) => now - at < INVITE_MS && !members.some((m) => m.loginId === id));
  const full = members.length + 1 + (mode === "new" ? pending.length : 0) >= TEAM_MAX;
  const myDriverBlocked = driverTaken(members);

  const switchMode = (m: "new" | "join") => {
    if (m === mode) return;
    // 팀에서 나오면 서버가 근무를 끝낸다(로그아웃). 그래서 팀이 생긴 뒤에는 바꿀 수 없다
    if (a.duty) return setErr("이미 팀이 있어요. 다른 팀으로 가려면 로그아웃한 뒤 다시 로그인하세요");
    setErr("");
    setMode(m);
  };

  const make = async () => {
    setBusy(true);
    setErr((await createTeam(role)) ?? "");
    setBusy(false);
  };

  const join = async (c: string) => {
    if (!/^\d{4}$/.test(c)) return setErr("팀원 화면의 4자리 코드를 입력해 주세요");
    setBusy(true);
    const e = await joinTeam({ code: c }, role);
    setBusy(false);
    setErr(e ?? "");
    if (!e) setRole(getAuth().duty?.role ?? role);
  };

  const invite = async (p: OnDuty) => {
    if (full) return setErr(`팀은 최대 ${TEAM_MAX}명이에요`);
    const e = await sendInvite(p.paramedicId);
    if (e) return setErr(e);
    setErr("");
    setSent((l) => ({ ...l, [p.paramedicId]: Date.now() }));
  };

  const pickMyRole = async (r: Role) => {
    if (r === "운전" && myDriverBlocked) return setErr("이미 운전 대원이 있어요. 운전은 팀에 1명이에요");
    setErr("");
    setRole(r);
    if (a.duty) {
      const e = await setMyRole(r);
      if (e) { setErr(e); setRole(a.duty.role); }
    }
  };

  // 팀원 없이 바로 시작해도 된다: 팀이 없으면 만들고 시작
  const start = async () => {
    if (mode === "join" && !a.duty) return setErr("팀 코드를 입력하거나 QR을 스캔해 주세요");
    if (!a.duty) {
      setBusy(true);
      const e = await createTeam(role);
      setBusy(false);
      if (e) return setErr(e);
    }
    startDuty();
  };

  // 이미 우리 팀인 대원은 위 '오늘의 팀'에 있으니 목록에서 뺀다
  const others = pool.filter((c) => !members.some((m) => m.loginId === String(c.paramedicId)));
  const shown = q.trim() ? others : others.filter((c) => c.onDuty);

  return (
    <PhoneScreen
      title="근무 시작"
      subtitle={`${me.name} ${me.rank} · ${me.orgName} ${me.center}`}
      badge={<Pill tone="neutral" dot={false} className="bg-primary/8 text-primary">{members.length + 1}/{TEAM_MAX}명</Pill>}
      footer={
        <div className="space-y-2">
          <BigButton size="lg" onClick={() => void start()} disabled={busy}>{mode === "new" ? "팀 만들고 근무 시작" : "이 팀으로 근무 시작"}</BigButton>
          <button className="flex w-full items-center justify-center gap-1.5 py-1 text-sm font-semibold text-muted-foreground" onClick={() => void leave("logout")}><LogOut className="size-4" /> 로그아웃</button>
        </div>
      }
    >
      {a.incoming.length > 0 && (
        <Link to="/invite" className="tile mb-4 flex items-center gap-3 border-2 border-accent bg-accent-soft p-4 shadow-[var(--shadow-accent)]">
          <IconTile tone="accent" className="bg-accent text-accent-foreground"><BellRing className="size-5" /></IconTile>
          <div className="min-w-0 flex-1">
            <p className="font-extrabold">팀 초대 {a.incoming.length}건 · 확인</p>
            <p className="mt-0.5 truncate text-xs text-accent-deep/85">{a.incoming.map((i) => `${i.from.name} 대원 · 팀 ${i.teamCode}`).join(", ")} · 5분 안에 수락해야 들어갈 수 있어요</p>
          </div>
        </Link>
      )}

      <Segmented
        value={mode}
        onChange={(m) => switchMode(m)}
        options={[{ value: "new", label: "팀 만들기" }, { value: "join", label: "팀 참여" }]}
      />

      {mode === "new" ? (
        <div className="tile mt-4 flex items-center gap-4 p-4">
          <div className="well shrink-0 rounded-xl p-2.5">
            {duty ? <QRCodeSVG value={`savetime:team:${duty.qrToken}`} size={92} /> : <div className="size-[92px]" />}
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">팀원에게 코드나 QR을 보여 주세요</p>
            {teamCode ? (
              <p className="mt-1 text-4xl leading-none font-extrabold tracking-[0.22em] tabular-nums">{teamCode}</p>
            ) : (
              <button disabled={busy} onClick={() => void make()} className="btn-solid-primary mt-2 rounded-xl px-4 py-2.5 text-sm font-extrabold text-primary-foreground disabled:opacity-50">팀 코드 만들기</button>
            )}
            <p className="mt-2 text-xs text-muted-foreground">{teamCode ? "팀원이 없어도 바로 시작할 수 있어요" : "코드를 만들어야 팀원이 들어오고 초대할 수 있어요"}</p>
          </div>
        </div>
      ) : duty ? (
        <div className="mt-4"><Notice tone="ok">팀 {duty.teamCode}에 참여했어요</Notice></div>
      ) : (
        <div className="mt-4">
          <Label>팀원이 보여준 4자리 팀 코드</Label>
          <div className="flex gap-2">
            <input className="field flex-1 text-center text-2xl font-extrabold tracking-[0.4em] tabular-nums" inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="4821" />
            <button disabled={busy} className="btn-solid-primary shrink-0 rounded-xl px-5 font-extrabold text-primary-foreground disabled:opacity-50" onClick={() => void join(code)}>참여</button>
          </div>
          <button className="tile mt-2 flex w-full items-center justify-center gap-2 p-3 text-sm font-bold transition hover:bg-surface" onClick={() => toast("QR 스캔은 준비 중이에요. 4자리 코드를 입력해 주세요")}>
            <QrCode className="size-5 text-accent-deep" /> QR 스캔으로 참여
          </button>
          <p className="mt-1.5 text-xs text-muted-foreground">카메라 권한은 QR 스캔할 때 물어요</p>
        </div>
      )}

      <SectionTitle hint={`최대 ${TEAM_MAX}명 · 운전은 1명 (운전 폰은 주행 중 입력 잠금)`}>
        <span className="inline-flex items-center gap-1.5"><Users className="size-4" /> 오늘의 팀 ({members.length + 1}명)</span>
      </SectionTitle>
      <div className="tile divide-y divide-border">
        <div className="flex items-center gap-3 px-4 py-3">
          <Avatar name={me.name} tone="accent" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold">{me.name} <span className="text-xs font-semibold text-muted-foreground">나</span></p>
            <p className="truncate text-xs text-muted-foreground">{me.rank} · {me.center}</p>
          </div>
          <RolePick value={duty?.role ?? role} onChange={(r) => void pickMyRole(r)} driverOff={myDriverBlocked} />
        </div>
        {members.map((m) => (
          <div key={m.loginId} className="flex items-center gap-3 px-4 py-3">
            <Avatar name={m.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold">{m.name}</p>
              <p className="truncate text-xs text-muted-foreground">{m.rank}</p>
            </div>
            <Pill tone="neutral" dot={false}>{m.role}</Pill>
          </div>
        ))}
        {mode === "new" && pending.map(([id, at]) => {
          const c = pool.find((x) => String(x.paramedicId) === id);
          const left = Math.max(0, INVITE_MS - (now - at));
          return (
            <div key={id} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={c?.name ?? "?"} tone="muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold text-muted-foreground">{c?.name ?? "초대한 대원"}</p>
                <p className="truncate text-xs text-muted-foreground">초대 보냄 · 수락 대기</p>
              </div>
              <span className="chip shrink-0"><Clock className="size-3" />{Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}</span>
            </div>
          );
        })}
        {members.length === 0 && pending.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">아직 팀원이 없어요. 아래 목록에서 초대하거나 바로 시작할 수 있어요.</p>
        )}
      </div>

      {mode === "new" && (
        <>
          <SectionTitle hint="지금 근무 중인 우리 소방서 대원이 먼저 보여요. 없으면 이름으로 찾으세요">대원 목록에서 초대</SectionTitle>
          <div className="relative">
            <Search className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input className="field pl-10" value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름으로 소방서 전체 검색" />
          </div>
          <div className="tile mt-2 divide-y divide-border">
            {shown.length === 0 && <p className="px-4 py-4 text-sm text-muted-foreground">{q.trim() ? "찾는 대원이 없어요" : "지금 근무 중인 대원이 없어요. 이름으로 찾아보세요"}</p>}
            {shown.map((c) => {
              const wasSent = c.inviteStatus === "sent" || pending.some(([id]) => id === String(c.paramedicId));
              return (
                <div key={c.paramedicId} className="flex items-center gap-3 px-4 py-3">
                  <Avatar name={c.name} tone={c.onDuty ? "ink" : "muted"} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold">{c.name} <span className="text-xs font-semibold text-muted-foreground">{c.rank} · 사번 끝 {c.employeeNoTail}</span></p>
                    <p className="truncate text-xs text-muted-foreground">{c.safetyCenter}{c.onDuty ? " · 근무 중" : ""}{c.myMemo ? ` · ${c.myMemo}` : ""}</p>
                  </div>
                  {c.inTeam ? <Pill tone="neutral" dot={false}>다른 팀</Pill> : wasSent ? <Pill tone="wait">보냄</Pill> : (
                    <button disabled={full || !duty} onClick={() => void invite(c)} className="chip chip-on shrink-0 cursor-pointer disabled:opacity-40"><UserPlus className="size-3.5" /> 초대</button>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">초대받은 대원이 '수락'해야 팀원이 돼요. 초대는 5분 뒤 만료돼요.</p>
        </>
      )}

      {err && <div className="mt-4"><Notice tone="warn">{err}</Notice></div>}
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">근무를 마치거나 로그아웃하면 나만 팀에서 빠져요. 근무 시작 후 14시간이 지나면 자동으로 근무가 끝나요.</p>
    </PhoneScreen>
  );
}

function RolePick({ value, onChange, driverOff }: { value: Role; onChange: (r: Role) => void; driverOff: boolean }) {
  return (
    <div className="flex shrink-0 gap-1 rounded-lg border border-border bg-surface-2 p-1">
      {(["처치", "운전"] as const).map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          disabled={r === "운전" && driverOff && value !== "운전"}
          className={cn(
            "rounded-md px-2.5 py-1.5 text-xs font-bold transition disabled:opacity-35",
            value === r ? "bg-card text-accent-deep shadow-[var(--shadow-card)]" : "text-muted-foreground",
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}
