import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import {
  McpClient,
  type StdioTransport,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv, StdioChannel } from "../env/types.js";
import { VirtualEnv } from "../env/virtual.js";
import { RemoteStdioTransport } from "./remote-transport.js";
import { mcpTransportFactory } from "./transport.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/support/mcp-fixture.mjs", import.meta.url),
);

const entry = (config: McpServerConfig) => ({
  name: "s",
  config,
  source: "yuanshu:s",
  scope: "extension" as const,
});

const http = () => entry({ type: "http", url: "https://example.invalid/mcp" });

const stdio = (extra: Partial<McpServerConfig> = {}) =>
  entry({
    type: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    ...extra,
  } as McpServerConfig);

const text = (res: { content: unknown[] }): string => {
  const first = res.content[0] as { type?: string; text?: string } | undefined;
  return first?.type === "text" ? (first.text ?? "") : "";
};

// 只替换 kind / os / openStdio 的假 ssh 环境：工厂只看这几个字段。
const fakeSsh = (withStdio: boolean): ExecEnv => {
  const env = new LocalEnv() as ExecEnv & { openStdio?: unknown };
  Object.defineProperty(env, "kind", { value: "ssh" });
  Object.defineProperty(env, "os", { value: "posix" });
  if (withStdio)
    env.openStdio = async (): Promise<StdioChannel> => {
      throw new Error("not used");
    };
  return env;
};

describe("mcpTransportFactory", () => {
  test("http 型交给 StreamableHttpTransport，与 home 无关", () => {
    const t = mcpTransportFactory(null)(http(), "/nowhere", undefined);
    expect(t).toBeInstanceOf(StreamableHttpTransport);
  });

  // 本机路径要能真的跑起来：值里的 `$HOME`、`!cmd` 不再被二次展开。
  test("本机 stdio 起 fixture，环境变量与 cwd 原样", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-mcp-home-"));
    try {
      mkdirSync(path.join(dir, "sub"));
      const t = mcpTransportFactory({ env: () => new LocalEnv(), cwd: dir })(
        stdio({
          cwd: "sub",
          env: { A_DOLLAR: "$HOME", B_BANG: "!echo hacked" },
        } as Partial<McpServerConfig>),
        "/ignored-by-factory",
        undefined,
      );
      const client = new McpClient({ name: "t", version: "0.0.0" });
      await client.connect(t);
      expect(text(await client.callTool("env", { name: "A_DOLLAR" }))).toBe(
        "$HOME",
      );
      expect(text(await client.callTool("env", { name: "B_BANG" }))).toBe(
        "!echo hacked",
      );
      await client.close();
      // 相对 cwd 解析到 home.cwd 下面
      expect((t as StdioTransport).options.cwd).toBe(path.join(dir, "sub"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("home 为 null 时 stdio 报错，http 不受影响", () => {
    expect(() =>
      mcpTransportFactory(null)(stdio(), "/nowhere", undefined),
    ).toThrow("needs an execution environment");
  });

  test("虚拟附件环境没有执行能力，报错", () => {
    const env = new VirtualEnv("/v");
    expect(() =>
      mcpTransportFactory({ env: () => env, cwd: "/v" })(
        stdio(),
        "/v",
        undefined,
      ),
    ).toThrow("cannot run in this directory's environment");
  });

  test("ssh 型返回 RemoteStdioTransport", () => {
    const t = mcpTransportFactory({
      env: () => fakeSsh(true),
      cwd: "/srv/work",
    })(
      stdio({ cwd: "srv" } as Partial<McpServerConfig>),
      "/elsewhere",
      undefined,
    );
    expect(t).toBeInstanceOf(RemoteStdioTransport);
  });

  test("ssh 环境没有 openStdio 时报明确的错", () => {
    expect(() =>
      mcpTransportFactory({ env: () => fakeSsh(false), cwd: "/srv/work" })(
        stdio(),
        "/elsewhere",
        undefined,
      ),
    ).toThrow("opens channels");
  });

  // 主机重新激活会换新的环境对象：每次建连都要重新取，不能拿创建会话时的那份
  test("环境每次建连现取；取不到时报错", () => {
    let calls = 0;
    let current: ExecEnv | null = fakeSsh(true);
    const make = mcpTransportFactory({
      env: () => {
        calls++;
        return current;
      },
      cwd: "/srv/work",
    });
    make(stdio(), "/x", undefined);
    make(stdio(), "/x", undefined);
    expect(calls).toBe(2);
    current = null;
    expect(() => make(stdio(), "/x", undefined)).toThrow("not available");
  });
});
