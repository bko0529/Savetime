import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/web/hospital")({
  head: () => ({ meta: [
    { title: "병원 이송 요청 · 골든타임즈 웹 미리보기" },
    { name: "description", content: "골든타임즈 병원용 이송 요청, 환자 평가 상세, 도착 예정 디자인 미리보기." },
    { property: "og:title", content: "병원 이송 요청 · 골든타임즈" },
    { property: "og:description", content: "구급대원 앱과 통일된 병원 웹 디자인 미리보기." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
  ] }), beforeLoad: () => { throw redirect({ to: "/hospital", replace: true }); },
});