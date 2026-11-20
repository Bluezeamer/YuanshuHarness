// 仅测试使用：隐私变量的构造器 + 带状态的假 fetch（模拟服务端的校验与合并语义）。
import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type {
  NewVariable,
  ReferenceView,
  VariableView,
} from "../../../api/variables";
import { ToastHost } from "../../../ui";
import { LeaveGuardProvider } from "../frame/leave";
import { VariablesPage } from "./VariablesPage";

export const reply = (status: number, body: unknown = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

const DAY = 86_400_000;
export const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let seq = 0;
export const variable = (
  name: string,
  over: Partial<VariableView> = {},
): VariableView => ({
  id: `v${++seq}`,
  name,
  desc: `${name} 的描述`,
  group: null,
  workspaces: [],
  kind: "text",
  maskable: true,
  valueMasked: "••••••••abcd",
  policy: "ask",
  expiry: { kind: "never" },
  expired: false,
  owner: "user",
  createdAt: ago(seq * 1000 + 60 * DAY),
  ...over,
});

export const fileVar = (name: string, over: Partial<VariableView> = {}) =>
  variable(name, {
    kind: "file",
    file: {
      name: `${name}.pem`,
      bytes: 1536,
      lines: 12,
      sha256: "ab12cd34ef56",
    },
    ...over,
  });

const DAYS_30 = { kind: "days", days: 30 } as const;

/** 两个组、一个未分组；含一个过期、一个禁止、一个没启用的。 */
export const seedVariables = (): VariableView[] => [
  variable("gitlab_token", {
    id: "gl",
    desc: "GitLab 访问令牌：克隆和推送公司私有仓库。",
    group: "Git 权限",
    workspaces: ["w1", "w2"],
    expiry: DAYS_30,
    lastUsedAt: ago(3 * 60_000),
  }),
  variable("github_token", {
    id: "gh",
    desc: "GitHub 个人访问令牌：推送开源仓库。",
    group: "Git 权限",
    workspaces: ["w1"],
    expiry: DAYS_30,
  }),
  fileVar("deploy_key", {
    id: "dk",
    desc: "部署机的 SSH 私钥。",
    group: "Git 权限",
    workspaces: ["w2"],
  }),
  variable("aws_access_key", {
    id: "aws",
    desc: "AWS 访问密钥，只给 S3 备份桶读写。",
    group: "云服务",
    workspaces: [],
    expiry: DAYS_30,
  }),
  variable("oss_secret", {
    id: "oss",
    desc: "阿里云 OSS 的 AccessKey Secret。",
    group: "云服务",
    workspaces: ["w1"],
    policy: "deny",
    expiry: DAYS_30,
  }),
  variable("hf_token", {
    id: "hf",
    desc: "Hugging Face 只读令牌：下载模型权重。",
    workspaces: ["w1", "w2", "w3", "w4"],
    policy: "allow",
    expiry: { kind: "days", days: 365 },
  }),
  variable("legacy_pypi_token", {
    id: "old",
    desc: "旧 PyPI 发布令牌，已停用。",
    workspaces: ["w1"],
    expiry: { kind: "at", at: ago(10 * DAY) },
    expired: true,
    expiresAt: ago(10 * DAY),
  }),
];

export const seedWorkspaces = () => [
  ws("w1", "元枢", "~/Yuanshu-harness"),
  ws("w2", "官网", "~/site"),
  ws("w3", "笔记", "~/notes"),
  ws("w4", "训练实验", "~/train"),
];

const ws = (id: string, name: string, path: string, archived = false) => ({
  id,
  name,
  description: "",
  groupId: null,
  archived,
  order: 0,
  defaults: {},
  directories: [
    { id: `d-${id}`, name, path, environmentId: "local", role: "local" },
  ],
  sessionCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

export const seedConnections = () => ({
  server: { host: "server", environmentId: "local", label: "本机" },
  connections: [
    {
      id: "prod-gpu",
      label: "GPU 训练机",
      host: "10.20.4.18",
      user: "deploy",
      status: "active",
    },
  ],
});

export const ref = (
  n: number,
  over: Partial<ReferenceView> = {},
): ReferenceView => ({
  id: String(n),
  name: "github_token",
  directoryId: "ws-core",
  hostId: "local",
  runId: `run-${n}`,
  toolCallId: `tc-${n}`,
  at: ago(n * 60_000),
  result: "ok",
  ...over,
});

export const seedDirectories = () => [
  { id: "ws-core", name: "harness-core" },
  { id: "ws-ft", name: "llm-finetune" },
];

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export type Handler = (
  body: unknown,
  match: RegExpExecArray,
) => Response | Promise<Response> | undefined;

export interface Seed {
  variables?: VariableView[];
  references?: ReferenceView[];
  /** 引用记录每页条数（默认 100）。 */
  pageSize?: number;
}

const NAME_RE = /^[a-z][a-z0-9_.-]{2,47}$/;

/**
 * 假服务端：变量 CRUD / reveal / rotate / 启用的工作区 / 变量组，工作区，连接，引用记录（按 id 倒序翻页），目录。
 * 与真实服务端一致：变量名唯一；reveal 返回明文；响应只含遮罩值；改组名到已有组 = 合并。
 */
export function fakeApi(seed: Seed = {}) {
  let vars = structuredClone(seed.variables ?? seedVariables());
  const spaces = seedWorkspaces();
  const refs = seed.references ?? [];
  const pageSize = seed.pageSize ?? 100;
  const plain = new Map<string, string>(
    vars.map((v) => [v.id, `plain-${v.name}-0000`]),
  );
  const calls: Call[] = [];
  const overrides: { re: RegExp; fn: Handler }[] = [];
  let next = 1000;

  const view = (id: string) => vars.find((v) => v.id === id);
  const put = (v: VariableView) => {
    vars = vars.map((x) => (x.id === v.id ? v : x));
    return reply(200, v);
  };

  const route = (
    method: string,
    full: string,
    body: unknown,
  ): Response | Promise<Response> => {
    const [path = "", query = ""] = full.split("?");
    for (const o of overrides) {
      const m = o.re.exec(`${method} ${full}`);
      const r = m && o.fn(body, m);
      if (r) return r;
    }
    if (method === "GET" && path === "/api/v1/variables")
      return reply(200, { variables: vars });
    if (method === "GET" && path === "/api/v1/workspaces")
      return reply(200, { workspaces: spaces });
    if (method === "GET" && path === "/api/v1/connections")
      return reply(200, seedConnections());
    if (method === "GET" && path === "/api/v1/directories")
      return reply(200, { directories: seedDirectories() });
    if (method === "GET" && path === "/api/v1/references") {
      const q = new URLSearchParams(query);
      const dir = q.get("directory");
      const who = q.get("name");
      const before = q.get("before");
      const all = refs
        .filter((r) => !dir || r.directoryId === dir)
        .filter((r) => !who || r.name === who)
        .filter((r) => !before || Number(r.id) < Number(before))
        .sort((a, b) => Number(b.id) - Number(a.id));
      const page = all.slice(0, pageSize);
      return reply(200, {
        references: page,
        nextBefore: all.length > pageSize ? Number(page.at(-1)?.id) : null,
      });
    }
    if (method === "POST" && path === "/api/v1/variables") {
      const b = body as NewVariable;
      if (!NAME_RE.test(b.name)) return reply(400, { error: "invalid_name" });
      if (!b.desc?.trim()) return reply(400, { error: "invalid_desc" });
      if (vars.some((v) => v.name === b.name))
        return reply(409, { error: "name_exists" });
      const v: VariableView = {
        id: `v${next++}`,
        name: b.name,
        desc: b.desc,
        group: b.group ?? null,
        workspaces: [...(b.workspaces ?? [])].sort(),
        kind: b.kind,
        maskable: b.value.length >= 8,
        ...(b.kind === "text"
          ? { valueMasked: "••••••••" }
          : {
              file: {
                name: b.fileName ?? "file",
                bytes: b.value.length,
                lines: b.value.split("\n").length,
                sha256: "0123456789abcdef",
              },
            }),
        policy: b.policy,
        expiry: b.expiry,
        expired: false,
        owner: "user",
        createdAt: new Date().toISOString(),
      };
      vars = [...vars, v];
      plain.set(v.id, b.value);
      return reply(201, v);
    }
    const grp = /^\/api\/v1\/variable-groups\/([^/]+)$/.exec(path);
    if (grp?.[1]) {
      const name = decodeURIComponent(grp[1]);
      const members = vars.filter((v) => v.group === name);
      if (members.length === 0) return reply(404, { error: "not_found" });
      if (method === "PUT") {
        const to = String((body as { name?: string }).name ?? "").trim();
        if (!to || to.length > 32)
          return reply(400, { error: "invalid_group" });
        vars = vars.map((v) => (v.group === name ? { ...v, group: to } : v));
        return reply(200, { renamed: members.length });
      }
      if (method === "DELETE") {
        vars = vars.map((v) => (v.group === name ? { ...v, group: null } : v));
        return reply(204);
      }
    }
    const one = /^\/api\/v1\/variables\/([^/]+)(\/.*)?$/.exec(path);
    const cur = one?.[1] ? view(one[1]) : undefined;
    if (one && !cur) return reply(404, { error: "not_found" });
    if (cur && !one?.[2]) {
      if (method === "PATCH") {
        const b = body as Partial<VariableView>;
        if (b.desc !== undefined && !b.desc.trim())
          return reply(400, { error: "invalid_desc" });
        const merged: VariableView = { ...cur, ...b };
        if (b.expiry?.kind === "at" && Date.parse(b.expiry.at) <= Date.now()) {
          merged.expired = true;
          merged.expiresAt = b.expiry.at;
        }
        return put(merged);
      }
      if (method === "DELETE") {
        vars = vars.filter((v) => v.id !== cur.id);
        return reply(204);
      }
    }
    if (cur && one?.[2] === "/workspaces" && method === "PUT") {
      const ids = (body as { workspaces: string[] }).workspaces;
      if (ids.some((id) => !spaces.some((w) => w.id === id)))
        return reply(400, { error: "invalid_workspace" });
      return put({ ...cur, workspaces: [...new Set(ids)].sort() });
    }
    if (cur && one?.[2] === "/reveal" && method === "POST")
      return reply(200, {
        id: cur.id,
        name: cur.name,
        kind: cur.kind,
        value: plain.get(cur.id) ?? "",
      });
    if (cur && one?.[2] === "/rotate" && method === "POST") {
      const b = body as { value: string; fileName?: string };
      plain.set(cur.id, b.value);
      return put({
        ...cur,
        rotatedAt: new Date().toISOString(),
        ...(cur.file && b.fileName
          ? { file: { ...cur.file, name: b.fileName, bytes: b.value.length } }
          : {}),
      });
    }
    return reply(404, { error: "not_found" });
  };

  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: input, body });
    return route(method, input, body);
  });

  return {
    fetchMock,
    calls,
    on(key: string, fn: Handler) {
      overrides.push({ re: new RegExp(`^${key}$`), fn });
    },
    writes: () => calls.filter((c) => c.method !== "GET"),
    called: (method: string, pathRe: RegExp) =>
      calls.filter((c) => c.method === method && pathRe.test(c.path)),
    get variables() {
      return vars;
    },
  };
}

export type FakeApi = ReturnType<typeof fakeApi>;

/** 挂载隐私变量页（带离开保护与右下角提示）并等到首屏出现。 */
export async function mount(seed: Seed = {}): Promise<FakeApi> {
  const api = fakeApi(seed);
  vi.stubGlobal("fetch", api.fetchMock);
  render(
    <LeaveGuardProvider>
      <VariablesPage />
      <ToastHost />
    </LeaveGuardProvider>,
  );
  await screen.findByRole("tab", { name: /变量/ });
  return api;
}

/** 点左列表里这个名字的行。 */
export const pickRow = (name: string) =>
  fireEvent.click(screen.getByText(name, { selector: ".u-lrow-label" }));
