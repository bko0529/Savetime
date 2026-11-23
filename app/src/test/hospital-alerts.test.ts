import { describe, it, expect, beforeEach } from "vitest";
import { hospitalAlerts, unacceptableText } from "@/lib/hospital-alerts";

beforeEach(() => {
  hospitalAlerts.clearMemo();
  hospitalAlerts.clearUnacceptable();
});

describe("병원 경보 (SFR-140 추가 메모 · SFR-158 수용 불가)", () => {
  it("수용 불가 사유 코드를 화면 문구로 바꾼다", () => {
    expect(unacceptableText("er_bed")).toBe("응급실 병상 부족");
    expect(unacceptableText("no_specialist")).toBe("해당 전문의 부재");
    expect(unacceptableText("etc")).toBe("기타 사유");
    expect(unacceptableText("")).toBe("사유 미상");
  });

  it("추가 메모 경보는 병원 이름·메모를 담고, 닫으면 사라진다", () => {
    hospitalAlerts.showMemo({ hospitalName: "천안중앙병원", memo: "2번 입구로 오세요" });
    expect(hospitalAlerts.get().memo).toMatchObject({
      hospitalName: "천안중앙병원",
      memo: "2번 입구로 오세요",
    });
    hospitalAlerts.clearMemo();
    expect(hospitalAlerts.get().memo).toBeNull();
  });

  it("수용 불가 경보는 '다시 요청하기'에 쓸 이송 건 ID 를 들고 있다", () => {
    hospitalAlerts.showUnacceptable({
      transportId: "t-1",
      hospitalName: "단국의료원",
      reason: "icu",
    });
    const a = hospitalAlerts.get().unacceptable;
    expect(a).toMatchObject({ transportId: "t-1", hospitalName: "단국의료원" });
    expect(unacceptableText(a!.reason)).toBe("중환자실 부족");
    // 추가 메모 경보와 따로 관리한다
    expect(hospitalAlerts.get().memo).toBeNull();
    hospitalAlerts.clearUnacceptable();
    expect(hospitalAlerts.get().unacceptable).toBeNull();
  });
});
