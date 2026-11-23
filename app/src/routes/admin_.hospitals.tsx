import { createFileRoute } from "@tanstack/react-router";
import { SaveTimeWebShell } from "@/components/savetime-web-shell";
import { HospitalAdmin } from "@/savetime-web/app/admin/hospitals/HospitalAdmin";
import { AdminShell } from "@/savetime-web/app/admin/AdminShell";
export const Route = createFileRoute("/admin_/hospitals")({
 head: () => ({ meta: [
  { title: "병원 관리 · 골든타임즈 SaveTime" },
  { name: "description", content: "병원 계정·라이선스 키·등록 PC·응급실 입구 관리" },
  { property: "og:title", content: "병원 관리 · 골든타임즈" },
  { property: "og:description", content: "병원 계정·라이선스 키·등록 PC·응급실 입구 관리" },
  { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
 ] }),
 component: () => <SaveTimeWebShell hospital={false}><AdminShell><HospitalAdmin /></AdminShell></SaveTimeWebShell>,
});
