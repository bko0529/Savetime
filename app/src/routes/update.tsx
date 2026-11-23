import { createFileRoute } from "@tanstack/react-router";
import { Download, Smartphone } from "lucide-react";
import { PhoneScreen, BigButton, IconTile, KeyVal } from "@/components/phone";
import { useAuth, APP_VERSION } from "@/lib/auth-store";

export const Route = createFileRoute("/update")({
  head: () => ({
    meta: [
      { title: "업데이트가 필요해요 · 골든타임즈" },
      { name: "description", content: "지금 버전으로는 쓸 수 없어요. 앱을 업데이트해 주세요." },
      { property: "og:title", content: "업데이트가 필요해요 · 골든타임즈" },
      { property: "og:description", content: "최소 지원 버전보다 낮은 앱은 기능을 막아요" },
    ],
  }),
  component: Update,
});

/** SFR-142: 서버가 정한 최소 버전보다 낮으면 기능을 막고 업데이트 안내만 */
function Update() {
  const a = useAuth();
  return (
    <PhoneScreen title="업데이트가 필요해요" subtitle="지금 버전으로는 쓸 수 없어요" footer={<BigButton size="lg"><Download className="size-5" /> 스토어에서 업데이트</BigButton>}>
      <div className="flex flex-col items-center py-8 text-center">
        <IconTile tone="warn" className="size-16 rounded-full"><Smartphone className="size-7 text-warning" /></IconTile>
        <p className="mt-5 text-base font-extrabold">새 버전이 나왔어요</p>
        <p className="mt-1.5 text-sm text-muted-foreground">업데이트하면 이어서 쓸 수 있어요</p>
      </div>
      <div className="tile divide-y divide-border text-sm">
        <KeyVal label="설치된 버전" value={<span className="tabular-nums">{APP_VERSION}</span>} />
        <KeyVal label="최소 지원 버전" value={<span className="tabular-nums text-accent-deep">{a.serverMinVersion}</span>} />
      </div>
    </PhoneScreen>
  );
}
