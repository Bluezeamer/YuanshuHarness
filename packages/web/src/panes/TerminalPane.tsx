import type { Terminal } from "@xterm/xterm";
import { useContext, useEffect, useRef, useState } from "react";
import { loadToken } from "../api";
import { EnvContext } from "../layout/env";
import type { PaneProps } from "../layout/types";
import {
  closeTerminal,
  createTerminal,
  openTerminalSocket,
  type TerminalInfo,
} from "./api";
import { useHost } from "./host";

export interface TerminalConfig {
  // tab 上的副标题（环境:目录），创建成功后写入，刷新页面后仍在。
  label: string | null;
}

type State =
  | { kind: "starting" }
  | { kind: "live" }
  | { kind: "exited"; code: number | null }
  | { kind: "dropped" }
  | { kind: "error"; message: string };

// 终端创建时钉死的主机：之后切换活动会话不会动正在跑的 shell。
interface Target {
  environmentId: string;
  environmentName: string;
  cwd: string | null;
  sessionId: string | null;
}

const idKey = (paneId: string) => `yuanshu.terminal.${paneId}`;

// xterm 体积大，用到时才取；构建产物里它只在这块懒加载 chunk 里。
const loadXterm = () =>
  Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);

// xterm 的主题只认 hex / rgb。把样式变量经 canvas 取成 hex，终端才能跟着样式走。
function cssColor(name: string): string | undefined {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  ctx.fillRect(0, 0, 1, 1);
  const px = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[px[0], px[1], px[2]].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? "/";

const STATUS: Record<State["kind"], { text: string; dot: string }> = {
  starting: { text: "连接中", dot: "bg-warn dot-run" },
  live: { text: "运行中", dot: "bg-ok" },
  exited: { text: "已退出", dot: "bg-mute" },
  dropped: { text: "连接已断开", dot: "bg-danger" },
  error: { text: "无法打开", dot: "bg-danger" },
};

const btn =
  "rounded-md border border-line px-2 py-0.5 text-[11px] font-semibold text-ink hover:bg-ink hover:text-bg";

export function TerminalPane({
  paneId,
  config,
  focused,
  binding,
  onUpdateConfig,
}: PaneProps<TerminalConfig>) {
  const env = useContext(EnvContext);
  const host = useHost(binding);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [state, setState] = useState<State>({ kind: "starting" });
  // 「重连」「重新打开」都靠递增它来重跑连接 effect。
  const [attempt, setAttempt] = useState(0);
  const termRef = useRef<Terminal | null>(null);
  // 回调、配置与焦点放 ref：连接 effect 不该因为它们的身份变化而重连。
  const latest = useRef({ config, onUpdateConfig, env });
  latest.current = { config, onUpdateConfig, env };
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  // 第一次拿到主机就定下来，之后不再跟随。
  useEffect(() => {
    if (target || !host.ready) return;
    setTarget({
      environmentId: host.environmentId,
      environmentName: host.environmentName,
      cwd: host.root,
      sessionId: host.sessionId,
    });
  }, [target, host]);

  // 真正卸载（pane 被关）才关服务端终端。StrictMode 的模拟卸载会在同一轮里重新挂载，
  // 用微任务等它复位标志，避免刷新后的开发环境误杀。
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      queueMicrotask(() => {
        if (!gone.current) return;
        const id = sessionStorage.getItem(idKey(paneId));
        if (!id) return;
        sessionStorage.removeItem(idKey(paneId));
        void closeTerminal(loadToken(), id);
      });
    };
  }, [paneId]);

  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  useEffect(() => {
    if (!box || !target) return;
    // attempt 只用来触发重跑
    void attempt;
    let disposed = false;
    let ws: WebSocket | null = null;
    let ro: ResizeObserver | null = null;
    let t: Terminal | null = null;
    const token = loadToken();
    const denied = () => latest.current.env?.hub.onUnauthorized();
    const fail = (message: string) => setState({ kind: "error", message });
    setState({ kind: "starting" });

    // 原终端已不存在（Server 重启、被回收）时新开一个。
    const create = async (term: Terminal): Promise<TerminalInfo | null> => {
      const r = await createTerminal(token, {
        environmentId: target.environmentId,
        ...(target.cwd ? { cwd: target.cwd } : {}),
        cols: term.cols,
        rows: term.rows,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      });
      if (disposed) {
        // 等待期间已卸载：刚建好的终端没人用，直接关掉。
        if (r.ok) void closeTerminal(token, r.data.id);
        return null;
      }
      if (r.ok) return r.data;
      if (r.kind === "unauthorized") denied();
      fail(
        r.kind === "rate_limited"
          ? "终端数量已达上限，请先关闭不用的终端"
          : r.kind === "not_found"
            ? "环境或工作目录不存在"
            : r.kind === "network"
              ? "网络不通，无法创建终端"
              : "Server 无法启动终端（pty 不可用或环境连接失败）",
      );
      return null;
    };

    const attach = (term: Terminal, id: string, known: boolean) => {
      let ready = false;
      let exited = false;
      const sock = openTerminalSocket(id, token);
      ws = sock;
      sock.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") {
          term.write(new Uint8Array(ev.data as ArrayBuffer));
          return;
        }
        let m: {
          type?: string;
          exitCode?: number | null;
          message?: string;
          cols?: number;
          rows?: number;
        };
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.type === "ready") {
          ready = true;
          setState({ kind: "live" });
          // 重连到已有终端时，服务端记的尺寸可能和当前窗口不一致。
          if (m.cols !== term.cols || m.rows !== term.rows)
            sock.send(
              JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
              }),
            );
        } else if (m.type === "exit") {
          exited = true;
          sessionStorage.removeItem(idKey(paneId));
          setState({ kind: "exited", code: m.exitCode ?? null });
        } else if (m.type === "error") {
          term.writeln(`\r\n[${m.message ?? "错误"}]`);
        }
      });
      // 握手失败时浏览器先发 error 再发 close，只处理 close。
      sock.addEventListener("close", () => {
        if (disposed || exited) return;
        if (!ready && !known) {
          // 记着的终端连不上：当作已回收，新开一个。
          sessionStorage.removeItem(idKey(paneId));
          void start(term, false, true);
          return;
        }
        setState({ kind: "dropped" });
      });
    };

    const start = async (term: Terminal, reuse: boolean, replaced = false) => {
      const stored = reuse ? sessionStorage.getItem(idKey(paneId)) : null;
      if (stored) return attach(term, stored, false);
      const info = await create(term);
      if (!info) return;
      if (replaced) term.writeln("\r\n[原终端已不存在，已新开一个]");
      sessionStorage.setItem(idKey(paneId), info.id);
      const label = `${target.environmentName}:${baseName(info.cwd)}`;
      const cur = latest.current;
      if (cur.config.label !== label) cur.onUpdateConfig({ label });
      attach(term, info.id, true);
    };

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await loadXterm();
      if (disposed) return;
      const style = getComputedStyle(document.documentElement);
      const theme: Record<string, string> = {};
      for (const [key, name] of [
        ["background", "--code-bg"],
        ["foreground", "--code-fg"],
        ["cursor", "--accent"],
      ] as const) {
        const c = cssColor(name);
        if (c) theme[key] = c;
      }
      const x = new Terminal({
        cursorBlink: true,
        fontFamily: style.getPropertyValue("--font-mono").trim(),
        fontSize: 12,
        theme,
      });
      const fit = new FitAddon();
      x.loadAddon(fit);
      x.open(box);
      fit.fit();
      t = x;
      termRef.current = x;
      x.onData((data) => {
        if (ws?.readyState === 1)
          ws.send(JSON.stringify({ type: "input", data }));
      });
      x.onResize(({ cols, rows }) => {
        if (ws?.readyState === 1)
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
      });
      ro = new ResizeObserver(() => fit.fit());
      ro.observe(box);
      if (focusedRef.current) x.focus();
      await start(x, true);
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      ws?.close();
      t?.dispose();
      termRef.current = null;
    };
  }, [box, target, attempt, paneId]);

  const shown: State =
    !target && host.error
      ? { kind: "error", message: "无法获取环境信息，刷新页面后重试" }
      : state;
  const status = STATUS[shown.kind];
  const reopen = () => {
    setTarget(null);
    setAttempt((n) => n + 1);
  };

  return (
    <div data-terminal-pane className="flex h-full min-h-0 flex-col bg-code-bg">
      <div className="flex items-center gap-2 border-b border-line2 bg-panel px-3 py-1 text-[11px] text-mute">
        <i
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${status.dot}`}
        />
        <span role="status">
          {shown.kind === "exited" && shown.code !== null
            ? `${status.text}（退出码 ${shown.code}）`
            : status.text}
        </span>
        {target && (
          <span className="ml-auto truncate font-mono">
            {target.environmentName}
          </span>
        )}
        {shown.kind === "dropped" && (
          <button
            type="button"
            className={btn}
            onClick={() => setAttempt((n) => n + 1)}
          >
            重连
          </button>
        )}
        {(shown.kind === "exited" || shown.kind === "error") && target && (
          <button type="button" className={btn} onClick={reopen}>
            {shown.kind === "exited" ? "重新打开" : "重试"}
          </button>
        )}
      </div>
      {shown.kind === "error" && (
        <p
          role="alert"
          className="border-b border-danger/30 bg-danger-soft px-3 py-1.5 text-xs text-danger"
        >
          {shown.message}
        </p>
      )}
      <div ref={setBox} className="min-h-0 flex-1 p-2" />
    </div>
  );
}
