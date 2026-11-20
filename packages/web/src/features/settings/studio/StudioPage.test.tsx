// 「提示词与能力」：七个页签、预设的列表与编辑页、全局 AGENTS.md 的激活与覆盖确认、卡片库。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../../../api/http";
import {
  type Call,
  fakeFetch,
  type Handler,
  json,
} from "../../../test/dialogsServer";
import { choose } from "../../../test/select";
import { clearToasts, ToastHost } from "../../../ui";
import { LeaveGuardProvider } from "../frame/leave";
import { StudioPage } from "./StudioPage";

const preset = (
  id: string,
  kind: string,
  name: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  kind,
  name,
  description: `${name} 的描述`,
  active: false,
  capabilities: null,
  capsAdd: [],
  capsRemove: [],
  updatedAt: "2026-11-06T08:00:00Z",
  ...over,
});
const PRESETS = [
  preset("g3", "global-agentsmd", "我的习惯 v3", { active: true }),
  preset("g2", "global-agentsmd", "我的习惯 v2"),
  preset("pf", "project-agentsmd", "前端模板"),
  preset("a1", "agent", "coder-full", { refCount: 0 }),
  preset("m1", "mode", "plan"),
];
const card = (id: string, title: string, group: string, builtin = false) => ({
  id,
  group,
  title,
  body: `${title} 的正文`,
  builtin,
  origin: builtin ? "pi" : "user",
  copyOf: null,
  usedBy: builtin ? 3 : 0,
});
const GROUPS0 = [
  {
    group: "项目约定",
    cards: [
      card("c1", "语言与称呼", "项目约定"),
      card("c2", "提交规范", "项目约定"),
    ],
  },
  { group: "角色与身份", cards: [card("c3", "元枢身份", "角色与身份", true)] },
];
const node = (cardIds: string[], tag: string | null = null) => ({
  id: "n1",
  tag,
  title: "正文",
  slotKind: "custom",
  channel: "system",
  builtin: false,
  items: cardIds.map((cardId) => ({ kind: "card", cardId })),
});

let calls: Call[];
let groups = structuredClone(GROUPS0);
let activateTimes = 0;
const state = { modified: true, activateFails: 1, putFails: 1 };

const server: Handler = (c) => {
  const p = c.path;
  if (c.method === "GET") {
    if (p === "/api/v1/studio/presets") return json({ presets: PRESETS });
    if (p === "/api/v1/studio/cards") return json({ groups });
    if (p === "/api/v1/default-model") return json({ default: null });
    if (p === "/api/v1/agents-md/global")
      return json({
        path: "/ys/AGENTS.md",
        exists: true,
        modified: state.modified,
      });
    const m = p.match(/^\/api\/v1\/studio\/presets\/([^/]+)$/);
    if (m) {
      const base = PRESETS.find((x) => x.id === m[1]);
      return base
        ? json({ preset: { ...base, nodes: [node(["c1"], null)] } })
        : json({ error: "not_found" }, 404);
    }
  }
  if (c.method === "POST" && /\/studio\/presets\/[^/]+\/activate$/.test(p)) {
    activateTimes += 1;
    if (
      state.activateFails > 0 &&
      !(c.body as { overwrite?: boolean }).overwrite
    ) {
      state.activateFails -= 1;
      return json({ error: "disk_modified" }, 409);
    }
    return json({ ok: true });
  }
  if (c.method === "POST" && p === "/api/v1/studio/card-groups") {
    const name = (c.body as { name: string }).name;
    if (groups.some((g) => g.group === name))
      return json({ error: "exists" }, 409);
    groups.push({ group: name, cards: [] });
    return json({ group: name }, 201);
  }
  if (c.method === "DELETE" && p.startsWith("/api/v1/studio/card-groups/")) {
    const name = decodeURIComponent(p.split("/").pop() ?? "");
    const g = groups.find((x) => x.group === name);
    if (!g) return json({ error: "not_found" }, 404);
    if (g.cards.length > 0) return json({ error: "not_empty" }, 409);
    groups = groups.filter((x) => x !== g);
    return new Response(null, { status: 204 });
  }
  if (c.method === "PATCH" && /\/studio\/cards\/[^/]+$/.test(p))
    return json({ id: p.split("/").pop(), ...(c.body as object) });
  if (c.method === "POST" && p === "/api/v1/agents-md/global/import") {
    state.modified = false;
    return json({ preset: preset("gi", "global-agentsmd", "从磁盘导入") }, 201);
  }
  if (c.method === "PUT" && /\/studio\/presets\/[^/]+\/nodes$/.test(p)) {
    if (state.putFails > 0 && !c.url.searchParams.get("overwrite")) {
      state.putFails -= 1;
      return json({ error: "disk_modified" }, 409);
    }
    return json({ preset: {} });
  }
  return undefined;
};

beforeEach(() => {
  saveToken("tkn");
  calls = [];
  groups = structuredClone(GROUPS0);
  activateTimes = 0;
  state.modified = true;
  state.activateFails = 1;
  state.putFails = 1;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearToasts();
});

async function mount(handler: Handler = server) {
  vi.stubGlobal("fetch", fakeFetch(calls, handler));
  render(
    <LeaveGuardProvider>
      <StudioPage />
      <ToastHost />
    </LeaveGuardProvider>,
  );
  await screen.findByRole("tab", { name: /^Agent/ });
}
const tab = (name: RegExp | string) => screen.getByRole("tab", { name });
const menu = async (cardName: string, item: string) => {
  fireEvent.click(screen.getByRole("button", { name: `${cardName} 的操作` }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
};
const find = (method: string, pattern: RegExp) =>
  calls.filter((c) => c.method === method && pattern.test(c.path));

test("八个页签都在，带数量；默认在 Agent", async () => {
  await mount();
  const names = screen.getAllByRole("tab").map((t) => t.textContent);
  expect(names).toEqual([
    "全局 AGENTS.md2",
    "项目 AGENTS.md1",
    "全局附加提示词0",
    "Agent1",
    "模式1",
    "审核提示词",
    "工具",
    "卡片3",
  ]);
  expect(tab(/^Agent/).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("button", { name: "coder-full" })).toBeTruthy();
});

test("全局 AGENTS.md：生效中的版本有标记，磁盘文件不在任何版本里时有提示条", async () => {
  await mount();
  fireEvent.click(tab(/^全局 AGENTS.md/));
  expect(await screen.findByText("生效中")).toBeTruthy();
  expect(screen.getByText(/不在任何版本里/)).toBeTruthy();
});

test("激活被手改过的文件：弹窗里「直接覆盖」带 overwrite 重发，成功后提示", async () => {
  await mount();
  fireEvent.click(tab(/^全局 AGENTS.md/));
  await menu("我的习惯 v2", "激活");
  await screen.findByText("磁盘上的文件被改动过");
  expect(find("POST", /activate$/)[0]?.body).toEqual({});
  fireEvent.click(screen.getByRole("button", { name: "直接覆盖" }));
  await screen.findByText(/已激活「我的习惯 v2」/);
  expect(find("POST", /activate$/).map((c) => c.body)).toEqual([
    {},
    { overwrite: true },
  ]);
});

test("激活被手改过的文件：选「另存为新版本再继续」先导入，再不带 overwrite 激活", async () => {
  await mount();
  fireEvent.click(tab(/^全局 AGENTS.md/));
  await menu("我的习惯 v2", "激活");
  fireEvent.click(
    await screen.findByRole("button", { name: "另存为新版本再继续" }),
  );
  await screen.findByText(/已激活「我的习惯 v2」/);
  const order = calls
    .filter((c) => c.method === "POST")
    .map((c) => c.path.replace(/presets\/[^/]+/, "presets/:id"));
  expect(order).toEqual([
    "/api/v1/studio/presets/:id/activate",
    "/api/v1/agents-md/global/import",
    "/api/v1/studio/presets/:id/activate",
  ]);
  expect(find("POST", /activate$/)[1]?.body).toEqual({});
});

test("激活被手改过的文件：取消就什么都不写；文件没被改过时直接激活不弹窗", async () => {
  await mount();
  fireEvent.click(tab(/^全局 AGENTS.md/));
  await menu("我的习惯 v2", "激活");
  fireEvent.click(await screen.findByRole("button", { name: "取消" }));
  expect(screen.queryByText("磁盘上的文件被改动过")).toBeNull();
  expect(activateTimes).toBe(1);
  await menu("我的习惯 v2", "激活");
  await screen.findByText(/已激活「我的习惯 v2」/);
  expect(screen.queryByText("磁盘上的文件被改动过")).toBeNull();
});

test("提示条里的「另存为新版本」把磁盘内容导入成新版本", async () => {
  await mount();
  fireEvent.click(tab(/^全局 AGENTS.md/));
  fireEvent.click(await screen.findByRole("button", { name: "另存为新版本" }));
  await screen.findByText(/已把磁盘上的内容存成新版本/);
  expect(find("POST", /global\/import$/)).toHaveLength(1);
});

test("删除：生效中的版本不能删（菜单项置灰并说明）", async () => {
  await mount();
  fireEvent.click(tab(/^全局 AGENTS.md/));
  fireEvent.click(screen.getByRole("button", { name: "我的习惯 v3 的操作" }));
  const del = await screen.findByRole("menuitem", { name: /删除/ });
  expect(
    del.hasAttribute("disabled") ||
      del.getAttribute("aria-disabled") === "true",
  ).toBe(true);
  expect(del.textContent).toContain("先把别的版本设为生效");
});

async function addCardToOpenVersion() {
  fireEvent.click(await screen.findByRole("button", { name: "添加卡片" }));
  const dlg = await screen.findByRole("dialog", { name: "添加卡片" });
  fireEvent.click(within(dlg).getByRole("button", { name: /^提交规范/ }));
  fireEvent.click(within(dlg).getByRole("button", { name: /^添加/ }));
}

test("编辑全局版本：保存时磁盘文件被手改过就先问，覆盖后带 overwrite 重发", async () => {
  await mount();
  fireEvent.click(tab(/^全局 AGENTS.md/));
  fireEvent.click(await screen.findByRole("button", { name: "我的习惯 v2" }));
  await addCardToOpenVersion();
  fireEvent.click(await screen.findByRole("button", { name: "保存" }));
  await screen.findByText("磁盘上的文件被改动过");
  expect(find("PUT", /nodes$/)).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "直接覆盖" }));
  await screen.findByText("已保存");
  const puts = find("PUT", /nodes/);
  expect(puts.map((c) => c.path)).toEqual([
    "/api/v1/studio/presets/g2/nodes",
    "/api/v1/studio/presets/g2/nodes?overwrite=1",
  ]);
});

test("两份 AGENTS.md 的编辑页不能建分组、预览里没有模型选择；Agent 的可以", async () => {
  await mount();
  fireEvent.click(tab(/^项目 AGENTS.md/));
  fireEvent.click(await screen.findByRole("button", { name: "前端模板" }));
  await screen.findByRole("button", { name: "添加卡片" });
  expect(screen.queryByRole("button", { name: "新建分组" })).toBeNull();
  expect(screen.queryByText("按这个模型求值")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "返回模板列表" }));
  fireEvent.click(await screen.findByRole("tab", { name: /^Agent/ }));
  fireEvent.click(await screen.findByRole("button", { name: "coder-full" }));
  await screen.findByRole("tab", { name: "能力" });
  expect(
    await screen.findAllByRole("button", { name: "新建分组" }),
  ).toBeTruthy();
});

test("卡片库：左边是分组，右边是该分组的卡片；点卡片开悬浮窗，内置卡片的主按钮是「复制一份」", async () => {
  await mount();
  fireEvent.click(tab(/^卡片/));
  const nav = await screen.findByRole("complementary", { name: "卡片库" });
  expect(within(nav).getByText("项目约定")).toBeTruthy();
  fireEvent.click(groupRow(nav, "角色与身份"));
  expect(screen.queryByRole("button", { name: "语言与称呼" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "元枢身份" }));
  const dlg = await screen.findByRole("dialog");
  expect(dlg.getAttribute("data-size")).toBe("xl");
  expect(within(dlg).getByRole("button", { name: "复制一份" })).toBeTruthy();
  expect(within(dlg).queryByRole("button", { name: "保存" })).toBeNull();
  await waitFor(() =>
    expect(
      (within(dlg).getByLabelText("标题") as HTMLInputElement).readOnly,
    ).toBe(true),
  );
});

// 左边分组行的按钮（不含它悬停时的「⋯」）
const groupRow = (nav: HTMLElement, name: string) =>
  within(nav).getByRole("button", { name: new RegExp(`^${name}(?! 的操作)`) });
const openLibrary = async () => {
  await mount();
  fireEvent.click(tab(/^卡片/));
  return screen.findByRole("complementary", { name: "卡片库" });
};
const newGroup = async (nav: HTMLElement, name: string) => {
  fireEvent.click(within(nav).getByRole("button", { name: "新建分组" }));
  const dlg = await screen.findByRole("dialog", { name: "新建分组" });
  fireEvent.change(within(dlg).getByLabelText("分组名"), {
    target: { value: name },
  });
  fireEvent.click(within(dlg).getByRole("button", { name: "新建" }));
  return dlg;
};

test("卡片库：新建分组后出现在左边并被选中，右边是空的；重名给出提示", async () => {
  const nav = await openLibrary();
  await newGroup(nav, "团队约定");
  await waitFor(() => expect(groupRow(nav, "团队约定")).toBeTruthy());
  expect(find("POST", /card-groups$/)[0]?.body).toEqual({ name: "团队约定" });
  expect(groupRow(nav, "团队约定").getAttribute("aria-current")).toBe("true");
  expect(await screen.findByText("这个分组里没有卡片")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "新建分组" })).toBeNull();

  const dlg = await newGroup(nav, "项目约定");
  void dlg;
  expect(await screen.findByText("已经有这个分组了")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "新建分组" })).toBeTruthy();
});

test("卡片库：有卡片的分组不能删（菜单项置灰并写明张数）；空分组删了就消失，选中回到「全部」", async () => {
  const nav = await openLibrary();
  fireEvent.click(within(nav).getByRole("button", { name: "项目约定 的操作" }));
  const blocked = await screen.findByRole("menuitem", { name: /删除分组/ });
  expect(blocked.textContent).toContain("还有 2 张卡片");
  expect(
    blocked.hasAttribute("disabled") ||
      blocked.getAttribute("aria-disabled") === "true",
  ).toBe(true);
  fireEvent.keyDown(document.body, { key: "Escape" });

  await newGroup(nav, "临时");
  await waitFor(() => expect(groupRow(nav, "临时")).toBeTruthy());
  fireEvent.click(within(nav).getByRole("button", { name: "临时 的操作" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /删除分组/ }));
  await waitFor(() =>
    expect(
      within(nav).queryByRole("button", { name: /^临时(?! 的操作)/ }),
    ).toBeNull(),
  );
  expect(find("DELETE", /card-groups\//).map((c) => c.path)).toEqual([
    `/api/v1/studio/card-groups/${encodeURIComponent("临时")}`,
  ]);
  expect(groupRow(nav, "全部").getAttribute("aria-current")).toBe("true");
  // 「全部」不是分组：没有「⋯」
  expect(within(nav).queryByRole("button", { name: "全部 的操作" })).toBeNull();
});

test("卡片库：在某个分组里新建卡片，分组默认就是它；编辑卡片时可以改分组", async () => {
  const nav = await openLibrary();
  await newGroup(nav, "团队约定");
  await waitFor(() => expect(groupRow(nav, "团队约定")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /新建卡片/ }));
  const created = await screen.findByRole("dialog", { name: "新建卡片" });
  expect(
    (within(created).getByLabelText("分组") as HTMLElement).getAttribute(
      "data-value",
    ),
  ).toBe("团队约定");
  fireEvent.click(within(created).getByRole("button", { name: "取消" }));

  fireEvent.click(groupRow(nav, "项目约定"));
  fireEvent.click(await screen.findByRole("button", { name: "语言与称呼" }));
  const dlg = await screen.findByRole("dialog");
  choose(within(dlg).getByLabelText("分组"), "团队约定");
  fireEvent.click(within(dlg).getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(find("PATCH", /studio\/cards\/c1$/)).toHaveLength(1),
  );
  expect(find("PATCH", /studio\/cards\/c1$/)[0]?.body).toMatchObject({
    group: "团队约定",
  });
});
