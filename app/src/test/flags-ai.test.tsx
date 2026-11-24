import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { applyAiSuggestions, type AiSuggestions } from "@/lib/journal";
import { organizeJournalWithAi } from "@/lib/engine";
import { AiOrganize } from "@/components/ai-organize";

const SUG: AiSuggestions = {
  chiefComplaint: "흉통",
  history: "고혈압",
  treatment: "산소 4L",
  medicalDirection: null,
  other: null,
};

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AI 일지 정리 제안 적용 (SFR-167)", () => {
  it("주 호소·병력은 제안으로, 처치는 원래 소견 뒤에 붙인다", () => {
    const f = { complaint: "가슴 아픔", historyEtc: "", opinion: "통증 7/10", other: 1 };
    expect(applyAiSuggestions(f, SUG)).toEqual({
      complaint: "흉통",
      historyEtc: "고혈압",
      opinion: "통증 7/10 · 처치: 산소 4L",
      other: 1,
    });
  });
  it("제안이 비어 있으면 대원이 쓴 값을 그대로 둔다", () => {
    const f = { complaint: "가슴 아픔", historyEtc: "당뇨", opinion: "" };
    const empty = { chiefComplaint: null, history: " ", treatment: null, medicalDirection: null, other: null };
    expect(applyAiSuggestions(f, empty)).toEqual(f);
  });
});

describe("AI 일지 정리 서버 호출", () => {
  it("메모 앞뒤 공백을 빼고 보내고, 제안을 돌려받는다", async () => {
    const fetchFn = stubFetch(200, { suggestions: SUG, removedIdentifiers: 0 });
    const r = await organizeJournalWithAi("  흉통 30분 전  ");
    expect(r).toEqual({ ok: true, value: SUG });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/journal\/ai-organize$/);
    expect(JSON.parse(String(init.body))).toEqual({ text: "흉통 30분 전" });
  });
  it("기능이 꺼져 있으면(403) 서버 문구를 보여 준다", async () => {
    stubFetch(403, { error: { code: "FEATURE_DISABLED", message: "관리자가 끈 기능이에요" } });
    const r = await organizeJournalWithAi("메모");
    expect(r.ok).toBe(false);
  });
});

describe("AI 일지 정리 카드", () => {
  it("메모를 넣고 정리하면 제안이 보이고, '적용'을 눌러야 일지에 넣는다", async () => {
    stubFetch(200, { suggestions: SUG, removedIdentifiers: 0 });
    const onApply = vi.fn();
    render(<AiOrganize onApply={onApply} />);
    const run = screen.getByRole("button", { name: "AI로 일지 정리" });
    expect(run).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("AI에게 줄 메모"), { target: { value: "흉통" } });
    fireEvent.click(run);
    expect(await screen.findByText("산소 4L")).toBeDefined();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith(SUG);
  });
});
