import { useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { BigButton } from "@/components/phone";
import { organizeJournalWithAi } from "@/lib/engine";
import type { AiSuggestions } from "@/lib/journal";

const AI_LABEL: [keyof AiSuggestions, string][] = [
  ["chiefComplaint", "주 호소"], ["history", "병력"], ["treatment", "처치"], ["medicalDirection", "의료지도"], ["other", "그 밖에"],
];

/** SFR-167: 메모를 적고 AI 로 일지 항목별 제안을 받는다. 제안은 '적용'을 눌러야 일지에 들어간다 */
export function AiOrganize({ onApply }: { onApply: (s: AiSuggestions) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sug, setSug] = useState<AiSuggestions | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    const r = await organizeJournalWithAi(text);
    setBusy(false);
    if (r.ok) setSug(r.value);
    else setErr(r.error);
  };
  const rows = sug ? AI_LABEL.filter(([k]) => sug[k]) : [];
  return (
    <section className="tile mb-3 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border bg-surface/70 px-4 py-2.5">
        <Sparkles className="size-4 text-accent-deep" />
        <h2 className="text-[15px] font-extrabold tracking-tight">AI 일지 정리</h2>
      </div>
      <div className="space-y-3 p-4">
        <textarea
          aria-label="AI에게 줄 메모"
          className="field min-h-24 py-2.5 text-base"
          maxLength={2000}
          placeholder="예: 60대 남성 흉통 30분 전 시작, 고혈압 약 복용, 산소 4L 투여"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">이름·전화번호·주소는 서버가 지운 뒤 AI에 보내고, 메모는 저장하지 않아요.</p>
        <BigButton onClick={run} disabled={busy || !text.trim()}>{busy ? "정리하는 중…" : "AI로 일지 정리"}</BigButton>
        {err && <p role="alert" className="text-sm font-bold text-destructive">{err}</p>}
        {sug && (
          <div className="rounded-xl border border-border bg-surface/60 p-3">
            {rows.length ? (
              <dl className="text-sm">
                {rows.map(([k, l]) => (
                  <div key={k} className="flex gap-3 border-b border-dashed border-border py-2 last:border-0">
                    <dt className="w-16 shrink-0 text-muted-foreground">{l}</dt>
                    <dd className="flex-1 font-semibold">{sug[k]}</dd>
                  </div>
                ))}
              </dl>
            ) : <p className="text-sm text-muted-foreground">나눌 내용을 찾지 못했어요.</p>}
            {rows.length > 0 && (
              <div className="mt-3 flex gap-2">
                <button className="flex-1 rounded-lg border border-border bg-card py-2.5 text-sm font-bold" onClick={() => setSug(null)}>버리기</button>
                <button className="btn-solid-primary flex-1 rounded-lg py-2.5 text-sm font-bold text-primary-foreground" onClick={() => { onApply(sug); setSug(null); toast.success("AI 제안을 일지에 넣었어요"); }}>적용</button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
