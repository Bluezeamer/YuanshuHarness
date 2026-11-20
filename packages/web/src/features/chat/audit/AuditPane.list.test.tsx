// 对应原型 tests/audit.smoke.cjs 的「调用序列 / 筛选与搜索 / 空态 / 会话之间」断言，外加分页载入。
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { api } from "./fakeapi";
import {
  clickRow,
  filterCounts,
  filterShown,
  installStore,
  isCurrent,
  labelOf,
  latest,
  loaded,
  mount,
  pickFilter,
  row,
  rows,
  search,
  seqs,
  setupEnv,
  subOf,
} from "./harness";
import { makeCall, sample } from "./testkit";

vi.mock("../../../api/calls", async () => (await import("./fakeapi")).api);

setupEnv();

// ── 调用序列 ──

test("序列渲染 11 行，倒序；默认选中最新一条；按轮次分组", async () => {
  mount();
  await loaded();
  expect(seqs()).toEqual([
    "11",
    "10",
    "9",
    "8",
    "7",
    "6",
    "5",
    "4",
    "3",
    "2",
    "1",
  ]);
  expect(isCurrent(row(11))).toBe(true);
  expect(isCurrent(row(10))).toBe(false);
  const turns = [...document.querySelectorAll(".au-turn")].map(
    (x) => x.textContent,
  );
  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatch(/轮次 2/);
  expect(turns[1]).toMatch(/轮次 1/);
});

test("每行：序号 / 摘要 / `触发 · 工具 · 入 · 耗时`；发起的工具不在行上，在悬停卡里", async () => {
  mount();
  await loaded();
  const r3 = row(3);
  expect(r3.querySelector(".au-seq")?.textContent).toBe("03");
  expect(labelOf(r3)).toBe("edited");
  expect(subOf(r3)).toBe("工具返回 · edit_file · 380 入 · 1.5s");
  expect(subOf(row(5))).toMatch(/^用户输入 · /);
  expect(subOf(row(6))).toMatch(/^工具返回 · /);
  // 没有 U / T / S 字形徽标
  expect(document.querySelector(".au-k")).toBeNull();
});

test("无轮次归属的调用单独成组", async () => {
  installStore({
    s1: [makeCall("s1", { seq: 1, turn: null, trigger: "user" })],
  });
  mount();
  await screen.findByText("调用 01");
  expect(document.querySelector(".au-turn")?.textContent).toMatch(/未归属轮次/);
});

// ── 筛选与搜索 ──

test("筛选计数与调用类型一致：全部11 用户2 工具返回9 工具调用8 子代理1（子代理按子会话的调用计）", async () => {
  mount();
  await loaded();
  expect(filterCounts()).toEqual({
    全部: 11,
    用户: 2,
    工具返回: 9,
    工具调用: 8,
    子代理: 1,
  });
});

test("子代理的调用不进本会话的序列：其余档位只含自己的调用", async () => {
  mount();
  await loaded();
  expect(seqs()).not.toContain("12");
  expect(rows().every((r) => !subOf(r).startsWith("子代理请求"))).toBe(true);
});

test("筛出子代理：读子会话那一路，标明来自哪个子会话；互斥选中；筛后自动选中首条", async () => {
  mount();
  await loaded();
  pickFilter("子代理");
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(filterShown()).toBe("子代理");
  expect(isCurrent(row(12))).toBe(true);
  expect(subOf(row(12))).toMatch(/^子代理请求 · /);
  // 轮次头标明来源子会话；详情头也是
  expect(document.querySelector(".au-turn")?.textContent).toMatch(
    /^只读检索 · 轮次 2/,
  );
  await screen.findByText("调用 12");
  expect(screen.getByText("来自子会话 · 只读检索")).toBeTruthy();
  expect(latest.afx?.filter).toBe("sub");
});

test("子代理调用的详情向子会话取，不是向本会话取", async () => {
  mount();
  await loaded();
  pickFilter("子代理");
  await screen.findByText("调用 12");
  await waitFor(() => expect(document.querySelector(".au-sec")).toBeTruthy());
  expect(api.getCall).toHaveBeenLastCalledWith(null, "s1-sub", "s1-c12");
});

test("筛出工具调用：按是否发起了工具判定，与触发类型无关", async () => {
  mount();
  await loaded();
  pickFilter("工具调用");
  expect(seqs()).toEqual(["9", "8", "7", "6", "5", "3", "2", "1"]);
});

test("工具返回档只含 tool_result 触发的调用", async () => {
  mount();
  await loaded();
  pickFilter("工具返回");
  expect(rows()).toHaveLength(9);
  expect(rows().every((r) => subOf(r).startsWith("工具返回"))).toBe(true);
});

test("搜索命中工具名（来源工具与发起的工具都算），写进 afx.q", async () => {
  mount();
  await loaded();
  search("dispatch");
  expect(seqs()).toEqual(["11", "5"]);
  expect(latest.afx?.q).toBe("dispatch");
  search("");
  expect(rows()).toHaveLength(11);
});

test("搜索不匹配请求正文（列表阶段只看摘要字段）", async () => {
  mount();
  await loaded();
  search("你是元枢");
  expect(rows()).toHaveLength(0);
});

test("搜索无结果给空态，详情不崩，清掉后恢复 11 条", async () => {
  mount();
  await loaded();
  search("zzzz-not-exist");
  expect(rows()).toHaveLength(0);
  expect(screen.getByText(/没有符合条件的调用/)).toBeTruthy();
  expect(screen.getByText(/没有可展开的调用/)).toBeTruthy();
  search("");
  await screen.findByText("调用 11");
  expect(rows()).toHaveLength(11);
});

test("汇总：次数 / 入 / 出；筛选或搜索后标「筛后」并改算筛出的合计", async () => {
  mount();
  await loaded();
  const sum = () => document.querySelector("[data-asum]")?.textContent ?? "";
  expect(sum()).toMatch(/^11 次调用/);
  expect(sum()).toContain("入 4.2k · 出 440");
  expect(sum()).not.toContain("筛后");
  pickFilter("子代理");
  await waitFor(() => expect(sum()).toMatch(/^1 次调用 · 筛后/));
  expect(sum()).toContain("入 380 · 出 40");
  pickFilter("全部");
  expect(sum()).not.toContain("筛后");
  search("dispatch");
  expect(sum()).toMatch(/^2 次调用 · 筛后/);
});

// ── 空态 / 失败 / 无输入框 / 会话切换 ──

test("无调用记录给空态，不铺占位", async () => {
  installStore({ s1: [] });
  mount();
  await screen.findByText("此会话没有模型调用记录");
  expect(rows()).toHaveLength(0);
});

test("审计视图里没有输入框：只有搜索框一个文本输入", async () => {
  mount();
  await loaded();
  expect(document.querySelector("textarea")).toBeNull();
  const boxes = screen.getAllByRole("textbox");
  expect(boxes).toHaveLength(1);
  expect(boxes[0]?.getAttribute("aria-label")).toBe("搜索调用记录");
});

test("列表载入失败给重试", async () => {
  api.listCalls.mockResolvedValueOnce({ ok: false, kind: "network" });
  mount();
  await screen.findByText("无法载入调用记录");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("调用 11");
});

test("详情载入失败给重试，重试成功后显示正文", async () => {
  api.getCall.mockResolvedValueOnce({ ok: false, kind: "network" });
  mount();
  await screen.findByText(/网络不通，无法载入这条调用/);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(document.querySelector(".au-sec")).toBeTruthy());
});

test("切换会话：序列与详情一起换，选中落到新会话的首条", async () => {
  installStore({
    s1: sample("s1"),
    s2: [1, 2, 3, 4, 5].map((n) =>
      makeCall("s2", {
        seq: n,
        turn: 1,
        trigger: "tool_result",
        toolName: "t",
      }),
    ),
  });
  const { switchTo } = mount();
  await loaded();
  clickRow(row(5));
  switchTo("s2");
  await screen.findByText("调用 05");
  await waitFor(() => expect(rows()).toHaveLength(5));
  expect(rows().every((r) => r.dataset.call?.startsWith("s2-"))).toBe(true);
});

// ── 载入更早的调用 ──

function bigStore(n: number) {
  installStore({
    s1: Array.from({ length: n }, (_, i) =>
      makeCall("s1", {
        seq: i + 1,
        turn: Math.floor(i / 10) + 1,
        trigger: "tool_result",
        toolName: "t",
      }),
    ),
  });
}

function nearEnd(list: HTMLElement) {
  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(list, "clientHeight", {
    configurable: true,
    value: 400,
  });
  Object.defineProperty(list, "scrollTop", { configurable: true, value: 560 });
}

test("滚到底自动载入更早的调用，游标取上一页最小 seq；到头后不再请求", async () => {
  bigStore(120);
  mount();
  await screen.findByText("调用 120");
  expect(rows()).toHaveLength(100);
  expect(api.listCalls).toHaveBeenLastCalledWith(null, "s1", { limit: 100 });
  const list = document.querySelector("[data-alist]") as HTMLElement;
  nearEnd(list);
  fireEvent.scroll(list);
  fireEvent.scroll(list); // 连续触发只发一次请求
  await waitFor(() => expect(rows()).toHaveLength(120));
  expect(api.listCalls).toHaveBeenCalledTimes(2);
  expect(api.listCalls).toHaveBeenLastCalledWith(null, "s1", {
    before: 21,
    limit: 100,
  });
  expect(screen.queryByRole("button", { name: /载入更早的调用/ })).toBeNull();
  fireEvent.scroll(list);
  expect(api.listCalls).toHaveBeenCalledTimes(2);
});

test("没滚到底不载入；底部按钮可手动载入；失败可重试", async () => {
  bigStore(120);
  mount();
  await screen.findByText("调用 120");
  const list = document.querySelector("[data-alist]") as HTMLElement;
  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    value: 5000,
  });
  Object.defineProperty(list, "clientHeight", {
    configurable: true,
    value: 400,
  });
  Object.defineProperty(list, "scrollTop", { configurable: true, value: 0 });
  fireEvent.scroll(list);
  expect(api.listCalls).toHaveBeenCalledTimes(1);
  api.listCalls.mockResolvedValueOnce({ ok: false, kind: "server" });
  fireEvent.click(screen.getByRole("button", { name: "载入更早的调用" }));
  await screen.findByRole("button", { name: "载入失败，点此重试" });
  expect(rows()).toHaveLength(100);
  fireEvent.click(screen.getByRole("button", { name: "载入失败，点此重试" }));
  await waitFor(() => expect(rows()).toHaveLength(120));
});

test("刷新：并入新增的调用，不丢已载入的更早部分", async () => {
  const store = { s1: sample("s1").filter((c) => c.seq <= 8) };
  installStore(store);
  mount();
  await screen.findByText("调用 08");
  store.s1 = sample("s1");
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(rows()).toHaveLength(11));
  expect(seqs()[0]).toBe("11");
  // 选中不会因刷新跳走
  expect(screen.getByText("调用 08")).toBeTruthy();
});

// ── 子代理那一路：分页 / 刷新 / 失败隔离 ──

// 自己 3 条，子代理 n 条
function subStore(n: number) {
  const store = {
    s1: [
      ...[1, 2, 3].map((seq) =>
        makeCall("s1", { seq, turn: 1, trigger: "tool_result", toolName: "t" }),
      ),
      ...Array.from({ length: n }, (_, i) =>
        makeCall("s1", { seq: 100 + i, turn: 1, trigger: "subagent" }),
      ),
    ],
  };
  installStore(store);
  return store;
}

test("子代理档计数是整棵子树的总数（不随分页变小）；滚到底按 id 游标载入更早的", async () => {
  subStore(120);
  mount();
  await waitFor(() => expect(filterCounts().子代理).toBe(120));
  pickFilter("子代理");
  await waitFor(() => expect(rows()).toHaveLength(100));
  // 第一页最小的是 seq 121 之外倒数第 100 条；游标取本页最后一条的 id
  const last = rows().at(-1)?.dataset.call;
  const list = document.querySelector("[data-alist]") as HTMLElement;
  nearEnd(list);
  fireEvent.scroll(list);
  fireEvent.scroll(list); // 连续触发只发一次
  await waitFor(() => expect(rows()).toHaveLength(120));
  expect(api.listSubagentCalls).toHaveBeenCalledTimes(2);
  expect(api.listSubagentCalls).toHaveBeenLastCalledWith(null, "s1", {
    before: last,
    limit: 100,
  });
  expect(filterCounts().子代理).toBe(120);
});

test("刷新同时刷新子代理那一路：新增的子代理调用进计数", async () => {
  const store = subStore(1);
  mount();
  await waitFor(() => expect(filterCounts().子代理).toBe(1));
  store.s1.push(makeCall("s1", { seq: 200, turn: 1, trigger: "subagent" }));
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(filterCounts().子代理).toBe(2));
});

test("子代理那一路载入失败：其余档位照常，子代理档如实报错并可重试", async () => {
  subStore(2);
  api.listSubagentCalls.mockResolvedValueOnce({ ok: false, kind: "network" });
  mount();
  await screen.findByText("调用 03");
  // 自己的三条照常
  expect(rows()).toHaveLength(3);
  expect(filterCounts().工具返回).toBe(3);
  pickFilter("子代理");
  await screen.findByText(/网络不通/);
  expect(screen.queryByText(/没有符合条件的调用/)).toBeNull();
  // 子代理档下仍可切回其他档位
  expect(filterCounts().全部).toBe(3);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(filterShown()).toBe("子代理");
});
