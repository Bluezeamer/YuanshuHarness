// 浏览器数据层的测试替身（只被 *.test.* 引用，不进产物）。
// 终端的 testkit.FakeSocket 没有「握手成功」与画面帧之外的接口，属性式回调也不支持，这里单独造一个。
import type { PageView } from "../../../api/browser";

type Listener = (ev?: unknown) => void;

export class FakeSocket {
  static all: FakeSocket[] = [];
  static get last(): FakeSocket {
    const s = FakeSocket.all.at(-1);
    if (!s) throw new Error("还没有打开过 WebSocket");
    return s;
  }
  static reset() {
    FakeSocket.all = [];
  }

  readyState = 0;
  closed = false;
  /** 发出去的 JSON 文本帧（已解析） */
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private ls: Record<string, Listener[]> = {};

  constructor(public id: string) {
    FakeSocket.all.push(this);
  }

  // 两种监听方式都支持：store 用属性，组件里可能用 addEventListener。
  addEventListener(t: string, fn: Listener) {
    this.ls[t] = [...(this.ls[t] ?? []), fn];
  }
  private fire(t: string, ev?: unknown) {
    for (const fn of this.ls[t] ?? []) fn(ev);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
    this.fire("close");
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
    this.fire("open");
  }
  serve(o: unknown) {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify(o) });
    this.fire("message", { data: JSON.stringify(o) });
  }
  serveText(raw: string) {
    this.readyState = 1;
    this.onmessage?.({ data: raw });
    this.fire("message", { data: raw });
  }
  serveBytes(b: Uint8Array) {
    this.readyState = 1;
    this.onmessage?.({ data: b.buffer });
    this.fire("message", { data: b.buffer });
  }
  // 对端断开：浏览器只触发 close。
  drop() {
    this.readyState = 3;
    this.onclose?.();
    this.fire("close");
  }
}

let seq = 0;

/** 造一个页面：不给 id 就自动编号，其余字段给默认值。 */
export const pageView = (over: Partial<PageView> = {}): PageView => {
  const id = over.id ?? `p${++seq}`;
  return {
    id,
    workspaceKey: "w",
    url: `https://example.org/${id}`,
    title: `页面 ${id}`,
    state: "active",
    controller: "agent",
    userOpened: false,
    usedBy: [],
    inUseBy: null,
    loading: false,
    hasThumb: false,
    epoch: 1,
    viewers: 0,
    handoffPending: false,
    handoffReason: null,
    pendingDownloads: [],
    pendingUpload: null,
    dialog: null,
    createdAt: "2026-11-12T08:00:00.000Z",
    lastUsedAt: "2026-11-12T08:00:00.000Z",
    ...over,
  };
};

export const engineState = (
  status: "idle" | "installing" | "starting" | "ready" | "failed" = "ready",
) =>
  ({
    status,
    executable: null,
    sandbox: null,
    emojiFont: null,
    problem: null,
  }) as const;

export const limitsView = {
  perWorkspace: 12,
  global: 30,
  sleepingPerWorkspace: 100,
};
