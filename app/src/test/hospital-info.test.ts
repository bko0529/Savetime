import { describe, it, expect } from "vitest";
import { bedAvail, capCount, type Hospital } from "@/lib/hospitals";
import { toAssessment } from "@/lib/engine";
import { emptyPatient, UNKNOWN } from "@/lib/transport-store";

const base: Hospital = {
  id: "1", name: "A병원", km: 2.1, min: 7, depts: [], caps: [], erPhone: "041-555-0101", mainPhone: "", bedsAt: "", grade: "대학병원급", phone: "",
};

describe("병원 정보 (SFR-007 · SFR-002 · SFR-089)", () => {
  it("병상 0개는 0, 정보 없음은 null 로 구분한다", () => {
    expect(bedAvail("0/10")).toBe(0);
    expect(bedAvail("3/12")).toBe(3);
    expect(bedAvail(undefined)).toBeNull();
  });

  it("추천 목록은 진료가능 개수만, 상세를 열면 항목으로 센다", () => {
    expect(capCount({ ...base, capCount: { available: 4, total: 6 } })).toEqual({ available: 4, total: 6 });
    const detail = { ...base, caps: [{ name: "[재관류중재술] 심근경색", available: true }, { name: "[응급투석] HD", available: false }] };
    expect(capCount({ ...detail, capCount: { available: 9, total: 9 } })).toEqual({ available: 1, total: 2 });
  });
});

describe("환자 정보 → 서버 평가 항목 (openapi Assessment, SER-012)", () => {
  it("화면 값을 서버 칸으로 바꾸고, 이름·연락처 같은 칸은 없다", () => {
    const a = toAssessment({
      ...emptyPatient, grade: "대학병원급", complaint: "흉통", sex: "남", age: "60대", consciousness: "말에 반응", bp: "160/95",
      pulse: "88", resp: "20", spo2: "93", painSite: "가슴", painScore: "8", onset: "30분 전", trauma: "없음", temp: "36.8", ktas: "2",
    });
    expect(a).toMatchObject({
      chiefComplaint: "흉통", sex: "M", ageBand: "60대", consciousness: "verbal", bp: "160/95", pulse: 88, spo2: 93, painScore: 8,
      trauma: "no", temp: 36.8, ktas: 2, unknownFields: [],
    });
    expect(Object.keys(a)).not.toContain("name");
  });

  it("'확인 불가'는 값 대신 unknownFields 로 보낸다", () => {
    const a = toAssessment({ ...emptyPatient, complaint: "의식 저하", sex: UNKNOWN, age: UNKNOWN, bp: UNKNOWN, pulse: UNKNOWN, trauma: UNKNOWN });
    expect(a.sex).toBe("U");
    expect(a.pulse).toBeNull();
    expect(a).not.toHaveProperty("bp");
    expect(a.trauma).toBe("unknown");
    expect(a.unknownFields).toEqual(expect.arrayContaining(["sex", "ageBand", "bp", "pulse", "trauma"]));
  });
});
