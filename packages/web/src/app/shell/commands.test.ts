import { expect, test, vi } from "vitest";
import type { LibrarySession } from "../../api/sessionLibrary";
import type { Workspace } from "../../api/workspaces";
import {
  buildCommands,
  type CommandSources,
  filterCommands,
  groupCommands,
  RECENT_WORKSPACES,
} from "./commands";

const act = () => ({
  newSession: vi.fn(),
  newSessionWith: vi.fn(),
  newWorkspace: vi.fn(),
  newWindow: vi.fn(),
  nextWindow: vi.fn(),
  toggleRail: vi.fn(),
  openOverview: vi.fn(),
  selectWorkspace: vi.fn(),
  selectSession: vi.fn(),
  openSettings: vi.fn(),
});

const sess = (
  id: string,
  title: string,
  workspaceId: string | null = null,
  updatedAt = "2026-01-01T00:00:00Z",
) =>
  ({
    id,
    title,
    workspaceId,
    updatedAt,
    lifecycle: "active",
  }) as LibrarySession;

const ws = (
  id: string,
  name: string,
  over: Partial<Workspace> = {},
): Workspace =>
  ({
    id,
    name,
    archived: false,
    sessionCount: 1,
    updatedAt: "2026-01-01T00:00:00Z",
    directories: [{ path: `/work/${id}` }],
    ...over,
  }) as Workspace;

const src = (over: Partial<CommandSources> = {}): CommandSources => ({
  hasFocusSession: true,
  sessions: [sess("a", "补齐 webhook", "w1"), sess("b", "整理竞品")],
  workspaces: [ws("w1", "官网")],
  settings: [
    { path: "providers", label: "供应商与模型" },
    { path: "agents", label: "Agent 与模式" },
  ],
  act: act(),
  ...over,
});

test("清单按 操作/窗口/视图/设置/工作区/会话 分组，组序固定；lead 指定的那一类排最前", () => {
  const list = buildCommands(src());
  expect(groupCommands(list).map((g) => g.kind)).toEqual([
    "action",
    "window",
    "view",
    "settings",
    "workspace",
    "session",
  ]);
  expect(groupCommands(list, "workspace")[0]?.kind).toBe("workspace");
});

test("没有聚焦会话时不给窗口类命令；任何时候都没有「编辑当前会话」", () => {
  const list = buildCommands(src({ hasFocusSession: false }));
  expect(list.some((c) => c.kind === "window")).toBe(false);
  expect(buildCommands(src()).some((c) => c.id === "edit")).toBe(false);
  expect(list.some((c) => c.id === "new")).toBe(true);
});

test("设置页六项直达：label 带「设置 ·」前缀，run 带 path", () => {
  const s = src();
  const list = buildCommands(s);
  const c = list.find((x) => x.id === "set-agents");
  expect(c?.label).toBe("设置 · Agent 与模式");
  c?.run();
  expect(s.act.openSettings).toHaveBeenCalledWith("agents");
});

test("会话项跨工作区、小字写它属于哪个工作区；run 选中该会话", () => {
  const s = src();
  const c = buildCommands(s).find((x) => x.id === "ses-a");
  expect(c?.note).toBe("官网");
  c?.run();
  expect(s.act.selectSession).toHaveBeenCalledWith("a");
  expect(buildCommands(s).find((x) => x.id === "ses-b")?.note).toBeUndefined();
});

test("过滤：按 label、附带路径或分类子串，不分大小写；空查询不列会话；无命中为空", () => {
  const list = buildCommands(src());
  const quiet = list.filter((c) => c.kind !== "session");
  expect(filterCommands(list, "")).toEqual(quiet);
  expect(filterCommands(list, "  ")).toEqual(quiet);
  expect(filterCommands(list, "/work/w1").map((c) => c.id)).toEqual(["ws-w1"]);
  expect(filterCommands(list, "webhook").map((c) => c.id)).toEqual(["ses-a"]);
  expect(
    filterCommands(list, "设置").every(
      (c) => c.kind === "settings" || c.label.includes("设置"),
    ),
  ).toBe(true);
  expect(filterCommands(list, "agent").map((c) => c.id)).toEqual([
    "set-agents",
  ]);
  expect(filterCommands(list, "不存在的东西")).toEqual([]);
});

test("「操作」类有三条：直接新建（Ctrl+N）、带配置新建、新建工作区；后两条没有快捷键", () => {
  const s = src();
  const ops = buildCommands(s).filter((c) => c.kind === "action");
  expect(ops.map((c) => [c.id, c.key])).toEqual([
    ["new", "Ctrl+N"],
    ["new-with", undefined],
    ["new-ws", undefined],
  ]);
  ops[1]?.run();
  ops[2]?.run();
  expect(s.act.newSessionWith).toHaveBeenCalledOnce();
  expect(s.act.newWorkspace).toHaveBeenCalledOnce();
});

test("工作区项：未归档的按最近有动静排序，选中即切过去；note 写对话数", () => {
  const s = src({
    workspaces: [
      ws("a", "老的", { updatedAt: "2026-01-01T00:00:00Z" }),
      ws("b", "有新对话", { sessionCount: 0 }),
      ws("c", "已归档", { archived: true }),
    ],
    sessions: [
      sess("x", "旧", "a", "2026-03-01T00:00:00Z"),
      sess("y", "归档的新对话", "b", "2026-05-01T00:00:00Z"),
    ],
  });
  // b 名下只有一条会话但它不是未归档的会话吗？这里 y 是 active，所以 b 排在前面
  const list = buildCommands(s).filter((c) => c.kind === "workspace");
  expect(list.map((c) => [c.id, c.label, c.note])).toEqual([
    ["ws-b", "有新对话", "还没有对话"],
    ["ws-a", "老的", "1 个对话"],
  ]);
  list[1]?.run();
  expect(s.act.selectWorkspace).toHaveBeenCalledWith("a");
});

test("空查询只列最近 RECENT_WORKSPACES 个工作区，搜索时全部都能搜到", () => {
  const many = Array.from({ length: RECENT_WORKSPACES + 3 }, (_, i) =>
    ws(`w${i}`, `项目${i}`),
  );
  const list = buildCommands(src({ workspaces: many }));
  const shown = (q: string) =>
    filterCommands(list, q).filter((c) => c.kind === "workspace");
  expect(shown("")).toHaveLength(RECENT_WORKSPACES);
  expect(shown("项目")).toHaveLength(many.length);
  expect(shown("项目8")).toHaveLength(1);
});
