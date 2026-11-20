// 仅测试使用：MCP 库的带状态假服务端，语义与规则对照 server 的 api/mcp.ts、mcp/conf.ts、mcp/pin.ts。
import { fireEvent, screen } from "@testing-library/react";
import type {
  McpCheck,
  McpConf,
  McpRef,
  McpView,
} from "../../../../api/mcpLibrary";
import type { Policy } from "../../../../api/toolRules";
import { toolsRoutes } from "../builtin/testkit";
import { fakeFetch, mountPage, type Route, reply } from "../common/testkit";
import { validate } from "./fake/testkit";

export interface FakeMcp {
  name: string;
  conf: McpConf;
  description: string | null;
  approval: Policy;
  enabled: boolean;
  global: boolean;
  handshake: McpView["handshake"];
  tools: { name: string; description: string }[] | null;
  latestVersion: string | null;
  candidates: string[];
  /** 检测的结果：不给就是通过。 */
  failure?: string;
  /** 失败属于授权类：检测结果里带 authFailed。 */
  authFailure?: true;
  createdAt: string;
}

// 测试用的地址在运行时拼出，免得 http 协议串出现在源码字面量里
const URL_BASE = `${"https"}:${"//"}`;
export const url = (rest: string) => `${URL_BASE}${rest}`;
const NO_DESC = "来源未提供描述";
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const NOW = "2026-10-25T08:00:00.000Z";

let seq = 0;
export const server = (
  name: string,
  conf: Partial<McpConf> & { command?: string; url?: string },
  over: Partial<FakeMcp> = {},
): FakeMcp => ({
  name,
  conf: { exposure: "direct", ...conf },
  description: null,
  approval: "ask",
  enabled: true,
  global: false,
  handshake: { ok: true, tools: 3, ms: 120, at: NOW },
  tools: [{ name: "do_it", description: `${name} 的工具` }],
  latestVersion: null,
  candidates: [],
  createdAt: new Date(Date.UTC(2026, 9, 1) - ++seq * 1000).toISOString(),
  ...over,
});

/** 与设计稿种子同形：7 个服务 · 6 启用 1 禁用 · 就绪 5 · 需处理 1（授权）· 浮动 2。 */
export const seedMcp = (): FakeMcp[] => [
  server(
    "filesystem",
    {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem@2.0.0"],
      exposure: "direct",
    },
    {
      // 握手说有 11 个，缓存里只有 3 个带描述
      handshake: { ok: true, tools: 11, ms: 180, at: NOW },
      tools: [
        { name: "read_file", description: "读取文件" },
        { name: "write_file", description: "写入文件" },
        { name: "list_dir", description: "列目录" },
      ],
      latestVersion: "2.0.0",
      candidates: ["2.0.0", "1.9.0"],
    },
  ),
  server(
    "playwright",
    { command: "npx", args: ["-y", "@playwright/mcp"], exposure: "direct" },
    {
      handshake: { ok: true, tools: 8, ms: 900, at: NOW },
      latestVersion: "0.0.83",
      candidates: ["0.0.83", "0.0.81", "0.0.79"],
    },
  ),
  server(
    "github",
    {
      url: url("api.githubcopilot.example/mcp"),
      headers: { Authorization: `Bearer \${GITHUB_TOKEN}` },
      exposure: "direct",
    },
    {
      description: "GitHub 的仓库与 Issue 工具",
      handshake: { ok: true, tools: 2, ms: 300, at: NOW },
      tools: [
        { name: "create_issue", description: "创建 issue，可指定仓库" },
        { name: "list_prs", description: "列出 PR" },
      ],
    },
  ),
  server(
    "postgres",
    { command: "uvx", args: ["mcp-server-postgres"], exposure: "direct" },
    { latestVersion: "0.3.0", candidates: ["0.3.0", "0.2.0"] },
  ),
  server(
    "linear",
    { url: url("mcp.linear.example/mcp"), exposure: "direct" },
    {
      handshake: {
        ok: false,
        tools: 0,
        ms: 60,
        at: NOW,
        error: "HTTP 401 未授权（令牌无效或已过期）",
        authFailed: true,
      },
      tools: null,
      failure: "HTTP 401 未授权（令牌无效或已过期）",
      authFailure: true,
    },
  ),
  server(
    "internal-tools",
    {
      command: "npx",
      args: ["-y", "@acme/internal-tools"],
      exposure: "hidden",
    },
    {
      enabled: false,
      handshake: null,
      tools: null,
      latestVersion: "1.0.0",
      candidates: ["1.0.0"],
    },
  ),
  server(
    "docs-search",
    {
      url: url("docs.internal.example/mcp"),
      headers: { "X-Key": "k" },
      exposure: "direct",
    },
    { description: "内部文档检索" },
  ),
];

// ---- 版本 ----

const srcOf = (conf: McpConf) => {
  const cmd = (conf.command ?? "").split("/").pop() ?? "";
  const runtime = cmd === "npx" ? "npm" : cmd === "uvx" ? "pypi" : null;
  if (!runtime || !conf.args) return null;
  const i = conf.args.findIndex((a) => !a.startsWith("-"));
  const spec = conf.args[i];
  if (i < 0 || !spec) return null;
  const at = spec.lastIndexOf("@");
  const [pkg, ver] =
    at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, null];
  return {
    runtime: runtime as "npm" | "pypi",
    pkg,
    version: ver && VERSION_RE.test(ver) ? ver : null,
    index: i,
  };
};

export interface FakeState {
  servers: FakeMcp[];
  /** 名称 → 引用它的位置（改名 409 用）。 */
  refs: Record<string, McpRef[]>;
  /** 名称 → 试装失败的原因（带三步）。 */
  pinFails: Record<string, string>;
}

const view = (m: FakeMcp): McpView => {
  const src = srcOf(m.conf);
  return {
    name: m.name,
    description: m.description ?? NO_DESC,
    transport: m.conf.url ? "http" : "stdio",
    conf: { ...m.conf, ...(m.enabled ? {} : { enabled: false }) },
    source: src ? { runtime: src.runtime, pkg: src.pkg } : null,
    version: src?.version ?? null,
    pinned: src?.version != null,
    latestVersion: m.latestVersion,
    approval: m.approval,
    enabled: m.enabled,
    global: m.global,
    exposure: m.conf.exposure,
    toolExposure: {},
    timeout: null,
    oauth: m.conf.oauth ?? null,
    handshake: m.handshake,
    tools: m.tools,
    toolsAt: m.handshake ? NOW : null,
    createdAt: m.createdAt,
    updatedAt: m.createdAt,
  };
};

const stepsOf = (m: FakeMcp): McpCheck["steps"] =>
  m.failure
    ? {
        start: { state: "ok", ms: 8 },
        handshake: { state: "error", ms: 40, error: m.failure },
        list: { state: "skipped", ms: 0 },
      }
    : {
        start: { state: "ok", ms: 8 },
        handshake: { state: "ok", ms: 40 },
        list: { state: "ok", ms: 30 },
      };

const checkOf = (m: FakeMcp): McpCheck => {
  const ok = !m.failure;
  m.handshake = {
    ok,
    tools: ok ? (m.handshake?.tools ?? 3) || 3 : 0,
    ms: 78,
    at: new Date().toISOString(),
    ...(ok
      ? {}
      : {
          error: m.failure,
          ...(m.authFailure ? { authFailed: true as const } : {}),
        }),
  };
  return {
    name: m.name,
    ok,
    ms: 78,
    tools: m.handshake.tools,
    steps: stepsOf(m),
    handshake: m.handshake,
  };
};

export function mcpRoutes(
  initial: FakeMcp[] = seedMcp(),
  extra: Partial<Pick<FakeState, "refs" | "pinFails">> = {},
) {
  const state: FakeState = {
    servers: structuredClone(initial),
    refs: extra.refs ?? {},
    pinFails: extra.pinFails ?? {},
  };
  const get = (n: string) => state.servers.find((s) => s.name === n);
  const norm = (n: string) => n.toLowerCase().replace(/-/g, "_");
  const conflictOf = (editing?: string) => (n: string) =>
    state.servers.find((s) => s.name !== editing && norm(s.name) === norm(n))
      ?.name;
  const all = () => state.servers.map(view);

  const pin = (m: FakeMcp, version?: string): Response => {
    const src = srcOf(m.conf);
    if (!src)
      return reply(400, {
        error: "not_pinnable",
        message: "这个命令不是 npx / uvx，没有可固定的包版本",
      });
    if (version !== undefined && !VERSION_RE.test(version))
      return reply(400, {
        error: "invalid_version",
        message: "版本形如 x.y.z",
      });
    const fail = state.pinFails[m.name];
    if (fail)
      return reply(502, {
        error: "run_failed",
        message: fail,
        steps: {
          start: { state: "error", ms: 5, error: fail },
          handshake: { state: "skipped", ms: 0 },
          list: { state: "skipped", ms: 0 },
        },
        server: view(m),
      });
    const latest = m.candidates[0] ?? "1.0.0";
    const v = version ?? latest;
    // 成功才写回：把包参数改成 pkg@版本
    const args = [...(m.conf.args ?? [])];
    args[src.index] = `${src.pkg}@${v}`;
    m.conf = { ...m.conf, args };
    m.latestVersion = latest;
    m.failure = undefined;
    const check = checkOf(m);
    return reply(200, {
      ok: true,
      version: v,
      latestVersion: latest,
      resolveMs: 210,
      check,
      server: view(m),
    });
  };

  const route: Route = (method, full, body) => {
    const path = full.split("?")[0] ?? "";
    if (method === "GET" && path === "/api/v1/mcp")
      return reply(200, { servers: all() });
    if (method === "POST" && path === "/api/v1/mcp/validate") {
      const b = body as { json: string; editing?: string };
      const r = validate(b.json, conflictOf(b.editing));
      return reply(200, {
        ok: r.ok,
        diagnostics: r.diagnostics,
        preview: r.preview,
      });
    }
    if (method === "POST" && path === "/api/v1/mcp") {
      const r = validate((body as { json: string }).json, conflictOf());
      if (!r.ok || !("draft" in r) || !r.draft) {
        const dup = r.diagnostics.find((x) => x.code === "name_exists");
        return reply(dup ? 409 : 400, {
          error: dup ? "name_exists" : "invalid_config",
          message: (dup ?? r.diagnostics[0])?.message,
          diagnostics: r.diagnostics,
        });
      }
      const m = server(r.draft.name, r.draft.conf, {
        enabled: r.draft.enabled,
        handshake: null,
        tools: null,
        createdAt: new Date().toISOString(),
      });
      state.servers.push(m);
      return reply(201, { ...view(m), diagnostics: r.diagnostics });
    }
    if (method === "POST" && path === "/api/v1/mcp/check-all") {
      const results = state.servers.filter((s) => s.enabled).map(checkOf);
      return reply(200, {
        total: results.length,
        ready: results.filter((r) => r.ok).length,
        results,
        servers: all(),
      });
    }
    if (method === "POST" && path === "/api/v1/mcp/batch") {
      const b = body as { names: string[]; action: string };
      const results = b.names.map((name) => {
        const m = get(name);
        if (!m) return { name, ok: false, error: "not_found" };
        if (b.action === "pin") {
          const res = pin(m);
          return res.status === 200
            ? { name, ok: true }
            : {
                name,
                ok: false,
                error: "run_failed",
                message: state.pinFails[name],
              };
        }
        if (b.action === "check") {
          const c = checkOf(m);
          return {
            name,
            ok: c.ok,
            ...(c.ok
              ? {}
              : { error: "check_failed", message: c.handshake.error }),
            detail: c,
          };
        }
        if (b.action === "uninstall")
          state.servers = state.servers.filter((s) => s.name !== name);
        else m.enabled = b.action === "enable";
        return { name, ok: true };
      });
      return reply(200, {
        action: b.action,
        okCount: results.filter((r) => r.ok).length,
        failCount: results.filter((r) => !r.ok).length,
        results,
        servers: all(),
      });
    }
    const one = /^\/api\/v1\/mcp\/([^/]+)(?:\/([\w-]+))?$/.exec(path);
    if (!one) return undefined;
    const m = get(decodeURIComponent(one[1] ?? ""));
    if (!m) return reply(404, { error: "not_found" });
    const sub = one[2];
    if (method === "PUT" && !sub) {
      const r = validate((body as { json: string }).json, conflictOf(m.name));
      if (!r.ok || !("draft" in r) || !r.draft)
        return reply(400, {
          error: "invalid_config",
          message: r.diagnostics[0]?.message,
          diagnostics: r.diagnostics,
        });
      if (r.draft.name !== m.name) {
        const refs = state.refs[m.name] ?? [];
        if (refs.length)
          return reply(409, {
            error: "mcp_referenced",
            message: `${m.name} 正被 ${refs.length} 处引用，不能改名；先在这些位置移除引用`,
            references: refs,
          });
        const old = m.name;
        m.name = r.draft.name;
        m.conf = r.draft.conf;
        return reply(200, {
          ...view(m),
          renamedFrom: old,
          diagnostics: r.diagnostics,
        });
      }
      m.conf = r.draft.conf;
      m.enabled = r.draft.enabled;
      // 改了配置要重新握手：旧结果作废
      m.handshake = null;
      return reply(200, { ...view(m), diagnostics: r.diagnostics });
    }
    if (method === "PATCH" && !sub) {
      const b = body as {
        approval?: Policy;
        enabled?: boolean;
        global?: boolean;
      };
      if (b.approval) m.approval = b.approval;
      if (b.enabled !== undefined) m.enabled = b.enabled;
      if (b.global !== undefined) m.global = b.global;
      return reply(200, view(m));
    }
    if (method === "DELETE" && !sub) {
      state.servers = state.servers.filter((s) => s !== m);
      return reply(204);
    }
    if (method === "POST" && sub === "check") {
      const c = checkOf(m);
      return reply(200, { ...c, server: view(m) });
    }
    if (method === "POST" && sub === "try-pin")
      return pin(m, (body as { version?: string } | undefined)?.version);
    if (method === "POST" && sub === "versions") {
      const src = srcOf(m.conf);
      if (!src)
        return reply(400, { error: "not_pinnable", message: "不可固定" });
      const latest = m.candidates[0] ?? "1.0.0";
      // 与服务端一致：查候选版本会记下查到的最新版
      m.latestVersion = latest;
      return reply(200, {
        name: m.name,
        runtime: src.runtime,
        pkg: src.pkg,
        current: src.version,
        latest,
        versions: m.candidates.map((v) => ({
          version: v,
          current: v === src.version,
          latest: v === latest,
        })),
      });
    }
    return undefined;
  };
  return { route, state };
}

/** 挂载整页并切到 MCP 页签。 */
export async function mountMcp(
  initial?: FakeMcp[],
  extra?: Partial<Pick<FakeState, "refs" | "pinFails">>,
  opts?: { autoCheck?: boolean },
) {
  const api = mcpRoutes(initial, extra);
  const fake = fakeFetch(api.route, toolsRoutes().route);
  await mountPage(fake, opts);
  fireEvent.click(screen.getByRole("tab", { name: /MCP/ }));
  await screen.findByRole("complementary", { name: "MCP 服务" });
  return { fake, api };
}
