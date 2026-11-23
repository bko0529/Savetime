import { describe, it, expect } from "vitest";
import {
  initialAuth,
  type AuthState,
  type Account,
  type Duty,
  type ServerTeam,
  passwordOk,
  signupError,
  driverTaken,
  dutyExpired,
  versionBelow,
  inviteLeft,
  inviteExpired,
  expiredInvites,
  toAccount,
  toDuty,
  toIncoming,
  INVITE_MS,
} from "@/lib/auth-store";

import { gateTarget } from "@/components/app-gate";

// 로그인·잠금(5번 틀리면 10분)은 서버가 판단한다 (SER-011). 여기서는 화면 순서 규칙과 서버 응답을 화면 모양으로 바꾸는 것만 본다
const ready = (): AuthState => ({
  ...initialAuth(),
  consent: "agreed",
  permissions: { location: "granted", phone: "granted", notify: "granted" },
});

const account = (status: Account["status"] = "approved"): Account => ({
  loginId: "demo-kim",
  paramedicId: 7,
  name: "김구조",
  rank: "소방교",
  orgCode: "",
  orgName: "천안동남소방서",
  center: "신부119안전센터",
  employeeNo: "",
  status,
  appliedAt: "-",
});
const loggedIn = (status: Account["status"] = "approved"): AuthState => ({
  ...ready(),
  session: "demo-kim",
  accounts: { "demo-kim": account(status) },
  tokens: { accessToken: "a", refreshToken: "r" },
});
const duty = (over: Partial<Duty> = {}): Duty => ({
  started: true,
  startedAt: new Date().toISOString(),
  teamId: 1,
  teamCode: "1234",
  qrToken: "q",
  isCreator: true,
  role: "처치",
  members: [],
  maxMembers: 4,
  ...over,
});

describe("첫 사용 · 로그인 · 근무 순서 (요구사항 v1.4)", () => {
  it("위치 동의를 안 하면 동의 화면에서 못 벗어난다 (SFR-041)", () => {
    expect(gateTarget({ ...initialAuth(), consent: "refused" }, "/login")).toBe("/welcome");
  });
  it("위치 권한을 거부하면 권한 화면에서 못 넘어간다 (SFR-092)", () => {
    const a = {
      ...ready(),
      permissions: {
        location: "denied" as const,
        phone: "granted" as const,
        notify: "granted" as const,
      },
    };
    expect(gateTarget(a, "/login")).toBe("/permissions");
  });
  it("로그인 전에는 로그인·가입 화면만", () => {
    expect(gateTarget(ready(), "/")).toBe("/login");
    expect(gateTarget(ready(), "/signup")).toBeNull();
  });
  it("근무 중이면 로그인 화면으로 보내지 않는다 (SFR-018)", () => {
    expect(gateTarget({ ...loggedIn(), duty: duty() }, "/")).toBeNull();
  });
  it("팀은 만들었지만 '근무 시작'을 누르기 전이면 근무 화면에 머문다", () => {
    expect(gateTarget({ ...loggedIn(), duty: duty({ started: false }) }, "/")).toBe("/duty");
  });
  it("승인 전 계정은 승인 대기 화면만 볼 수 있다 (SFR-022)", () => {
    expect(gateTarget(loggedIn("pending"), "/")).toBe("/pending");
    expect(gateTarget(loggedIn("pending"), "/signup")).toBe("/pending");
  });
  it("반려된 계정은 가입 화면에서 다시 신청할 수 있다", () => {
    expect(gateTarget(loggedIn("rejected"), "/signup")).toBeNull();
  });
  it("비밀번호는 8자 이상 영문+숫자 (SER-006)", () => {
    expect(passwordOk("abcdefgh")).toBe(false);
    expect(passwordOk("abc12345")).toBe(true);
    expect(passwordOk("ab1234")).toBe(false);
  });
  it("공무원증 사진이나 사진 동의가 없으면 가입 신청할 수 없다 (SFR-017)", () => {
    const f = {
      orgCode: "DEMO-AG",
      name: "최진아",
      center: "신부119안전센터",
      employeeNo: "2024-0001",
      loginId: "jina01",
      pw: "abc12345",
      photo: "id.jpg",
      agree: true,
    };
    expect(signupError(f)).toBeNull();
    expect(signupError({ ...f, photo: null })).toBeTruthy();
    expect(signupError({ ...f, agree: false })).toBeTruthy();
    expect(signupError({ ...f, orgCode: " " })).toBeTruthy();
  });
  it("운전은 팀에 1명 (SFR-113)", () => {
    expect(
      driverTaken([{ loginId: "x", name: "", rank: "", center: "", employeeNo: "", role: "운전" }]),
    ).toBe(true);
  });
  it("근무 시작 후 14시간이 지나면 근무가 끝난다 (SER-007)", () => {
    const t = Date.now();
    const d = (h: number) => duty({ startedAt: new Date(t - h * 3600_000).toISOString() });
    expect(dutyExpired(d(13.9), t)).toBe(false);
    expect(dutyExpired(d(14), t)).toBe(true);
  });
  it("앱 버전이 서버 최소 버전보다 낮으면 업데이트 안내만 (SFR-142)", () => {
    expect(versionBelow("1.4.2", "1.10.0")).toBe(true);
    expect(gateTarget({ ...ready(), serverMinVersion: "9.0.0" }, "/")).toBe("/update");
  });
});

describe("서버 응답 → 화면 모양", () => {
  it("내 정보: 소방서·안전센터·반려 사유를 화면 문구로", () => {
    const acc = toAccount(
      {
        id: 7,
        name: "김구조",
        rank: "소방교",
        agency: "천안동남소방서",
        safetyCenter: "신부119안전센터",
        status: "rejected",
        rejectReason: "photo_unclear",
        appliedAt: null,
        mustChangePassword: false,
        teamId: null,
        hasActiveTransport: false,
      },
      "demo-kim",
    );
    expect(acc.paramedicId).toBe(7);
    expect(acc.orgName).toBe("천안동남소방서");
    expect(acc.rejectReason).toContain("흐려서");
  });
  it("팀: 나는 빼고 팀원만, 역할은 운전·처치로. 같은 팀이면 시작 시각·근무 시작 여부를 이어 쓴다", () => {
    const team: ServerTeam = {
      id: 3,
      code: "4821",
      qrToken: "qr",
      maxMembers: 4,
      members: [
        { paramedicId: 7, name: "김구조", rank: "소방교", role: "driver", isMe: true },
        { paramedicId: 8, name: "이구급", rank: "소방사", role: "care", isMe: false },
      ],
    };
    const first = toDuty(team, null, { at: 1000, isCreator: true, started: false });
    expect(first.role).toBe("운전");
    expect(first.members).toEqual([
      { loginId: "8", name: "이구급", rank: "소방사", center: "", employeeNo: "", role: "처치" },
    ]);
    expect(first.started).toBe(false);
    const again = toDuty(team, first);
    expect(again.startedAt).toBe(first.startedAt);
    expect(again.isCreator).toBe(true);
    expect(again.started).toBe(false);
    // 앱을 다시 켜서 서버에서 처음 받은 팀이면 이미 근무 중
    expect(toDuty(team, null).started).toBe(true);
  });
});

describe("팀 초대 (SFR-159)", () => {
  const inv = toIncoming({
    inviteId: 5,
    teamCode: "4821",
    fromName: "이구급",
    expiresAt: new Date(1000 + INVITE_MS).toISOString(),
  });
  it("서버 초대 이벤트를 카드로: 만료 시각에서 5분을 거꾸로", () => {
    expect(inv.inviteId).toBe(5);
    expect(inv.from.name).toBe("이구급");
    expect(inv.sentAt).toBe(1000);
  });
  it("초대는 5분 뒤 만료되고, 만료된 초대는 목록에서 빠진다", () => {
    const a: AuthState = { ...loggedIn(), incoming: [inv] };
    expect(inviteLeft(inv, 1000 + 4 * 60_000)).toBe(60_000);
    expect(inviteExpired(inv, 1000 + 5 * 60_000)).toBe(true);
    expect(expiredInvites(a, 1000 + 5 * 60_000)?.incoming).toEqual([]);
    expect(expiredInvites(a, 1000 + 60_000)).toBeNull();
  });
  it("근무 전에도 초대 확인 화면에 머물 수 있다 (게이트)", () => {
    const a: AuthState = { ...loggedIn(), incoming: [inv] };
    expect(gateTarget(a, "/invite")).toBeNull();
    expect(gateTarget(a, "/duty")).toBeNull();
  });
});
