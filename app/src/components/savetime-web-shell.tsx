import { Link } from "@tanstack/react-router";
import { HeartPulse, ArrowLeft, Building2, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { EcgLine } from "@/components/phone";
import { Button } from "@/components/ui/button";

export function SaveTimeWebShell({ children, hospital = false }: { children: ReactNode; hospital?: boolean }) {
  return <div className="savetime-web min-h-screen bg-background text-foreground">
    <header className="surface-header relative overflow-hidden border-b border-border px-5 py-5 lg:px-9">
      <EcgLine className="absolute bottom-0 left-1/3 w-64 text-accent/35" />
      <div className="relative mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3">
        <Link to={hospital ? "/hospital" : "/admin"} className="flex items-center gap-3"><span className="grid size-11 place-items-center rounded-lg bg-accent-soft text-accent"><HeartPulse className="size-6" /></span><span><span className="block text-xl font-extrabold">골든타임즈 <span className="text-xs font-normal text-muted-foreground">SaveTime</span></span><span className="mt-1 block text-xs text-muted-foreground">{hospital ? "병원 · 응급실 이송 요청" : "운영 관리자"}</span></span></Link>
        <nav aria-label="서비스 이동" className="flex flex-wrap gap-1">
          <Button asChild variant="ghost" className="hover:bg-surface hover:text-foreground"><Link to="/hospital"><Building2 />병원 웹</Link></Button>
          <Button asChild variant="ghost" className="hover:bg-surface hover:text-foreground"><Link to="/admin"><ShieldCheck />관리자</Link></Button>
          <Button asChild variant="ghost" className="hover:bg-surface hover:text-foreground"><Link to="/welcome"><ArrowLeft />구급대원 앱</Link></Button>
        </nav>
      </div>
    </header>
    <div className="mx-auto w-full max-w-[1500px]">{children}</div>
  </div>;
}