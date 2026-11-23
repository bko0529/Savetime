import { createFileRoute } from "@tanstack/react-router";
import { SaveTimeWebShell } from "@/components/savetime-web-shell";
import { DesignPreview } from "@/savetime-web/app/hospital/design-preview/DesignPreview";
export const Route = createFileRoute("/hospital_/design-preview")({
 head: () => ({ meta: [
  { title: "병원 디자인 시안 · 골든타임즈 SaveTime" },
  { name: "description", content: "원본 웹에 포함된 버튼·요청 알림 디자인 시안" },
  { property: "og:title", content: "병원 디자인 시안 · 골든타임즈" },
  { property: "og:description", content: "원본 웹에 포함된 버튼·요청 알림 디자인 시안" },
  { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
 ] }),
 component: () => <SaveTimeWebShell hospital={true}><DesignPreview /></SaveTimeWebShell>,
});
