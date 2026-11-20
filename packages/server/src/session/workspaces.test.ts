import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
  testPresets,
} from "../../test/support/stub.js";
import type { SessionPool } from "../session/pool.js";
import { SubagentStore } from "../store/subagents.js";
import { DirectoryResolver } from "./directory-resolver.js";
import { WorkspaceError, WorkspaceService } from "./workspaces.js";

const stub = await startStub(() => "好的");
afterAll(() => stub.close());

let data: TestData | undefined;
let pool: SessionPool | undefined;
afterEach(() => {
  pool?.dispose();
  pool = undefined;
  data?.close();
  data = undefined;
});

// 真实库 + 真实目录；resolver 只走本机分支。
function world() {
  const d = testData();
  data = d;
  const presets = testPresets(d);
  const t = testPool(stubSessionFactory(stub), d, {
    presetView: presets.view,
    modeView: presets.modeView,
  });
  pool = t.pool;
  const service = new WorkspaceService({
    workspaces: d.workspaces,
    mounts: d.workspaceDirectories,
    groups: d.workspaceGroups,
    layouts: d.workspaceLayouts,
    directories: d.directories,
    pool: t.pool,
    resolver: new DirectoryResolver({
      hub: { getSsh: () => null } as never,
      directories: d.directories,
    }),
    presets: presets.presets,
    modelCheck: () => true,
  });
  const dir = (name: string) => {
    mkdirSync(join(d.dir, name), { recursive: true });
    return { path: join(d.dir, name) };
  };
  return { d, presets, pool: t.pool, service, dir };
}

const code = (err: unknown) =>
  err instanceof WorkspaceError ? err.code : `unexpected: ${String(err)}`;

// layout / putLayout 是同步的，用 try 取错误（.catch 接不住同步抛出）。
const thrown = (f: () => unknown): unknown => {
  try {
    f();
  } catch (err) {
    return err;
  }
  throw new Error("没有抛错");
};

test("create：名称缺省取主目录名，清单顺序保留，附加目录 role 为 remote", async () => {
  const { service, dir } = world();
  const a = dir("alpha");
  const b = dir("beta");
  const r = await service.create({ directories: [a, b] });
  expect(r.created).toBe(true);
  expect(r.workspace).toMatchObject({
    name: "alpha",
    description: "",
    groupId: null,
    archived: false,
    defaults: {},
    sessionCount: 0,
  });
  expect(r.workspace.directories.map((d) => [d.name, d.role])).toEqual([
    ["alpha", "local"],
    ["beta", "remote"],
  ]);
});

test("create：同一路径写两次是 duplicate_directory，超上限是 too_many_directories", async () => {
  const { service, dir } = world();
  const a = dir("alpha");
  await expect(service.create({ directories: [a, a] })).rejects.toSatisfy(
    (e) => code(e) === "duplicate_directory",
  );
  const many = Array.from({ length: 13 }, (_, i) => dir(`d${i}`));
  await expect(service.create({ directories: many })).rejects.toSatisfy(
    (e) => code(e) === "too_many_directories",
  );
});

test("create：同一批里两个同名的新目录各自登记，名字自动去重而不是撞唯一索引", async () => {
  const { service, dir, d } = world();
  const a = dir("x/app");
  const b = dir("y/app");
  const r = await service.create({ directories: [a, b] });
  expect(r.created).toBe(true);
  const names = d.directories
    .list()
    .filter((x) => x.path === a.path || x.path === b.path)
    .map((x) => x.name)
    .sort();
  expect(names).toEqual(["app", "app-2"]);
});

test("create：defaults 的模型与思考强度都要合法", async () => {
  const { service, dir } = world();
  const a = dir("alpha");
  const bad = await service
    .create({
      directories: [a],
      defaults: {
        model: { provider: "p", model: "m", reasoning: "超级高" },
      },
    })
    .catch((e) => e);
  expect(code(bad)).toBe("bad_request");
});

test("create：主目录已是某工作区的主目录时返回已有工作区，附加入参被忽略也不报错", async () => {
  const { service, dir, d } = world();
  const a = dir("alpha");
  const b = dir("beta");
  const first = await service.create({ directories: [a, b], name: "原来的" });
  const again = await service.create({
    directories: [a, { path: "/不存在的路径" }],
    name: "换个名字",
  });
  expect(again.created).toBe(false);
  expect(again.workspace.id).toBe(first.workspace.id);
  expect(again.workspace.name).toBe("原来的");
  expect(d.workspaces.list()).toHaveLength(1);
});

test("create：校验失败不留半成品（不建目录、不建工作区）", async () => {
  const { service, dir, d } = world();
  const a = dir("alpha");
  const b = dir("beta");
  const before = d.directories.list().length;
  await expect(
    service.create({
      directories: [a, b],
      defaults: { agentPresetId: "不存在" },
    }),
  ).rejects.toSatisfy((e) => code(e) === "bad_request");
  expect(d.directories.list()).toHaveLength(before);
  expect(d.workspaces.list()).toEqual([]);
  // 名称非法也一样
  await expect(
    service.create({ directories: [a, b], name: "   " }),
  ).rejects.toSatisfy((e) => code(e) === "bad_request");
  expect(d.directories.list()).toHaveLength(before);
  expect(d.workspaces.list()).toEqual([]);
});

test("create：defaults 校验预设与模式的引用", async () => {
  const { service, dir, presets } = world();
  const a = dir("alpha");
  await expect(
    service.create({
      directories: [a],
      defaults: { agentPresetId: presets.mode.id },
    }),
  ).rejects.toSatisfy((e) => code(e) === "bad_request");
  const ok = await service.create({
    directories: [a],
    defaults: {
      agentPresetId: presets.coder.id,
      modePresetIds: [presets.mode.id],
      permissionTier: "full",
    },
  });
  expect(ok.workspace.defaults).toEqual({
    agentPresetId: presets.coder.id,
    modePresetIds: [presets.mode.id],
    permissionTier: "full",
  });
});

test("update：部分字段；任一非法整体不改；defaults 整份替换", async () => {
  const { service, dir, presets } = world();
  const a = dir("alpha");
  const { workspace } = await service.create({
    directories: [a],
    defaults: { agentPresetId: presets.coder.id },
  });
  const updated = await service.update(workspace.id, {
    name: "改名",
    description: "说明",
    order: 3,
  });
  expect(updated).toMatchObject({
    name: "改名",
    description: "说明",
    order: 3,
  });

  // 同时给合法与非法字段：整体不改
  await expect(
    service.update(workspace.id, { name: "又一个", order: -1 }),
  ).rejects.toSatisfy((e) => code(e) === "bad_request");
  expect(service.get(workspace.id)?.name).toBe("改名");

  // defaults 整份替换：没出现的键等于恢复跟随
  const replaced = await service.update(workspace.id, {
    defaults: { permissionTier: "rules" },
  });
  expect(replaced.defaults).toEqual({ permissionTier: "rules" });
});

test("update：groupId 必须是存在的分组；归档有会话在跑时被拒", async () => {
  const { service, dir, d, pool } = world();
  const a = dir("alpha");
  const { workspace } = await service.create({ directories: [a] });
  await expect(
    service.update(workspace.id, { groupId: "nope" }),
  ).rejects.toSatisfy((e) => code(e) === "unknown_group");
  const group = d.workspaceGroups.create({ name: "组" });
  expect(
    (await service.update(workspace.id, { groupId: group.id })).groupId,
  ).toBe(group.id);
  expect(
    (await service.update(workspace.id, { groupId: null })).groupId,
  ).toBeNull();

  // 建一个会话并让它跑起来
  const id = (await pool.create({ workspaceId: workspace.id })).id;
  const entry = pool.get(id);
  if (!entry) throw new Error("会话不在池里");
  const c = collector();
  entry.subscribe(c);
  stub.mode.delayMs = 800;
  entry.send("慢一点");
  await waitFor(() => c.types().includes("message.started"), "生成中");
  expect(pool.info(id)?.running).toBe(true);
  await expect(
    service.update(workspace.id, { archived: true }),
  ).rejects.toSatisfy((e) => code(e) === "session_running");
  expect(service.get(workspace.id)?.archived).toBe(false);
  stub.mode.delayMs = 0;
  await waitFor(() => c.types().includes("run.ended"), "run.ended");
  expect(
    (await service.update(workspace.id, { archived: true })).archived,
  ).toBe(true);
});

test("layout：revision 往返，冲突时带上当前快照", async () => {
  const { service, dir } = world();
  const a = dir("alpha");
  const { workspace } = await service.create({ directories: [a] });
  expect(service.layout(workspace.id)).toEqual({ revision: 0, document: null });
  expect(service.putLayout(workspace.id, 0, { windows: [] })).toEqual({
    revision: 1,
  });
  expect(service.layout(workspace.id)).toEqual({
    revision: 1,
    document: { windows: [] },
  });
  const err = thrown(() =>
    service.putLayout(workspace.id, 0, { windows: [{ id: "x" }] }),
  );
  expect(code(err)).toBe("revision_conflict");
  expect((err as WorkspaceError).current).toEqual({
    revision: 1,
    document: { windows: [] },
  });
  expect(service.layout(workspace.id).document).toEqual({ windows: [] });
  expect(code(thrown(() => service.layout("nope")))).toBe("not_found");
  expect(code(thrown(() => service.putLayout(workspace.id, -1, {})))).toBe(
    "bad_request",
  );
});

test("update：order 只改这一个工作区；不存在的工作区是 not_found", async () => {
  const { service, dir } = world();
  const a = dir("alpha");
  const b = dir("beta");
  const one = await service.create({ directories: [a] });
  const two = await service.create({ directories: [b] });
  expect([one.workspace.order, two.workspace.order]).toEqual([1, 2]);
  expect((await service.update(one.workspace.id, { order: 9 })).order).toBe(9);
  expect(service.get(two.workspace.id)?.order).toBe(2);
  await expect(service.update("nope", { name: "x" })).rejects.toSatisfy(
    (e) => code(e) === "not_found",
  );
});

test("sessionCount 数顶层会话，不数子代理会话", async () => {
  const { service, dir, d, pool, presets } = world();
  const a = dir("alpha");
  const { workspace } = await service.create({ directories: [a] });
  const one = (await pool.create({ workspaceId: workspace.id })).id;
  const two = (await pool.create({ workspaceId: workspace.id })).id;
  // 索引行要等会话有了 JSONL 才写，这里直接补，模拟已经落过盘的会话。
  for (const id of [one, two]) {
    d.store.upsert({
      id,
      name: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      directoryId: a.path,
      workspaceId: workspace.id,
    });
  }
  // 第三个是「子代理会话」：isChild 读 subagents 表。
  const child = (await pool.create({ workspaceId: workspace.id })).id;
  const subagents = new SubagentStore(d.db);
  subagents.create({
    childId: child,
    parentId: one,
    depth: 1,
    task: "看一眼",
    spec: {
      agentPresetId: "p",
      directoryIds: [],
      primaryDirectoryId: "",
      tierCap: "rules",
    },
  });
  d.store.upsert({
    id: child,
    name: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    directoryId: a.path,
    workspaceId: workspace.id,
  });
  // Service 用池的 subagents 依赖来判 isChild：这里换成一个认识这条记录的池。
  const svc = new WorkspaceService({
    workspaces: d.workspaces,
    mounts: d.workspaceDirectories,
    groups: d.workspaceGroups,
    layouts: d.workspaceLayouts,
    directories: d.directories,
    pool: testPool(stubSessionFactory(stub), d, { subagents }).pool,
    resolver: new DirectoryResolver({
      hub: { getSsh: () => null } as never,
      directories: d.directories,
    }),
    presets: presets.presets,
  });
  expect(svc.get(workspace.id)?.sessionCount).toBe(2);
  expect(service.get(workspace.id)?.sessionCount).toBe(3);
});

test("同一主目录的两个并发 create：只建一个工作区，后到的返回已有的，不留孤儿", async () => {
  const w = world();
  const a = w.dir("alpha");
  const b = w.dir("beta");
  const [r1, r2] = await Promise.all([
    w.service.create({ directories: [a, b] }),
    w.service.create({ directories: [a, b] }),
  ]);
  expect(r1.workspace.id).toBe(r2.workspace.id);
  expect([r1.created, r2.created].filter(Boolean)).toHaveLength(1);
  expect(w.d.workspaces.list()).toHaveLength(1);
  expect(w.d.workspaceDirectories.get(r1.workspace.id)).toHaveLength(2);
});

test("create 失败不留下没有目录的工作区", async () => {
  const w = world();
  const a = w.dir("alpha");
  const real = w.d.directories.create.bind(w.d.directories);
  let calls = 0;
  w.d.directories.create = ((...args: Parameters<typeof real>) => {
    calls++;
    return calls === 2 ? undefined : real(...args);
  }) as typeof real;
  await expect(
    w.service.create({ directories: [a, w.dir("beta")] }),
  ).rejects.toThrow();
  expect(
    w.d.workspaces
      .list()
      .filter((x) => w.d.workspaceDirectories.get(x.id).length === 0),
  ).toHaveLength(0);
});
