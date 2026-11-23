import { createFileRoute } from "@tanstack/react-router";
import { SaveTimeWebShell } from "@/components/savetime-web-shell";
import { SignupReview } from "@/savetime-web/app/admin/accounts/SignupReview";
import { AdminShell } from "@/savetime-web/app/admin/AdminShell";
import { ParamedicAdmin } from "@/savetime-web/app/admin/accounts/ParamedicAdmin";
export const Route = createFileRoute("/admin_/accounts")({
 head: () => ({ meta: [
  { title: "계정 관리 · 골든타임즈 SaveTime" },
  { name: "description", content: "가입 승인·반려와 구급대원 계정 정지·해제" },
  { property: "og:title", content: "계정 관리 · 골든타임즈" },
  { property: "og:description", content: "가입 승인·반려와 구급대원 계정 정지·해제" },
  { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
 ] }),
 component: () => <SaveTimeWebShell hospital={false}><AdminShell><h1 className="text-2xl font-extrabold">계정 관리</h1><SignupReview /><ParamedicAdmin /></AdminShell></SaveTimeWebShell>,
});
