import { createFileRoute } from "@tanstack/react-router";
import { SaveTimeWebShell } from "@/components/savetime-web-shell";
import { RegisterForm } from "@/savetime-web/app/hospital/register/RegisterForm";
export const Route = createFileRoute("/hospital_/register")({
 head: () => ({ meta: [
  { title: "병원 PC 등록 · 골든타임즈 SaveTime" },
  { name: "description", content: "라이선스 키로 병원 PC를 등록합니다" },
  { property: "og:title", content: "병원 PC 등록 · 골든타임즈" },
  { property: "og:description", content: "라이선스 키로 병원 PC를 등록합니다" },
  { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
 ] }),
 component: () => <SaveTimeWebShell hospital={true}><main className="mx-auto flex min-h-[70vh] max-w-lg flex-col justify-center gap-7 px-5 py-10"><h1 className="text-2xl font-extrabold">병원 PC 등록</h1><RegisterForm /></main></SaveTimeWebShell>,
});
