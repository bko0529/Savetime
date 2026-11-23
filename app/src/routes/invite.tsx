import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BellRing, Check, X, Users, Clock } from "lucide-react";
import { toast } from "sonner";
import { PhoneScreen, BigButton, SectionTitle, Notice, Pill, Avatar, IconTile } from "@/components/phone";
import { useAuth, inviteLeft, type Incoming } from "@/lib/auth-store";
import { acceptInvite, declineInvite } from "@/lib/auth-server";

export const Route = createFileRoute("/invite")({
  head: () => ({
    meta: [
      { title: "팀 초대 · 골든타임즈" },
      { name: "description", content: "다른 대원이 보낸 팀 초대를 확인하고 5분 안에 수락·거절해요." },
      { property: "og:title", content: "팀 초대 · 골든타임즈" },
      { property: "og:description", content: "초대는 5분 뒤 만료, 수락해야 팀원이 돼요" },
    ],
  }),
  component: InvitePage,
});

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/** SFR-159: 내 폰에 온 '팀 초대' 알림을 확인하는 화면. 수락해야 팀원이 된다 */
function InvitePage() {
  const a = useAuth();
  const nav = useNavigate();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const accept = async (inv: Incoming) => {
    const r = await acceptInvite(inv.id, inv.role);
    if (r.error) {
      toast(r.error);
      return;
    }
    toast.success(r.message);
    nav({ to: "/" });
  };

  const reject = async (inv: Incoming) => {
    toast(await declineInvite(inv.id));
  };

  if (a.incoming.length === 0) {
    return (
      <PhoneScreen title="팀 초대" subtitle="지금 온 초대가 없어요" footer={<BigButton variant="outline" onClick={() => nav({ to: "/" })}>홈으로</BigButton>}>
        <div className="flex flex-col items-center py-10 text-center">
          <IconTile tone="ink" className="size-14 rounded-2xl"><BellRing className="size-6" /></IconTile>
          <p className="mt-4 text-base font-extrabold">대기 중인 초대가 없어요</p>
        </div>
        <Notice tone="info">초대는 초대받은 대원의 폰에 '팀 초대' 알림으로 와요. 5분 안에 수락해야 팀에 들어갈 수 있어요.</Notice>
      </PhoneScreen>
    );
  }

  return (
    <PhoneScreen
      title="팀 초대"
      subtitle={`${a.incoming.length}건 · 5분 안에 답해야 해요`}
      badge={<Pill tone="wait" dot={false} className="bg-primary/8 text-primary">답변 필요</Pill>}
      footer={<BigButton variant="outline" onClick={() => nav({ to: "/" })}>홈으로</BigButton>}
    >
      {a.incoming.map((inv) => {
        const left = inviteLeft(inv, now);
        const soon = left <= 60_000;
        return (
          <div key={inv.id} className="tile mb-3 overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2.5">
              <span className="inline-flex items-center gap-2 text-[11px] font-bold tracking-wide text-muted-foreground uppercase"><BellRing className="size-3.5" /> 팀 초대</span>
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-extrabold tabular-nums ${soon ? "bg-destructive text-destructive-foreground" : "bg-warning-soft text-warning"}`}>
                <Clock className="size-3" /> {mmss(left)} 뒤 만료
              </span>
            </div>

            <div className="space-y-4 p-4">
              <div className="flex items-center gap-3">
                <Avatar name={inv.from.name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-extrabold">{inv.from.name} <span className="text-sm font-semibold text-muted-foreground">{inv.from.rank}</span></p>
                  <p className="truncate text-xs text-muted-foreground">같은 소방서 대원</p>
                </div>
              </div>

              <div className="well flex items-end justify-between gap-3 px-4 py-3.5">
                <div>
                  <p className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">들어갈 팀</p>
                  <p className="mt-1 text-3xl leading-none font-extrabold tracking-[0.22em] tabular-nums">{inv.teamCode}</p>
                </div>
                <Pill tone="call" dot={false}>내 역할 {inv.role}</Pill>
              </div>

              <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                <Users className="mt-px size-3.5 shrink-0" />
                수락하면 이 대원과 한 팀이 돼요. 팀은 최대 4명 · 운전은 1명이고, 이미 운전 대원이 있으면 내 역할은 처치로 들어가요.
              </p>

              <div className="grid grid-cols-2 gap-2">
                <BigButton size="lg" onClick={() => void accept(inv)}><Check className="size-5" /> 수락</BigButton>
                <BigButton size="lg" variant="outline" onClick={() => void reject(inv)}><X className="size-5" /> 거절</BigButton>
              </div>
            </div>
          </div>
        );
      })}

      <SectionTitle hint="5분 안에 답하지 않으면 초대가 만료되고, 초대한 대원 화면에도 그 사실이 보여요">알림으로 도착</SectionTitle>
      <Notice tone="info">이 초대는 폰에 '팀 초대' 푸시 알림으로 도착했어요. 앱이 꺼져 있어도 진동·소리로 알리고, 여기서 수락하거나 거절할 수 있어요.</Notice>
    </PhoneScreen>
  );
}
