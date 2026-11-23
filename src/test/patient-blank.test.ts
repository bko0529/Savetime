import { describe, expect, it } from "vitest";
import { emptyPatient, filledCount, REQUIRED_FIELDS } from "@/lib/transport-store";

describe("새 이송의 환자 정보 시작 상태", () => {
  it("필수 12개 항목이 모두 비어 있다", () => {
    expect(REQUIRED_FIELDS).toHaveLength(12);
    expect(filledCount(emptyPatient)).toBe(0);
    REQUIRED_FIELDS.forEach((k) => expect(String(emptyPatient[k])).toBe(""));
  });

  it("선택 항목과 요청 병원 등급도 비어 있다", () => {
    expect(emptyPatient.grade).toBeNull();
    expect(emptyPatient.history).toBe("");
    expect(emptyPatient.temp).toBe("");
    expect(emptyPatient.glucose).toBe("");
    expect(emptyPatient.ktas).toBe("");
  });
});
