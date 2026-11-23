import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envelope, FakeSocket } from "@/savetime-web/testing/fakeSocket";
import { fakeServer, renderWithQuery } from "@/savetime-web/testing/render";
import { HospitalHome } from "./HospitalHome";
vi.mock("@/savetime-web/savetime-web/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("@/savetime-web/lib/alarm/browserAlarm", () => ({
  unlockSound: vi.fn(async () => true),
  askNotificationPermission: vi.fn(async () => "granted"),
  notificationPermission: vi.fn(() => "granted"),
  startAlarmLoop: vi.fn(),
  stopAlarmLoop: vi.fn(),
  showRequestNotification: vi.fn(),
}));
const INCOMING = "GET /hw/incoming";
const SESSION = {
  hospital: { id: 1, name: "B병원" },
  pc: { id: 7, name: "접수대" },
  shift: { id: 5, staffName: "박서연", alarmOn: true },
};
function incoming(id, extra = {}) {
  return {
    id,
    label: `R-${id}`,
    summary: "남·60대 · 뇌출혈 의심",
    status: "confirmed",
    version: 1,
    etaMin: 7,
    hasLocation: true,
    changedFields: [],
    arrivedAt: null,
    canConfirmArrival: false,
    canMarkUnacceptable: false,
    extraMemoUsed: false,
    ...extra,
  };
}
const list = (...items) => ({
  status: 200,
  body: { items, serverNow: new Date().toISOString() },
});
let socket;
let server;
beforeEach(() => {
  socket = new FakeSocket();
  server = fakeServer({
    "GET /hw/session": { status: 200, body: SESSION },
    "GET /hw/requests?status=open": { status: 200, body: { items: [], nextCursor: null } },
    [INCOMING]: list(incoming(102)),
  });
  renderWithQuery(<HospitalHome createSocket={() => socket.asSocket()} />);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
// '도착 예정' 제목 아래 표
async function incomingTable() {
  const heading = await screen.findByRole("heading", { name: "도착 예정" });
  return heading.parentElement;
}
describe("도착 예정 목록 (SFR-121)", () => {
  it("우리 병원으로 확정된 환자를 '요약 · 이동 중 · 도착 예상 N분'으로 보여 준다", async () => {
    const section = await incomingTable();
    const row = (await within(section).findByText("R-102")).closest("tr");
    expect(row.textContent).toContain("남·60대 · 뇌출혈 의심");
    expect(row.textContent).toContain("이동 중");
    expect(row.textContent).toContain("도착 예상 7분");
  });
  it("구급차 위치·지도는 보여 주지 않는다 (D-71)", async () => {
    await screen.findByText("도착 예상 7분");
    expect(document.body.textContent).not.toMatch(/위도|경도|지도|km/);
    expect(document.querySelector("iframe, canvas, [data-map]")).toBeNull();
  });
  it("새로 확정·도착 예상 갱신·도착 알림이 오면 목록을 다시 받는다", async () => {
    await screen.findByText("도착 예상 7분");
    const before = server.callsTo(INCOMING).length;
    server.set(INCOMING, list(incoming(102, { etaMin: 3 })));
    socket.fire("incoming.updated", envelope({ requestId: 102, etaMin: 3 }));
    expect(await screen.findByText("도착 예상 3분")).toBeTruthy();
    server.set(INCOMING, list(incoming(102, { etaMin: 3 }), incoming(103, { etaMin: 15 })));
    socket.fire(
      "incoming.added",
      envelope({ requestId: 103, label: "R-103", etaMin: 15, hasLocation: true }),
    );
    expect(await screen.findByText("도착 예상 15분")).toBeTruthy();
    const arrivedAt = new Date(2026, 10, 3, 14, 5).toISOString();
    server.set(INCOMING, list(incoming(102, { status: "arrived", arrivedAt, etaMin: null })));
    socket.fire("incoming.arrived", envelope({ requestId: 102, arrivedAt, method: "button" }));
    expect(await screen.findByText("14:05 도착")).toBeTruthy();
    expect(server.callsTo(INCOMING).length).toBe(before + 3);
  });
  it("이송이 취소되면 목록에서 빠지고, 확인을 누를 때까지 이유를 보여 준다", async () => {
    await screen.findByText("도착 예상 7분");
    server.set(INCOMING, list());
    socket.fire("incoming.removed", envelope({ requestId: 102, reason: "cancelled" }));
    const notice = await screen.findByText("R-102 이송이 취소됐어요");
    await waitFor(() => expect(screen.queryByText("도착 예상 7분")).toBeNull());
    expect(screen.getByText("도착 예정 환자가 없어요.")).toBeTruthy();
    fireEvent.click(within(notice.closest("[role=alert]")).getByRole("button", { name: "확인" }));
    expect(screen.queryByText("R-102 이송이 취소됐어요")).toBeNull();
  });
  it("목적지가 바뀌거나 승인을 취소해도 이유를 보여 준다", async () => {
    await screen.findByText("도착 예상 7분");
    server.set(INCOMING, list());
    socket.fire("incoming.removed", envelope({ requestId: 102, reason: "dest_changed" }));
    expect(await screen.findByText("R-102 목적지가 다른 병원으로 바뀌었어요")).toBeTruthy();
    socket.fire("incoming.removed", envelope({ requestId: 104, reason: "approval_cancelled" }));
    expect(await screen.findByText("R-104 승인을 취소해서 도착 예정에서 빠졌어요")).toBeTruthy();
  });
  it("다시 연결되면 전체를 다시 받는다", async () => {
    await screen.findByText("도착 예상 7분");
    const before = server.callsTo(INCOMING).length;
    socket.serverConnect("sock-2");
    await waitFor(() => expect(server.callsTo(INCOMING).length).toBeGreaterThan(before));
  });
});
describe("도착 예정 목록의 추가 메모 (SFR-140)", () => {
  const EXTRA = "POST /hw/requests/102/extra-memo";
  it("이동 중 환자에 '추가 메모'를 보내면 목록을 다시 받고 버튼이 사라진다", async () => {
    server.set(EXTRA, { status: 204 });
    const section = await incomingTable();
    const row = (await within(section).findByText("R-102")).closest("tr");
    fireEvent.click(within(row).getByRole("button", { name: "추가 메모" }));
    const dialog = await screen.findByRole("dialog");
    server.set(INCOMING, list(incoming(102, { extraMemoUsed: true, version: 2 })));
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "CT 고장, 2번 입구로 오세요" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "추가 메모 보내기" }));
    await waitFor(() => expect(server.callsTo(EXTRA)).toHaveLength(1));
    expect(server.callsTo(EXTRA)[0].body).toEqual({
      memo: "CT 고장, 2번 입구로 오세요",
      version: 1,
    });
    await waitFor(() =>
      expect(within(section).queryByRole("button", { name: "추가 메모" })).toBeNull(),
    );
  });
  it("이미 보냈거나 도착한 환자에는 버튼이 없다", async () => {
    server.set(
      INCOMING,
      list(
        incoming(102, { extraMemoUsed: true }),
        incoming(103, { status: "arrived", arrivedAt: new Date().toISOString(), etaMin: null }),
      ),
    );
    socket.fire("incoming.updated", envelope({ requestId: 102 }));
    const section = await incomingTable();
    await within(section).findByText("R-103");
    expect(within(section).queryByRole("button", { name: "추가 메모" })).toBeNull();
  });
});
describe("도착 예정 실시간 (SFR-144·105)", () => {
  it("구급차가 입구 200m 안에 들어오면(incoming.near) 목록을 다시 받아 도착 확인 버튼이 켜진다", async () => {
    const section = await incomingTable();
    const row = () => within(section).getByText("R-102").closest("tr");
    await waitFor(() =>
      expect(within(row()).getByRole("button", { name: "도착 확인" })).toHaveProperty(
        "disabled",
        true,
      ),
    );
    server.set(INCOMING, list(incoming(102, { canConfirmArrival: true })));
    socket.fire("incoming.near", envelope({ requestId: 102 }));
    await waitFor(() =>
      expect(within(row()).getByRole("button", { name: "도착 확인" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
  });
  it("번호를 누르면 확정된 요청의 상세가 열리고, 환자 정보가 바뀌면 새로 받는다", async () => {
    const DETAIL = "GET /hw/requests/102";
    const body = (spo2) => ({
      status: 200,
      body: {
        id: 102,
        label: "R-102",
        status: "confirmed",
        version: 1,
        serverNow: new Date().toISOString(),
        assessment: { chiefComplaint: "흉통", spo2, unknownFields: [] },
        abnormalFields: ["spo2"],
        ourHospital: { capability: null, beds: { er: "5/20", icu: null, or: null } },
      },
    });
    server.set(DETAIL, body(85));
    const section = await incomingTable();
    fireEvent.click(await within(section).findByRole("button", { name: "R-102" }));
    expect(await screen.findByText("⚠ 85%")).toBeTruthy();
    // 남은 시간만 바뀐 때는 상세를 다시 받지 않는다 (열람 기록이 1분마다 쌓이지 않게)
    socket.fire("incoming.updated", envelope({ requestId: 102, etaMin: 5 }));
    await waitFor(() => expect(server.callsTo(INCOMING).length).toBeGreaterThan(1));
    expect(server.callsTo(DETAIL)).toHaveLength(1);
    server.set(DETAIL, body(77));
    socket.fire("incoming.updated", envelope({ requestId: 102, changedFields: ["spo2"] }));
    expect(await screen.findByText("⚠ 77%")).toBeTruthy();
    expect(server.callsTo(DETAIL)).toHaveLength(2);
  });
});
