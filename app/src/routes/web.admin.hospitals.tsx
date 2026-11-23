import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/web/admin/hospitals")({
  head: () => ({ meta: [
    { title: "병원 관리 · 골든타임즈 웹 미리보기" },
    { name: "description", content: "병원 계정, 라이선스 키, 등록 PC 관리 디자인 미리보기." },
    { property: "og:title", content: "병원 관리 · 골든타임즈" },
    { property: "og:description", content: "골든타임즈 관리자 병원·라이선스 관리 화면." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
  ] }), beforeLoad: () => { throw redirect({ to: "/admin/hospitals", replace: true }); },
});