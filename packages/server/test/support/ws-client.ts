import WebSocket from "ws";
import { type Frame, waitFor } from "./frames.js";

export interface Ack {
  type: "ack";
  id?: string;
  ok: boolean;
  error?: { code: string; message: string };
}

// 协议客户端：收集信封与 ack，发命令并等对应 ack。
export class TestClient {
  readonly frames: Frame[] = [];
  readonly acks: Ack[] = [];
  closed: { code: number } | null = null;
  private n = 0;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "ack") this.acks.push(m);
      else this.frames.push(m);
    });
    ws.on("close", (code) => {
      this.closed = { code };
    });
  }

  static async connect(
    url: string,
    opts: ConstructorParameters<typeof WebSocket>[2] & { token?: string } = {},
  ): Promise<TestClient> {
    const { token, ...wsOpts } = opts;
    const ws = token
      ? new WebSocket(url, ["yuanshu.v1", `bearer.${token}`], wsOpts)
      : new WebSocket(url, wsOpts);
    const c = new TestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode}`)),
      );
    });
    return c;
  }

  types(): string[] {
    return this.frames.map((f) => f.type);
  }

  async command(
    type: string,
    extra: Record<string, unknown> = {},
  ): Promise<Ack> {
    const id = `c${++this.n}`;
    this.ws.send(JSON.stringify({ id, type, ...extra }));
    await waitFor(() => this.acks.some((a) => a.id === id), `ack ${id}`);
    return this.acks.find((a) => a.id === id) as Ack;
  }

  waitClosed(): Promise<number> {
    return waitFor(() => this.closed !== null, "连接关闭").then(
      () => (this.closed as { code: number }).code,
    );
  }

  close(): void {
    this.ws.terminate();
  }
}
