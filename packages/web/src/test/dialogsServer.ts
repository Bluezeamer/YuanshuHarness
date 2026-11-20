// 工作区 / 会话弹窗测试共用的假服务端：目录数据 + 记录每次请求。
import { vi } from "vitest";

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const preset = (
  id: string,
  kind: string,
  name: string,
  caps: unknown = null,
) => ({
  id,
  kind,
  name,
  description: "",
  active: false,
  capabilities: caps,
});

export const AGENT = preset("p-agent", "agent", "coder-full");
export const REVIEWER = preset("p-reviewer", "agent", "reviewer", [
  "tool:read",
  "tool:grep",
]);
export const MODE = preset("p-mode", "mode", "plan", ["tool:read"]);

const tool = (name: string) => ({
  name,
  description: name,
  readOnly: false,
  server: false,
  available: true,
  defaultEnabled: true,
  layer: "main",
  factory: null,
});

const PROVIDER = {
  id: "prov",
  name: "本地",
  status: "ok",
  models: [
    {
      id: "m1",
      name: "模型一",
      reasoning: true,
      levels: ["off", "low", "high"],
      input: ["text"],
      ctx: 128000,
      out: 4096,
      source: "manual",
    },
  ],
};

/** path 是不带查询串的路径；记录下来的 Call.path 带查询串 */
export type Handler = (c: Call & { url: URL }) => Response | undefined;

/** 默认能回答弹窗载入的全部目录接口；`handler` 先看一眼，返回 Response 就用它的 */
export function fakeFetch(calls: Call[], handler?: Handler) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = new URL(input, "http://localhost");
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method, path: `${path}${url.search}`, body };
    calls.push(call);
    const custom = handler?.({ ...call, path, url });
    if (custom) return custom;
    if (method === "GET") {
      if (path === "/api/v1/studio/presets") {
        const kind = url.searchParams.get("kind");
        if (kind === "mode") return json({ presets: [MODE] });
        if (kind === "project-agentsmd") return json({ presets: [] });
        return json({ presets: [AGENT, REVIEWER] });
      }
      if (path === "/api/v1/providers") return json({ providers: [PROVIDER] });
      if (path === "/api/v1/connections")
        return json({
          server: { host: "s.lan", environmentId: "local", label: "本机" },
          connections: [],
        });
      if (path === "/api/v1/skills") return json({ skills: [] });
      if (path === "/api/v1/mcp") return json({ servers: [] });
      if (path === "/api/v1/tools")
        return json({ tools: [tool("read"), tool("write"), tool("bash")] });
      if (path === "/api/v1/directories") return json({ directories: [] });
      if (path === "/api/v1/fs/dirs")
        return json({ path: "/home/u", parent: null, dirs: [] });
      if (path === "/api/v1/defaults")
        return json({
          directoryStart: "~",
          imageCompression: { enabled: true },
          permissionTier: "rules",
          reviewModel: null,
        });
      if (path.endsWith("/git/status"))
        return json({ root: null, branch: null, detached: false, entries: [] });
    }
    return json({ error: "not_found" }, 404);
  });
}
