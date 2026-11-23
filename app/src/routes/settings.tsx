import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PhoneScreen, BigButton, SectionTitle, Notice, KeyVal, Pill } from "@/components/phone";
import { toast } from "sonner";
import { useAuth, resetAuth, currentAccount, isIOS } from "@/lib/auth-store";
import { actions } from "@/lib/engine";
import { hasActiveTransport, isLastMember, leave } from "@/lib/duty";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "설정 · 골든타임즈" },
      { name: "description", content: "근무 종료 · 로그아웃 · 권한 · 회원 탈퇴" },
      { property: "og:title", content: "설정 · 골든타임즈" },
      { property: "og:description", content: "구급대원 앱 설정" },
    ],
  }),
  component: Settings,
});

type Kind = "duty_end" | "logout" | "withdrawal";
const KIND_LABEL: Record<Kind, string> = { duty_end: "근무 종료", logout: "로그아웃", withdrawal: "회원 탈퇴" };

function Settings() {
  const a = useAuth();
  const nav = useNavigate();
  const acc = currentAccount(a);
  const [ask, setAsk] = useState<Kind | null>(null);
  const active = hasActiveTransport();
  const last = isLastMember(a);
  const p = a.permissions;
  const permLabel = (v: string, on: string) => (v === "granted" ? on : "꺼짐");
  const started = a.duty ? new Date(a.duty.startedAt) : null;
  const ends = started ? new Date(started.getTime() + 14 * 3600_000) : null;
  const hm = (d: Date) => d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <PhoneScreen title="설정" subtitle={acc ? `${acc.name} ${acc.rank} · ${acc.orgName} ${acc.center}` : ""} footer={<BigButton variant="outline" onClick={() => nav({ to: "/" })}>← 홈으로</BigButton>}>
      {ask && (
        <div className="rise-in mb-5 space-y-3 rounded-xl border-2 border-destructive/40 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 font-extrabold text-destructive">{KIND_LABEL[ask]}할까요?</p>
          {active && <Notice tone="warn">진행 중 이송 1건이 있어요</Notice>}
          <p className="text-sm leading-relaxed text-muted-foreground">
            {active && last ? `팀에 나만 남아 있어서, 진행 중 이송을 '취소'(사유: ${KIND_LABEL[ask]})로 끝내요. ` : ""}
            {ask === "withdrawal" ? "계정 · 프로필 정보가 바로 삭제되고 되돌릴 수 없어요." : "나만 팀에서 빠지고 다음에 다시 로그인해야 해요."}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <BigButton variant="outline" onClick={() => setAsk(null)}>아니요</BigButton>
            <BigButton variant="danger" onClick={async () => { const kind = ask; setAsk(null); const e = await leave(kind); if (e) toast(e); }}>{KIND_LABEL[ask]}</BigButton>
          </div>
        </div>
      )}

      <SectionTitle hint="근무 종료 = 로그아웃이에요. 근무 시작 후 14시간이 지나면 자동으로 끝나요">근무</SectionTitle>
      <div className="tile divide-y divide-border">
        <KeyVal label="팀 코드" value={<span className="tabular-nums tracking-widest">{a.duty?.teamCode ?? "-"}</span>} />
        <KeyVal label="내 역할" value={a.duty?.role ?? "-"} />
        <KeyVal label="팀원" value={`${(a.duty?.members.length ?? 0) + 1}명`} />
        {started && ends && <KeyVal label="근무 시간" value={`${hm(started)} 시작 · ${hm(ends)} 자동 종료`} />}
        <button className="w-full px-4 py-3.5 text-left text-sm font-bold text-destructive transition hover:bg-destructive/5" onClick={() => setAsk("duty_end")}>근무 종료</button>
      </div>

      <SectionTitle>권한</SectionTitle>
      <div className="tile divide-y divide-border">
        <KeyVal label="위치" value={permLabel(p.location, "앱 사용 중 허용")} />
        {!isIOS() && <KeyVal label="전화" value={permLabel(p.phone, "허용")} />}
        <KeyVal label="알림" value={permLabel(p.notify, "허용")} />
      </div>

      <SectionTitle>계정</SectionTitle>
      <div className="tile divide-y divide-border">
        <KeyVal label="아이디" value={acc?.loginId ?? "-"} />
        <KeyVal label="소속" value={acc ? `${acc.orgName} · ${acc.center}` : "-"} />
        <KeyVal label="상태" value={<Pill tone="ok">승인됨</Pill>} />
        <button className="w-full px-4 py-3.5 text-left text-sm font-bold transition hover:bg-surface" onClick={() => setAsk("logout")}>로그아웃</button>
        <button className="w-full px-4 py-3.5 text-left text-sm font-bold text-destructive transition hover:bg-destructive/5" onClick={() => setAsk("withdrawal")}>회원 탈퇴</button>
      </div>

      <SectionTitle hint="이 기기에 남은 위치 동의·권한 기록까지 지우고 처음 쓰는 날 화면부터 다시 봐요">이 기기</SectionTitle>
      <div className="tile divide-y divide-border text-sm">
        <DemoRow onClick={async () => { await leave("logout"); actions.reset(); resetAuth(); nav({ to: "/welcome" }); }}>로그아웃하고 처음 쓰는 날부터 다시 보기</DemoRow>
      </div>
    </PhoneScreen>
  );
}

function DemoRow({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left text-muted-foreground transition hover:bg-surface" onClick={onClick}>
      <span>{children}</span>
      <span className="chip shrink-0 border-0 bg-surface-2 text-[11px]">시연</span>
    </button>
  );
}
