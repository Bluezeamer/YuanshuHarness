import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { POLICY_MAX } from "../permission/review-policy.js";
import { type Db, openDatabase } from "./db.js";
import { SessionStore } from "./sessions.js";
import { WorkspaceDirectoryStore } from "./workspace-directories.js";
import { WorkspaceLayoutStore } from "./workspace-layouts.js";
import { WorkspaceVariableStore } from "./workspace-variables.js";
import {
  isWorkspaceDefaults,
  WORKSPACE_DESCRIPTION_MAX,
  WORKSPACE_NAME_MAX,
  WorkspaceStore,
} from "./workspaces.js";

let dir: string;
let db: Db;
let store: WorkspaceStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yuanshu-ws-"));
  db = openDatabase(dir);
  store = new WorkspaceStore(db);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("创建", () => {
  test("去首尾空白、排在最后、默认值可省略", () => {
    const a = store.create({ name: "  A  " });
    const b = store.create({ name: "B", description: "说明" });
    expect(a).toMatchObject({
      name: "A",
      description: "",
      groupId: null,
      archived: false,
      defaults: {},
    });
    expect(a.order).toBeLessThan(b.order);
    expect(store.list().map((w) => w.name)).toEqual(["A", "B"]);
  });

  test("空名与超长名称、超长描述被拒", () => {
    expect(() => store.create({ name: "   " })).toThrow();
    expect(() =>
      store.create({ name: "x".repeat(WORKSPACE_NAME_MAX + 1) }),
    ).toThrow();
    expect(() =>
      store.create({
        name: "a",
        description: "x".repeat(WORKSPACE_DESCRIPTION_MAX + 1),
      }),
    ).toThrow();
    expect(
      store.create({ name: "x".repeat(WORKSPACE_NAME_MAX) }).name,
    ).toHaveLength(WORKSPACE_NAME_MAX);
  });

  test("默认配置：合法值原样读回，不合法就抛错", () => {
    const defaults = {
      agentPresetId: "agent",
      modePresetIds: ["m1", "m2"],
      model: { provider: "p", model: "m", reasoning: "high" },
      permissionTier: "auto" as const,
    };
    expect(store.create({ name: "d", defaults }).defaults).toEqual(defaults);
    for (const bad of [
      { unknownKey: 1 },
      { permissionTier: "deny" },
      { modePresetIds: [] },
      { modePresetIds: [1] },
      { model: { provider: "p", model: "m" } },
      { agentPresetId: "" },
      [],
      null,
    ])
      expect(() => store.create({ name: "bad", defaults: bad })).toThrow();
  });
});

describe("审核设置", () => {
  test('新建默认 {append, ""}；写入后读回、trim；不影响其它字段', () => {
    const a = store.create({ name: "A", defaults: { permissionTier: "full" } });
    expect(a.reviewPolicy).toEqual({ mode: "append", text: "" });
    const b = store.update(a.id, {
      reviewPolicy: { mode: "override", text: "  一律拒绝删除  " },
    });
    expect(b?.reviewPolicy).toEqual({ mode: "override", text: "一律拒绝删除" });
    expect(b?.defaults).toEqual({ permissionTier: "full" });
    expect(store.get(a.id)?.reviewPolicy).toEqual({
      mode: "override",
      text: "一律拒绝删除",
    });
    // 只改名字不动审核设置
    expect(store.update(a.id, { name: "A2" })?.reviewPolicy).toEqual({
      mode: "override",
      text: "一律拒绝删除",
    });
  });

  test("非法设置抛错且库里不变", () => {
    const a = store.create({ name: "A" });
    for (const bad of [
      { mode: "prepend", text: "x" },
      { mode: "append" },
      { mode: "append", text: 1 },
      { mode: "append", text: "x".repeat(POLICY_MAX + 1) },
      [],
      null,
      "x",
    ])
      expect(
        () => store.update(a.id, { reviewPolicy: bad }),
        JSON.stringify(bad),
      ).toThrow("审核设置不合法");
    expect(store.get(a.id)?.reviewPolicy).toEqual({ mode: "append", text: "" });
  });
});

test("isWorkspaceDefaults：空对象合法，未知键不合法", () => {
  expect(isWorkspaceDefaults({})).toBe(true);
  expect(isWorkspaceDefaults({ agentPresetId: "a" })).toBe(true);
  expect(isWorkspaceDefaults({ nope: true })).toBe(false);
  expect(isWorkspaceDefaults({ permissionTier: "rules" })).toBe(true);
  expect(isWorkspaceDefaults({ permissionTier: "deny" })).toBe(false);
});

describe("更新", () => {
  test("只改传入的字段，每次更新 updated_at", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const a = store.create({ name: "A", description: "d" });
      vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
      const b = store.update(a.id, { name: " A2 " });
      expect(b).toMatchObject({
        name: "A2",
        description: "d",
        defaults: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
      vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
      expect(
        store.update(a.id, { defaults: { permissionTier: "full" } }),
      ).toMatchObject({
        description: "d",
        defaults: { permissionTier: "full" },
        updatedAt: "2026-01-03T00:00:00.000Z",
      });
      expect(store.update("nope", { name: "x" })).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("更新时同样校验名称与默认配置", () => {
    const a = store.create({ name: "A" });
    expect(() => store.update(a.id, { name: "" })).toThrow();
    expect(() => store.update(a.id, { defaults: { nope: 1 } })).toThrow();
    expect(store.get(a.id)?.name).toBe("A");
  });
});

test("分组、归档与重排", () => {
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  store.setGroup(a.id, "g");
  expect(store.get(a.id)?.groupId).toBe("g");
  store.setGroup(a.id, null);
  expect(store.get(a.id)?.groupId).toBeNull();
  store.setArchived(b.id, true);
  expect(store.get(b.id)?.archived).toBe(true);
  store.reorder([b.id, a.id]);
  expect([b.id, a.id].map((id) => store.get(id)?.order)).toEqual([1, 2]);
});

test("remove 连带删目录挂载、布局与变量启用关系，不动会话行", () => {
  const a = store.create({ name: "A" });
  const other = store.create({ name: "B" });
  const dirs = new WorkspaceDirectoryStore(db);
  dirs.set(a.id, ["d1", "d2"]);
  dirs.set(other.id, ["d2"]);
  const layouts = new WorkspaceLayoutStore(db);
  layouts.put(a.id, 0, { windows: [] });
  const vars = new WorkspaceVariableStore(db);
  db.prepare(
    "INSERT INTO secrets (id, name, kind, ciphertext, created_at) VALUES ('v1', 'v1', 'variable', x'00', 'now')",
  ).run();
  vars.setForWorkspace(a.id, ["v1"]);
  vars.setForWorkspace(other.id, ["v1"]);
  const sessions = new SessionStore(db);
  sessions.upsert({
    id: "s1",
    name: null,
    createdAt: "a",
    updatedAt: "a",
    workspaceId: a.id,
  });

  expect(store.remove(a.id)).toBe(true);
  expect(dirs.get(a.id)).toEqual([]);
  expect(layouts.get(a.id)).toEqual({ revision: 0, document: null });
  expect(vars.enabledIds(a.id)).toEqual(new Set());
  expect(sessions.get("s1")?.workspaceId).toBe(a.id);
  expect(dirs.get(other.id)).toEqual(["d2"]);
  expect(vars.enabledIds(other.id)).toEqual(new Set(["v1"]));
  expect(store.remove(a.id)).toBe(false);
});
