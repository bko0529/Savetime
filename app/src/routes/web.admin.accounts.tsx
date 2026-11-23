import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/web/admin/accounts")({
  head: () => ({ meta: [
    { title: "계정 관리 · 골든타임즈 웹 미리보기" },
    { name: "description", content: "구급대원 가입 심사와 계정 관리 디자인 미리보기." },
    { property: "og:title", content: "계정 관리 · 골든타임즈" },
    { property: "og:description", content: "골든타임즈 관리자 가입 승인·반려 화면." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
  ] }), beforeLoad: () => { throw redirect({ to: "/admin/accounts", replace: true }); },
});