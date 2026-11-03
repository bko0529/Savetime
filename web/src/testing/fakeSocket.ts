import { act } from '@testing-library/react';
import type { HospitalSocket } from '@/lib/realtime/hospitalSocket';

type Handler = (...args: unknown[]) => void;

// 진짜 서버 없이 Socket.IO 연결을 흉내 낸다. 테스트가 serverConnect·fire 로 서버 쪽 일을 일으킨다
export class FakeSocket {
  id: string | undefined;
  connected = false;
  /** alarm.resume 에 서버가 줄 답 */
  resumeOk = true;
  readonly emitted: { event: string; args: unknown[] }[] = [];
  private readonly handlers = new Map<string, Set<Handler>>();

  on(event: string, fn: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return this;
  }

  off(event: string, fn: Handler) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }

  connect() {
    return this;
  }

  disconnect() {
    this.connected = false;
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    this.emitted.push({ event, args });
    if (event === 'alarm.resume') (args[1] as (r: { ok: boolean }) => void)({ ok: this.resumeOk });
    return this;
  }

  // ---- 테스트에서 서버 쪽 일을 일으킬 때 ----
  serverConnect(id = 'sock-1') {
    this.id = id;
    this.connected = true;
    this.fire('connect');
  }

  serverDisconnect() {
    this.id = undefined;
    this.connected = false;
    this.fire('disconnect', 'transport close');
  }

  fire(event: string, ...args: unknown[]) {
    act(() => this.handlers.get(event)?.forEach((fn) => fn(...args)));
  }

  asSocket(): HospitalSocket {
    return this as unknown as HospitalSocket;
  }
}

export function envelope<T>(data: T) {
  const now = new Date().toISOString();
  return { seq: 1, room: 'hospital:1:on', occurredAt: now, serverNow: now, data };
}
