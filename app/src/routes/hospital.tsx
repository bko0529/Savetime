import { createFileRoute } from "@tanstack/react-router";
import { SaveTimeWebShell } from "@/components/savetime-web-shell";
import { HospitalHome } from "@/savetime-web/app/hospital/HospitalHome";
export const Route = createFileRoute("/hospital")({
 head: () => ({ meta: [
  { title: "병원 이송 요청 · 골든타임즈 SaveTime" },
  { name: "description", content: "병원 근무 시작과 이송 요청 승인·거절, 도착 예정 확인" },
  { property: "og:title", content: "병원 이송 요청 · 골든타임즈" },
  { property: "og:description", content: "병원 근무 시작과 이송 요청 승인·거절, 도착 예정 확인" },
  { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
 ] }),
 component: () => <SaveTimeWebShell hospital={true}><main className="px-5 py-8 lg:px-8"><h1 className="mb-6 text-2xl font-extrabold">이송 요청</h1><HospitalHome /></main></SaveTimeWebShell>,
});
