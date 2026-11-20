// 终端连接控制器：创建 / 按 id 接回 / 断线重连 / 结束判定。与 xterm、React 解耦，只通过回调汇报。
// 铁律（终端生命周期 R6）：id 失效或重连用尽时只汇报状态，绝不自行新建 shell；
// 新建只发生在「首次（tab 还没有 id）」和用户点「重新打开」两处。
import { type CallResult, loadToken } from "../../../../api/http";
import {
  closeTerminal,
  createTerminal,
  getTerminal,
  listTerminals,
  openTerminalSocket,
} from "../../../../api/terminals";
import type { FailCause, LinkState } from "./types";

/** 断线后第 n 次重连前的等待（毫秒）；用尽即进入 lost，等用户手动重试。 */
export const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15000] as const;

export interface LinkTarget {
  termId: string | undefined;
  termEnded: boolean;
  environmentId: string;
  cwd: string | undefined;
  sessionId: string | null;
  workspaceId: string | null;
}

export interface LinkOptions {
  target(): LinkTarget;
  size(): { cols: number; rows: number };
  /** 把终端 id / 已结束标记写回 tab。 */
  patch(p: { termId?: string; termEnded?: boolean }): void;
  write(data: Uint8Array): void;
  /** 每次（重）连上先清屏：服务端随后会回放最近输出，不清会重复。 */
  reset(): void;
  onState(s: LinkState): void;
}

type Failed = Extract<CallResult<unknown>, { ok: false }>;

function causeOf(r: Failed): FailCause {
  switch (r.kind) {
    // 终端数量上限的 429 不带 Retry-After；带了说明是通用限流。
    case "rate_limited":
      return r.retryAfter === null ? "limit" : "throttled";
    case "bad_request":
      return "invalid";
    case "not_found":
    case "network":
    case "unauthorized":
    case "forbidden":
      return r.kind;
    default:
      return "server";
  }
}

export class TerminalLink {
  private sock: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  // 已发起的重连次数，连上（ready）即清零。
  private attempts = 0;
  // 每次 create / dispose 递增，用来丢弃过期的异步结果。
  private gen = 0;
  private disposed = false;
  // 当前仍认为存活的终端；已结束或尚未创建时为 undefined。
  private id: string | undefined;

  constructor(private readonly o: LinkOptions) {}

  /** 有 id 且未结束 → 接回；有 id 且已结束 → 只展示；没有 id → 首次创建。 */
  start(): void {
    const t = this.o.target();
    if (t.termId && t.termEnded) {
      this.o.onState({ kind: "ended", reason: "gone", exitCode: null });
      return;
    }
    if (t.termId) {
      this.id = t.termId;
      this.o.onState({ kind: "connecting", stage: "attaching" });
      this.attach(t.termId);
      return;
    }
    void this.create();
  }

  /** 已结束态的「重新打开」：显式新建，成功后替换 termId 并清除 termEnded。 */
  reopen(): void {
    void this.create();
  }

  /** lost / failed 态的「重试」：有存活 id 就接回它，否则重走创建。 */
  retry(): void {
    if (this.id) {
      this.attempts = 0;
      this.o.onState({ kind: "connecting", stage: "attaching" });
      this.attach(this.id);
    } else {
      void this.create();
    }
  }

  input(data: string): void {
    this.send({ type: "input", data });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: "resize", cols, rows });
  }

  dispose(): void {
    this.disposed = true;
    this.gen++;
    clearTimeout(this.timer);
    this.closeSock();
  }

  private emit(s: LinkState): void {
    if (!this.disposed) this.o.onState(s);
  }

  private send(msg: object): void {
    if (this.sock?.readyState === 1) this.sock.send(JSON.stringify(msg));
  }

  private closeSock(): void {
    const s = this.sock;
    this.sock = null;
    s?.close();
  }

  private async create(): Promise<void> {
    const gen = ++this.gen;
    clearTimeout(this.timer);
    this.closeSock();
    this.emit({ kind: "connecting", stage: "creating" });
    const t = this.o.target();
    const { cols, rows } = this.o.size();
    const token = loadToken();
    const r = await createTerminal(token, {
      environmentId: t.environmentId,
      ...(t.cwd ? { cwd: t.cwd } : {}),
      cols,
      rows,
      ...(t.sessionId ? { sessionId: t.sessionId } : {}),
      ...(t.workspaceId ? { workspaceId: t.workspaceId } : {}),
    });
    if (this.disposed || gen !== this.gen) {
      // 等待期间已卸载或被新的操作取代：刚建好的终端没人引用，关掉以免占名额。
      if (r.ok) void closeTerminal(token, r.data.id);
      return;
    }
    if (!r.ok) {
      await this.fail(r, gen);
      return;
    }
    this.id = r.data.id;
    this.attempts = 0;
    this.o.patch({ termId: r.data.id, termEnded: false });
    this.emit({ kind: "connecting", stage: "attaching" });
    this.attach(r.data.id);
  }

  private async fail(r: Failed, gen: number): Promise<void> {
    const cause = causeOf(r);
    if (cause === "limit") {
      // 429 响应体里的上限数值被通用调用层丢掉了；达到上限时列表长度就是上限。
      const list = await listTerminals(loadToken());
      if (this.disposed || gen !== this.gen) return;
      this.emit({
        kind: "failed",
        cause,
        max: list.ok ? list.data.length : null,
      });
      return;
    }
    this.emit({
      kind: "failed",
      cause,
      ...(r.kind === "rate_limited" && r.retryAfter !== null
        ? { retryAfter: r.retryAfter }
        : {}),
    });
  }

  private attach(id: string): void {
    clearTimeout(this.timer);
    this.closeSock();
    const sock = openTerminalSocket(id, loadToken());
    this.sock = sock;
    let exited = false;

    sock.addEventListener("message", (ev) => {
      if (sock !== this.sock) return;
      if (typeof ev.data !== "string") {
        this.o.write(new Uint8Array(ev.data as ArrayBuffer));
        return;
      }
      let m: {
        type?: string;
        exitCode?: number | null;
        cols?: number;
        rows?: number;
      };
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === "ready") {
        this.attempts = 0;
        this.o.reset();
        this.emit({ kind: "live" });
        // 服务端记的尺寸可能和当前窗口不一致（多客户端、重连）。
        const { cols, rows } = this.o.size();
        if (m.cols !== cols || m.rows !== rows) this.resize(cols, rows);
      } else if (m.type === "exit") {
        exited = true;
        this.finish("exit", m.exitCode ?? null);
      }
    });

    // 握手失败时浏览器先发 error 再发 close，只处理 close。
    sock.addEventListener("close", () => {
      if (sock !== this.sock) return;
      this.sock = null;
      if (!exited) void this.dropped(id);
    });
  }

  // 连接掉了：先问服务端终端还在不在。不在 → 已结束；在或暂时问不到 → 退避重连。
  private async dropped(id: string): Promise<void> {
    const gen = this.gen;
    const r = await getTerminal(loadToken(), id);
    if (this.disposed || gen !== this.gen || this.sock) return;
    if (!r.ok && r.kind === "not_found") return this.finish("gone", null);
    if (!r.ok && r.kind === "unauthorized") {
      this.emit({ kind: "failed", cause: "unauthorized" });
      return;
    }
    this.reconnectLater(id);
  }

  private reconnectLater(id: string): void {
    const max = RECONNECT_DELAYS.length;
    if (this.attempts >= max) {
      this.emit({ kind: "lost", attempts: this.attempts });
      return;
    }
    const delay = RECONNECT_DELAYS[this.attempts] as number;
    this.attempts++;
    this.emit({ kind: "reconnecting", attempt: this.attempts, max });
    this.timer = setTimeout(() => {
      if (!this.disposed) this.attach(id);
    }, delay);
  }

  private finish(reason: "gone" | "exit", exitCode: number | null): void {
    this.id = undefined;
    clearTimeout(this.timer);
    this.closeSock();
    this.o.patch({ termEnded: true });
    this.emit({ kind: "ended", reason, exitCode });
  }
}
