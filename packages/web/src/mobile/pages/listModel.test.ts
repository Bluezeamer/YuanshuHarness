import { expect, test } from "vitest";
import type { LibrarySession } from "../../api/sessionLibrary";
import type { Workspace } from "../../api/workspaces";
import { buildListModel } from "./listModel";

const NOW = Date.parse("2026-11-19T10:00:00Z");

const ws = (id: string, over: Partial<Workspace> = {}): Workspace =>
  ({
    id,
    name: `工作区 ${id}`,
    groupId: null,
    archived: false,
    pinned: false,
    directories: [],
    createdAt: "2026-11-01T00:00:00Z",
    ...over,
  }) as unknown as Workspace;

const sess = (id: string, over: Partial<LibrarySession> = {}): LibrarySession =>
  ({
    id,
    title: `会话 ${id}`,
    no: null,
    status: "idle",
    lifecycle: "active",
    workspaceId: "a",
    parentSessionId: null,
    unreadResult: false,
    unreadError: false,
    pinned: false,
    createdAt: "2026-11-18T00:00:00Z",
    updatedAt: "2026-11-18T00:00:00Z",
    directoryId: null,
    ...over,
  }) as unknown as LibrarySession;

const build = (sessions: LibrarySession[], workspaces = [ws("a"), ws("b")]) =>
  buildListModel(workspaces, [], sessions, NOW, (id) => id);

test("「需要你」：待处理排前、其次出错，跨工作区；新结果、待命与已归档的不进来", () => {
  const m = build([
    sess("err", {
      workspaceId: "b",
      unreadError: true,
      updatedAt: "2026-11-19T09:00:00Z",
    }),
    sess("block-old", { status: "blocked", updatedAt: "2026-11-18T01:00:00Z" }),
    sess("block-new", {
      workspaceId: "b",
      status: "blocked",
      updatedAt: "2026-11-19T08:00:00Z",
    }),
    sess("result", { unreadResult: true }),
    sess("idle"),
    sess("gone", { status: "blocked", lifecycle: "archived" }),
  ]);
  expect(m.needs.map((n) => [n.session.id, n.reason, n.workspaceName])).toEqual(
    [
      ["block-new", "blocked", "工作区 b"],
      ["block-old", "blocked", "工作区 a"],
      ["err", "error", "工作区 b"],
    ],
  );
});

test("没有需要处理的会话时「需要你」为空", () => {
  expect(build([sess("x"), sess("y", { unreadResult: true })]).needs).toEqual(
    [],
  );
});

test("已归档的工作区整个不出现，也不产生「需要你」", () => {
  const m = build(
    [sess("x", { workspaceId: "b", status: "blocked" })],
    [ws("a"), ws("b", { archived: true })],
  );
  expect(m.sections.flatMap((s) => s.list.map((w) => w.id))).toEqual(["a"]);
  expect(m.needs).toEqual([]);
});

test("工作区里的会话：置顶在前，已归档的不列", () => {
  const m = build([
    sess("old", { updatedAt: "2026-11-10T00:00:00Z" }),
    sess("new", { updatedAt: "2026-11-18T00:00:00Z" }),
    sess("pin", { pinned: true, updatedAt: "2026-11-01T00:00:00Z" }),
    sess("arch", { lifecycle: "archived" }),
  ]);
  const a = m.sections.flatMap((s) => s.list).find((w) => w.id === "a");
  expect(a?.sessions.map((s) => s.id)).toEqual(["pin", "new", "old"]);
});
