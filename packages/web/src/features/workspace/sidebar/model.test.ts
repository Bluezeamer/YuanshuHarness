import { expect, test } from "vitest";
import type { LibrarySession } from "../../../api/sessionLibrary";
import type { Workspace } from "../../../api/workspaces";
import {
  aggregate,
  EMPTY_AGG,
  peekFacts,
  type Sess,
  sectionsOf,
  toWorkspace,
  treeOf,
  type Ws,
  workspaceFacts,
} from "./model";

const sess = (over: Partial<Sess> = {}): Sess => ({
  id: "s1",
  title: "整理接口文档",
  status: "idle",
  ago: ["3", "分钟"],
  ...over,
});

// 本地时间构造，避免时区把「2026-11-07 14:05」算成别的日子
const iso = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi).toISOString();

test("悬停卡片事实：状态、目录、创建与最近活动、编号，缺的不列", () => {
  const facts = peekFacts(
    sess({
      no: "#0042",
      dir: "/repo/api",
      createdAt: iso(2026, 11, 6, 9, 30),
      updatedAt: iso(2026, 11, 7, 14, 5),
    }),
  );
  expect(facts).toEqual([
    ["状态", "待命"],
    ["目录", "/repo/api"],
    ["创建于", "2026-11-06 09:30"],
    ["最近活动", "2026-11-07 14:05"],
    ["编号", "#0042"],
  ]);
  expect(peekFacts(sess()).map(([k]) => k)).toEqual(["状态"]);
});

test("状态一句话：执行中、等你处理，未读追加在后面，归档盖过一切", () => {
  const text = (s: Sess) => peekFacts(s)[0]?.[1];
  expect(text(sess({ status: "running" }))).toBe("执行中");
  expect(text(sess({ status: "blocked" }))).toBe("等你处理");
  expect(text(sess({ unread: "result" }))).toBe("待命 · 有新结果");
  expect(text(sess({ status: "running", unread: "error" }))).toBe(
    "执行中 · 出错了，还没看",
  );
  expect(text(sess({ archived: true, unread: "result" }))).toBe("已归档");
});

test("fork 多一行来源，写父会话的名字", () => {
  expect(peekFacts(sess(), "整理接口文档").map((r) => r.join("："))).toContain(
    "来源：从「整理接口文档」分出",
  );
  expect(peekFacts(sess()).map(([k]) => k)).not.toContain("来源");
});

test("时间解析失败时不列这一行", () => {
  expect(peekFacts(sess({ createdAt: "不是时间" })).map(([k]) => k)).toEqual([
    "状态",
  ]);
});

const lib = (id: string, directoryId: string | null): LibrarySession => ({
  id,
  title: id,
  no: `#000${id.slice(1)}`,
  name: null,
  status: "idle",
  lifecycle: "active",
  workspaceId: "w1",
  parentSessionId: null,
  forkEntryId: null,
  unreadResult: false,
  unreadError: false,
  pinned: false,
  createdAt: "2026-11-06T01:00:00.000Z",
  updatedAt: "2026-11-07T01:00:00.000Z",
  running: false,
  directoryId,
  promptPresetId: null,
  modePresetIds: [],
  activeModeId: null,
});

test("会话的目录取自它所属的目录；远程目录带主机名，找不到的不填", () => {
  const w = {
    id: "w1",
    name: "工作区",
    groupId: null,
    directories: [
      { id: "d1", name: "api", path: "/repo/api", environmentId: "local" },
      { id: "d2", name: "web", path: "/srv/web", environmentId: "env-1" },
    ],
  } as unknown as Workspace;
  const ws = toWorkspace(
    w,
    [lib("s1", "d1"), lib("s2", "d2"), lib("s3", null), lib("s4", "gone")],
    Date.now(),
    (id) => (id === "env-1" ? "build-box" : id),
  );
  expect(ws.path).toBe("/repo/api");
  expect(ws.sessions.map((s) => s.dir)).toEqual([
    "/repo/api",
    "build-box:/srv/web",
    undefined,
    undefined,
  ]);
  expect(ws.sessions[0]?.no).toBe("#0001");
});

const ws = (over: Partial<Ws> = {}): Ws => ({
  id: "w1",
  name: "元枢",
  path: "/repo/api",
  group: null,
  sessions: [],
  ...over,
});

test("工作区卡片事实：对话统计、目录、创建与最近活动", () => {
  const w = ws({
    dirs: ["/repo/api"],
    createdAt: iso(2026, 11, 1, 8, 0),
    sessions: [
      sess({ id: "a", status: "running", updatedAt: iso(2026, 11, 5, 10, 0) }),
      sess({ id: "b", status: "blocked", updatedAt: iso(2026, 11, 7, 14, 5) }),
      sess({ id: "c", archived: true, updatedAt: iso(2026, 11, 6, 9, 0) }),
    ],
  });
  expect(workspaceFacts(w, aggregate(w.sessions))).toEqual([
    ["对话", "2 个 · 1 个执行中 · 1 个等你处理 · 1 个已归档"],
    ["目录", "/repo/api"],
    ["创建于", "2026-11-01 08:00"],
    ["最近活动", "2026-11-07 14:05"],
  ]);
});

test("有附加目录时分行列出，主目录在前；一个附加目录不编号", () => {
  const one = ws({ dirs: ["/repo/api", "build-box:/srv/web"] });
  expect(workspaceFacts(one, EMPTY_AGG).map((r) => r.join("："))).toEqual([
    "对话：还没有对话",
    "主目录：/repo/api",
    "附加目录：build-box:/srv/web",
  ]);
  const two = ws({ dirs: ["/a", "h:/b", "h:/c"] });
  expect(workspaceFacts(two, EMPTY_AGG).map(([k]) => k)).toEqual([
    "对话",
    "主目录",
    "附加目录 1",
    "附加目录 2",
  ]);
});

test("样张没给 dirs 时退回主目录路径；没有目录也不报错", () => {
  expect(workspaceFacts(ws(), EMPTY_AGG).map(([k, v]) => `${k}：${v}`)).toEqual(
    ["对话：还没有对话", "目录：/repo/api"],
  );
  expect(workspaceFacts(ws({ path: "" }), EMPTY_AGG).map(([k]) => k)).toEqual([
    "对话",
  ]);
});

test("toWorkspace 带上全部目录、描述与创建时间", () => {
  const w = {
    id: "w1",
    name: "工作区",
    description: "接口与前端",
    groupId: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    directories: [
      { id: "d1", name: "api", path: "/repo/api", environmentId: "local" },
      { id: "d2", name: "web", path: "/srv/web", environmentId: "env-1" },
    ],
  } as unknown as Workspace;
  const out = toWorkspace(w, [], Date.now(), () => "build-box");
  expect(out.dirs).toEqual(["/repo/api", "build-box:/srv/web"]);
  expect(out.description).toBe("接口与前端");
  expect(out.createdAt).toBe("2026-11-01T00:00:00.000Z");
  expect(
    toWorkspace({ ...w, description: "" }, [], Date.now(), () => "h")
      .description,
  ).toBeUndefined();
});

test("置顶的会话与工作区排在同级之前，其余保持原顺序；fork 仍跟着父会话", () => {
  const list = [
    sess({ id: "a" }),
    sess({ id: "b", pinned: true }),
    sess({ id: "c" }),
    sess({ id: "d", pinned: true }),
    sess({ id: "k", parent: "a" }),
  ];
  expect(treeOf(list).map((n) => [n.s.id, n.kids.map((k) => k.id)])).toEqual([
    ["b", []],
    ["d", []],
    ["a", ["k"]],
    ["c", []],
  ]);

  const w = (id: string, group: string | null, pinned = false): Ws => ({
    id,
    name: id,
    path: "/",
    group,
    ...(pinned ? { pinned } : {}),
    sessions: [],
  });
  const g = { id: "g1", name: "组", tone: 0 };
  const sections = sectionsOf(
    [w("w1", "g1"), w("w2", "g1", true), w("w3", null), w("w4", null, true)],
    [g],
  );
  expect(sections.map((s) => s.list.map((x) => x.id))).toEqual([
    ["w2", "w1"],
    ["w4", "w3"],
  ]);
});
