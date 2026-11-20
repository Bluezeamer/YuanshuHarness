import { expect, test, vi } from "vitest";
import type { SidebarController } from "./controller";
import { sessionItems, workspaceItems } from "./menus";
import type { Sess, Ws } from "./model";

const sess = (id: string, archived = false): Sess =>
  ({ id, title: id, archived }) as unknown as Sess;
const ws = (id: string, sessions: Sess[], group: string | null = null): Ws =>
  ({ id, name: id, path: `/w/${id}`, group, sessions }) as Ws;

const s1 = sess("s1");
const s2 = sess("s2");
const s3 = sess("s3", true);
const w1 = ws("w1", [s1, s2, s3]);
const w2 = ws("w2", [], "g1");
const w3 = ws("w3", []);
const wArch = ws("wa", []);

function ctl(selection: SidebarController["selection"]) {
  const calls = {
    archiveSessions: vi.fn(),
    restoreSessions: vi.fn(),
    askRemoveSessions: vi.fn(),
    archiveWorkspaces: vi.fn(),
    askRemoveWorkspaces: vi.fn(),
    joinGroup: vi.fn(),
    newGroup: vi.fn(),
    setSessionPinned: vi.fn(),
    setWorkspacePinned: vi.fn(),
  };
  const c = {
    selection,
    workspaces: [w1, w2, w3],
    archivedWorkspaces: [wArch],
    groups: [
      { id: "g1", name: "主线" },
      { id: "g2", name: "杂项" },
    ],
    ...calls,
  } as unknown as SidebarController;
  return { c, calls };
}

const find = (items: ReturnType<typeof sessionItems>, id: string) =>
  items.find((i) => i.id === id);

test("会话：没有多选（或只选了一个）：还是单个会话的菜单，归档 / 删除只管这一个", () => {
  for (const selection of [
    null,
    { kind: "session", ids: ["s1"] },
    { kind: "session", ids: ["s2", "s3"] }, // 被右键的 s1 不在选择里
    { kind: "workspace", ids: ["w1", "w2"] },
  ] as const) {
    const { c, calls } = ctl(selection);
    const items = sessionItems(s1, c);
    expect(items.map((i) => i.id)).toEqual([
      "refresh",
      "from",
      "settings",
      "pin",
      "rename",
      "archive",
      "remove",
    ]);
    find(items, "archive")?.onSelect?.();
    find(items, "remove")?.onSelect?.();
    expect(calls.archiveSessions).toHaveBeenCalledWith(["s1"]);
    expect(calls.askRemoveSessions).toHaveBeenCalledWith(["s1"]);
  }
});

test("会话：右键选中的行：菜单就是批量的，只剩 归档 / 恢复 / 删除，数量写在字上，动作作用于整个选择", () => {
  const { c, calls } = ctl({ kind: "session", ids: ["s1", "s2", "s3"] });
  const items = sessionItems(s2, c);
  expect(items.map((i) => [i.id, i.label])).toEqual([
    ["archive", "归档 2 个会话"],
    ["restore", "恢复 1 个会话"],
    ["remove", "删除 3 个会话…"],
  ]);
  find(items, "archive")?.onSelect?.();
  expect(calls.archiveSessions).toHaveBeenCalledWith(["s1", "s2"]);
  find(items, "restore")?.onSelect?.();
  expect(calls.restoreSessions).toHaveBeenCalledWith(["s3"]);
  find(items, "remove")?.onSelect?.();
  expect(calls.askRemoveSessions).toHaveBeenCalledWith(["s1", "s2", "s3"]);
  expect(find(items, "remove")?.tone).toBe("danger");
});

test("会话：选的全是没归档的：没有「恢复」；全是已归档的：没有「归档」", () => {
  const live = sessionItems(s1, ctl({ kind: "session", ids: ["s1", "s2"] }).c);
  expect(live.map((i) => i.id)).toEqual(["archive", "remove"]);
  const only = sessionItems(s3, ctl({ kind: "session", ids: ["s3", "s3b"] }).c);
  // s3b 不存在：只数找得到的
  expect(only.map((i) => i.id)).toEqual(["restore", "remove"]);
  expect(only[0]?.label).toBe("恢复 1 个会话");
});

test("工作区：没有多选：单个菜单，删除是 askRemoveWorkspaces([它])", () => {
  const { c, calls } = ctl(null);
  const items = workspaceItems(w1, c, false);
  expect(items.some((i) => i.id === "edit")).toBe(true);
  find(items, "remove")?.onSelect?.();
  expect(calls.askRemoveWorkspaces).toHaveBeenCalledWith(["w1"]);
});

test("工作区：右键选中的行：批量菜单——分组（已全在那个组里的禁用）、移出分组、归档 / 恢复、删除，数量写在字上", () => {
  const { c, calls } = ctl({ kind: "workspace", ids: ["w2", "w3", "wa"] });
  const items = workspaceItems(w3, c, false);
  expect(items.map((i) => [i.id, i.label])).toEqual([
    ["join-g1", "移入分组「主线」"],
    ["join-g2", "移入分组「杂项」"],
    ["newgroup", "新建分组并移入…"],
    ["ungroup", "移出分组"],
    ["archive", "归档 2 个工作区"],
    ["restore", "恢复 1 个工作区"],
    ["remove", "删除 3 个工作区…"],
  ]);
  // w3 不在 g1：「移入主线」可用
  expect(find(items, "join-g1")?.disabled).toBe(false);
  find(items, "join-g2")?.onSelect?.();
  expect(calls.joinGroup).toHaveBeenCalledWith(["w2", "w3", "wa"], "g2");
  find(items, "ungroup")?.onSelect?.();
  expect(calls.joinGroup).toHaveBeenLastCalledWith(["w2", "w3", "wa"], null);
  find(items, "newgroup")?.onSelect?.();
  expect(calls.newGroup).toHaveBeenCalledWith(["w2", "w3", "wa"]);
  find(items, "archive")?.onSelect?.();
  expect(calls.archiveWorkspaces).toHaveBeenCalledWith(["w2", "w3"], true);
  find(items, "restore")?.onSelect?.();
  expect(calls.archiveWorkspaces).toHaveBeenLastCalledWith(["wa"], false);
  find(items, "remove")?.onSelect?.();
  expect(calls.askRemoveWorkspaces).toHaveBeenCalledWith(["w2", "w3", "wa"]);
});

test("工作区：选的都没有分组时没有「移出分组」；都在某个组里时那个组的「移入」禁用", () => {
  const none = workspaceItems(
    w3,
    ctl({ kind: "workspace", ids: ["w3", "wa"] }).c,
    false,
  );
  expect(none.some((i) => i.id === "ungroup")).toBe(false);
  const same = workspaceItems(
    w2,
    ctl({ kind: "workspace", ids: ["w2", "w2"] }).c,
    false,
  );
  expect(same.find((i) => i.id === "join-g1")?.disabled).toBe(true);
});

test("置顶：未置顶写「置顶」，已置顶写「取消置顶」；已归档的不能置顶", () => {
  const { c, calls } = ctl(null);
  find(sessionItems(s1, c), "pin")?.onSelect?.();
  expect(calls.setSessionPinned).toHaveBeenCalledWith("s1", true);
  const pinned = { ...s1, pinned: true } as Sess;
  const item = find(sessionItems(pinned, c), "pin");
  expect(item?.label).toBe("取消置顶");
  item?.onSelect?.();
  expect(calls.setSessionPinned).toHaveBeenLastCalledWith("s1", false);
  expect(find(sessionItems(s3, c), "pin")?.disabled).toBe(true);

  find(workspaceItems(w3, c, false), "pin")?.onSelect?.();
  expect(calls.setWorkspacePinned).toHaveBeenCalledWith("w3", true);
  expect(find(workspaceItems(wArch, c, true), "pin")?.disabled).toBe(true);
});
