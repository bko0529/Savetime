import { createFileRoute } from "@tanstack/react-router";
import { SaveTimeWebShell } from "@/components/savetime-web-shell";
import { LoginForm } from "@/savetime-web/app/admin/login/LoginForm";
export const Route = createFileRoute("/admin_/login")({
 head: () => ({ meta: [
  { title: "관리자 로그인 · 골든타임즈 SaveTime" },
  { name: "description", content: "아이디·비밀번호와 OTP로 로그인합니다" },
  { property: "og:title", content: "관리자 로그인 · 골든타임즈" },
  { property: "og:description", content: "아이디·비밀번호와 OTP로 로그인합니다" },
  { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
 ] }),
 component: () => <SaveTimeWebShell hospital={false}><main className="mx-auto flex min-h-[70vh] max-w-lg flex-col justify-center gap-7 px-5 py-10"><h1 className="text-2xl font-extrabold">관리자 로그인</h1><LoginForm /></main></SaveTimeWebShell>,
});
