import { expect, test } from "vitest";
import type { BoardList } from "../../../../api/canvas";
import type { TreeNode } from "../../../../ui";
import {
  back,
  canBack,
  canForward,
  currentOf,
  forward,
  loadNav,
  mapViews,
  pushView,
  saveNav,
  startNav,
  type View,
} from "./nav";
import {
  clashes,
  countWithin,
  isWithin,
  joinLocation,
  locationOptions,
  movedId,
  newFolderOf,
  newNotePathFor,
  nodesOf,
  opsForMoves,
  previewCreate,
  previewMoves,
  previewRemove,
  refOf,
  renameTarget,
  resolveTarget,
} from "./navTree";

const b = (name: string): View => ({ kind: "board", name });
const n = (path: string): View => ({ kind: "note", path });

test("历史：压入新视图、返回 / 前进；和当前一样不重复压；从中间压入会丢掉「前进」的部分", () => {
  let nav = startNav(b("甲"));
  expect(canBack(nav)).toBe(false);
  nav = pushView(nav, n("a.md"));
  nav = pushView(nav, n("a.md"));
  nav = pushView(nav, b("乙"));
  expect(nav.stack).toEqual([b("甲"), n("a.md"), b("乙")]);
  nav = back(back(nav));
  expect(currentOf(nav)).toEqual(b("甲"));
  expect(canBack(nav)).toBe(false);
  expect(canForward(nav)).toBe(true);
  nav = forward(nav);
  expect(currentOf(nav)).toEqual(n("a.md"));
  nav = pushView(nav, n("c.md"));
  expect(nav.stack).toEqual([b("甲"), n("a.md"), n("c.md")]);
  expect(canForward(nav)).toBe(false);
  expect(back(startNav(b("x")))).toEqual(startNav(b("x")));
});

test("历史最多留 50 条，丢最旧的", () => {
  let nav = startNav(n("0.md"));
  for (let i = 1; i <= 60; i++) nav = pushView(nav, n(`${i}.md`));
  expect(nav.stack).toHaveLength(50);
  expect(nav.stack[0]).toEqual(n("11.md"));
  expect(currentOf(nav)).toEqual(n("60.md"));
});

test("mapViews：改名换成新视图、删除去掉；相邻重复合并；当前条目被去掉时落在它前面的；全没了返回 null", () => {
  const nav = { stack: [b("甲"), n("a.md"), b("乙"), n("a.md")], at: 3 };
  const renamed = mapViews(nav, (v) =>
    v.kind === "note" ? n("新.md") : v,
  ) as NonNullable<ReturnType<typeof mapViews>>;
  expect(renamed.stack).toEqual([b("甲"), n("新.md"), b("乙"), n("新.md")]);
  expect(currentOf(renamed)).toEqual(n("新.md"));

  const dropped = mapViews(nav, (v) =>
    v.kind === "note" ? null : v,
  ) as NonNullable<ReturnType<typeof mapViews>>;
  expect(dropped.stack).toEqual([b("甲"), b("乙")]);
  expect(currentOf(dropped)).toEqual(b("乙"));

  // 合并相邻重复：甲 → 乙 都变成「丙」
  const merged = mapViews({ stack: [b("甲"), b("乙")], at: 1 }, () =>
    b("丙"),
  ) as NonNullable<ReturnType<typeof mapViews>>;
  expect(merged.stack).toEqual([b("丙")]);
  expect(merged.at).toBe(0);

  // 当前条目是第一个又被去掉：落在新的第一个
  const first = mapViews({ stack: [n("a.md"), b("乙")], at: 0 }, (v) =>
    v.kind === "note" ? null : v,
  ) as NonNullable<ReturnType<typeof mapViews>>;
  expect(currentOf(first)).toEqual(b("乙"));
  expect(mapViews(nav, () => null)).toBeNull();
});

const LIST: BoardList = {
  ready: true,
  git: "ok",
  folders: ["产品", "产品/子", "空"],
  boards: [
    { name: "想法", cards: 0, mtimeMs: 0 },
    { name: "产品/时间线", cards: 0, mtimeMs: 0 },
  ],
  notes: ["设计.md", "产品/调研.md", "产品/子/深.md"],
};

test("nodesOf：文件夹、画布（id 带 .canvas）、笔记（id 带 .md）；画布与笔记的显示名去掉后缀；refOf 反过来", () => {
  const nodes = nodesOf(LIST);
  expect(nodes.map((x) => [x.id, x.kind, x.label])).toEqual([
    ["产品", "folder", undefined],
    ["产品/子", "folder", undefined],
    ["空", "folder", undefined],
    ["想法.canvas", "item", "想法"],
    ["产品/时间线.canvas", "item", "时间线"],
    ["设计.md", "item", "设计"],
    ["产品/调研.md", "item", "调研"],
    ["产品/子/深.md", "item", "深"],
  ]);
  expect(nodes.map((x) => refOf(x))).toEqual([
    { kind: "folder", path: "产品" },
    { kind: "folder", path: "产品/子" },
    { kind: "folder", path: "空" },
    { kind: "board", name: "想法" },
    { kind: "board", name: "产品/时间线" },
    { kind: "note", path: "设计.md" },
    { kind: "note", path: "产品/调研.md" },
    { kind: "note", path: "产品/子/深.md" },
  ]);
  expect(nodesOf(null)).toEqual([]);
});

test("renameTarget：只改最后一段，保留所在文件夹；画布与笔记没写后缀就补上、写了不重复；撞名、空名、非法字符、点开头报错", () => {
  const nodes = nodesOf(LIST);
  const taken = new Set(nodes.map((x) => x.id));
  const at = (id: string) =>
    nodes.find((x) => x.id === id) as (typeof nodes)[0];
  expect(renameTarget(at("产品/调研.md"), "研究", taken)).toEqual({
    to: "产品/研究.md",
  });
  expect(renameTarget(at("产品/调研.md"), "研究.md", taken)).toEqual({
    to: "产品/研究.md",
  });
  expect(renameTarget(at("产品/时间线.canvas"), "路线", taken)).toEqual({
    to: "产品/路线.canvas",
  });
  expect(renameTarget(at("想法.canvas"), "新想法.canvas", taken)).toEqual({
    to: "新想法.canvas",
  });
  expect(renameTarget(at("产品/子"), "孙", taken)).toEqual({ to: "产品/孙" });
  // 没改（和自己同名）不算撞名
  expect(renameTarget(at("设计.md"), "设计", taken)).toEqual({ to: "设计.md" });
  for (const [node, name, msg] of [
    ["设计.md", "想法", undefined],
    ["设计.md", "  ", "不能为空"],
    ["设计.md", "a/b", "不能有"],
    ["设计.md", ".隐藏", "点开头"],
    ["空", "x.md", "不能以"],
    ["空", "产品", "同名"],
  ] as const) {
    const r = renameTarget(at(node), name, taken);
    if (msg === undefined) expect(r).toEqual({ to: "想法.md" });
    else expect("error" in r && r.error).toContain(msg);
  }
});

test("opsForMoves / movedId：画布换成画布名、文件夹与笔记保持路径；被挪的文件夹里的东西一起走；没被挪的原样", () => {
  const nodes = nodesOf(LIST);
  const ops = opsForMoves(nodes, [
    { id: "想法.canvas", to: "空/想法.canvas" },
    { id: "产品", to: "空/产品" },
    { id: "设计.md", to: "空/设计.md" },
    { id: "不存在.md", to: "x.md" },
  ]);
  expect(ops).toEqual([
    { kind: "board", from: "想法", to: "空/想法" },
    { kind: "folder", from: "产品", to: "空/产品" },
    { kind: "note", from: "设计.md", to: "空/设计.md" },
  ]);
  expect(movedId("想法.canvas", ops)).toBe("空/想法.canvas");
  expect(movedId("产品/子/深.md", ops)).toBe("空/产品/子/深.md");
  expect(movedId("产品/时间线.canvas", ops)).toBe("空/产品/时间线.canvas");
  expect(movedId("设计.md", ops)).toBe("空/设计.md");
  expect(movedId("产品2/x.md", ops)).toBe("产品2/x.md");
  expect(movedId("空", ops)).toBe("空");
});

test("isWithin / clashes / countWithin：文件夹之下算在内（前缀要整段匹配）；拖过去撞名；删除要数里面有多少", () => {
  expect(isWithin("产品/子", ["产品"])).toBe(true);
  expect(isWithin("产品", ["产品"])).toBe(true);
  expect(isWithin("产品2", ["产品"])).toBe(false);
  const nodes = nodesOf(LIST);
  const dragged = nodes.filter((x) => x.id === "产品/调研.md");
  expect(clashes(nodes, dragged, "")).toBe(false);
  expect(clashes(nodes, [{ id: "设计.md", kind: "item" }], "产品")).toBe(false);
  expect(
    clashes(
      [...nodes, { id: "产品/设计.md", kind: "item" }],
      [{ id: "设计.md", kind: "item" }],
      "产品",
    ),
  ).toBe(true);
  expect(countWithin(nodes, ["产品"])).toEqual({
    folders: 2,
    boards: 1,
    notes: 2,
  });
  expect(countWithin(nodes, ["设计.md", "想法.canvas"])).toEqual({
    folders: 0,
    boards: 1,
    notes: 1,
  });
});

test("resolveTarget：先原样、再补 .md、再补 .canvas；规范化 ./ 与 .canvas/；指不到是 null；newNotePathFor 去掉 .md", () => {
  expect(resolveTarget("设计", LIST)).toEqual({
    kind: "note",
    path: "设计.md",
  });
  expect(resolveTarget("产品/调研.md", LIST)).toEqual({
    kind: "note",
    path: "产品/调研.md",
  });
  expect(resolveTarget("想法", LIST)).toEqual({ kind: "board", name: "想法" });
  expect(resolveTarget("产品/时间线.canvas", LIST)).toEqual({
    kind: "board",
    name: "产品/时间线",
  });
  expect(resolveTarget("./.canvas/设计", LIST)).toEqual({
    kind: "note",
    path: "设计.md",
  });
  expect(resolveTarget("不存在", LIST)).toBeNull();
  expect(resolveTarget("  ", LIST)).toBeNull();
  expect(resolveTarget("设计", null)).toBeNull();
  expect(newNotePathFor("./新/笔记.md")).toBe("新/笔记");
});

test("joinLocation：位置 + 名字拼成路径；名字空 = 以斜杠结尾（画布留空用时间命名）；根上的不带斜杠", () => {
  expect(joinLocation("", "笔记")).toBe("笔记");
  expect(joinLocation("产品/子", "笔记")).toBe("产品/子/笔记");
  expect(joinLocation("产品", "")).toBe("产品/");
  expect(joinLocation("", "")).toBe("");
});

test("locationOptions：根在最前、再是所有文件夹；默认位置不存在时补一项标「新建」，存在或是根就不补", () => {
  const folders = ["产品", "产品/子"];
  expect(locationOptions(folders, "")).toEqual([
    { value: "", label: "根目录" },
    { value: "产品", label: "产品" },
    { value: "产品/子", label: "产品/子" },
  ]);
  expect(locationOptions(folders, "产品/子")).toHaveLength(3);
  expect(locationOptions(folders, "新/路径").at(-1)).toEqual({
    value: "新/路径",
    label: "新/路径（新建）",
  });
});

test("previewMoves：画布 / 笔记 / 文件夹按服务端的规则换路径，文件夹里的一起走，前缀整段匹配；清单保持排序", () => {
  const ops = [
    { kind: "board" as const, from: "想法", to: "空/想法" },
    { kind: "folder" as const, from: "产品", to: "空/产品" },
    { kind: "note" as const, from: "设计.md", to: "空/设计.md" },
  ];
  const out = previewMoves(LIST, ops);
  expect(out.boards.map((b) => b.name)).toEqual(["空/产品/时间线", "空/想法"]);
  expect(out.notes).toEqual([
    "空/产品/子/深.md",
    "空/产品/调研.md",
    "空/设计.md",
  ]);
  expect(out.folders).toEqual(["空", "空/产品", "空/产品/子"]);
  // 前缀相近的兄弟文件夹不受影响
  const other: BoardList = {
    ...LIST,
    folders: ["产品", "产品2"],
    notes: ["产品2/a.md"],
    boards: [],
  };
  const o2 = previewMoves(other, [{ kind: "folder", from: "产品", to: "X" }]);
  expect(o2.folders).toEqual(["X", "产品2"]);
  expect(o2.notes).toEqual(["产品2/a.md"]);
  // 改名：只换最后一段
  const r = previewMoves(LIST, [
    { kind: "note", from: "产品/调研.md", to: "产品/研究.md" },
  ]);
  expect(r.notes).toContain("产品/研究.md");
  expect(r.notes).not.toContain("产品/调研.md");
});

test("previewRemove：文件夹里的东西一起去掉；previewCreate：补上缺的上级文件夹、不重复加", () => {
  const r = previewRemove(LIST, ["产品", "想法.canvas"]);
  expect(r.folders).toEqual(["空"]);
  expect(r.boards).toEqual([]);
  expect(r.notes).toEqual(["设计.md"]);
  const c = previewCreate(LIST, { kind: "note", path: "新/深/笔记.md" });
  expect(c.folders).toEqual(["产品", "产品/子", "新", "新/深", "空"]);
  expect(c.notes).toContain("新/深/笔记.md");
  expect(
    previewCreate(c, { kind: "note", path: "新/深/笔记.md" }).notes,
  ).toEqual(c.notes);
  const b = previewCreate(LIST, { kind: "board", path: "产品/新板" });
  expect(b.boards.map((x) => x.name)).toContain("产品/新板");
  expect(
    previewCreate(LIST, { kind: "folder", path: "空/子" }).folders,
  ).toContain("空/子");
});

const folderNode = (id: string): TreeNode => ({ id, kind: "folder" });
const itemNode = (id: string): TreeNode => ({ id, kind: "item" });
const FOCUS_NODES = [
  folderNode("产品"),
  folderNode("产品/访谈"),
  itemNode("产品/访谈/甲.md"),
  itemNode("总览.md"),
];

test("快捷新建的位置：树里选中的优先（文件夹是它自己、条目是它所在的文件夹），其次主区打开的，最后根", () => {
  expect(newFolderOf(FOCUS_NODES, "产品/访谈", "总览.md")).toBe("产品/访谈");
  expect(newFolderOf(FOCUS_NODES, "产品/访谈/甲.md", "总览.md")).toBe(
    "产品/访谈",
  );
  expect(newFolderOf(FOCUS_NODES, "总览.md", null)).toBe("");
  expect(newFolderOf(FOCUS_NODES, null, "产品/访谈/甲.md")).toBe("产品/访谈");
  expect(newFolderOf(FOCUS_NODES, null, "总览.md")).toBe("");
  expect(newFolderOf(FOCUS_NODES, null, null)).toBe("");
});

test("选中的行已经不在清单里：当没选，退到主区打开的", () => {
  expect(newFolderOf(FOCUS_NODES, "已删", "产品/访谈/甲.md")).toBe("产品/访谈");
  expect(newFolderOf([], "产品", null)).toBe("");
});

test("浏览历史存进标签记录再读回来：画布与笔记混着、当前位置都还原；认不出的条目丢掉；空的读不出来", () => {
  let nav = startNav(b("想法"));
  nav = pushView(nav, n("产品/访谈.md"));
  nav = pushView(nav, b("产品/时间线"));
  nav = back(nav);
  const saved = saveNav(nav);
  expect(saved).toEqual({
    stack: ["board:想法", "note:产品/访谈.md", "board:产品/时间线"],
    at: 1,
  });
  expect(loadNav(saved)).toEqual(nav);
  // 认不出的条目丢掉，当前位置跟着它前面的条目重算
  expect(loadNav({ stack: ["x:1", "board:甲", "note:乙.md"], at: 2 })).toEqual({
    stack: [b("甲"), n("乙.md")],
    at: 1,
  });
  // 当前位置指向认不出的条目：落在最后一条
  expect(loadNav({ stack: ["board:甲", "bad"], at: 1 })).toEqual({
    stack: [b("甲")],
    at: 0,
  });
  expect(loadNav({ stack: ["bad"], at: 0 })).toBeNull();
  expect(loadNav(undefined)).toBeNull();
});
