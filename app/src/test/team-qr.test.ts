import { describe, expect, it, vi } from "vitest";

// jsQR 은 카메라 화면 한 장에서 QR 글자를 찾는다. 여기서는 찾은 글자만 흉내 낸다
const found = vi.hoisted(() => ({ data: null as string | null }));
vi.mock("jsqr", () => ({ default: vi.fn(() => (found.data === null ? null : { data: found.data })) }));

import { findTeamQr, parseTeamQr } from "@/lib/team-qr";

const frame = { data: new Uint8ClampedArray(4), width: 1, height: 1 } as ImageData;

describe("팀 QR 읽기 (SFR-159)", () => {
  it("우리 팀 QR 이면 토큰만 꺼낸다", () => {
    expect(parseTeamQr("savetime:team:abc123")).toBe("abc123");
    expect(parseTeamQr("  savetime:team:abc123 \n")).toBe("abc123");
  });
  it("다른 QR·빈 토큰은 무시한다", () => {
    expect(parseTeamQr("https://example.com")).toBeNull();
    expect(parseTeamQr("savetime:team:")).toBeNull();
    expect(parseTeamQr("savetime:team:" + "x".repeat(201))).toBeNull();
  });
  it("카메라 화면에서 QR 을 찾으면 토큰, 못 찾거나 다른 QR 이면 null", () => {
    found.data = "savetime:team:tok-9";
    expect(findTeamQr(frame)).toBe("tok-9");
    found.data = "WIFI:S:cafe;;";
    expect(findTeamQr(frame)).toBeNull();
    found.data = null;
    expect(findTeamQr(frame)).toBeNull();
  });
});
