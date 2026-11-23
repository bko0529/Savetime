import { createFileRoute } from "@tanstack/react-router";
import { MapPin, MapPinOff, ShieldCheck, Clock, Hospital, Navigation, Send } from "lucide-react";
import { PhoneScreen, BigButton, IconTile } from "@/components/phone";
import { useAuth, setAuth } from "@/lib/auth-store";

export const Route = createFileRoute("/welcome")({
  head: () => ({
    meta: [
      { title: "골든타임즈 시작하기 · 위치정보 안내" },
      { name: "description", content: "위치를 왜 쓰는지, 무엇을 얼마나 보관하는지 먼저 알려드려요." },
      { property: "og:title", content: "골든타임즈 시작하기" },
      { property: "og:description", content: "위치정보 수집 · 이용 안내와 필수 동의" },
    ],
  }),
  component: Welcome,
});

/** SFR-041 고지 항목 */
const ITEMS: { k: string; v: string; icon: typeof MapPin }[] = [
  { k: "수집 목적", v: "이송 요청 · 도착 예상 시간 계산, 구급활동일지 이동 거리 기록, 구급차 경로 안내 개선을 위한 익명 경로 축적", icon: ShieldCheck },
  { k: "보관 항목", v: "이송 중 구급차 위치 기록 (좌표 · 시각)", icon: MapPin },
  { k: "보관 기간", v: "도착 · 취소하면 바로 대원 계정 · 팀 · 이송 건과의 연결을 끊고 '익명 이송 경로'로 바꿔 3년 보관해요. 이송 기록에는 이동 거리만 남아요", icon: Clock },
  { k: "병원 제공", v: "환자 평가 정보와, 위치로 계산한 도착 예상 시간을 요청 대상 병원에 보내요", icon: Hospital },
  { k: "길찾기 서비스", v: "경로 안내 · 이동 시간 계산을 위해 위치가 카카오모빌리티에 전달돼요", icon: Navigation },
];

function Welcome() {
  const a = useAuth();

  if (a.consent === "refused") {
    return (
      <PhoneScreen title="골든타임즈" footer={<BigButton size="lg" onClick={() => setAuth({ consent: "unknown" })}>다시 동의하기</BigButton>}>
        <div className="flex flex-col items-center py-16 text-center">
          <IconTile tone="warn" className="size-16 rounded-full"><MapPinOff className="size-7 text-warning" /></IconTile>
          <p className="mt-5 text-lg font-extrabold">위치 동의가 있어야 사용할 수 있어요</p>
        </div>
      </PhoneScreen>
    );
  }

  return (
    <PhoneScreen
      title="골든타임즈 시작하기"
      subtitle="위치정보 수집 · 이용 안내 (필수)"
      footer={
        <div className="space-y-2">
          <BigButton size="lg" onClick={() => setAuth({ consent: "agreed" })}>동의하고 계속</BigButton>
          <BigButton variant="outline" onClick={() => setAuth({ consent: "refused" })}>동의 안 함</BigButton>
        </div>
      }
    >
      <div className="mb-5 flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
        <IconTile tone="accent" className="size-11 rounded-2xl"><MapPin className="size-5" /></IconTile>
        <p className="pt-1 text-sm leading-relaxed text-muted-foreground">
          병상 숫자가 아니라, <b className="text-foreground">병원의 대답</b>을 봅니다.<br />119 구급대원 전용 이송 요청 앱이에요.
        </p>
      </div>

      <div className="tile divide-y divide-border">
        {ITEMS.map(({ k, v, icon: Icon }, i) => (
          <div key={k} className="flex gap-3.5 p-4">
            <IconTile tone="ink" className="size-8 rounded-lg text-xs font-extrabold">{i + 1}</IconTile>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-extrabold">
                <Icon className="size-3.5 text-muted-foreground" />
                {k}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{v}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-xl bg-surface p-4">
        <p className="text-sm font-extrabold">왜 필수인가요?</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">위치가 있어야 반경 안 병원에 요청을 보내고 도착 예상 시간을 계산할 수 있어요. 그래서 동의해야 앱을 쓸 수 있어요.</p>
      </div>
      <p className="mt-4 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <Send className="mt-px size-3.5 shrink-0" />
        본 서비스는 참고용이며 의료 판단과 병원 수용을 보장하지 않습니다.
      </p>
    </PhoneScreen>
  );
}
