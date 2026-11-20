// 页面级画面流：文本帧是页面状态 / 控制台 / 错误，二进制帧是 JPEG 画面。
// 断开后自动重连几次（照 useBrowserStream）；服务端发 closed（页面被关）之后不再重连。
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type ConsoleEntry,
  type InputEvent,
  openPageStream,
  type PageView,
  type StreamCommand,
  type StreamEvent,
} from "../../../api/browser";
import { createProbe, onForeground } from "../../../api/foreground";
import { loadToken } from "../../../api/http";
import { foldConsole } from "./model";

export interface PageStreamState {
  /** closed = 服务端发了 closed（页面被关） */
  link: "connecting" | "live" | "reconnecting" | "lost" | "closed";
  /** 最近一条 state 带来的页面 */
  page: PageView | null;
  /** 本连接此刻是不是操作窗口 */
  operator: boolean;
  /** 连接后新增的控制台条目，最多保留最近 500 条 */
  console: ConsoleEntry[];
  /** 最近一条 error；seq 每条加一，相同文字也能重新触发提示 */
  notice: { text: string; seq: number } | null;
  /** 最近一次 copy 的回答（页面里选中的文字，没选中是空串）；seq 每条加一，相同文字也能重新触发 */
  copied: { text: string; seq: number } | null;
  /** 页面自己写剪贴板的内容（用户操作期间 Server 推来）；seq 同 copied */
  pageCopy: { text: string; seq: number } | null;
}

export interface StreamSend {
  input(ev: InputEvent): void;
  nav(action: "back" | "forward" | "reload"): void;
  goto(target: string): void;
  copy(): void;
  take(): void;
}

export interface StreamDeps {
  open?: (wid: string, pid: string) => WebSocket;
  retryMs?: number;
  maxRetries?: number;
}

const INITIAL_PAGE_STREAM: PageStreamState = {
  link: "connecting",
  page: null,
  operator: false,
  console: [],
  notice: null,
  copied: null,
  pageCopy: null,
};

// 每收到一帧画面就确认一次，服务端靠它限制在路上的画面量（慢链路上不堆成陈旧的画面）
const ACK = JSON.stringify({ type: "ack" } satisfies StreamCommand);

const RETRY_MS = 3000;
const MAX_RETRIES = 5;
const CONSOLE_MAX = 500;

// 一条连接的命令出口；连接断了、不是 live、或页面已关时静默丢弃（不排队）。
interface Conn {
  send(cmd: StreamCommand): void;
  retry(): void;
}

const isEvent = (m: unknown): m is StreamEvent => {
  const type = (m as { type?: unknown } | null)?.type;
  return (
    type === "state" ||
    type === "console" ||
    type === "copied" ||
    type === "clipboard" ||
    type === "error" ||
    type === "closed"
  );
};

export function usePageStream(
  workspaceId: string,
  pageId: string | null,
  canvas: RefObject<HTMLCanvasElement | null>,
  deps?: StreamDeps,
): PageStreamState & {
  send: StreamSend;
  retry(): void;
  clearNotice(): void;
} {
  const [state, setState] = useState<PageStreamState>(INITIAL_PAGE_STREAM);
  const conn = useRef<Conn | null>(null);
  // 测试注入的依赖每次渲染都可能是新对象，别让它触发重连
  const injected = useRef(deps);
  injected.current = deps;
  const seq = useRef(0);

  useEffect(() => {
    if (pageId === null) {
      conn.current = null;
      setState(INITIAL_PAGE_STREAM);
      return;
    }

    const cfg = injected.current;
    const open =
      cfg?.open ??
      ((wid: string, pid: string) => openPageStream(wid, pid, loadToken()));
    const retryMs = cfg?.retryMs ?? RETRY_MS;
    const maxRetries = cfg?.maxRetries ?? MAX_RETRIES;

    let alive = true;
    let sock: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let drawn = 0;
    let live = false;
    // 服务端发过 closed：页面已经没了，断开也不再重连
    let ended = false;

    setState(INITIAL_PAGE_STREAM);

    const update = (p: Partial<PageStreamState>) => {
      if (alive) setState((s) => ({ ...s, ...p }));
    };

    const draw = (data: ArrayBuffer) => {
      if (typeof createImageBitmap !== "function") return;
      const n = ++drawn;
      createImageBitmap(new Blob([data], { type: "image/jpeg" }))
        .then((bm) => {
          const el = canvas.current;
          const ctx = el?.getContext("2d");
          // 解码是异步的：只画最新一帧，旧帧晚到就丢
          if (!alive || !el || !ctx || n !== drawn) return bm.close();
          // 给 canvas 的 width / height 赋值会清空并重建位图，每帧都赋就是白白的开销：尺寸变了才赋。
          if (el.width !== bm.width) el.width = bm.width;
          if (el.height !== bm.height) el.height = bm.height;
          ctx.drawImage(bm, 0, 0);
          bm.close();
        })
        .catch(() => {});
    };

    const onText = (raw: string) => {
      let msg: StreamEvent;
      try {
        msg = JSON.parse(raw) as StreamEvent;
      } catch {
        return;
      }
      if (!isEvent(msg)) return;
      if (msg.type === "state")
        return update({ page: msg.page, operator: msg.operator });
      if (msg.type === "console")
        return setState((s) =>
          alive
            ? { ...s, console: foldConsole(s.console, msg.entry, CONSOLE_MAX) }
            : s,
        );
      if (msg.type === "copied")
        return update({ copied: { text: msg.text, seq: ++seq.current } });
      if (msg.type === "clipboard")
        return update({ pageCopy: { text: msg.text, seq: ++seq.current } });
      if (msg.type === "error")
        return update({ notice: { text: msg.message, seq: ++seq.current } });
      ended = true;
      live = false;
      update({ link: "closed" });
    };

    const connect = () => {
      timer = undefined;
      if (!alive) return;
      const ws = open(workspaceId, pageId);
      sock = ws;
      ws.onopen = () => {
        if (!alive || sock !== ws) return;
        failures = 0;
        live = true;
        update({ link: "live" });
      };
      ws.onmessage = (e) => {
        if (!alive || sock !== ws) return;
        probe.settle();
        if (typeof e.data === "string") onText(e.data);
        else if (e.data instanceof ArrayBuffer) {
          ws.send(ACK);
          draw(e.data);
        }
      };
      ws.onclose = () => {
        if (!alive || sock !== ws) return;
        sock = null;
        live = false;
        probe.cancel();
        // 服务端已经说过页面被关：停下，等界面切到别的页面
        if (ended) return update({ link: "closed" });
        failures += 1;
        if (failures > maxRetries) return update({ link: "lost" });
        update({ link: "reconnecting" });
        timer = setTimeout(connect, retryMs);
      };
      ws.onerror = () => ws.close();
    };

    const retry = () => {
      if (!alive) return;
      clearTimeout(timer);
      probe.cancel();
      failures = 0;
      ended = false;
      live = false;
      const old = sock;
      sock = null;
      old?.close();
      update({ link: "connecting" });
      connect();
    };

    // 回前台：连着的探一下还活不活（死了就重连），在退避里等着或已放弃的立即重连；首次连接还在路上、页面已被关的不动。
    const probe = createProbe(
      () => {
        if (!live || !sock) return false;
        sock.send(JSON.stringify({ type: "ping" }));
        return true;
      },
      () => retry(),
    );
    const offForeground = onForeground(() => {
      if (live) probe.start();
      else if (!sock && !ended) retry();
    });

    conn.current = {
      send(cmd) {
        if (!alive || !live || !sock) return;
        sock.send(JSON.stringify(cmd));
      },
      retry,
    };
    connect();

    return () => {
      alive = false;
      live = false;
      conn.current = null;
      clearTimeout(timer);
      offForeground();
      probe.cancel();
      const ws = sock;
      sock = null;
      ws?.close();
    };
  }, [workspaceId, pageId, canvas]);

  const send: StreamSend = {
    input: (ev) => conn.current?.send({ type: "input", event: ev }),
    nav: (action) => conn.current?.send({ type: "nav", action }),
    goto: (target) =>
      conn.current?.send({ type: "nav", action: "goto", target }),
    copy: () => conn.current?.send({ type: "copy" }),
    take: () => conn.current?.send({ type: "take" }),
  };

  const retry = useCallback(() => conn.current?.retry(), []);
  const clearNotice = useCallback(
    () => setState((s) => (s.notice === null ? s : { ...s, notice: null })),
    [],
  );

  return { ...state, send, retry, clearNotice };
}
