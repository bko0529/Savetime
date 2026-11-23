import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/web/admin/monitoring")({
  head: () => ({ meta: [
    { title: "모니터링 · 골든타임즈 웹 미리보기" },
    { name: "description", content: "운영 알림, 병원 응답 현황, 관리자 작업 이력 디자인 미리보기." },
    { property: "og:title", content: "운영 모니터링 · 골든타임즈" },
    { property: "og:description", content: "병원 응답 현황과 운영 알림을 확인하는 관리자 화면." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
  ] }), beforeLoad: () => { throw redirect({ to: "/admin/monitoring", replace: true }); },
});