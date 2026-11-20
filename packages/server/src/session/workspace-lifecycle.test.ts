import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testPool,
} from "../../test/support/stub.js";
import {
  isChild,
  spawnChild,
  subagentWorld,
  type World,
} from "../../test/support/subagents.js";
import { LocalEnv } from "../env/local.js";
import type { SessionPool } from "../session/pool.js";
import { CallStore } from "../store/calls.js";
import { CapabilityStore } from "../store/capabilities.js";
import { HookStore } from "../store/hooks.js";
import { PromptPresetStore } from "../store/prompt-presets.js";
import { findSessionFile, sessionDirFor } from "../store/sessions.js";
import { TerminalManager } from "../terminal/manager.js";
import { DirectoryResolver } from "./directory-resolver.js";
import {
  WorkspaceLifecycle,
  type WorkspaceLifecycleDeps,
  WorkspaceLifecycleError,
} from "./workspace-lifecycle.js";
import { WorkspaceService, type WorkspaceView } from "./workspaces.js";

// 子代理带报告交付，协作区里才会真的留下东西。
const stub = await startStub((_n, body) =>
  isChild(body)
    ? (body.messages as { role: string }[]).at(-1)?.role === "tool"
      ? "child-done"
      : { tool: "deliver", args: { summary: "ok", report: "# 报告" } }
    : "好的",
);
afterAll(() => stub.close());

let pool: SessionPool | undefined;
let data: TestData | undefined;
let terminals: TerminalManager | undefined;
const worlds: World[] = [];

afterEach(async () => {
  terminals?.closeAll();
  terminals = undefined;
  pool?.dispose();
  pool = undefined;
  data?.close();
  data = undefined;
  for (const w of worlds.splice(0).reverse()) await w.close();
  stub.mode.delayMs = 0;
  stub.requests.length = 0;
});

const ended = (c: ReturnType<typeof collector>) => () =>
  c.types().includes("run.ended");

// 真实库 + 真实目录 + 真实终端；终端只开本机，测试结束时全部关掉。
function wire(
  d: TestData,
  p: SessionPool,
  browser?: WorkspaceLifecycleDeps["browser"],
  attachments?: WorkspaceLifecycleDeps["attachments"],
) {
  const manager = new TerminalManager();
  terminals = manager;
  const resolver = new DirectoryResolver({
    hub: { getSsh: () => null },
    directories: d.directories,
  } as never);
  const service = new WorkspaceService({
    workspaces: d.workspaces,
    mounts: d.workspaceDirectories,
    groups: d.workspaceGroups,
    layouts: d.workspaceLayouts,
    directories: d.directories,
    pool: p,
    resolver,
    presets: new PromptPresetStore(d.db),
    modelCheck: () => true,
  });
  const lifecycle = new WorkspaceLifecycle({
    service,
    workspaces: d.workspaces,
    mounts: d.workspaceDirectories,
    directories: d.directories,
    rules: d.rules,
    hooks: new HookStore(d.db),
    sessions: d.store,
    pool: p,
    terminals: manager,
    ...(browser ? { browser } : {}),
    ...(attachments ? { attachments } : {}),
    resolver,
    sessionRoot: d.sessionDir,
  });
  return { service, lifecycle, terminals: manager };
}

function world(
  browser?: WorkspaceLifecycleDeps["browser"],
  attachments?: WorkspaceLifecycleDeps["attachments"],
) {
  const t = testPool(stubSessionFactory(stub));
  pool = t.pool;
  data = t.data;
  return {
    d: t.data,
    pool: t.pool,
    ...wire(t.data, t.pool, browser, attachments),
  };
}

// 子代理场景：同一套服务挂到 subagentWorld 的库与池上；调用要与索引表真的写进库。
function childWorld() {
  const w = subagentWorld(stub, {
    deps: (d) => ({ calls: new CallStore(d.db) }),
  });
  worlds.push(w);
  return { w, ...wire(w.data, w.pool) };
}

const dirOf = (d: TestData, name: string) => {
  const path = join(d.dir, name);
  mkdirSync(path, { recursive: true });
  const dir = d.directories.create(name, path);
  if (!dir) throw new Error("directory 没建成");
  return dir;
};

const run = async (p: SessionPool, id: string) => {
  const e = p.get(id);
  if (!e) throw new Error("会话不在池里");
  const c = collector();
  e.subscribe(c);
  e.send("go");
  await waitFor(ended(c), "run.ended");
};

const codeOf = (err: unknown) =>
  err instanceof WorkspaceLifecycleError
    ? err.code
    : `unexpected: ${String(err)}`;

const reject = async (f: () => Promise<unknown>) =>
  codeOf(await f().catch((e: unknown) => e));

const openTerminal = async (manager: TerminalManager, workspaceId?: string) =>
  (
    await manager.create(new LocalEnv(), {
      cols: 80,
      rows: 24,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    })
  ).info.id;

const count = (d: TestData, sql: string, ...args: unknown[]) =>
  (d.db.prepare(sql).get(...args) as { n: number }).n;

const seen = (text: string) =>
  JSON.stringify(stub.requests.at(-1)?.body.messages ?? []).includes(text);

const thrown = (f: () => unknown): unknown => {
  try {
    f();
  } catch (err) {
    return err;
  }
  throw new Error("没有抛错");
};

describe("删除前的影响预览", () => {
  test("会话数（含归档、不含子代理）、终端数、每个目录的连带条数与是否被保留", async () => {
    const { w, service, lifecycle, terminals: manager } = childWorld();
    const d = w.data;
    const p = w.pool;
    const alpha = dirOf(d, "alpha");
    const beta = dirOf(d, "beta");
    const gamma = dirOf(d, "gamma");
    const ws = (
      await service.create({
        directories: [{ path: alpha.path }, { path: beta.path }],
      })
    ).workspace;
    // 另一个工作区也挂着 beta：删本工作区时它要被保留。
    await service.create({
      directories: [{ path: gamma.path }, { path: beta.path }],
    });

    const one = (await p.create({ directoryIds: [alpha.id, beta.id] })).id;
    const two = (await p.create({ directoryIds: [alpha.id, beta.id] })).id;
    await run(p, one);
    d.store.setLifecycle(two, "archived");
    // 子代理会话不算进会话数
    const { childId, done } = await spawnChild(w, one, { task: "看一眼" });
    await done;
    expect(w.subagents.get(childId)?.state).toBe("done");
    await openTerminal(manager, ws.id);
    await openTerminal(manager, ws.id);
    // 不归属任何工作区的终端不计数
    await openTerminal(manager);

    d.rules.add(alpha.id, { kind: "path", access: "read", value: "/x" });
    d.rules.add(alpha.id, { kind: "command", access: null, value: "ls" });
    const hooks = new HookStore(d.db);
    hooks.create({
      name: "h",
      point: "PreToolUse",
      matcher: "bash",
      command: "true",
      timeoutSec: 10,
      enabled: true,
      directoryId: alpha.id,
    });
    hooks.create({
      name: "全局",
      point: "Stop",
      matcher: "",
      command: "true",
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    const caps = new CapabilityStore(d.db);
    caps.set(ws.id, "skill", ["a"]);
    caps.set(ws.id, "mcp", ["b", "c"]);

    const preview = lifecycle.removalPreview(ws.id);
    expect(preview.running).toBe(false);
    expect(preview.sessions).toBe(2);
    expect(preview.terminals).toBe(2);
    expect(preview.directories.map((x) => [x.name, x.removed])).toEqual([
      ["alpha", true],
      ["beta", false],
    ]);
    expect(preview.directories[0]).toMatchObject({
      id: alpha.id,
      path: alpha.path,
      environmentId: "local",
      rules: 2,
      // 只数该目录专属的 hook，不含全局
      hooks: 1,
    });
    // 被保留的目录也给出条数
    expect(preview.directories[1]).toMatchObject({
      id: beta.id,
      rules: 0,
      hooks: 0,
    });
    expect(codeOf(thrown(() => lifecycle.removalPreview("nope")))).toBe(
      "not_found",
    );
  });
});

describe("删除工作区", () => {
  test("通知浏览器清掉这个工作区的页面与上下文", async () => {
    const forgotten: string[] = [];
    const { d, service, lifecycle } = world({
      forgetWorkspace: async (key) => void forgotten.push(key),
    });
    const alpha = dirOf(d, "alpha");
    const ws = (await service.create({ directories: [{ path: alpha.path }] }))
      .workspace;
    await lifecycle.remove(ws.id);
    expect(forgotten).toEqual([ws.id]);
  });

  test("删工作区时清掉它那块附件区（按工作区存放，会话删除不动它）", async () => {
    const removed: string[] = [];
    const { d, service, lifecycle } = world(undefined, {
      removeOwner: async (id) => void removed.push(id),
    });
    const alpha = dirOf(d, "alpha");
    const ws = (await service.create({ directories: [{ path: alpha.path }] }))
      .workspace;
    await lifecycle.remove(ws.id);
    expect(removed).toEqual([ws.id]);
  });

  test("会话（含子代理与 fork）全删且无残留，终端关闭、挂载与布局清空、目录随引用存亡", async () => {
    const { w, service, lifecycle, terminals: manager } = childWorld();
    const alpha = dirOf(w.data, "alpha");
    const beta = dirOf(w.data, "beta");
    const gamma = dirOf(w.data, "gamma");
    // alpha 目录里还有用户自己的文件，删目录不能动它
    writeFileSync(join(alpha.path, "AGENTS.md"), "约定");
    const ws = (
      await service.create({
        directories: [{ path: alpha.path }, { path: beta.path }],
      })
    ).workspace;
    // beta 同时挂在另一个工作区上：保留
    const other = (
      await service.create({
        directories: [{ path: gamma.path }, { path: beta.path }],
      })
    ).workspace;
    w.data.workspaceLayouts.put(ws.id, 0, { windows: [] });

    const parent = (await w.pool.create({ directoryIds: [alpha.id, beta.id] }))
      .id;
    await run(w.pool, parent);
    const { childId, done } = await spawnChild(w, parent, { task: "看一眼" });
    await done;
    const reply = w.pool
      .get(parent)
      ?.sessionManager.getBranch()
      .find((e) => e.type === "message" && e.message.role === "assistant");
    if (!reply) throw new Error("没有助手回复");
    const forked = (await w.pool.fork(parent, reply.id, "分支")).id;
    // 删除前这些残留都在
    expect(w.subagents.get(childId)).toBeDefined();
    expect(w.jobs.list(parent).length).toBeGreaterThan(0);
    expect(existsSync(w.collab.treeDir(parent))).toBe(true);

    const hooks = new HookStore(w.data.db);
    hooks.create({
      name: "专属",
      point: "PreToolUse",
      matcher: "bash",
      command: "true",
      timeoutSec: 10,
      enabled: true,
      directoryId: alpha.id,
    });
    hooks.create({
      name: "全局",
      point: "Stop",
      matcher: "",
      command: "true",
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    new CapabilityStore(w.data.db).set(ws.id, "mcp", ["m"]);

    const inside = await openTerminal(manager, ws.id);
    const outside = await openTerminal(manager);

    await lifecycle.remove(ws.id);

    // 会话：索引行、文件、子代理行、后台任务、调用、协作区
    expect(w.data.store.listByWorkspace(ws.id)).toEqual([]);
    for (const id of [parent, childId, forked]) {
      expect(findSessionFile(w.data.sessionDir, id)).toBeNull();
      expect(w.pool.get(id)).toBeUndefined();
    }
    expect(count(w.data, "SELECT count(*) AS n FROM subagents")).toBe(0);
    expect(count(w.data, "SELECT count(*) AS n FROM jobs")).toBe(0);
    expect(count(w.data, "SELECT count(*) AS n FROM calls")).toBe(0);
    expect(count(w.data, "SELECT count(*) AS n FROM latest_request")).toBe(0);
    expect(existsSync(w.collab.treeDir(parent))).toBe(false);

    // 终端：本工作区的关掉，别的留着
    expect(manager.get(inside)).toBeUndefined();
    expect(manager.get(outside)).toBeDefined();

    // 工作区行、挂载、布局
    expect(w.data.workspaces.get(ws.id)).toBeUndefined();
    expect(w.data.workspaceDirectories.get(ws.id)).toEqual([]);
    expect(
      count(
        w.data,
        "SELECT count(*) AS n FROM workspace_layouts WHERE workspace_id = ?",
        ws.id,
      ),
    ).toBe(0);

    // 目录随引用存亡：独占的 alpha 连同规则、hooks 一起删；共享的 beta 留着
    expect(w.data.directories.get(alpha.id)).toBeUndefined();
    expect(w.data.rules.list(alpha.id)).toEqual([]);
    expect(hooks.list().map((h) => h.name)).toEqual(["全局"]);
    // 工作区自己的能力分配随外键级联清掉
    expect(
      count(
        w.data,
        "SELECT count(*) AS n FROM workspace_capabilities WHERE workspace_id = ?",
        ws.id,
      ),
    ).toBe(0);
    expect(w.data.directories.get(beta.id)).toBeDefined();
    expect(w.data.workspaces.get(other.id)).toBeDefined();
    // 磁盘上的文件不动
    expect(readFileSync(join(alpha.path, "AGENTS.md"), "utf8")).toBe("约定");
    // 会话文件目录空了就移除
    expect(existsSync(sessionDirFor(w.data.sessionDir, ws.id))).toBe(false);
  });

  test("会话文件目录里还有别的东西时保留，不递归删", async () => {
    const { d, pool: p, service, lifecycle } = world();
    const alpha = dirOf(d, "alpha");
    const ws = (await service.create({ directories: [{ path: alpha.path }] }))
      .workspace;
    const id = (await p.create({ directoryIds: [alpha.id] })).id;
    await run(p, id);
    const dir = sessionDirFor(d.sessionDir, ws.id);
    writeFileSync(join(dir, "留下.txt"), "x");

    await lifecycle.remove(ws.id);

    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "留下.txt"))).toBe(true);
  });

  test("顶层会话在跑：拒绝，什么都没删", async () => {
    const { d, pool: p, service, lifecycle } = world();
    const alpha = dirOf(d, "alpha");
    const ws = (await service.create({ directories: [{ path: alpha.path }] }))
      .workspace;
    const id = (await p.create({ directoryIds: [alpha.id] })).id;
    stub.mode.delayMs = 3000;
    const e = p.get(id);
    if (!e) throw new Error("会话不在池里");
    e.send("go");
    await waitFor(() => e.info.running, "进入运行态");

    expect(lifecycle.removalPreview(ws.id).running).toBe(true);
    expect(await reject(() => lifecycle.remove(ws.id))).toBe("session_running");
    expect(d.workspaces.get(ws.id)).toBeDefined();
    expect(d.workspaceDirectories.get(ws.id)).toEqual([alpha.id]);
    expect(p.get(id)).toBeDefined();
    expect(d.directories.get(alpha.id)).toBeDefined();
  });

  test("刚 send、还没进入运行态的会话：同样拒绝，不会删了工作区却把会话留下", async () => {
    const { d, pool: p, service, lifecycle } = world();
    const alpha = dirOf(d, "alpha");
    const ws = (await service.create({ directories: [{ path: alpha.path }] }))
      .workspace;
    const id = (await p.create({ directoryIds: [alpha.id] })).id;
    stub.mode.delayMs = 3000;
    const e = p.get(id);
    if (!e) throw new Error("会话不在池里");
    e.send("go");
    // send 返回之后 busy 已为真（starting），running 要等运行真的开始才变
    expect(e.busy).toBe(true);
    expect(await reject(() => lifecycle.remove(ws.id))).toBe("session_running");
    expect(d.workspaces.get(ws.id)).toBeDefined();
    expect(p.get(id)).toBeDefined();
  });

  test("别的会话在跑时被拒：同工作区的空闲会话一个都没少（拒绝发生在任何删除之前）", async () => {
    const { d, pool: p, service, lifecycle } = world();
    const alpha = dirOf(d, "alpha");
    const ws = (await service.create({ directories: [{ path: alpha.path }] }))
      .workspace;
    const idle = (await p.create({ directoryIds: [alpha.id] })).id;
    const busy = (await p.create({ directoryIds: [alpha.id] })).id;
    await run(p, idle);
    stub.mode.delayMs = 3000;
    p.get(busy)?.send("go");
    // 会话列表按更新时间排，空闲的那个先被轮到：若只靠 pool.remove 的返回值兜底，它会先被删掉
    expect(await reject(() => lifecycle.remove(ws.id))).toBe("session_running");
    expect(d.store.get(idle)).toBeDefined();
    expect(findSessionFile(d.sessionDir, idle)).not.toBeNull();
    expect(d.workspaces.get(ws.id)).toBeDefined();
  });

  test("只有子代理在跑（根会话空闲）：也拒绝，什么都没删", async () => {
    const { w, service, lifecycle } = childWorld();
    const alpha = dirOf(w.data, "alpha");
    const ws = (await service.create({ directories: [{ path: alpha.path }] }))
      .workspace;
    const parent = (await w.pool.create({ directoryIds: [alpha.id] })).id;
    await run(w.pool, parent);
    stub.mode.delayMs = 3000;
    const { childId, done } = await spawnChild(w, parent, { task: "慢活" });
    done.catch(() => {});
    expect(w.pool.get(parent)?.busy).toBe(false);
    expect(w.subagents.get(childId)?.state).toBe("running");

    // 同工作区再放一个空闲会话：拒绝若发生在删除之后，它会先被删掉
    const idle = (await w.pool.create({ directoryIds: [alpha.id] })).id;
    await run(w.pool, idle);

    expect(lifecycle.removalPreview(ws.id).running).toBe(true);
    expect(await reject(() => lifecycle.remove(ws.id))).toBe("session_running");
    expect(w.data.workspaces.get(ws.id)).toBeDefined();
    expect(w.data.store.listByWorkspace(ws.id)).not.toEqual([]);
    expect(w.data.store.get(idle)).toBeDefined();
    expect(w.subagents.get(childId)).toBeDefined();
  });
});

describe("改目录挂载", () => {
  test("加附加目录、去附加目录（独占的删、共享的留）、顺序变化", async () => {
    const { d, pool: p, service, lifecycle } = world();
    const alpha = dirOf(d, "alpha");
    const beta = dirOf(d, "beta");
    const gamma = dirOf(d, "gamma");
    const delta = join(d.dir, "delta");
    mkdirSync(delta, { recursive: true });
    const ws = (
      await service.create({
        directories: [{ path: alpha.path }, { path: beta.path }],
      })
    ).workspace;
    const other = (
      await service.create({
        directories: [{ path: gamma.path }, { path: beta.path }],
      })
    ).workspace;
    const id = (await p.create({ directoryIds: [alpha.id, beta.id] })).id;
    await run(p, id);
    expect(d.directories.getByPath(delta)).toBeUndefined();

    // 加一个还没登记过的目录
    const added = (await lifecycle.setDirectories(ws.id, {
      directories: [{ path: alpha.path }, { path: beta.path }, { path: delta }],
    })) as WorkspaceView;
    expect(added.directories.map((x) => x.name)).toEqual([
      "alpha",
      "beta",
      "delta",
    ]);
    const deltaId = d.directories.getByPath(delta)?.id;
    expect(deltaId).toEqual(expect.any(String));
    expect(p.directoryIdsOf(id).map((x) => d.directories.get(x)?.name)).toEqual(
      ["alpha", "beta", "delta"],
    );

    // 顺序变化：beta 与 delta 换位
    const reordered = (await lifecycle.setDirectories(ws.id, {
      directories: [{ path: alpha.path }, { path: delta }, { path: beta.path }],
    })) as WorkspaceView;
    expect(reordered.directories.map((x) => [x.name, x.role])).toEqual([
      ["alpha", "local"],
      ["delta", "remote"],
      ["beta", "remote"],
    ]);

    // 去掉 delta 与 beta：delta 没人挂 → 删；beta 还被另一个工作区挂着 → 留
    await lifecycle.setDirectories(ws.id, {
      directories: [{ path: alpha.path }],
    });
    expect(d.directories.get(deltaId as string)).toBeUndefined();
    expect(d.directories.get(beta.id)).toBeDefined();
    expect(d.workspaceDirectories.get(other.id)).toEqual([gamma.id, beta.id]);
    expect(p.directoryIdsOf(id)).toEqual([alpha.id]);
  });

  test("目录存亡的两个条件各自生效：只被别的工作区挂着 / 只被别的会话当前目录占着，都保留", async () => {
    const { d, pool: p, service, lifecycle } = world();
    const alpha = dirOf(d, "alpha");
    const mounted = dirOf(d, "mounted");
    const occupied = dirOf(d, "occupied");
    const lone = dirOf(d, "lone");
    const gamma = dirOf(d, "gamma");
    const ws = (
      await service.create({
        directories: [
          { path: alpha.path },
          { path: mounted.path },
          { path: occupied.path },
          { path: lone.path },
        ],
      })
    ).workspace;
    // mounted：只被另一个工作区挂着，没有会话停在里面
    await service.create({
      directories: [{ path: gamma.path }, { path: mounted.path }],
    });
    // occupied：别的工作区没挂它，但别的工作区的会话当前目录停在它里面
    const other = (
      await service.create({ directories: [{ path: gamma.path }] })
    ).workspace;
    expect(other.id).toBeDefined();
    const stray = (await p.create({ directoryIds: [gamma.id] })).id;
    await run(p, stray);
    d.store.updateDirectoryId(stray, occupied.id);

    await lifecycle.setDirectories(ws.id, {
      directories: [{ path: alpha.path }],
    });
    expect(d.directories.get(mounted.id)).toBeDefined();
    expect(d.directories.get(occupied.id)).toBeDefined();
    // 对照：没人挂、没人占的 lone 被删
    expect(d.directories.get(lone.id)).toBeUndefined();
  });

  test("第 0 个改了 400 local_immutable；超 12 与重复都是 400，且不留半成品", async () => {
    const { d, pool: p, service, lifecycle } = world();
    const alpha = dirOf(d, "alpha");
    const beta = join(d.dir, "beta");
    mkdirSync(beta, { recursive: true });
    const ws = (await service.create({ directories: [{ path: alpha.path }] }))
      .workspace;
    const id = (await p.create({ directoryIds: [alpha.id] })).id;
    await run(p, id);

    expect(
      await reject(() =>
        lifecycle.setDirectories(ws.id, { directories: [{ path: beta }] }),
      ),
    ).toBe("local_immutable");
    expect(
      await reject(() =>
        lifecycle.setDirectories(ws.id, {
          directories: Array.from({ length: 13 }, (_, i) => ({
            path: dirOf(d, `many-${i}`).path,
          })),
        }),
      ),
    ).toBe("too_many_directories");
    expect(
      await reject(() =>
        lifecycle.setDirectories(ws.id, {
          directories: [{ path: alpha.path }, { path: beta }, { path: beta }],
        }),
      ),
    ).toBe("duplicate_directory");
    expect(d.workspaceDirectories.get(ws.id)).toEqual([alpha.id]);
    // 校验失败时不登记任何目录
    expect(d.directories.getByPath(beta)).toBeUndefined();
    expect(p.directoryIdsOf(id)).toEqual([alpha.id]);
  });

  test("dryRun：不写库、不登记目录，返回新增与将被删的目录", async () => {
    const { d, pool: p, service, lifecycle } = world();
    const alpha = dirOf(d, "alpha");
    const beta = dirOf(d, "beta");
    const gamma = join(d.dir, "gamma");
    mkdirSync(gamma, { recursive: true });
    const ws = (
      await service.create({
        directories: [{ path: alpha.path }, { path: beta.path }],
      })
    ).workspace;
    const id = (await p.create({ directoryIds: [alpha.id, beta.id] })).id;
    await run(p, id);

    const preview = (await lifecycle.setDirectories(ws.id, {
      directories: [{ path: alpha.path }, { path: gamma }],
      dryRun: true,
    })) as { added: { path: string }[]; removed: { id: string }[] };
    expect(preview.added.map((x) => x.path)).toEqual([gamma]);
    expect(preview.removed.map((x) => x.id)).toEqual([beta.id]);
    expect(d.workspaceDirectories.get(ws.id)).toEqual([alpha.id, beta.id]);
    expect(d.directories.getByPath(gamma)).toBeUndefined();
    expect(p.directoryIdsOf(id)).toEqual([alpha.id, beta.id]);
  });

  test("同一工作区的两个已装载会话下一轮都收到目录变更通知", async () => {
    const { d, pool: p, service, lifecycle } = world();
    const alpha = dirOf(d, "alpha");
    const beta = dirOf(d, "beta");
    const ws = (await service.create({ directories: [{ path: alpha.path }] }))
      .workspace;
    const one = (await p.create({ directoryIds: [alpha.id] })).id;
    const two = (await p.create({ directoryIds: [alpha.id] })).id;
    await run(p, one);
    await run(p, two);

    await lifecycle.setDirectories(ws.id, {
      directories: [{ path: alpha.path }, { path: beta.path }],
    });
    for (const id of [one, two]) {
      await run(p, id);
      expect(seen("The directories of this session have changed")).toBe(true);
    }
  });

  test("当前目录被移除的会话被移回主目录：已装载与未装载各一例", async () => {
    const { d, pool: p, service } = world();
    const alpha = dirOf(d, "alpha");
    const beta = dirOf(d, "beta");
    const ws = (
      await service.create({
        directories: [{ path: alpha.path }, { path: beta.path }],
      })
    ).workspace;
    const live = (await p.create({ directoryIds: [alpha.id, beta.id] })).id;
    const idle = (await p.create({ directoryIds: [alpha.id, beta.id] })).id;
    await run(p, live);
    await run(p, idle);
    d.store.updateDirectoryId(live, beta.id);
    d.store.updateDirectoryId(idle, beta.id);

    // 新池：live 按需装载，idle 留在库里
    p.dispose();
    const t2 = testPool(stubSessionFactory(stub), d);
    pool = t2.pool;
    data = t2.data;
    const w2 = wire(t2.data, t2.pool);
    const resident = await t2.pool.acquire(live);
    if (!resident) throw new Error("会话没装载");
    resident.directoryId = beta.id;
    expect(w2.service.get(ws.id)).toBeDefined();

    await w2.lifecycle.setDirectories(ws.id, {
      directories: [{ path: alpha.path }],
    });
    expect(resident.directoryId).toBe(alpha.id);
    expect(d.store.get(live)?.directoryId).toBe(alpha.id);
    expect(d.store.get(idle)?.directoryId).toBe(alpha.id);
    // beta 独占了，已经删掉
    expect(d.directories.get(beta.id)).toBeUndefined();

    await run(t2.pool, live);
    expect(seen("The directory you were in has been removed")).toBe(true);
  });
});
