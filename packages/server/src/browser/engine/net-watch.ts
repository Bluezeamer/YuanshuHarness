// 网络请求的接线：把 Playwright 的请求事件记进每页一份的环形缓冲（最近的 500 条）。
// 只读观察：不拦截、不重放；请求体与响应体按需现取。
import type { Page, Request, Response } from "playwright-core";
import { NetworkBuffer, type NetworkInput } from "./network.js";
import type { NetworkBody, NetworkDetail, NetworkEntry } from "./types.js";

export interface NetworkWatch {
  list(): NetworkEntry[];
  evicted(): number;
  detail(id: number): Promise<NetworkDetail | null>;
  body(id: number, which: "request" | "response"): Promise<NetworkBody | null>;
}

const noop = () => {};

/** `content-type` 去掉参数部分并小写；没有这个头是空串。 */
function mimeOf(headers: Record<string, string>): string {
  const raw = headers["content-type"] ?? "";
  return (raw.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * 头：full 时用 allHeaders（含 cookie 这类安全相关的头），失败退回 headers，再失败就当没有
 * （读不到头不该让详情失败）。没有响应的请求 allHeaders 会一直等，调用方传 full: false。
 */
async function headersOf(
  target: Request | Response,
  full: boolean,
): Promise<Record<string, string>> {
  if (full) {
    try {
      return await target.allHeaders();
    } catch {}
  }
  try {
    return target.headers();
  } catch {}
  return {};
}

export function watchNetwork(page: Page, max = 500): NetworkWatch {
  const buffer = new NetworkBuffer(max);
  // Request → 编号：response / requestfinished / requestfailed 的事件里只有 Request。
  const ids = new WeakMap<Request, number>();
  // 编号 → Request：详情要回头查头。被缓冲挤出时同步删，不跟着页面活到关闭。
  const live = new Map<number, Request>();
  // 编号 → 开始时刻：算耗时用（WebSocket 没有 Request，也记在这里）。
  const starts = new Map<number, number>();

  /** 入缓冲并记下开始时刻；返回编号，同时清掉被挤出的那条的映射。 */
  const track = (input: NetworkInput): number => {
    const { entry, evicted } = buffer.push(input);
    starts.set(entry.id, input.ts);
    if (evicted !== null) {
      live.delete(evicted);
      starts.delete(evicted);
    }
    return entry.id;
  };

  /** 开始到此刻的毫秒数；开始时刻已被挤出就是 null。 */
  const elapsed = (id: number): number | null => {
    const start = starts.get(id);
    return start === undefined ? null : Math.max(0, Date.now() - start);
  };

  /** 发请求的 frame 是不是主 frame；service worker 发的请求取不到 frame，按 sub 算。 */
  const frameOf = (req: Request): "main" | "sub" => {
    try {
      return req.frame() === page.mainFrame() ? "main" : "sub";
    } catch {
      return "sub";
    }
  };

  page.on("request", (req) => {
    const url = req.url();
    // data: 与 blob: 不是网络请求。
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const id = track({
      ts: Date.now(),
      method: req.method(),
      url,
      type: req.resourceType(),
      frame: frameOf(req),
    });
    ids.set(req, id);
    live.set(id, req);
  });

  page.on("response", (res) => {
    const id = ids.get(res.request());
    if (id === undefined) return;
    buffer.update(id, { status: res.status(), mime: mimeOf(res.headers()) });
  });

  page.on("requestfinished", (req) => {
    const id = ids.get(req);
    if (id === undefined) return;
    buffer.update(id, { ms: elapsed(id) });
    // 字节数只有 requestfinished 之后才拿得到；取不到就留 null。
    void req
      .sizes()
      .then((s) => {
        buffer.update(id, { size: s.responseBodySize });
      })
      .catch(noop);
  });

  page.on("requestfailed", (req) => {
    const id = ids.get(req);
    if (id === undefined) return;
    buffer.update(id, {
      ms: elapsed(id),
      failure: req.failure()?.errorText ?? "request failed",
    });
  });

  // WebSocket 也记一条（帧内容不记）；连接关掉时补上耗时。
  page.on("websocket", (ws) => {
    const id = track({
      ts: Date.now(),
      method: "GET",
      url: ws.url(),
      type: "websocket",
      frame: "main",
    });
    ws.on("close", () => buffer.update(id, { ms: elapsed(id) }));
  });

  /** 取响应体：先用条目上的状态挡掉失败 / 未响应 / 未结束，这些都不能等 body()。 */
  const responseBody = async (
    entry: NetworkEntry,
    req: Request,
  ): Promise<NetworkBody> => {
    if (entry.failure !== null)
      return {
        ok: false,
        reason: `请求失败了（${entry.failure}），没有响应体`,
      };
    if (entry.status === null)
      return { ok: false, reason: "请求还没有响应（pending）" };
    // 必须早于 response.body()：没结束的响应（流式 / SSE）上它会一直等到结束。
    if (entry.ms === null)
      return {
        ok: false,
        reason: "响应还没传完（可能是流式连接），等它结束后再取",
      };
    const res = await req.response().catch(() => null);
    if (res === null) return { ok: false, reason: "请求还没有响应（pending）" };
    try {
      return {
        ok: true,
        mime: mimeOf(res.headers()),
        bytes: await res.body(),
      };
    } catch (err) {
      // 重定向的响应、导航后被浏览器回收的资源都会在这里抛：如实给出原因。
      const line =
        err instanceof Error ? err.message.split("\n")[0] : String(err);
      return { ok: false, reason: line || "取不到响应体" };
    }
  };

  return {
    list: () => buffer.list(),
    evicted: () => buffer.evicted(),
    async detail(id) {
      const entry = buffer.list().find((e) => e.id === id);
      if (!entry) return null;
      const req = live.get(id);
      // WebSocket 的连接没有 Request：只给条目本身。
      if (req === undefined)
        return {
          entry,
          requestHeaders: {},
          responseHeaders: null,
          requestBodyBytes: null,
        };
      // 还没收到响应的请求：response() / allHeaders() / sizes() 都会一直等到它响应或页面关闭，
      // 所以只用同步的 headers() 与 postDataBuffer()（请求体只取长度）。
      const answered = entry.status !== null;
      const res = answered ? await req.response().catch(() => null) : null;
      const [requestHeaders, responseHeaders] = await Promise.all([
        headersOf(req, answered),
        res === null ? null : headersOf(res, true),
      ]);
      return {
        entry,
        requestHeaders,
        responseHeaders,
        requestBodyBytes: req.postDataBuffer()?.length ?? 0,
      };
    },
    async body(id, which) {
      const entry = buffer.list().find((e) => e.id === id);
      if (!entry) return null;
      const req = live.get(id);
      if (req === undefined)
        return { ok: false, reason: "WebSocket 没有可读的请求体与响应体" };
      if (which === "request") {
        const bytes = req.postDataBuffer();
        if (bytes === null) return { ok: false, reason: "这个请求没有请求体" };
        const headers = await headersOf(req, entry.status !== null);
        return { ok: true, mime: mimeOf(headers), bytes };
      }
      return responseBody(entry, req);
    },
  };
}
