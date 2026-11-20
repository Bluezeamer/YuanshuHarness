import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState, useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, type Mock, test, vi } from "vitest";
import type { Goal } from "../../../api";
import type { ExecutionBody, WorkflowRun } from "../../../api/flows";
import type { JobInfo, JobSnapshot } from "../../../api/jobs";
import type { TeamView } from "../../../api/team";
import type { TabAfx } from "../../workspace/model/types";
import {
  exec,
  FLOWS,
  installFlowsApi,
  jobInfo,
  phase,
  wfRun,
} from "../exec/testkit";
import { type FakeBox, fakeSession, mergeAfx } from "../tab/testkit";
import { StatusPanel } from "./StatusPanel";

const MIN = 60_000;
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString();
const done = (id: string, parentId: string, min: number, over = {}) =>
  exec({
    id,
    parentId,
    name: `任务 ${id}`,
    state: "done",
    outcome: "ok",
    ended: ago(min),
    ...over,
  });

const TODOS = [
  { content: "读 retry 与 handler", status: "completed" as const },
  { content: "改写 webhook 重试", status: "in_progress" as const },
  { content: "跑测试", status: "pending" as const },
];
const goal = (over: Partial<Goal> = {}): Goal => ({
  id: "g1",
  revision: 1,
  text: "把 public API 保持向后兼容\n第二行说明",
  by: "user",
  state: "active",
  maxRounds: 50,
  rounds: 12,
  since: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-25T10:00:00.000Z",
  ...over,
});

// 一棵有各种状态的树：x1 在跑（带一个很久以前结束的孙代理）、x2 很久前结束、x3 刚结束、x4 很久前失败（没看过）
const TREE: ExecutionBody[] = [
  exec({ id: "x1", name: "任务 x1" }),
  done("x5", "x1", 40),
  done("x2", "s1", 30),
  done("x3", "s1", 2),
  done("x4", "s1", 60, { outcome: "failed" }),
];

interface Out {
  afx: TabAfx | undefined;
  patchAfx: Mock<(p: Partial<TabAfx>) => void>;
  open: Mock<(id: string) => void>;
  openFile: Mock<(path: string) => void>;
  openTeamDiff: Mock<(path: string) => void>;
  openJob: Mock<(job: JobSnapshot) => void>;
}

function Host({ box, width, out }: { box: FakeBox; width: number; out: Out }) {
  const session = useSyncExternalStore(box.subscribe, () => box.session);
  const [afx, setAfx] = useState<TabAfx | undefined>(out.afx);
  out.afx = afx;
  return (
    <StatusPanel
      sessionId="s1"
      session={session}
      afx={afx}
      patchAfx={(p) => {
        out.patchAfx(p);
        setAfx((a) => mergeAfx(a, p));
      }}
      width={width}
      onOpenExecution={out.open}
      onOpenJob={out.openJob}
      onOpenFile={out.openFile}
      onOpenTeamDiff={out.openTeamDiff}
    />
  );
}

async function mount(
  over: Parameters<typeof fakeSession>[0] = {},
  opts: {
    width?: number;
    flows?: ExecutionBody[];
    workflow?: WorkflowRun[];
    team?: TeamView;
    jobs?: JobInfo[];
    afx?: TabAfx;
  } = {},
) {
  const server = installFlowsApi({
    ...(opts.team ? { team: opts.team } : {}),
    ...(opts.jobs ? { jobs: opts.jobs } : {}),
    flows: {
      ...FLOWS,
      executions: opts.flows ?? [],
      workflow: opts.workflow ?? [],
    },
  });
  const box = fakeSession(over);
  const out: Out = {
    afx: opts.afx,
    patchAfx: vi.fn<(p: Partial<TabAfx>) => void>(),
    open: vi.fn<(id: string) => void>(),
    openFile: vi.fn<(path: string) => void>(),
    openTeamDiff: vi.fn<(path: string) => void>(),
    openJob: vi.fn<(job: JobSnapshot) => void>(),
  };
  render(<Host box={box} width={opts.width ?? 1200} out={out} />);
  await act(async () => {});
  return { box, out, server };
}

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const panel = () => document.querySelector(".ch-status, .ch-rail");
const block = (k: string) =>
  document.querySelector(`[data-block="${k}"]`) as HTMLElement | null;
const titles = () =>
  [...document.querySelectorAll(".ch-sec .ch-sec-h .t-group")].map(
    (e) => e.textContent,
  );
const subRow = (id: string) =>
  document.querySelector(`[data-subagent="${id}"]`) as HTMLElement | null;
const subIds = () =>
  [...document.querySelectorAll("[data-subagent]")].map((e) =>
    e.getAttribute("data-subagent"),
  );

test("宽时常驻：目标 / 计划 / 子代理 / 已加载能力依次排开；没有内容的块不出现", async () => {
  await mount({ goal: goal(), todos: TODOS }, { flows: TREE });
  await screen.findByText("已加载能力");
  expect(panel()?.className).toBe("ch-status");
  expect(titles()).toEqual(["目标", "计划", "子代理", "已加载能力"]);
});

test("什么都没有：整栏不占位", async () => {
  await mount({}, { flows: [] });
  // 会话上下文里的技能 / MCP 来自假世界；这里只看没有目标 / 计划 / 子代理时的块
  expect(block("goal")).toBeNull();
  expect(block("plan")).toBeNull();
  expect(block("sub")).toBeNull();
});

test("窄时收成竖排标签，只有标签没有内容；标签是文字不是图标", async () => {
  await mount({ goal: goal(), todos: TODOS }, { width: 800, flows: TREE });
  await screen.findByRole("button", { name: "已加载能力" });
  expect(panel()?.className).toBe("ch-rail");
  expect(
    [...document.querySelectorAll(".ch-rail-label")].map((e) => e.textContent),
  ).toEqual(["目标", "计划", "子代理", "已加载能力"]);
  expect(document.querySelector(".ch-rail-pop")).toBeNull();
});

test("窄时悬停标签向左展开那一块；整块离开才收；键盘聚焦也展开、Esc 收起", async () => {
  await mount({ todos: TODOS }, { width: 800 });
  const tab = screen.getByRole("button", { name: "计划" });
  fireEvent.pointerEnter(tab);
  expect(document.querySelector(".ch-rail-pop")).toBeTruthy();
  expect(block("plan")?.textContent).toContain("改写 webhook 重试");
  // 从标签移到卡片上不算离开
  fireEvent.pointerEnter(
    document.querySelector(".ch-rail-card") as HTMLElement,
  );
  expect(document.querySelector(".ch-rail-pop")).toBeTruthy();
  fireEvent.pointerLeave(panel() as HTMLElement);
  expect(document.querySelector(".ch-rail-pop")).toBeNull();

  fireEvent.focus(tab);
  expect(document.querySelector(".ch-rail-pop")).toBeTruthy();
  fireEvent.keyDown(tab, { key: "Escape" });
  expect(document.querySelector(".ch-rail-pop")).toBeNull();
});

test("窄时有东西在动的标签前是脉动的点，其余是静止的点", async () => {
  await mount({ todos: TODOS, goal: goal() }, { width: 800 });
  const dot = (name: string) =>
    screen
      .getByRole("button", { name })
      .querySelector(".u-dot")
      ?.getAttribute("data-motion");
  expect(dot("计划")).toBe("pulse");
  expect(dot("目标")).toBeNull();
});

test("计划：已完成是勾，当前项脉动，右上角 完成数 / 总数", async () => {
  await mount({ todos: TODOS });
  const plan = block("plan") as HTMLElement;
  expect(plan.textContent).toContain("1 / 3");
  const lis = [...plan.querySelectorAll("li")];
  expect(lis).toHaveLength(3);
  expect(lis[0]?.hasAttribute("data-done")).toBe(true);
  expect(lis[1]?.querySelector(".u-dot")?.getAttribute("data-motion")).toBe(
    "pulse",
  );
});

// ── 目标 ──

test("目标：正文、谁设的、自某时、进行中、已用轮数，三个动作 编辑 / 暂停 / 删除", async () => {
  const { box } = await mount({ goal: goal() });
  const g = block("goal") as HTMLElement;
  expect(g.querySelector(".ch-goal")?.textContent).toContain("第二行说明");
  expect(g.textContent).toMatch(
    /你设定 · 自 2026-10-25 \d\d:\d\d · 进行中 · 12 \/ 50 轮/,
  );
  expect(
    [...g.querySelectorAll("[data-goalact]")].map((b) =>
      b.getAttribute("data-goalact"),
    ),
  ).toEqual(["edit", "pause", "del"]);
  // 模型设的、不限轮数的：标记换了，轮数只写已用的
  act(() => box.set({ goal: goal({ by: "model", maxRounds: null }) }));
  expect(g.textContent).toMatch(/模型设定 · .* · 进行中 · 12 轮/);
});

test("暂停与受阻：写出原因与说明，动作变「继续」；完成的目标不再占右栏", async () => {
  const { box } = await mount({ goal: goal() });
  act(() =>
    box.set({
      goal: goal({
        state: "paused",
        reason: { code: "request-failed", detail: "502 Bad Gateway" },
      }),
    }),
  );
  const g = () => block("goal") as HTMLElement;
  expect(g().textContent).toContain("已暂停：模型请求出错");
  expect(g().textContent).toContain("502 Bad Gateway");
  expect(g().querySelector("[data-goalact='resume']")?.textContent).toBe(
    "继续",
  );
  act(() =>
    box.set({
      goal: goal({ state: "blocked", reason: { code: "round-limit" } }),
    }),
  );
  expect(g().textContent).toContain("受阻：轮数用完");
  expect(g().querySelector("[data-goalact='resume']")).not.toBeNull();
  act(() => box.set({ goal: goal({ state: "complete" }) }));
  expect(block("goal")).toBeNull();
});

test("编辑：就地输入框，保存调 editGoal 并收起；取消不保存", async () => {
  const { box } = await mount({ goal: goal() });
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  const ta = screen.getByRole("textbox", {
    name: "编辑长期目标",
  }) as HTMLTextAreaElement;
  expect(ta.value).toContain("public API");
  fireEvent.change(ta, { target: { value: "可观测性可以加" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(box.session.actions.editGoal).toHaveBeenCalledWith({
    text: "可观测性可以加",
  });
  expect(screen.queryByRole("textbox", { name: "编辑长期目标" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("textbox", { name: "编辑长期目标" })).toBeNull();
  expect(box.session.actions.editGoal).toHaveBeenCalledTimes(1);
});

const SPEC = {
  name: "spec.pdf",
  mime: "application/pdf",
  sizeText: "20 KB",
  path: "spec.pdf",
};

test("目标带附件：正文下面列出文件；编辑时附件条预载，没动附件就不带 attachments", async () => {
  const { box } = await mount({ goal: goal({ attachments: [SPEC] }) });
  const g = block("goal") as HTMLElement;
  expect(
    within(g).getByRole("button", { name: "下载附件 spec.pdf" }),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect(within(g).getByLabelText("附件").textContent).toContain("spec.pdf");
  fireEvent.change(screen.getByRole("textbox", { name: "编辑长期目标" }), {
    target: { value: "改了字" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(box.session.actions.editGoal).toHaveBeenCalledWith({ text: "改了字" });
});

test("编辑目标时移除附件：保存带空数组（整体替换）；只改附件不改文字也能保存", async () => {
  const { box } = await mount({ goal: goal({ attachments: [SPEC] }) });
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.click(screen.getByRole("button", { name: /移除/ }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(box.session.actions.editGoal).toHaveBeenCalledWith({
    attachments: [],
  });
});

test("正文单击无响应，双击进入编辑；编辑中再点「编辑」不覆盖已输入内容", async () => {
  await mount({ goal: goal() });
  const p = () => document.querySelector(".ch-goal") as HTMLElement;
  fireEvent.click(p());
  expect(screen.queryByRole("textbox", { name: "编辑长期目标" })).toBeNull();
  fireEvent.doubleClick(p());
  fireEvent.change(screen.getByRole("textbox", { name: "编辑长期目标" }), {
    target: { value: "改到一半" },
  });
  // 编辑中「编辑」按钮已让位给输入框，双击正文也已不在；直接确认输入没有被重置
  expect(
    (
      screen.getByRole("textbox", {
        name: "编辑长期目标",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("改到一半");
});

test("编辑轮数上限：留空 = 不限，不合法时不能保存；只改上限不带文本", async () => {
  const { box } = await mount({ goal: goal() });
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  const max = screen.getByRole("textbox", {
    name: "轮数上限",
  }) as HTMLInputElement;
  expect(max.value).toBe("50");
  const save = screen.getByRole("button", { name: "保存" });
  fireEvent.change(max, { target: { value: "0" } });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(max, { target: { value: "二十" } });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(max, { target: { value: "" } });
  fireEvent.click(save);
  expect(box.session.actions.editGoal).toHaveBeenCalledWith({
    maxRounds: null,
  });
});

test("暂停 / 继续调对应动作", async () => {
  const { box } = await mount({ goal: goal() });
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  expect(box.session.actions.pauseGoal).toHaveBeenCalledTimes(1);
  act(() => box.set({ goal: goal({ state: "paused" }) }));
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  expect(box.session.actions.resumeGoal).toHaveBeenCalledTimes(1);
});

test("删除两步确认：第一次变「确认删除」，3.2 秒后复位，再点一次才真删", async () => {
  const { box } = await mount({ goal: goal() });
  vi.useFakeTimers();
  const del = () =>
    document.querySelector('[data-goalact="del"]') as HTMLElement;
  fireEvent.click(del());
  expect(del().textContent).toBe("确认删除");
  expect(box.session.actions.clearGoal).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(3300);
  });
  expect(del().textContent).toBe("删除");
  fireEvent.click(del());
  fireEvent.click(del());
  expect(box.session.actions.clearGoal).toHaveBeenCalledTimes(1);
});

test("窄栏里正在编辑目标时，鼠标移开卡片也不收（输入不丢）", async () => {
  await mount({ goal: goal() }, { width: 800 });
  fireEvent.pointerEnter(screen.getByRole("button", { name: "目标" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.change(screen.getByRole("textbox", { name: "编辑长期目标" }), {
    target: { value: "写到一半" },
  });
  fireEvent.pointerLeave(panel() as HTMLElement);
  expect(
    (
      screen.getByRole("textbox", {
        name: "编辑长期目标",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("写到一半");
});

// ── 子代理 ──

test("子代理：根是主代理，现状视图把结束够久的收成「已结束 N 个」，没看过的失败与刚结束的留着", async () => {
  await mount({}, { flows: TREE });
  await screen.findByText("任务 x1");
  // 顶层：x1（在跑）、x3（刚结束）、x4（没看过的失败）留着；x2 折起
  expect(subIds()).toEqual(["root", "x1", "x3", "x4"]);
  expect(subRow("root")?.textContent).toContain("主代理");
  // 顶层与 x1 下面各有一行「已结束」
  const folds = [...document.querySelectorAll("[data-folded]")];
  expect(folds.map((f) => f.getAttribute("data-folded"))).toEqual([
    "x1",
    "root",
  ]);
  expect(folds.map((f) => f.textContent)).toEqual([
    "已结束 1 个",
    "已结束 1 个",
  ]);
  // 失败的写「失败 · 时间」，刚结束的写「N 分钟前」
  expect(subRow("x4")?.textContent).toMatch(/失败 · 1 小时前/);
  expect(subRow("x3")?.textContent).toContain("2 分钟前");
});

test("点「已结束 N 个」原地展开那棵子树，不再二次折叠；再点收起", async () => {
  await mount({}, { flows: TREE });
  await screen.findByText("任务 x1");
  const fold = () =>
    document.querySelector('[data-folded="root"] .u-lrow-main') as HTMLElement;
  fireEvent.click(fold());
  expect(subIds()).toContain("x2");
  expect(fold().textContent).toBe("收起已结束的 1 个");
  fireEvent.click(fold());
  expect(subIds()).not.toContain("x2");
});

test("切到「全部」：全部列出，按钮旁是子代理总数；选择存进标签页，不用折叠", async () => {
  const { out } = await mount({}, { flows: TREE });
  await screen.findByText("任务 x1");
  const radio = screen.getByRole("radio", { name: /全部/ });
  expect(radio.textContent).toContain("5");
  fireEvent.click(radio);
  expect(out.patchAfx).toHaveBeenLastCalledWith({ subAll: true });
  expect(subIds()).toEqual(["root", "x1", "x5", "x2", "x3", "x4"]);
  expect(document.querySelector("[data-folded]")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "现状" }));
  expect(out.patchAfx).toHaveBeenLastCalledWith({ subAll: undefined });
});

test("没看过的失败：点一下标为已看（存进标签页），之后按时间折起来", async () => {
  const { out } = await mount({}, { flows: TREE });
  await screen.findByText("任务 x1");
  fireEvent.click(subRow("x4")?.querySelector(".u-lrow-main") as HTMLElement);
  expect(out.patchAfx).toHaveBeenCalledWith({ subSeen: ["x4"] });
  expect(subIds()).not.toContain("x4");
  expect(document.querySelector('[data-folded="root"]')?.textContent).toBe(
    "已结束 2 个",
  );
});

test("点子代理行：打开它的执行视图", async () => {
  const { out } = await mount({}, { flows: TREE });
  await screen.findByText("任务 x1");
  fireEvent.click(subRow("x3")?.querySelector(".u-lrow-main") as HTMLElement);
  expect(out.open).toHaveBeenCalledWith("x3");
});

test("标签页里存的「全部」「已展开」「已看过」状态进来就生效", async () => {
  await mount({}, { flows: TREE, afx: { subAll: true } });
  await screen.findByText("任务 x1");
  expect(subIds()).toContain("x2");
  cleanup();
  await mount({}, { flows: TREE, afx: { subSeen: ["x4"], subOpen: ["root"] } });
  await screen.findByText("任务 x1");
  expect(subIds()).toContain("x2");
  expect(subIds()).toContain("x4");
});

test("在跑的子代理永远不折，即使很久以前开始", async () => {
  await mount(
    {},
    { flows: [exec({ id: "x1", name: "任务 x1", since: ago(600) })] },
  );
  await screen.findByText("任务 x1");
  expect(subIds()).toEqual(["root", "x1"]);
  expect(document.querySelector("[data-folded]")).toBeNull();
});

// ── 已加载能力 ──

test("已加载能力：技能与 MCP 一行一个，MCP 带状态点", async () => {
  await mount({});
  const caps = await screen.findByText("已加载能力");
  const body = caps.closest("section") as HTMLElement;
  const skills = [...body.querySelectorAll('[data-cap="skill"]')];
  const mcps = [...body.querySelectorAll('[data-cap="mcp"]')];
  expect(skills.length).toBeGreaterThan(0);
  expect(mcps.length).toBeGreaterThan(0);
  expect(within(body).getAllByText("MCP").length).toBe(mcps.length);
  expect(mcps.some((m) => m.getAttribute("data-state") !== "ready")).toBe(true);
});

test("展开「已结束 N 个」后，里面的子树原样列全，不再二次折叠", async () => {
  await mount({}, { flows: [done("x2", "s1", 30), done("x6", "x2", 40)] });
  await screen.findByText("主代理");
  const fold = () =>
    document.querySelector('[data-folded="root"] .u-lrow-main') as HTMLElement;
  // x2 连同它的孙代理一共 2 个，折在根下面一行
  expect(fold().textContent).toBe("已结束 2 个");
  fireEvent.click(fold());
  expect(subIds()).toEqual(["root", "x2", "x6"]);
  expect(document.querySelector('[data-folded="x2"]')).toBeNull();
});

// ── 团队与工作流：各有自己的块，不混进子代理树 ──

const member = (id: string, name: string, over = {}) =>
  exec({
    id,
    parentId: "s1",
    source: "team",
    member: name,
    role: "编码",
    task: `${name} 的活`,
    ...over,
  });
const wfAgent = (id: string, phaseName: string) =>
  exec({
    id,
    parentId: "s1",
    source: "workflow",
    run: { id: "r1", phase: phaseName },
  });
const phaseRows = () =>
  [...document.querySelectorAll("[data-phase]")].map((e) => [
    e.getAttribute("data-phase"),
    e.querySelector(".t-aux")?.textContent,
  ]);

test("团队与工作流各一块，排在计划与子代理之间；它们的 agent 不进子代理树", async () => {
  await mount(
    { goal: goal(), todos: TODOS },
    {
      flows: [
        member("m1", "小王"),
        wfAgent("w1", "查"),
        exec({ id: "x1", name: "任务 x1" }),
      ],
      workflow: [wfRun()],
    },
  );
  await screen.findByText("已加载能力");
  expect(titles()).toEqual([
    "目标",
    "计划",
    "团队",
    "工作流",
    "子代理",
    "已加载能力",
  ]);
  expect(subIds()).toEqual(["root", "x1"]);
});

test("团队：名册一行一个成员，点一行打开成员的会话；成员不走折叠", async () => {
  const { out } = await mount(
    {},
    {
      flows: [
        member("m1", "小王"),
        member("m2", "小李", {
          state: "done",
          outcome: "ok",
          ended: ago(120),
          result: "已交付 3 个文件",
        }),
        member("m3", "小赵", {
          state: "done",
          outcome: "failed",
          ended: ago(1),
          result: "boom",
        }),
      ],
    },
  );
  await screen.findByText("小王");
  const rows = [...document.querySelectorAll("[data-member]")];
  expect(rows.map((r) => r.getAttribute("data-member"))).toEqual([
    "m1",
    "m2",
    "m3",
  ]);
  expect(rows.map((r) => r.getAttribute("data-status"))).toEqual([
    "live",
    "ok",
    "error",
  ]);
  // 结束两小时的成员仍在名册里
  expect(block("team")?.textContent).toContain("小李");
  fireEvent.click(within(rows[1] as HTMLElement).getByText("小李"));
  expect(out.open).toHaveBeenCalledWith("m2");
});

test("工作流：每个阶段一行名字与计数，失败单独写，底下是已启动数与上限", async () => {
  await mount(
    {},
    {
      flows: [wfAgent("w1", "查")],
      workflow: [
        wfRun({
          phases: [
            phase({ name: "查", done: 3, failed: 1 }),
            phase({ name: "写", done: 1, run: 2, queued: 5 }),
            phase({ name: null, failed: 2 }),
          ],
          started: 9,
        }),
      ],
    },
  );
  await screen.findByText("代码审查");
  expect(phaseRows()).toEqual([
    ["查", "已完成 3 · 失败 1"],
    ["写", "已完成 1 · 运行中 2 · 排队 5"],
    ["", "失败 2"],
  ]);
  expect(block("flow")?.textContent).toContain("未分阶段");
  expect(block("flow")?.textContent).toContain(
    "已启动 9 个 agent · 单次运行上限 1000",
  );
  // 阶段前的标记：做完是勾，在动是脉动的点，全失败是红点
  const mark = (name: string) =>
    document.querySelector(
      `[data-phase="${name}"] .ch-plan-mark`,
    ) as HTMLElement;
  expect(mark("查").querySelector("svg")).toBeTruthy();
  expect(mark("查").querySelector(".u-dot")).toBeNull();
  expect(mark("写").querySelector(".u-dot")?.getAttribute("data-motion")).toBe(
    "pulse",
  );
  expect(mark("").querySelector(".u-dot")?.getAttribute("data-tone")).toBe(
    "danger",
  );
  // 没有总数、没有进度条
  expect(block("flow")?.querySelector(".u-progress, .u-readbar")).toBeNull();
  // 在动的阶段名字是强调字样，做完的是正文
  const names = [
    ...document.querySelectorAll(
      "[data-phase] > .ch-phase-t > span:first-child",
    ),
  ];
  expect(names.map((n) => n.className)).toEqual([
    "t-plain",
    "t-entry",
    "t-plain",
  ]);
});

test("工作流：结束的运行写「N 分钟前」，不成功的带结局；结束满 10 分钟的不再出现", async () => {
  await mount(
    {},
    {
      workflow: [
        wfRun({ id: "a", label: "刚结束", state: "ok", ended: ago(3) }),
        wfRun({ id: "b", label: "失败的", state: "failed", ended: ago(4) }),
        wfRun({ id: "c", label: "很久前", state: "ok", ended: ago(30) }),
      ],
    },
  );
  await screen.findByText("刚结束");
  const heads = [...document.querySelectorAll("[data-run] .ch-run-h")].map(
    (e) => e.textContent,
  );
  expect(heads).toEqual(["刚结束3 分钟前", "失败的失败 · 4 分钟前"]);
  expect(block("flow")?.textContent).not.toContain("很久前");
});

test("窄时团队与工作流各有竖排标签；有东西在跑的前面是脉动的点", async () => {
  await mount(
    {},
    {
      width: 800,
      flows: [member("m1", "小王"), wfAgent("w1", "查")],
      workflow: [wfRun()],
    },
  );
  await screen.findByRole("button", { name: "团队" });
  const dot = (name: string) =>
    screen
      .getByRole("button", { name })
      .querySelector(".u-dot")
      ?.getAttribute("data-motion");
  expect(dot("团队")).toBe("pulse");
  expect(dot("工作流")).toBe("pulse");
  fireEvent.pointerEnter(screen.getByRole("button", { name: "工作流" }));
  expect(block("flow")?.textContent).toContain("代码审查");
});

// ── 团队：公告板与团队改动两行 ──

const TEAM: TeamView = {
  board: {
    file: "/data/collab/s1/board.md",
    count: 7,
    recent: [
      { no: 5, time: "10:01", from: "alpha", to: "all", text: "接口改好了" },
      { no: 6, time: "10:02", from: "beta", to: "all", text: "测试补完" },
      { no: 7, time: "10:03", from: "lead", to: "all", text: "继续" },
    ],
  },
  changes: {
    mode: "git",
    total: 2,
    files: [
      { path: "src/a.ts", status: "modified", added: 12, removed: 3 },
      { path: "docs/notes.md", status: "added", added: 40, removed: 0 },
    ],
  },
};
const teamRow = (k: string) =>
  document.querySelector(`[data-team="${k}"]`) as HTMLElement | null;
// 行本身是容器，点的是里面那个可点击的主区
const clickRow = (k: string) =>
  fireEvent.click(teamRow(k)?.querySelector(".u-lrow-main") as HTMLElement);

test("公告板：一行「N 条」，点开用预览打开公告板文件", async () => {
  const { out } = await mount(
    {},
    { flows: [member("m1", "小王")], team: TEAM },
  );
  await screen.findByText("公告板");
  expect(teamRow("board")?.textContent).toContain("7 条");
  clickRow("board");
  expect(out.openFile).toHaveBeenCalledWith("/data/collab/s1/board.md");
});

test("公告板悬停：最近 3 条，每条写编号与署名", async () => {
  await mount({}, { flows: [member("m1", "小王")], team: TEAM });
  await screen.findByText("公告板");
  fireEvent.pointerEnter(teamRow("board")?.closest(".u-hc") as HTMLElement);
  const tip = await screen.findByRole("tooltip", {}, { timeout: 2000 });
  expect(tip.textContent).toContain("#5 alpha");
  expect(tip.textContent).toContain("接口改好了");
  expect(tip.textContent).toContain("#7 lead");
});

test("团队改动：一行「N 个文件」，点开列出文件，点文件打开团队对比", async () => {
  const { out } = await mount(
    {},
    { flows: [member("m1", "小王")], team: TEAM },
  );
  await screen.findByText("团队改动");
  expect(teamRow("changes")?.textContent).toContain("2 个文件");
  expect(teamRow("files")).toBeNull();
  clickRow("changes");
  const files = [...document.querySelectorAll("[data-file]")];
  expect(files.map((f) => f.getAttribute("data-file"))).toEqual([
    "src/a.ts",
    "docs/notes.md",
  ]);
  expect(files[0]?.textContent).toContain("a.ts");
  expect(files[0]?.textContent).toContain("+12");
  fireEvent.click(within(files[1] as HTMLElement).getByText("notes.md"));
  expect(out.openTeamDiff).toHaveBeenCalledWith("docs/notes.md");
  // 再点一次收起
  clickRow("changes");
  expect(teamRow("files")).toBeNull();
});

test("文件被截断时写明只记录前几个", async () => {
  await mount(
    {},
    {
      flows: [member("m1", "小王")],
      team: {
        ...TEAM,
        changes: {
          mode: "files",
          total: 600,
          files: TEAM.changes?.files ?? [],
        },
      },
    },
  );
  await screen.findByText("团队改动");
  clickRow("changes");
  expect(teamRow("files")?.textContent).toContain("只记录前 2 个");
});

test("没有公告、没有改动（或取不到改动）：这两行不画", async () => {
  await mount(
    {},
    {
      flows: [member("m1", "小王")],
      team: {
        board: { file: "/x", count: 0, recent: [] },
        changes: { mode: "git", total: 0, files: [] },
      },
    },
  );
  await screen.findByText("小王");
  expect(teamRow("board")).toBeNull();
  expect(teamRow("changes")).toBeNull();
});

test("没有成员时不去取团队接口", async () => {
  const { server } = await mount({}, { flows: [exec({ id: "x1" })] });
  await screen.findByText("主代理");
  expect(server.count("/team")).toBe(0);
});

test("后台任务：只列在跑的并显示已用时，结束的不在块里；子代理与工作流不在这里；块排在子代理之后", async () => {
  await mount(
    {},
    {
      flows: TREE,
      jobs: [
        jobInfo(),
        jobInfo({
          id: "j2",
          label: "pytest -x",
          state: "failed",
          exitCode: 1,
          endedAt: ago(1),
        }),
        jobInfo({ id: "j3", kind: "subagent", name: "spawn_subagent" }),
        jobInfo({ id: "j4", kind: "tool", name: "workflow_run" }),
      ],
    },
  );
  await screen.findByText("npm run dev");
  expect(titles()).toEqual(["子代理", "后台任务", "已加载能力"]);
  const rows = [...document.querySelectorAll("[data-job]")];
  expect(rows.map((r) => r.getAttribute("data-job"))).toEqual(["j1"]);
  expect(rows[0]?.textContent).toContain("1 分 5 秒");
  expect(screen.queryByText("pytest -x")).toBeNull();
});

test("后台任务：全结束了整块不出现", async () => {
  const { server } = await mount(
    {},
    {
      jobs: [
        jobInfo({ state: "done", exitCode: 0, endedAt: ago(1) }),
        jobInfo({ id: "j2", state: "stopped", endedAt: ago(1) }),
      ],
    },
  );
  await waitFor(() => expect(server.count("/jobs")).toBeGreaterThan(0));
  expect(block("job")).toBeNull();
});

test("后台任务：点一行把任务快照交给打开的处理", async () => {
  const { out } = await mount({}, { jobs: [jobInfo()] });
  fireEvent.click(await screen.findByText("npm run dev"));
  expect(out.openJob).toHaveBeenCalledTimes(1);
  expect(out.openJob.mock.calls[0]?.[0]).toMatchObject({
    id: "j1",
    kind: "command",
    state: "running",
  });
});

test("后台任务：停止两步确认，确认后才发请求，并让清单重取", async () => {
  const { server } = await mount({}, { jobs: [jobInfo()] });
  await screen.findByText("npm run dev");
  const stop = within(block("job") as HTMLElement).getByRole("button", {
    name: "停止",
  });
  fireEvent.click(stop);
  expect(server.count("/stop")).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "确认停止" }));
  await act(async () => {});
  expect(server.count("/stop")).toBe(1);
  expect(server.count("/jobs")).toBeGreaterThanOrEqual(2);
});

test("后台任务：会话收到 jobs.updated 就重取清单；没有任务时整块不出现", async () => {
  const { box, server } = await mount({}, { jobs: [] });
  expect(block("job")).toBeNull();
  const before = server.count("/jobs");
  server.jobs = [jobInfo()];
  await act(async () => {
    box.set({ jobsRev: 1 });
  });
  await screen.findByText("npm run dev");
  expect(server.count("/jobs")).toBeGreaterThan(before);
});

test("窄时后台任务也有竖排标签；有任务在跑的前面是脉动的点", async () => {
  await mount({}, { width: 800, jobs: [jobInfo()] });
  const tab = await screen.findByRole("button", { name: "后台任务" });
  expect(tab.querySelector('[data-motion="pulse"]')).toBeTruthy();
});
