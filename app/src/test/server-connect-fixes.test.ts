import { describe, it, expect, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { retryOnVersionConflict } from "@/lib/versionRetry";
import { acceptSeq } from "@/lib/realtime";
import { reviveTimeline, fmtTime, emptyPatient } from "@/lib/transport-store";
import { mergePatient } from "@/lib/journal";
import type { JournalDraft } from "@/lib/engine";

describe("실시간 이벤트 번호 거르기", () => {
  it("이미 받은 번호는 버리고 새 번호는 받는다", () => {
    expect(acceptSeq(null, 5)).toEqual({ accept: true, last: 5 });
    expect(acceptSeq(5, 5)).toEqual({ accept: false, last: 5 });
    expect(acceptSeq(5, 4).accept).toBe(false);
    expect(acceptSeq(5, 6)).toEqual({ accept: true, last: 6 });
  });
  it("번호 0(강제 로그아웃 등 바로 보내는 이벤트)은 늘 받고 마지막 번호를 바꾸지 않는다 (SER-016)", () => {
    expect(acceptSeq(120, 0)).toEqual({ accept: true, last: 120 });
    expect(acceptSeq(null, 0)).toEqual({ accept: true, last: null });
  });
});

describe("기기에 저장한 시각", () => {
  it("글자로 돌아온 시각을 날짜로 되살려 일지 화면이 죽지 않는다", () => {
    const saved = JSON.parse(
      JSON.stringify({ callAt: new Date("2026-11-23T01:02:00Z"), arriveAt: "망가진 값" }),
    );
    const t = reviveTimeline(saved);
    expect(t.callAt).toBeInstanceOf(Date);
    expect(t.arriveAt).toBeUndefined();
    expect(fmtTime(t.callAt)).toMatch(/^\d\d:\d\d$/);
    expect(fmtTime("2026-11-23T01:02:00Z" as unknown as Date)).toMatch(/^\d\d:\d\d$/);
    expect(fmtTime(undefined)).toBe("");
  });
});

describe("일지: 서버 초안으로 빈칸 채우기 (SFR-164)", () => {
  const draft: JournalDraft = {
    departedAt: null,
    arrivedAt: null,
    distanceKm: 1.4,
    sex: "M",
    ageBand: "60대",
    chiefComplaint: "흉통",
    onsetAt: null,
    consciousness: "V",
    vitals: { sbp: 82, dbp: 50, pulse: 140, resp: 32, temp: null, spo2: 82, glucose: null },
    history: null,
    ktas: 2,
    hospitalName: "천안중앙병원",
  };
  it("팀원 폰처럼 비어 있으면 서버 값으로 채운다", () => {
    const p = mergePatient(emptyPatient, draft);
    expect(p).toMatchObject({
      complaint: "흉통",
      sex: "남",
      age: "60대",
      consciousness: "말에 반응",
      bp: "82/50",
      pulse: "140",
      spo2: "82",
      ktas: "2",
    });
  });
  it("이 폰에서 입력한 값은 덮어쓰지 않는다", () => {
    const p = mergePatient({ ...emptyPatient, complaint: "흉통, 식은땀", spo2: "77" }, draft);
    expect(p.complaint).toBe("흉통, 식은땀");
    expect(p.spo2).toBe("77");
  });
});

describe("도착·취소 버전 충돌 한 번 받아 주기 (SFR-160)", () => {
  const conflict = () => new ApiError(409, "VERSION_CONFLICT", "그사이 상태가 바뀌었어요");
  it("상태는 그대로이고 버전만 올랐으면 새 버전으로 한 번 더 보낸다", async () => {
    const sent: number[] = [];
    const send = vi.fn(async (v: number) => {
      sent.push(v);
      if (v === 3) throw conflict();
    });
    await retryOnVersionConflict({ status: "moving", version: 3 }, send, async () => ({
      status: "moving",
      version: 4,
    }));
    expect(sent).toEqual([3, 4]);
  });
  it("팀원이 이미 상태를 바꿨으면 다시 보내지 않고 오류를 그대로 알린다", async () => {
    const send = vi.fn(async () => {
      throw conflict();
    });
    await expect(
      retryOnVersionConflict({ status: "moving", version: 3 }, send, async () => ({
        status: "arrived",
        version: 4,
      })),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("다른 오류는 다시 읽지도 보내지도 않는다", async () => {
    const reload = vi.fn();
    const send = vi.fn(async () => {
      throw new ApiError(409, "INVALID_TRANSITION", "지금은 할 수 없어요");
    });
    await expect(
      retryOnVersionConflict({ status: "moving", version: 3 }, send, reload),
    ).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    expect(reload).not.toHaveBeenCalled();
  });
});
