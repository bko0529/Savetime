import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { PhoneScreen, BigButton, Label, Notice } from "@/components/phone";
import { useAuth, currentAccount, newPasswordError } from "@/lib/auth-store";
import { changePassword } from "@/lib/auth-server";
import { leave } from "@/lib/duty";

export const Route = createFileRoute("/password")({
  head: () => ({
    meta: [
      { title: "비밀번호 바꾸기 · 골든타임즈" },
      { name: "description", content: "임시 비밀번호를 새 비밀번호로 바꿔요" },
      { property: "og:title", content: "비밀번호 바꾸기 · 골든타임즈" },
      { property: "og:description", content: "8자 이상, 영문과 숫자를 섞어 주세요" },
    ],
  }),
  component: PasswordPage,
});

/**
 * SFR-021: 비밀번호 바꾸기.
 * - 관리자가 초기화한 임시 비밀번호로 들어오면 이 화면만 볼 수 있다 (app-gate). 바꾸면 원래 흐름(근무 시작)으로 넘어간다
 * - 설정에서 들어오면 평소처럼 바꾸고 설정으로 돌아간다
 */
function PasswordPage() {
  const a = useAuth();
  const nav = useNavigate();
  const acc = currentAccount(a);
  const required = !!acc?.mustChangePassword;
  const [f, setF] = useState({ current: "", next: "", confirm: "" });
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    // 규칙은 먼저 화면에서 보고, 지금 비밀번호가 맞는지는 서버가 본다 (5번 틀리면 10분 잠금)
    const bad = newPasswordError(f);
    if (bad) return setErr(bad);
    setBusy(true);
    const fail = await changePassword(f.current, f.next);
    setBusy(false);
    if (fail) return setErr(fail);
    setErr("");
    setF({ current: "", next: "", confirm: "" });
    // 임시 비밀번호였으면 app-gate 가 다음 화면으로 보낸다. 설정에서 왔으면 완료 표시 뒤 돌아간다
    if (!required) setDone(true);
  };

  return (
    <PhoneScreen
      title={required ? "새 비밀번호를 정해 주세요" : "비밀번호 바꾸기"}
      subtitle={
        required
          ? "관리자가 초기화한 임시 비밀번호로 들어왔어요"
          : "8자 이상, 영문과 숫자를 섞어 주세요"
      }
      footer={
        required ? (
          <BigButton variant="outline" onClick={() => void leave("logout")}>
            로그아웃
          </BigButton>
        ) : (
          <BigButton variant="outline" onClick={() => nav({ to: "/settings" })}>
            ← 설정으로
          </BigButton>
        )
      }
    >
      {required && (
        <div className="mb-4">
          <Notice tone="warn" icon={<KeyRound className="size-4" />}>
            비밀번호를 바꾸기 전에는 다른 기능을 쓸 수 없어요
          </Notice>
        </div>
      )}
      <form onSubmit={submit} className="tile space-y-3.5 p-5" noValidate>
        <div>
          <Label>{required ? "임시 비밀번호" : "지금 비밀번호"}</Label>
          <input
            className="field"
            type="password"
            value={f.current}
            onChange={set("current")}
            autoComplete="current-password"
          />
        </div>
        <div>
          <Label>새 비밀번호</Label>
          <input
            className="field"
            type="password"
            value={f.next}
            onChange={set("next")}
            autoComplete="new-password"
            placeholder="8자 이상 · 영문+숫자"
          />
        </div>
        <div>
          <Label>새 비밀번호 확인</Label>
          <input
            className="field"
            type="password"
            value={f.confirm}
            onChange={set("confirm")}
            autoComplete="new-password"
          />
        </div>
        {err && <Notice tone="warn">{err}</Notice>}
        {done && <Notice tone="ok">비밀번호를 바꿨어요</Notice>}
        <BigButton size="lg" type="submit" disabled={busy}>
          {busy ? "바꾸는 중…" : "비밀번호 바꾸기"}
        </BigButton>
      </form>
    </PhoneScreen>
  );
}
