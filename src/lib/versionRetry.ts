import { ApiError } from "./api";

type Snapshot = { status: string | null; version: number };

/**
 * 이송 건 버전 충돌(409 VERSION_CONFLICT)을 한 번만 받아 준다.
 * 서버는 상태가 그대로여도 버전을 올릴 때가 있다 (운전 대원 폰이 경로 안내 담당을 맡을 때 등).
 * 그래서 거절되면 최신 상태를 다시 읽고, 상태가 누르기 전과 같으면 새 버전으로 한 번 더 보낸다.
 * 상태가 바뀌었으면(팀원이 이미 도착·취소 처리) 다시 보내지 않는다 → 덮어쓰기 방지(SFR-160)는 그대로.
 */
export async function retryOnVersionConflict(
  before: Snapshot,
  send: (version: number) => Promise<unknown>,
  reload: () => Promise<Snapshot>,
): Promise<void> {
  try {
    await send(before.version);
  } catch (e) {
    if (!(e instanceof ApiError && e.code === "VERSION_CONFLICT")) throw e;
    const now = await reload();
    if (now.status !== before.status || now.version === before.version) throw e;
    await send(now.version);
  }
}
