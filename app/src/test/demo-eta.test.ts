import { describe, expect, it } from "vitest";
import { demoEtaMin } from "@/lib/engine";

describe("시연 위치로 달릴 때 남은 시간 (SFR-121)", () => {
  it("출발 때 길찾기 값에서 남은 거리 비율로 줄어든다 (화면마다 같은 값에서 이어지게)", () => {
    expect(demoEtaMin(1400, 1400, 6)).toBe(6);
    expect(demoEtaMin(700, 1400, 6)).toBe(3);
    expect(demoEtaMin(100, 1400, 6)).toBe(1);
    expect(demoEtaMin(3, 1400, 6)).toBe(0);
  });
  it("출발 때 값이 없으면 시연 속도로 계산한다", () => {
    expect(demoEtaMin(1320, 1320, null)).toBe(2);
  });
});
