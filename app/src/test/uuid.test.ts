import { describe, expect, it } from "vitest";
import { uuid } from "@/lib/api";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("무작위 ID (휴대폰 http 시연)", () => {
  it("crypto.randomUUID 가 없어도(https 가 아닌 주소) UUID v4 모양을 만든다", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const a = uuid();
      const b = uuid();
      expect(a).toMatch(V4);
      expect(a).not.toBe(b);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });

  it("있으면 crypto.randomUUID 를 쓴다", () => {
    expect(uuid()).toMatch(V4);
  });
});
