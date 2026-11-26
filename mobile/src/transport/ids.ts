/**
 * UUID v4 (이송 건 id · Idempotency-Key). 앱에서 웹의 crypto.randomUUID 가 없을 수 있어서 직접 만든다.
 * 중복만 피하면 되는 값이라(비밀 값 아님) Math.random 으로 충분하다. 서버는 같은 키를 한 번만 처리한다
 */
export function uuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === 'function') return g.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
