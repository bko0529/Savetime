import { createFileRoute } from "@tanstack/react-router";
import { SaveTimeWebShell } from "@/components/savetime-web-shell";
import { Notifications } from "@/savetime-web/app/admin/monitoring/Notifications";
import { AdminShell } from "@/savetime-web/app/admin/AdminShell";
import { HospitalStats } from "@/savetime-web/app/admin/monitoring/HospitalStats";
import { AuditLog } from "@/savetime-web/app/admin/monitoring/AuditLog";
export const Route = createFileRoute("/admin_/monitoring")({
 head: () => ({ meta: [
  { title: "모니터링 · 골든타임즈 SaveTime" },
  { name: "description", content: "관리자 알림·병원 응답 통계·작업 이력" },
  { property: "og:title", content: "모니터링 · 골든타임즈" },
  { property: "og:description", content: "관리자 알림·병원 응답 통계·작업 이력" },
  { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
 ] }),
 component: () => <SaveTimeWebShell hospital={false}><AdminShell><h1 className="text-2xl font-extrabold">모니터링</h1><Notifications /><HospitalStats /><AuditLog /></AdminShell></SaveTimeWebShell>,
});
