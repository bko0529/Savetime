import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TeamQrScanner } from "@/components/team-qr-scanner";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("팀 QR 스캔 화면", () => {
  it("카메라를 못 쓰면 코드 입력을 안내하고, 닫기를 누르면 닫힌다", async () => {
    // jsdom 에는 카메라(mediaDevices)가 없다 = 카메라를 못 쓰는 폰
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const onClose = vi.fn();
    render(<TeamQrScanner onFound={vi.fn()} onClose={onClose} />);
    expect((await screen.findByRole("alert")).textContent).toContain("4자리 코드");
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalled();
  });
});
