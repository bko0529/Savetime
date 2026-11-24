import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { emptyPatient, UNKNOWN, type Patient } from "@/lib/transport-store";

// 서버·실시간·로그인 상태를 흉내 낸다
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  handlers: new Map<string, (e: unknown) => void>(),
}));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: mocks.api }));
vi.mock("@/lib/realtime", () => ({
  onEvent: (name: string, fn: (e: unknown) => void) => {
    mocks.handlers.set(name, fn);
    return () => mocks.handlers.delete(name);
  },
  connectRealtime: vi.fn(),
  disconnectRealtime: vi.fn(),
  reconnectRealtime: vi.fn(),
  acceptSeq: vi.fn(),
}));
vi.mock("@/lib/auth-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-store")>()),
  getAuth: () => ({ duty: { teamCode: "4850" } }),
  currentAccount: () => ({ name: "김처치" }),
}));

import { applyDraft, draftChanges, useTeamDraftSync } from "@/lib/team-draft";

const P = (over: Partial<Patient>): Patient => ({ ...emptyPatient, ...over });

describe("바뀐 칸만 서버 형식으로 (SFR-114)", () => {
  it("고친 칸만 보내고, 지운 칸은 null", () => {
    const prev = P({ complaint: "흉통", pulse: "120" });
    const next = P({ complaint: "흉통", pulse: "", sex: "남" });
    expect(draftChanges(prev, next)).toEqual({ pulse: null, sex: "M" });
  });
  it("병원 등급은 이 폰에만 있는 값이라 보내지 않는다", () => {
    expect(draftChanges(P({}), P({ grade: "권역센터" as Patient["grade"] }))).toBeNull();
  });
  it("'확인 불가'로 바꾸면 unknownFields 도 같이 보낸다", () => {
    const c = draftChanges(P({}), P({ bp: UNKNOWN }));
    expect(c?.unknownFields).toContain("bp");
  });
});

describe("서버 값을 내 화면에 넣기", () => {
  const server = { chiefComplaint: "호흡곤란", sex: "F", pulse: 130, consciousness: "verbal", trauma: "no" };
  it("처음 열 때는 내 빈칸만 채우고, 내가 쓴 값은 그대로", () => {
    const mine = P({ complaint: "가슴 통증" });
    const out = applyDraft(mine, server);
    expect(out.complaint).toBe("가슴 통증");
    expect(out.sex).toBe("여");
    expect(out.pulse).toBe("130");
    expect(out.consciousness).toBe("말에 반응");
    expect(out.trauma).toBe("없음");
  });
  it("팀원이 고친 칸은 서버 값으로 바꾸고, 다른 칸은 건드리지 않는다", () => {
    const mine = P({ complaint: "가슴 통증", pulse: "100" });
    const out = applyDraft(mine, server, ["chiefComplaint"]);
    expect(out.complaint).toBe("호흡곤란");
    expect(out.pulse).toBe("100");
  });
});

describe("환자 정보 화면과 팀 작성 중 정보 맞추기", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.api.mockReset();
    mocks.handlers.clear();
  });
  afterEach(() => vi.useRealTimers());

  function setup(initial: Patient) {
    return renderHook(() => {
      const [p, setP] = useState(initial);
      const sync = useTeamDraftSync(p, setP);
      return { p, setP, sync };
    });
  }

  it("열면 팀원이 쓴 값을 받고, 내가 고친 칸은 잠깐 뒤 바뀐 칸만 보낸다", async () => {
    mocks.api.mockImplementation(async (method: string) =>
      method === "GET" ? { version: 3, assessment: { chiefComplaint: "흉통" } } : { version: 4 },
    );
    const h = setup(P({}));
    await act(async () => {});
    expect(h.result.current.p.complaint).toBe("흉통");

    act(() => h.result.current.setP({ ...h.result.current.p, pulse: "88" }));
    expect(mocks.api).toHaveBeenCalledTimes(1); // 타자 치는 중에는 안 보냄
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(mocks.api).toHaveBeenLastCalledWith("PATCH", "/teams/current/draft", {
      body: { baseVersion: 3, changes: { pulse: 88 } },
    });
  });

  it("팀원이 고쳤다는 알림을 받으면 그 칸 값만 받아 넣고 누가 고쳤는지 알려 준다", async () => {
    mocks.api.mockResolvedValueOnce({ version: 1, assessment: {} });
    const h = setup(P({ pulse: "100" }));
    await act(async () => {});
    mocks.api.mockResolvedValueOnce({ version: 2, assessment: { chiefComplaint: "의식 저하", pulse: 50 } });
    await act(async () => {
      mocks.handlers.get("draft.updated")?.({ data: { version: 2, fields: ["chiefComplaint"], byName: "이운전", overwritten: [] } });
    });
    expect(h.result.current.p.complaint).toBe("의식 저하");
    expect(h.result.current.p.pulse).toBe("100");
    expect(h.result.current.sync.notice).toBe("이운전 대원이 환자 정보를 고쳤어요");
  });

  it("내가 보낸 변경 알림은 다시 받지 않는다", async () => {
    mocks.api.mockResolvedValueOnce({ version: 1, assessment: {} });
    setup(P({}));
    await act(async () => {});
    await act(async () => {
      mocks.handlers.get("draft.updated")?.({ data: { version: 2, fields: ["pulse"], byName: "김처치", overwritten: [] } });
    });
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it("직전 환자 정보로 채워졌으면 알려 주고, '지우기'를 누르면 서버와 내 화면을 비운다 (SFR-157)", async () => {
    mocks.api.mockResolvedValueOnce({ version: 5, assessment: { chiefComplaint: "지난 환자" }, prefilledFromTransportId: "t-1" });
    const h = setup(P({}));
    await act(async () => {});
    expect(h.result.current.sync.prevPatient).toBe(true);
    expect(h.result.current.p.complaint).toBe("지난 환자");
    mocks.api.mockResolvedValueOnce(undefined);
    await act(async () => {
      await h.result.current.sync.clearPrevPatient();
    });
    expect(mocks.api).toHaveBeenLastCalledWith("DELETE", "/teams/current/draft");
    expect(h.result.current.sync.prevPatient).toBe(false);
    expect(h.result.current.p.complaint).toBe("");
  });
});

describe("운전 중 입력 잠금 (SFR-115)", () => {
  it("운전 역할이 이동 중 시속 10km 이상이면 잠근다", async () => {
    const { driverLocked } = await import("@/lib/engine");
    expect(driverLocked("운전", "moving", 39.6)).toBe(true);
    expect(driverLocked("운전", "moving", 3)).toBe(false);
    expect(driverLocked("처치", "moving", 39.6)).toBe(false);
    expect(driverLocked("운전", "requesting", 39.6)).toBe(false);
    // 이 폰이 속도를 모르면 서버 판단에 맡긴다
    expect(driverLocked("운전", "moving", null)).toBe(false);
  });
});
