// 终端测试共用替身（只被 *.test.* 引用，不进产物）：WebSocket 与 API 结果构造。
import type { TerminalStatus } from "../../../../api/terminals";

type Listener = (ev: { data?: unknown }) => void;

export class FakeSocket {
  static all: FakeSocket[] = [];
  static get last(): FakeSocket {
    const s = FakeSocket.all.at(-1);
    if (!s) throw new Error("还没有打开过 WebSocket");
    return s;
  }

  readyState = 0;
  closed = false;
  sent: Record<string, unknown>[] = [];
  private ls: Record<string, Listener[]> = {};

  constructor(public id: string) {
    FakeSocket.all.push(this);
  }

  addEventListener(t: string, fn: Listener) {
    this.ls[t] = [...(this.ls[t] ?? []), fn];
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  private fire(t: string, ev: { data?: unknown } = {}) {
    for (const fn of this.ls[t] ?? []) fn(ev);
  }

  serve(o: unknown) {
    this.readyState = 1;
    this.fire("message", { data: JSON.stringify(o) });
  }
  serveBytes(b: Uint8Array) {
    this.readyState = 1;
    this.fire("message", { data: b.buffer });
  }
  // 对端断开：浏览器只触发 close。
  drop() {
    this.readyState = 3;
    this.fire("close");
  }
}

export const ok = <T>(data: T) => ({ ok: true as const, data });
export const bad = (kind: string, extra: object = {}) => ({
  ok: false as const,
  kind,
  ...extra,
});

export const status = (
  id: string,
  over: Partial<TerminalStatus> = {},
): TerminalStatus => ({
  id,
  environmentId: "local",
  cwd: "/w",
  cols: 80,
  rows: 24,
  workspaceId: null,
  createdAt: "2026-10-25T08:00:00.000Z",
  attached: 0,
  paused: false,
  busy: false,
  ...over,
});
