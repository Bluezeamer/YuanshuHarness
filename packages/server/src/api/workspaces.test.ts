import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { startStub, stubSessionFactory } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { POLICY_MAX } from "../permission/review-policy.js";
import { createServer, type YuanshuServer } from "../server.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

const TOKEN = "t".repeat(40);
let base: string;
const servers: YuanshuServer[] = [];

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-wsapi-"));
  mkdirSync(path.join(base, "web"));
  writeFileSync(path.join(base, "web", "index.html"), "<!doctype html>");
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  rmSync(base, { recursive: true, force: true });
});

async function launch() {
  const server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(base, "data"),
      token: TOKEN,
      allowCidrs: [],
    },
    {
      startDir: mkdirp("start"),
      webRoot: path.join(base, "web"),
      sessionFactory: stubSessionFactory(stub),
    },
  );
  const addr = await server.start();
  servers.push(server);
  const call = (method: string, p: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${addr.port}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, port: addr.port };
}
type Call = Awaited<ReturnType<typeof launch>>["call"];

function mkdirp(name: string): string {
  const p = path.join(base, name);
  mkdirSync(p, { recursive: true });
  return p;
}

const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

const list = async (call: Call) =>
  (await json<{ workspaces: View[] }>(await call("GET", "/api/v1/workspaces")))
    .workspaces;

const create = (call: Call, body: unknown) =>
  call("POST", "/api/v1/workspaces", body);

interface View {
  id: string;
  name: string;
  description: string;
  groupId: string | null;
  archived: boolean;
  pinned: boolean;
  order: number;
  defaults: Record<string, unknown>;
  reviewPolicy: { mode: string; text: string };
  directories: { name: string; path: string; role: string }[];
  sessionCount: number;
}

describe("创建与读取", () => {
  test("201 新建、200 已存在的主目录；名称缺省取目录名", async () => {
    const { call } = await launch();
    const alpha = mkdirp("alpha");
    const beta = mkdirp("beta");
    const first = await create(call, {
      directories: [{ path: alpha }, { path: beta }],
      description: "说明",
    });
    expect(first.status).toBe(201);
    const ws = await json<View>(first);
    expect(ws).toMatchObject({
      name: "alpha",
      description: "说明",
      groupId: null,
      archived: false,
      order: 1,
      defaults: {},
      reviewPolicy: { mode: "append", text: "" },
      sessionCount: 0,
    });
    expect(ws.directories.map((d) => [d.name, d.role])).toEqual([
      ["alpha", "local"],
      ["beta", "remote"],
    ]);

    // 同一主目录再来一次：返回已有的那个
    const again = await create(call, {
      directories: [{ path: alpha }],
      name: "换个名字",
    });
    expect(again.status).toBe(200);
    expect(await json<View>(again)).toMatchObject({ id: ws.id, name: "alpha" });

    expect(
      await json<View>(await call("GET", `/api/v1/workspaces/${ws.id}`)),
    ).toMatchObject({ id: ws.id, name: "alpha" });
    expect((await call("GET", "/api/v1/workspaces/nope")).status).toBe(404);
  });

  test("目录入参的错误：缺目录、路径不合法、重复、超上限、非法名称", async () => {
    const { call } = await launch();
    const alpha = mkdirp("alpha");
    for (const body of [
      {},
      { directories: [] },
      { directories: [{ path: "rel/dir" }] },
      { directories: [{ path: path.join(base, "nope") }] },
      { directories: [{ path: alpha }, { path: alpha }] },
      { directories: [{ path: alpha }], name: "  " },
      {
        directories: Array.from({ length: 13 }, (_, i) => ({
          path: mkdirp(`many-${i}`),
        })),
      },
    ]) {
      const r = await create(call, body);
      expect(r.status).toBe(400);
    }
    expect(await list(call)).toEqual([]);
  });
});

describe("修改", () => {
  test("PATCH 部分字段；非法值 400 且不改；404", async () => {
    const { call } = await launch();
    const alpha = mkdirp("alpha");
    const ws = await json<View>(
      await create(call, { directories: [{ path: alpha }] }),
    );
    const url = `/api/v1/workspaces/${ws.id}`;
    const r = await call("PATCH", url, {
      name: "新名字",
      description: "新说明",
      order: 5,
    });
    expect(r.status).toBe(200);
    expect(await json<View>(r)).toMatchObject({
      name: "新名字",
      description: "新说明",
      order: 5,
    });
    for (const body of [
      { name: "" },
      { order: -1 },
      { archived: "yes" },
      { groupId: "nope" },
      { defaults: { agentPresetId: "nope" } },
      { defaults: { unknownKey: 1 } },
      {},
    ])
      expect((await call("PATCH", url, body)).status).toBe(400);
    expect(await json<View>(await call("GET", url))).toMatchObject({
      name: "新名字",
    });
    expect(
      (await call("PATCH", "/api/v1/workspaces/nope", { name: "x" })).status,
    ).toBe(404);
    const archived = await call("PATCH", url, { archived: true });
    expect(await json<View>(archived)).toMatchObject({ archived: true });
  });

  test("审核设置：单独 PATCH 不被挡，读回与列表一致；非法 400 且库里不变", async () => {
    const { call } = await launch();
    const ws = await json<View>(
      await create(call, {
        directories: [{ path: mkdirp("review") }],
        defaults: { permissionTier: "full" },
      }),
    );
    const url = `/api/v1/workspaces/${ws.id}`;
    const r = await call("PATCH", url, {
      reviewPolicy: { mode: "override", text: "  一律拒绝删除  " },
    });
    expect(r.status).toBe(200);
    expect(await json<View>(r)).toMatchObject({
      reviewPolicy: { mode: "override", text: "一律拒绝删除" },
      defaults: { permissionTier: "full" },
    });
    expect(await json<View>(await call("GET", url))).toMatchObject({
      reviewPolicy: { mode: "override", text: "一律拒绝删除" },
    });
    expect((await list(call))[0]?.reviewPolicy).toEqual({
      mode: "override",
      text: "一律拒绝删除",
    });
    for (const reviewPolicy of [
      { mode: "prepend", text: "x" },
      { mode: "append", text: 1 },
      { mode: "append", text: "x".repeat(POLICY_MAX + 1) },
      { mode: "append" },
      [],
      null,
      "x",
    ])
      expect(
        (await call("PATCH", url, { reviewPolicy })).status,
        JSON.stringify(reviewPolicy),
      ).toBe(400);
    expect(await json<View>(await call("GET", url))).toMatchObject({
      reviewPolicy: { mode: "override", text: "一律拒绝删除" },
      defaults: { permissionTier: "full" },
    });
  });

  test("pinned 置顶 / 取消置顶；非布尔 400", async () => {
    const { call } = await launch();
    const ws = await json<View>(
      await create(call, { directories: [{ path: mkdirp("pin") }] }),
    );
    const url = `/api/v1/workspaces/${ws.id}`;
    expect(ws.pinned).toBe(false);
    expect(
      await json<View>(await call("PATCH", url, { pinned: true })),
    ).toMatchObject({
      pinned: true,
    });
    expect(await json<View>(await call("GET", url))).toMatchObject({
      pinned: true,
    });
    expect(
      await json<View>(await call("PATCH", url, { pinned: false })),
    ).toMatchObject({ pinned: false });
    expect((await call("PATCH", url, { pinned: 1 })).status).toBe(400);
  });
});

describe("重排", () => {
  test("PUT /workspaces/reorder 不被当成 id；不存在的 id 忽略；条数超上限 400", async () => {
    const { call } = await launch();
    const one = await json<View>(
      await create(call, { directories: [{ path: mkdirp("one") }] }),
    );
    const two = await json<View>(
      await create(call, { directories: [{ path: mkdirp("two") }] }),
    );
    expect([one.order, two.order]).toEqual([1, 2]);
    const r = await call("PUT", "/api/v1/workspaces/reorder", {
      ids: [two.id, "nope", one.id],
    });
    expect(r.status).toBe(204);
    expect((await list(call)).map((w) => [w.id, w.order])).toEqual([
      [two.id, 1],
      [one.id, 2],
    ]);
    expect(
      (await call("PUT", "/api/v1/workspaces/reorder", { ids: "x" })).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", "/api/v1/workspaces/reorder", {
          ids: Array.from({ length: 1001 }, (_, i) => `id-${i}`),
        })
      ).status,
    ).toBe(400);
  });
});

describe("布局", () => {
  test("revision 往返；冲突 409 带当前快照；超限 413；404", async () => {
    const { call } = await launch();
    const ws = await json<View>(
      await create(call, { directories: [{ path: mkdirp("alpha") }] }),
    );
    const url = `/api/v1/workspaces/${ws.id}/layout`;
    expect(await json(await call("GET", url))).toEqual({
      revision: 0,
      document: null,
    });
    const put = await call("PUT", url, {
      baseRevision: 0,
      document: { windows: [] },
    });
    expect(put.status).toBe(200);
    expect(await json(put)).toEqual({ revision: 1 });
    expect(await json(await call("GET", url))).toEqual({
      revision: 1,
      document: { windows: [] },
    });
    const conflict = await call("PUT", url, {
      baseRevision: 0,
      document: { windows: [{ id: "x" }] },
    });
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toEqual({
      revision: 1,
      document: { windows: [] },
    });
    for (const body of [
      { baseRevision: -1, document: {} },
      { baseRevision: 1 },
      { baseRevision: 1, document: 5 },
    ])
      expect((await call("PUT", url, body)).status).toBe(400);
    // 超过 256 KiB 的请求体被直接挡下，且不写入。
    expect(
      (
        await call("PUT", url, {
          baseRevision: 1,
          document: { windows: [], pad: "x".repeat(256 * 1024) },
        })
      ).status,
    ).toBe(413);
    expect(await json(await call("GET", url))).toEqual({
      revision: 1,
      document: { windows: [] },
    });
    expect((await call("GET", "/api/v1/workspaces/nope/layout")).status).toBe(
      404,
    );
    expect(
      (
        await call("PUT", "/api/v1/workspaces/nope/layout", {
          baseRevision: 0,
          document: {},
        })
      ).status,
    ).toBe(404);
  });
});

describe("分组", () => {
  test("CRUD 与「删分组只解散」", async () => {
    const { call } = await launch();
    const ws = await json<View>(
      await create(call, { directories: [{ path: mkdirp("alpha") }] }),
    );
    const made = await call("POST", "/api/v1/workspace-groups", {
      name: " 前端 ",
    });
    expect(made.status).toBe(201);
    const group = await json<{ id: string; name: string; tone: number }>(made);
    expect(group).toMatchObject({ name: "前端", tone: 0 });
    for (const body of [{}, { name: "" }, { name: "x", tone: 9 }])
      expect(
        (await call("POST", "/api/v1/workspace-groups", body)).status,
      ).toBe(400);

    expect(
      await json(await call("GET", "/api/v1/workspace-groups")),
    ).toMatchObject({ groups: [{ id: group.id, name: "前端" }] });

    const patch = await call("PATCH", `/api/v1/workspace-groups/${group.id}`, {
      name: "后端",
      collapsed: true,
      order: 2,
    });
    expect(patch.status).toBe(200);
    expect(await json(patch)).toMatchObject({
      name: "后端",
      collapsed: true,
      order: 2,
    });
    for (const body of [{}, { tone: -1 }, { collapsed: 1 }, { order: 1.5 }])
      expect(
        (await call("PATCH", `/api/v1/workspace-groups/${group.id}`, body))
          .status,
      ).toBe(400);
    expect(
      (await call("PATCH", "/api/v1/workspace-groups/nope", { name: "x" }))
        .status,
    ).toBe(404);

    expect(
      await json(
        await call("PATCH", `/api/v1/workspaces/${ws.id}`, {
          groupId: group.id,
        }),
      ),
    ).toMatchObject({ groupId: group.id });

    expect(
      (await call("DELETE", `/api/v1/workspace-groups/${group.id}`)).status,
    ).toBe(204);
    // 组内工作区保留，group_id 置空
    expect(
      await json<View>(await call("GET", `/api/v1/workspaces/${ws.id}`)),
    ).toMatchObject({ id: ws.id, groupId: null });
    expect(
      (await call("DELETE", `/api/v1/workspace-groups/${group.id}`)).status,
    ).toBe(404);
  });
});

describe("删除、影响预览与目录挂载", () => {
  test("预览与删除工作区：204、会话随之删除；404 与 409", async () => {
    const { call } = await launch();
    const alpha = mkdirp("alpha");
    const ws = await json<View>(
      await create(call, { directories: [{ path: alpha }] }),
    );
    const created = await call("POST", "/api/v1/sessions", {
      workspaceId: ws.id,
    });
    expect(created.status).toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;

    const preview = await call(
      "GET",
      `/api/v1/workspaces/${ws.id}/removal-preview`,
    );
    expect(preview.status).toBe(200);
    expect(await json(preview)).toMatchObject({
      running: false,
      sessions: 1,
      terminals: 0,
      directories: [{ path: alpha, removed: true, rules: 0, hooks: 0 }],
    });
    expect(
      (await call("GET", "/api/v1/workspaces/nope/removal-preview")).status,
    ).toBe(404);

    const del = await call("DELETE", `/api/v1/workspaces/${ws.id}`);
    expect(del.status).toBe(204);
    expect((await call("GET", `/api/v1/workspaces/${ws.id}`)).status).toBe(404);
    expect((await call("GET", `/api/v1/sessions/${sessionId}`)).status).toBe(
      404,
    );
    expect((await call("DELETE", `/api/v1/workspaces/${ws.id}`)).status).toBe(
      404,
    );
  });

  test("有会话在跑：预览 running 为真，删除 409", async () => {
    const { call, port } = await launch();
    const ws = await json<View>(
      await create(call, { directories: [{ path: mkdirp("alpha") }] }),
    );
    const created = await call("POST", "/api/v1/sessions", {
      workspaceId: ws.id,
    });
    const sessionId = ((await created.json()) as { id: string }).id;
    const client = await TestClient.connect(
      `ws://127.0.0.1:${port}/api/v1/sessions/${sessionId}/stream`,
      { token: TOKEN },
    );
    stub.mode.delayMs = 3000;
    try {
      await client.command("send_message", { text: "跑一会儿" });
      const preview = await call(
        "GET",
        `/api/v1/workspaces/${ws.id}/removal-preview`,
      );
      expect(await json(preview)).toMatchObject({ running: true });
      const del = await call("DELETE", `/api/v1/workspaces/${ws.id}`);
      expect(del.status).toBe(409);
      expect(await json(del)).toMatchObject({ error: "session_running" });
      expect((await call("GET", `/api/v1/workspaces/${ws.id}`)).status).toBe(
        200,
      );
    } finally {
      stub.mode.delayMs = 0;
      client.close();
    }
  });

  test("PUT /workspaces/:id/directories：改附加目录、dryRun、主目录不可改、404", async () => {
    const { call } = await launch();
    const alpha = mkdirp("alpha");
    const beta = mkdirp("beta");
    const gamma = mkdirp("gamma");
    const ws = await json<View>(
      await create(call, { directories: [{ path: alpha }] }),
    );
    const url = `/api/v1/workspaces/${ws.id}/directories`;

    const dry = await call("PUT", url, {
      directories: [{ path: alpha }, { path: beta }],
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    expect(await json(dry)).toEqual({
      added: [{ environmentId: "local", path: beta, name: "beta" }],
      removed: [],
    });
    // dryRun 没写库
    expect(
      await json<View>(await call("GET", `/api/v1/workspaces/${ws.id}`)),
    ).toMatchObject({ directories: [{ path: alpha, role: "local" }] });

    const put = await call("PUT", url, {
      directories: [{ path: alpha }, { path: beta }],
    });
    expect(put.status).toBe(200);
    expect(await json<View>(put)).toMatchObject({
      directories: [
        { path: alpha, role: "local" },
        { path: beta, role: "remote" },
      ],
    });

    // 去掉 beta 再加 gamma：beta 独占，随引用消失
    const again = await call("PUT", url, {
      directories: [{ path: alpha }, { path: gamma }],
    });
    expect(again.status).toBe(200);
    const dirs = await json<{ directories: { path: string }[] }>(
      await call("GET", "/api/v1/directories"),
    );
    expect(dirs.directories.map((d) => d.path)).not.toContain(beta);

    expect(
      (await call("PUT", url, { directories: [{ path: beta }] })).status,
    ).toBe(400);
    expect((await call("PUT", url, { directories: [] })).status).toBe(400);
    expect(
      (
        await call("PUT", "/api/v1/workspaces/nope/directories", {
          directories: [{ path: alpha }],
        })
      ).status,
    ).toBe(404);
    // 旧路由不受影响
    expect(
      (await call("PUT", "/api/v1/workspaces/reorder", { ids: [ws.id] }))
        .status,
    ).toBe(204);
  });
});

describe("项目 AGENTS.md", () => {
  const node = (presetId: string, cardId: string) => ({
    id: `${presetId}-root`,
    tag: null,
    title: "正文",
    slotKind: "custom",
    channel: "system",
    builtin: false,
    items: [{ kind: "card", cardId }],
  });

  // 建一份项目 AGENTS.md 预设，正文来自一张新卡片
  const projectPreset = async (
    call: Call,
    body: string,
    kind = "project-agentsmd",
  ) => {
    const card = await json<{ id: string }>(
      await call("POST", "/api/v1/studio/cards", {
        title: "项目约定",
        group: "导入",
        body,
      }),
    );
    const preset = await json<{ id: string }>(
      await call("POST", "/api/v1/studio/presets", {
        kind,
        name: "项目约定",
      }),
    );
    await call("PUT", `/api/v1/studio/presets/${preset.id}/nodes`, {
      nodes: [node(preset.id, card.id)],
    });
    return preset.id;
  };

  const writeTo = async (call: Call, workspaceId: string, body: unknown) => {
    const r = await call(
      "POST",
      `/api/v1/workspaces/${workspaceId}/agents-md`,
      body,
    );
    return { status: r.status, json: await json<Record<string, unknown>>(r) };
  };

  const target = (dir: string) => path.join(dir, "AGENTS.md");
  const read = (dir: string) => readFileSync(target(dir), "utf8");

  test("没有文件时直接写入；path 是主目录下的绝对路径", async () => {
    const { call } = await launch();
    const alpha = mkdirp("agents-a");
    const ws = await json<View>(
      await create(call, { directories: [{ path: alpha }] }),
    );
    const id = await projectPreset(call, "  项目约定一  ");
    const r = await writeTo(call, ws.id, { presetId: id });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ written: true, path: target(alpha) });
    expect(read(alpha)).toBe("项目约定一\n");
  });

  test("已有文件且没给 mode：409 file_exists，文件不动", async () => {
    const { call } = await launch();
    const alpha = mkdirp("agents-b");
    writeFileSync(target(alpha), "原文件\n");
    const ws = await json<View>(
      await create(call, { directories: [{ path: alpha }] }),
    );
    const id = await projectPreset(call, "预设正文");
    const r = await writeTo(call, ws.id, { presetId: id });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: "file_exists" });
    expect(read(alpha)).toBe("原文件\n");

    // 空白文件等于没有文件
    writeFileSync(target(alpha), "  \n\t\n");
    expect((await writeTo(call, ws.id, { presetId: id })).status).toBe(200);
    expect(read(alpha)).toBe("预设正文\n");
  });

  test("overwrite 整个替换；append 原文去尾部空白后空行接新文本", async () => {
    const { call } = await launch();
    const alpha = mkdirp("agents-c");
    writeFileSync(target(alpha), "原文件\n\n  ");
    const ws = await json<View>(
      await create(call, { directories: [{ path: alpha }] }),
    );
    const id = await projectPreset(call, "预设正文");

    expect(
      (await writeTo(call, ws.id, { presetId: id, mode: "append" })).status,
    ).toBe(200);
    expect(read(alpha)).toBe("原文件\n\n预设正文\n");

    expect(
      (await writeTo(call, ws.id, { presetId: id, mode: "overwrite" })).status,
    ).toBe(200);
    expect(read(alpha)).toBe("预设正文\n");
  });

  test("预设不存在、kind 不对、正文为空、工作区不存在都被拒", async () => {
    const { call } = await launch();
    const alpha = mkdirp("agents-d");
    const ws = await json<View>(
      await create(call, { directories: [{ path: alpha }] }),
    );
    const missing = await writeTo(call, ws.id, { presetId: "nope" });
    expect(missing.status).toBe(400);
    expect(missing.json).toEqual({ error: "bad_preset" });

    const global = await projectPreset(call, "全局正文", "global-agentsmd");
    const wrongKind = await writeTo(call, ws.id, { presetId: global });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.json).toEqual({ error: "bad_preset" });

    const empty = await projectPreset(call, "   ");
    const emptyText = await writeTo(call, ws.id, { presetId: empty });
    expect(emptyText.status).toBe(400);
    expect(emptyText.json).toEqual({ error: "empty_preset" });

    expect((await writeTo(call, "nope", { presetId: global })).status).toBe(
      404,
    );
    expect(existsSync(target(alpha))).toBe(false);
  });
});
