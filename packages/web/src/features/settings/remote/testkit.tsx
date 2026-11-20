// 仅测试使用：连接视图构造器 + 带状态的假服务端（模拟激活六步、主机密钥核对、跳板与删除守卫）。
import { fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import {
  ACTIVATION_STEPS,
  type Activation,
  type ConnectionView,
  type Credential,
  type LogEntry,
} from "../../../api/connections";
import { ToastHost } from "../../../ui";
import { LeaveGuardProvider } from "../frame/leave";
import { RemotePage } from "./RemotePage";
import { createRemoteStore } from "./store";

export const reply = (status: number, body: unknown = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

export const conn = (
  id: string,
  over: Partial<ConnectionView> = {},
): ConnectionView => ({
  id,
  label: id,
  host: `${id}.example`,
  port: 22,
  user: "ops",
  os: "posix",
  auth: { kind: "key", secretId: "k1" },
  jump: [],
  chain: [],
  dependants: [],
  policy: {
    keepAlive: true,
    reuseSession: true,
    hostKey: "ask",
    proxyJumpFallback: false,
  },
  status: "inactive",
  dirty: false,
  hostKey: null,
  hostKeyChange: null,
  lastActiveAt: null,
  createdAt: "2026-10-20T00:00:00.000Z",
  activation: null,
  ...over,
});

/** 首次连接自动记录主机密钥的连接：激活能一路走完，不停在核对。 */
export const tofu = (id: string, over: Partial<ConnectionView> = {}) =>
  conn(id, {
    policy: {
      keepAlive: true,
      reuseSession: true,
      hostKey: "tofu",
      proxyJumpFallback: false,
    },
    ...over,
  });

export const key = (
  id: string,
  over: Partial<Credential> = {},
): Credential => ({
  id,
  name: id === "k1" ? "ys-deploy-ed25519" : id,
  kind: "ssh_key",
  createdAt: "2026-10-01T00:00:00.000Z",
  fingerprint: `SHA256:${id}fp`,
  keyType: "ssh-ed25519",
  referencedBy: [],
  ...over,
});

export const trusted = (fingerprint: string) => ({
  fingerprint,
  keyType: "ssh-ed25519",
  changedFrom: null,
  acceptedAt: "2026-10-21T00:00:00.000Z",
});

const STEP_DETAIL = [
  "直连",
  "TCP 握手",
  "ssh-ed25519 · 与记录一致",
  "publickey",
  "Linux x86_64",
  "复用通道就绪",
];

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeInit {
  conns: ConnectionView[];
  creds?: Credential[];
  directories?: {
    id: string;
    name: string;
    path: string;
    environmentId: string;
  }[];
  sessions?: { id: string; directoryId: string }[];
  logs?: Record<string, LogEntry[]>;
  /** 一开始就待核对的指纹（连接 id → 本次看到的指纹）。 */
  pending?: Record<string, string>;
}

/**
 * 假服务端。激活进度由测试手动推进：`tick(id)` 完成当前一步；`auto` 为 true 时每次
 * GET /connections/:id 自动推进一步（等价于真实服务端随时间前进）。
 * `seen[id]` 是目标主机本次出示的指纹；`failAt[id]` 让激活停在某一步。
 */
export function fakeServer(init: FakeInit, opts: { auto?: boolean } = {}) {
  const auto = opts.auto ?? true;
  let list = structuredClone(init.conns);
  let creds = structuredClone(init.creds ?? []);
  const directories = init.directories ?? [];
  const sessions = init.sessions ?? [];
  const logs = init.logs ?? {};
  const calls: Call[] = [];
  const overrides: {
    re: RegExp;
    fn: (body: unknown) => Response | undefined;
  }[] = [];
  const runs = new Map<string, { idx: number; act: Activation }>();
  const seen: Record<string, string> = {};
  const failAt: Record<string, { step: number; code: string }> = {};
  const pending: Record<string, string | null> = { ...init.pending };
  let seq = 100;

  const find = (id: string) => list.find((c) => c.id === id);
  const seenOf = (id: string) => seen[id] ?? `SHA256:${id}-host`;
  const deps = (id: string) => list.filter((c) => c.jump[0] === id);
  const below = (id: string): ConnectionView[] =>
    deps(id).flatMap((c) => [c, ...below(c.id)]);

  const view = (c: ConnectionView): ConnectionView => {
    const p = pending[c.id] ?? null;
    const chain: ConnectionView["chain"] = [];
    for (let j = c.jump[0] ? find(c.jump[0]) : undefined; j; ) {
      chain.unshift({ id: j.id, label: j.label });
      j = j.jump[0] ? find(j.jump[0]) : undefined;
    }
    const act = runs.get(c.id)?.act ?? c.activation;
    return {
      ...c,
      chain,
      dependants: deps(c.id).map((d) => ({ id: d.id, label: d.label })),
      status: runs.has(c.id)
        ? "activating"
        : p
          ? "verify-required"
          : c.status === "active"
            ? "active"
            : "inactive",
      hostKeyChange: p
        ? {
            old: c.hostKey?.fingerprint ?? null,
            new: p,
            oldType: c.hostKey ? "ssh-ed25519" : null,
            newType: "ssh-ed25519",
            changedFrom: c.hostKey?.fingerprint ?? null,
          }
        : null,
      activation: act,
    };
  };

  const step = (id: string, i: number, state: string, extra = {}) => {
    const r = runs.get(id);
    if (r) r.act.steps[i] = { ...r.act.steps[i], state, ...extra } as never;
  };

  const finish = (id: string, patch: Partial<Activation>) => {
    const r = runs.get(id);
    if (!r) return;
    const act = { ...r.act, ...patch };
    runs.delete(id);
    const c = find(id);
    if (c) c.activation = act;
  };

  const tick = (id: string) => {
    const r = runs.get(id);
    const c = find(id);
    if (!r || !c) return;
    const i = r.idx;
    const bad = failAt[id];
    const fail = (code: string) => {
      step(id, i, "failed", { ms: 0 });
      finish(id, {
        state: "failed",
        failedStage: ACTIVATION_STEPS[i]?.id,
        code,
        message: `${code} raw message`,
      });
    };
    if (bad?.step === i) return fail(bad.code);
    if (i === 2) {
      const now = seenOf(id);
      if (c.hostKey && c.hostKey.fingerprint !== now) {
        pending[id] = now;
        return fail("hostkey_changed");
      }
      if (!c.hostKey) {
        if (c.policy.hostKey === "ask") {
          pending[id] = now;
          return fail("hostkey_unknown");
        }
        c.hostKey = trusted(now);
      }
    }
    step(id, i, "done", { ms: 10 * (i + 1), detail: STEP_DETAIL[i] });
    if (i === 5) {
      c.status = "active";
      c.dirty = false;
      c.lastActiveAt = new Date().toISOString();
      return finish(id, { state: "done" });
    }
    r.idx = i + 1;
    step(id, i + 1, "running");
  };

  const activate = (c: ConnectionView) => {
    if (runs.has(c.id)) return reply(409, { error: "activating" });
    if (c.status === "active") return reply(409, { error: "already_active" });
    const [otherId] = [...runs.keys()];
    const other = otherId === undefined ? undefined : find(otherId);
    if (other)
      return reply(409, {
        error: "busy",
        activating: { id: other.id, label: other.label },
      });
    const v = view(c);
    if (v.hostKeyChange)
      return reply(409, {
        error: "verify_required",
        hostKeyChange: v.hostKeyChange,
      });
    const j = c.jump[0] ? find(c.jump[0]) : undefined;
    if (j && j.status !== "active")
      return reply(409, {
        error: "jump_inactive",
        jump: { id: j.id, label: j.label },
      });
    const steps = ACTIVATION_STEPS.map(({ id, name }, n) => ({
      id,
      name,
      state: n === 0 ? "running" : "pending",
    }));
    runs.set(c.id, { idx: 0, act: { state: "running", steps } as Activation });
    return reply(202, view(c));
  };

  const patch = (c: ConnectionView, b: Record<string, unknown>) => {
    const live = ["host", "port", "user", "jump", "auth"].some((k) => k in b);
    if (live && runs.has(c.id)) return reply(409, { error: "activating" });
    if (
      typeof b.label === "string" &&
      list.some((x) => x.id !== c.id && x.label === b.label)
    )
      return reply(409, { error: "name_exists" });
    if (Array.isArray(b.jump) && b.jump[0]) {
      const j = b.jump[0] as string;
      if (j === c.id || below(c.id).some((d) => d.id === j))
        return reply(409, { error: "jump_cycle" });
    }
    const moved =
      ("host" in b && b.host !== c.host) || ("port" in b && b.port !== c.port);
    for (const [k, v] of Object.entries(b)) {
      if (k === "auth") {
        const a = v as { secretId: string; kind: "key" | "password" };
        c.auth = { kind: a.kind, secretId: a.secretId };
      } else if (k === "policy") c.policy = { ...c.policy, ...(v as object) };
      else (c as unknown as Record<string, unknown>)[k] = v;
    }
    if (moved) {
      c.hostKey = null;
      delete pending[c.id];
    }
    if (c.status === "active" && live) c.dirty = true;
    return reply(200, view(c));
  };

  const route = (method: string, path: string, body: unknown): Response => {
    for (const o of overrides) {
      const r = o.re.test(`${method} ${path}`) && o.fn(body);
      if (r) return r;
    }
    if (method === "GET" && path === "/api/v1/connections")
      return reply(200, {
        server: { host: "server", environmentId: "local", label: "本机" },
        connections: list.map(view),
      });
    if (method === "POST" && path === "/api/v1/connections") {
      const b = body as {
        label: string;
        host: string;
        port: number;
        user: string;
        auth: { secretId: string };
        jump?: string[];
      };
      if (list.some((c) => c.label === b.label))
        return reply(409, { error: "name_exists" });
      const secret = creds.find((k) => k.id === b.auth?.secretId);
      const created = conn(`c${++seq}`, {
        label: b.label,
        host: b.host,
        port: b.port,
        user: b.user,
        auth: {
          kind: secret?.kind === "password" ? "password" : "key",
          secretId: b.auth.secretId,
        },
        jump: b.jump ?? [],
      });
      list = [...list, created];
      return reply(201, view(created));
    }
    const m = /^\/api\/v1\/connections\/([^/]+)(?:\/([a-z]+))?(?:\?.*)?$/.exec(
      path,
    );
    if (m) {
      const c = find(m[1] as string);
      if (!c) return reply(404, { error: "not_found" });
      const sub = m[2];
      if (!sub && method === "GET") {
        if (auto) tick(c.id);
        return reply(200, view(c));
      }
      if (!sub && method === "PATCH") return patch(c, body as never);
      if (!sub && method === "DELETE") {
        if (c.status === "active" || runs.has(c.id))
          return reply(409, { error: "active" });
        if (deps(c.id).length)
          return reply(409, {
            error: "referenced",
            referencedBy: deps(c.id).map((d) => ({ id: d.id, label: d.label })),
          });
        const n = directories.filter((w) => w.environmentId === c.id).length;
        if (n) return reply(409, { error: "in_use", directories: n });
        list = list.filter((x) => x.id !== c.id);
        return reply(204);
      }
      if (sub === "activate") return activate(c);
      if (sub === "deactivate") {
        const all = [c, ...below(c.id)];
        for (const x of all) {
          x.status = "inactive";
          runs.delete(x.id);
          x.activation = null;
        }
        return reply(200, {
          deactivated: all.map((x) => ({ id: x.id, label: x.label })),
          connection: view(c),
        });
      }
      if (sub === "trust") {
        const p = pending[c.id];
        if (!p) return reply(409, { error: "nothing_to_trust" });
        c.hostKey = {
          ...trusted(p),
          changedFrom: c.hostKey?.fingerprint ?? null,
        };
        delete pending[c.id];
        return reply(200, view(c));
      }
      if (sub === "log") {
        const q = new URLSearchParams(path.split("?")[1] ?? "");
        const before = Number(q.get("before")) || Infinity;
        const limit = Number(q.get("limit")) || 100;
        const all = (logs[c.id] ?? []).filter((e) => e.id < before);
        const page = all.slice(0, limit);
        return reply(200, {
          log: page,
          nextBefore: all.length > limit ? (page.at(-1)?.id ?? null) : null,
        });
      }
    }
    if (method === "GET" && path === "/api/v1/secrets")
      return reply(200, {
        secrets: creds.map((k) => ({
          ...k,
          referencedBy: list
            .filter((c) => c.auth.secretId === k.id)
            .map((c) => ({ id: c.id, label: c.label })),
        })),
      });
    if (method === "POST" && path === "/api/v1/secrets") {
      const b = body as { name: string; kind: Credential["kind"] };
      if (creds.some((k) => k.name === b.name))
        return reply(409, { error: "name_exists" });
      const k = key(`s${++seq}`, { name: b.name, kind: b.kind });
      creds = [...creds, k];
      return reply(201, { id: k.id, name: k.name, kind: k.kind });
    }
    const s = /^\/api\/v1\/secrets\/([^/]+)$/.exec(path);
    if (method === "DELETE" && s) {
      if (list.some((c) => c.auth.secretId === s[1]))
        return reply(409, { error: "in_use" });
      creds = creds.filter((k) => k.id !== s[1]);
      return reply(204);
    }
    if (method === "GET" && path === "/api/v1/directories")
      return reply(200, {
        directories: directories.map((w) => ({
          tier: "rules",
          createdAt: "",
          ...w,
        })),
      });
    if (method === "GET" && path === "/api/v1/sessions")
      return reply(200, {
        sessions: sessions.map((x) => ({
          name: null,
          createdAt: "",
          updatedAt: "",
          running: false,
          ...x,
        })),
      });
    return reply(404, { error: "not_found" });
  };

  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: input, body });
    return route(method, input, body);
  });

  // 服务端侧连接掉线：状态回到未激活，日志多一条（新的在前）
  const drop = (id: string) => {
    const c = find(id);
    if (!c) return;
    c.status = "inactive";
    c.activation = null;
    logs[id] = [
      {
        id: Math.max(0, ...(logs[id] ?? []).map((e) => e.id)) + 1,
        at: new Date().toISOString(),
        type: "disconnect",
        text: "连接已断开",
        detail: "对端关闭了连接",
      },
      ...(logs[id] ?? []),
    ];
  };

  return {
    fetchMock,
    calls,
    tick,
    drop,
    seen,
    failAt,
    /** 覆盖某个 "METHOD /path" 正则的响应；返回 undefined 落回默认行为。 */
    on(key: string, fn: (body: unknown) => Response | undefined) {
      overrides.push({ re: new RegExp(`^${key}$`), fn });
    },
    writes: () => calls.filter((c) => c.method !== "GET"),
    writesTo: (re: RegExp) =>
      calls.filter((c) => c.method !== "GET" && re.test(c.path)),
    get conns() {
      return list;
    },
    get creds() {
      return creds;
    },
  };
}

export type FakeServer = ReturnType<typeof fakeServer>;

/** 挂载远程连接页（带离开保护与提示条）并等到首屏；激活轮询间隔压到 2ms，已激活连接的巡检默认不动（watchMs 才开）。 */
export async function mount(
  init: FakeInit,
  opts: { auto?: boolean; watchMs?: number } = {},
) {
  const server = fakeServer(init, opts);
  vi.stubGlobal("fetch", server.fetchMock);
  const store = createRemoteStore({
    pollMs: 2,
    ...(opts.watchMs === undefined ? {} : { watchMs: opts.watchMs }),
  });
  render(
    <LeaveGuardProvider>
      <RemotePage store={store} />
      <ToastHost />
    </LeaveGuardProvider>,
  );
  await screen.findByRole("tablist");
  return { server, store };
}

// ---- 页面操作的小助手：左列表、详情头、「⋯」菜单 ----

export const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));

export const rail = () => screen.getByRole("complementary", { name: "连接" });

/** 点左列表里叫这个名字的行 */
export const selectConn = (label: string) =>
  fireEvent.click(
    within(rail())
      .getByText(label, { selector: ".u-lrow-label" })
      .closest("button") as HTMLElement,
  );

/** 左列表从上到下的连接名 */
export const railOrder = () =>
  [...rail().querySelectorAll(".u-lrow-label")].map((e) => e.textContent);

/** 详情区现在显示的连接名 */
export const detailName = () =>
  screen
    .getByRole("article")
    .getAttribute("aria-label")
    ?.replace(/ 详情$/, "");

/** 左列表里状态点写着「已激活」的行数 */
export const activeCount = () =>
  within(rail()).queryAllByRole("img", { name: "已激活" }).length;

/** 详情头「⋯」菜单里的某一项 */
export async function menuItem(name: string | RegExp): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  // 置灰的项带着原因（hint），可访问名是「名字＋原因」，所以按开头匹配
  return screen.findByRole("menuitem", {
    name: typeof name === "string" ? new RegExp(`^${name}`) : name,
  });
}

/** 保存条里的按钮 */
export const saveBar = () => screen.queryByRole("region", { name: "保存" });
export const saveClick = (name = "保存") =>
  fireEvent.click(
    within(screen.getByRole("region", { name: "保存" })).getByRole("button", {
      name,
    }),
  );

export const isDisabled = (el: HTMLElement) =>
  el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
