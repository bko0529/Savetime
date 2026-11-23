import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Hourglass, XCircle, BellRing } from "lucide-react";
import { PhoneScreen, BigButton, Pill, IconTile, KeyVal, Notice } from "@/components/phone";
import { useAuth, currentAccount } from "@/lib/auth-store";
import { refreshMe } from "@/lib/auth-server";
import { leave } from "@/lib/duty";

export const Route = createFileRoute("/pending")({
  head: () => ({
    meta: [
      { title: "승인 대기 중 · 골든타임즈" },
      { name: "description", content: "관리자가 공무원증을 확인하고 있어요. 승인되면 알림으로 알려드려요." },
      { property: "og:title", content: "승인 대기 중 · 골든타임즈" },
      { property: "og:description", content: "승인 전에는 다른 기능을 쓸 수 없어요" },
    ],
  }),
  component: Pending,
});

/** SFR-022: 승인 전에는 '승인 대기 중' 화면만. 승인 · 반려 결과는 알림 */
function Pending() {
  const a = useAuth();
  const nav = useNavigate();
  const acc = currentAccount(a);
  if (!acc) return null;
  const rejected = acc.status === "rejected";
  // 반려되면 같은 계정으로 내용·사진만 다시 보낸다 (가입 화면이 PUT /me/signup)
  const reapply = () => nav({ to: "/signup" });

  return (
    <PhoneScreen
      title={rejected ? "가입이 반려됐어요" : "승인 대기 중"}
      subtitle={rejected ? "내용을 고쳐 다시 신청해 주세요" : "승인 전에는 다른 기능을 쓸 수 없어요"}
      footer={rejected ? <BigButton size="lg" onClick={reapply}>다시 가입 신청</BigButton> : <BigButton variant="outline" onClick={() => void leave("logout")}>로그아웃</BigButton>}
    >
      <div className="flex flex-col items-center py-8 text-center">
        {rejected ? (
          <IconTile tone="warn" className="size-16 rounded-full bg-destructive/10"><XCircle className="size-7 text-destructive" /></IconTile>
        ) : (
          <IconTile tone="warn" className="size-16 rounded-full"><Hourglass className="size-7 text-warning" /></IconTile>
        )}
        <p className="mt-5 text-lg font-extrabold">{rejected ? acc.rejectReason : "관리자가 공무원증을 확인하고 있어요"}</p>
        {!rejected && <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted-foreground"><BellRing className="size-3.5" /> 승인되면 알림으로 알려드려요</p>}
      </div>

      {rejected && <div className="mb-4"><Notice tone="warn">반려 사유: {acc.rejectReason}</Notice></div>}

      <dl className="tile divide-y divide-border text-sm">
        <KeyVal label="신청 일시" value={acc.appliedAt} />
        <KeyVal label="이름" value={`${acc.name} ${acc.rank}`} />
        <KeyVal label="소속" value={`${acc.orgName} · ${acc.center}`} />
        <KeyVal label="사번" value={acc.employeeNo} />
        <div className="flex items-center justify-between px-4 py-3.5">
          <dt className="text-sm text-muted-foreground">상태</dt>
          <dd>{rejected ? <Pill tone="danger">반려</Pill> : <Pill tone="wait">확인 중</Pill>}</dd>
        </div>
      </dl>

      {!rejected && (
        <button className="mt-7 w-full text-center text-xs font-semibold text-muted-foreground underline" onClick={() => void refreshMe()}>
          지금 결과 다시 확인
        </button>
      )}
    </PhoneScreen>
  );
}
