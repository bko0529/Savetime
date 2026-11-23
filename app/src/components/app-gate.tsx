import { useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { useAuth, getAuth, currentAccount, dutyExpired, versionBelow, APP_VERSION, isIOS, type AuthState } from "@/lib/auth-store";
import { useEngine, loadCurrent } from "@/lib/engine";
import { hasActiveTransport, leave } from "@/lib/duty";
import { loadConfig, resumeSession } from "@/lib/auth-server";

const PRE_LOGIN = ["/update", "/welcome", "/permissions", "/login", "/signup", "/pending"];

/** 권한 단계가 끝났는지: 위치는 허용, 전화(iOS 제외) · 알림은 한 번 물어봤음 */
export function permissionsDone(a: AuthState) {
  const p = a.permissions;
  return p.location === "granted" && (isIOS() || p.phone !== "unknown") && p.notify !== "unknown";
}

/** 지금 상태에서 있어야 할 화면 (null = 지금 화면 그대로) */
export function gateTarget(a: AuthState, path: string): string | null {
  const want = (p: string, ok: string[] = [p]) => (ok.includes(path) ? null : p);
  if (versionBelow(APP_VERSION, a.serverMinVersion)) return want("/update");
  if (a.consent !== "agreed") return want("/welcome");
  if (!permissionsDone(a)) return want("/permissions");
  const acc = currentAccount(a);
  if (!acc) return want("/login", ["/login", "/signup"]);
  // 반려되면 가입 화면에서 다시 신청할 수 있다
  if (acc.status !== "approved") return want("/pending", acc.status === "rejected" ? ["/pending", "/signup"] : ["/pending"]);
  if (!a.duty?.started) return want("/duty", ["/duty", "/invite"]);
  if (PRE_LOGIN.includes(path) || path === "/duty") return "/";
  return null;
}

/** 첫 사용 · 로그인 · 근무 순서를 지키고, 이송 상태가 바뀌면 맞는 화면으로 보냄 */
export function AppGate() {
  const a = useAuth();
  const e = useEngine();
  const nav = useNavigate();
  const path = useRouterState({ select: (r) => r.location.pathname });

  useEffect(() => {
    const to = gateTarget(a, path);
    if (to) nav({ to: to as "/", replace: true });
  }, [a, path, nav]);

  // 서버 설정(최소 버전·기능 토글)은 켜질 때와 1분마다, 로그인돼 있으면 서버 상태로 다시 맞춘다 (SFR-142)
  useEffect(() => {
    void loadConfig();
    void resumeSession();
    const t = setInterval(() => void loadConfig(), 60_000);
    return () => clearInterval(t);
  }, []);

  // 로그인·근무가 준비되면 팀의 진행 중 이송을 서버에서 불러온다 (앱을 다시 켜도 이어서, SFR-133)
  const ready = !!a.tokens && !!a.duty?.started;
  useEffect(() => {
    if (ready) void loadCurrent();
  }, [ready, a.duty?.teamId]);

  // 이송 건 상태 → 화면
  const prev = useRef<string>("");
  useEffect(() => {
    const key = `${e.status}:${e.phoneTarget}`;
    if (key === prev.current) return;
    const first = prev.current === "";
    prev.current = key;
    if (first || !e.status) return;
    if (e.status === "requesting" || e.status === "fallback") nav({ to: "/request" });
    else if (e.status === "phone_check" && e.phoneTarget) nav({ to: "/call/$hospitalId", params: { hospitalId: e.phoneTarget } });
    else if (e.status === "moving") nav({ to: "/transport" });
    else if (e.status === "arrived") nav({ to: "/log" });
    else if (e.status === "cancelled" && getAuth().duty) nav({ to: "/" });
  }, [e.status, e.phoneTarget, nav]);

  // SER-007: 근무 시작 후 14시간 → 자동 근무 종료(= 로그아웃). 이송 중이면 끝난 뒤
  useEffect(() => {
    const check = () => {
      if (dutyExpired(getAuth().duty) && !hasActiveTransport()) {
        void leave("duty_end");
        toast("근무 시작 후 14시간이 지나 근무를 마쳤어요. 다시 로그인해 주세요");
      }
    };
    check();
    const t = setInterval(check, 30_000);
    return () => clearInterval(t);
  }, [e.status]);

  return null;
}
