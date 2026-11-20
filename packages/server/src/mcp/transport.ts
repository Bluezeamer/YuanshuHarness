// 给 pi 的 MCP 扩展用的传输工厂：http 照旧 Server 直连，stdio 按会话「逻辑 local」目录所在主机分流。
// pi 传进来的 cwd 一律忽略：恢复会话时它是「当前目录」，可能在另一台主机上。
import { homedir } from "node:os";
import path from "node:path";
import type {
  McpServerEntry,
  McpTransportFactory,
} from "@earendil-works/pi-coding-agent";
import {
  type McpTransport,
  StdioTransport,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import type { ExecEnv } from "../env/types.js";
import { type RemoteHost, RemoteStdioTransport } from "./remote-transport.js";
import type { McpSessionStatus } from "./session-status.js";

export interface McpHome {
  /** 每次建连时现取：主机重新激活会换新的环境对象，拿着旧的会绕开用户的「断开」 */
  env: () => ExecEnv | null;
  /** 逻辑 local 目录的路径（所在主机上的路径） */
  cwd: string;
}

// `~`、`~/…` 指家目录，与 pi 的 createDefaultTransport 一致。
const expandHome = (v: string): string => {
  if (v === "~") return homedir();
  if (v.startsWith("~/")) return path.join(homedir(), v.slice(2));
  return v;
};

// fetch 失败时 message 只有「fetch failed」，真正的原因（ECONNREFUSED 等）在 cause 里
const causeOf = (e: unknown): string => {
  const c =
    e instanceof Error
      ? (e.cause as { code?: string; message?: string } | undefined)
      : undefined;
  const why = c?.code ?? c?.message;
  return why ? ` (${why})` : "";
};

const describe = (e: unknown, t: { stderr?: string }): string => {
  const m = e instanceof Error ? e.message : String(e);
  const tail = (t.stderr ?? "").trim().slice(-600);
  return `${m}${causeOf(e)}${tail ? `\n${tail}` : ""}`;
};

// 观测不包装：pi 在连接失败时认 StdioTransport 这个类型、取它的 stderr，所以对象本身不能换。
// 启动与第一次发送的失败、第一个应答（握手成功或被拒）、之后的断开，各记进会话的状态簿。
function observe(
  t: McpTransport & { stderr?: string },
  name: string,
  status: McpSessionStatus,
): void {
  status.connecting(name);
  let answered = false;
  const start = t.start.bind(t);
  t.start = async () => {
    try {
      await start();
    } catch (e) {
      status.failed(name, describe(e, t));
      throw e;
    }
  };
  const send = t.send.bind(t);
  t.send = async (m, o) => {
    try {
      await send(m, o);
    } catch (e) {
      // 握手之前的发送失败就是连不上；握手之后某次调用失败不代表服务不可用
      if (!answered) status.failed(name, describe(e, t));
      throw e;
    }
  };
  t.onMessage((m) => {
    if (answered || !("id" in m) || !("result" in m || "error" in m)) return;
    answered = true;
    if ("error" in m)
      status.failed(name, describe(m.error?.message ?? "握手被拒绝", t));
    else status.ready(name);
  });
  t.onClose(() => status.failed(name, describe("连接已关闭", t)));
}

export function mcpTransportFactory(
  home: McpHome | null,
  status?: McpSessionStatus,
): McpTransportFactory {
  const make = (
    entry: McpServerEntry,
    authProvider: Parameters<McpTransportFactory>[2],
  ): McpTransport & { stderr?: string } => {
    const { config } = entry;
    if ("url" in config)
      return new StreamableHttpTransport({
        url: config.url,
        headers: config.headers ?? {},
        authProvider,
      });
    if (home === null)
      throw new Error(
        "MCP stdio server needs an execution environment, but this session has none",
      );
    const env = home.env();
    if (!env)
      throw new Error(
        "MCP stdio server: the environment of the session's first directory is not available",
      );
    const { cwd } = home;
    const args = config.args ?? [];
    const vars = config.env ?? {};
    if (env.kind === "ssh") {
      if (!env.openStdio)
        throw new Error(
          "MCP stdio servers need an SSH host that opens channels",
        );
      return new RemoteStdioTransport({
        env: env as RemoteHost,
        command: config.command,
        args,
        cwd: path.posix.resolve(cwd, config.cwd ?? "."),
        vars,
      });
    }
    if (env.kind === "local")
      return new StdioTransport({
        command: expandHome(config.command),
        args: args.map(expandHome),
        cwd: path.resolve(cwd, expandHome(config.cwd ?? ".")),
        env: vars,
        stderr: "pipe",
      });
    throw new Error(
      "MCP stdio servers cannot run in this directory's environment",
    );
  };
  return (entry: McpServerEntry, _cwd: string, authProvider) => {
    try {
      const t = make(entry, authProvider);
      if (status) observe(t, entry.name, status);
      return t;
    } catch (e) {
      // 建都建不起来（比如主机被用户断开）：pi 会把这个错放进失败原因，这里同步记进状态簿
      status?.failed(entry.name, describe(e, {}));
      throw e;
    }
  };
}
