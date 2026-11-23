import { createFileRoute } from "@tanstack/react-router";
import { MapPin, Phone, Bell, Settings2, Check, X } from "lucide-react";
import { PhoneScreen, BigButton, Pill, Notice, IconTile } from "@/components/phone";
import { useAuth, setAuth, isIOS, type Perm } from "@/lib/auth-store";

export const Route = createFileRoute("/permissions")({
  head: () => ({
    meta: [
      { title: "권한 확인 · 골든타임즈" },
      { name: "description", content: "위치 · 전화 · 알림 권한을 이유와 함께 순서대로 물어요." },
      { property: "og:title", content: "권한 확인 · 골든타임즈" },
      { property: "og:description", content: "위치 → 전화 → 알림, 권한마다 이유 한 줄" },
    ],
  }),
  component: Permissions,
});

type K = "location" | "phone" | "notify";

/** SFR-092: 위치 → 전화 → 알림 (iOS는 위치 → 알림). 카메라는 여기서 묻지 않음 */
function Permissions() {
  const a = useAuth();
  const p = a.permissions;
  const ios = isIOS();
  const rows: { k: K; icon: typeof MapPin; title: string; why: string }[] = [
    { k: "location", icon: MapPin, title: "위치 (필수)", why: "반경 안 병원에 요청하고 도착 예상 시간을 계산해요. '앱 사용 중'에만 써요" },
    ...(ios ? [] : [{ k: "phone" as const, icon: Phone, title: "전화", why: "응급실에 앱에서 바로 전화를 걸어요" }]),
    {
      k: "notify", icon: Bell, title: "알림",
      why: `병원 승인을 소리 · 진동으로 바로 알려요${ios ? ". 무음 모드에서는 소리 없이 진동으로만 알려요" : ""}`,
    },
  ];
  const set = (k: K, v: Perm) => setAuth({ permissions: { ...p, [k]: v } });

  const grant = (k: K) => {
    if (k === "location" && "geolocation" in navigator) navigator.geolocation.getCurrentPosition(() => {}, () => {}, { timeout: 3000 });
    if (k === "notify" && "Notification" in window) Notification.requestPermission().catch(() => {});
    set(k, "granted");
  };

  // 위치 거부: 허용할 때까지 다음 단계로 안 넘어감
  if (p.location === "denied") {
    return (
      <PhoneScreen
        title="권한 확인"
        footer={<BigButton size="lg" onClick={() => set("location", "granted")}><Settings2 className="size-5" /> 설정으로 이동</BigButton>}
      >
        <div className="flex flex-col items-center py-16 text-center">
          <IconTile tone="warn" className="size-16 rounded-full"><MapPin className="size-7 text-warning" /></IconTile>
          <p className="mt-5 text-lg font-extrabold">위치 권한이 있어야 사용할 수 있어요</p>
          <p className="mt-1.5 text-sm text-muted-foreground">설정에서 위치를 '앱 사용 중 허용'으로 바꿔 주세요</p>
        </div>
        <p className="text-center text-xs text-muted-foreground">시연: '설정으로 이동'을 누르면 허용한 것으로 처리해요</p>
      </PhoneScreen>
    );
  }

  const next = rows.find((r) => p[r.k] === "unknown");
  const done = rows.filter((r) => p[r.k] !== "unknown").length;
  return (
    <PhoneScreen
      title="권한 확인"
      subtitle="필요한 이유를 보고 허용해 주세요"
      badge={<Pill tone="neutral" dot={false} className="bg-primary/8 text-primary">{done}/{rows.length}</Pill>}
      footer={
        next && (
          <div className="space-y-2">
            <BigButton size="lg" onClick={() => grant(next.k)}>{next.k === "location" ? "앱 사용 중 허용" : "허용"}</BigButton>
            <BigButton variant="outline" onClick={() => set(next.k, "denied")}>허용 안 함</BigButton>
          </div>
        )
      }
    >
      <div className="space-y-2.5">
        {rows.map(({ k, icon: Icon, title, why }) => {
          const on = next?.k === k;
          return (
            <div key={k} className={`tile flex items-start gap-3.5 p-4 transition ${on ? "border-2 border-accent bg-accent-soft/40 shadow-[var(--shadow-accent)]" : ""}`}>
              <IconTile tone={p[k] === "granted" ? "ok" : on ? "accent" : "ink"}><Icon className="size-5" /></IconTile>
              <div className="min-w-0 flex-1">
                <p className="font-extrabold">{title}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{why}</p>
              </div>
              {p[k] === "granted" ? (
                <Pill tone="ok"><Check className="size-3" /> 허용함</Pill>
              ) : p[k] === "denied" ? (
                <Pill tone="neutral"><X className="size-3" /> 허용 안 함</Pill>
              ) : on ? (
                <Pill tone="wait">지금</Pill>
              ) : (
                <Pill tone="neutral" dot={false}>다음</Pill>
              )}
            </div>
          );
        })}
      </div>
      {p.notify === "denied" && <div className="mt-4"><Notice tone="warn">병원 승인을 소리·진동으로만 알 수 있어요</Notice></div>}
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
        위치는 '앱 사용 중'에만 쓰고, 백그라운드 위치 권한은 묻지 않아요. 카메라는 공무원증 촬영 · QR 스캔 때 물어요.
      </p>
    </PhoneScreen>
  );
}
