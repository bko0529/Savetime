import { createFileRoute } from "@tanstack/react-router";
import { SaveTimeWebShell } from "@/components/savetime-web-shell";
import { AdminHome } from "@/savetime-web/app/admin/AdminHome";
export const Route = createFileRoute("/admin")({
 head: () => ({ meta: [
  { title: "관리자 · 골든타임즈 SaveTime" },
  { name: "description", content: "계정·모니터링·병원 관리" },
  { property: "og:title", content: "관리자 · 골든타임즈" },
  { property: "og:description", content: "계정·모니터링·병원 관리" },
  { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
 ] }),
 component: () => <SaveTimeWebShell hospital={false}><AdminHome /></SaveTimeWebShell>,
});
