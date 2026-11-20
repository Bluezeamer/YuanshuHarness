import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { GoalNotice, JobSnapshot } from "../../../api";
import { compactionAnchor } from "../../../test/chatFakes";
import { approval, mount, question, sizeScroll } from "./testkit";

vi.mock("../audit", () => ({
  AuditPane: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="audit">审计 {sessionId}</div>
  ),
}));

const stream = () => screen.getByRole("log", { name: "对话记录" });

const groupLabels = () =>
  [...stream().querySelectorAll(".ch-group")].map(
    (g) => g.querySelector(".ch-glabel")?.textContent,
  );

// 收起的组头上跟着的内容预览
const groupHints = () =>
  [...stream().querySelectorAll(".ch-group")].map(
    (g) => g.querySelector(":scope > .u-lrow .ch-arg")?.textContent ?? null,
  );

test("没有对话头：标题只在标签与左轨，窗格里不再重复；也没有元信息 chip 行", () => {
  mount(
    {},
    { meta: { title: "补齐幂等键", agentName: "编码", status: "running" } },
  );
  expect(document.querySelector(".ch-head")).toBeNull();
  expect(screen.queryByRole("heading")).toBeNull();
  expect(screen.queryByRole("radio", { name: /^审计/ })).toBeNull();
  expect(document.querySelector(".ch-chips,.cchip")).toBeNull();
});

test("tab.ctab 是 audit 时渲染审计页、流区隐藏；是 chat 时恢复", () => {
  const h = mount({ messages: [{ role: "user", text: "你好" }] });
  expect(screen.getByText("你好")).toBeTruthy();
  expect(screen.queryByTestId("audit")).toBeNull();
  cleanup();
  mount(
    { messages: [{ role: "user", text: "你好" }] },
    { tab: { ctab: "audit" } },
  );
  expect(screen.getByTestId("audit").textContent).toBe("审计 s1");
  expect(screen.queryByRole("log")).toBeNull();
  expect(h.box).toBeTruthy();
});

test("用户气泡把引用块还原成 chip，正文走 Markdown", () => {
  const text =
    "Quote build:src/a.ts:L3-L9\n```\nconst x = 1;\n```\n\n这里为什么是 **1**？";
  mount({ messages: [{ role: "user", text }] });
  const chip = screen.getByLabelText("引用").querySelector("li") as HTMLElement;
  expect(chip.textContent).toBe("build:src/a.ts:L3-L9");
  expect(chip.title).toBe("const x = 1;");
  expect(stream().querySelector(".ch-bubble strong")?.textContent).toBe("1");
  expect(stream().textContent).not.toContain("const x = 1;");
});

test("历史里更早的消息排在窗口消息之前", () => {
  mount({
    loaded: {
      older: [{ index: 0, role: "user", text: "最早" }],
      nextBefore: null,
      compactions: [],
      notices: [],
    },
    messages: [{ role: "assistant", text: "最新" }],
  });
  const t = stream().textContent ?? "";
  expect(t.indexOf("最早")).toBeLessThan(t.indexOf("最新"));
});

test("助手消息：连续工具块按类折成组，出错的组默认展开并露出红字输出", () => {
  mount({
    messages: [
      {
        role: "assistant",
        text: "改好了",
        blocks: [
          { type: "thinking", text: "先看看" },
          {
            type: "tool",
            id: "t1",
            name: "read",
            args: JSON.stringify({ path: "src/a.ts" }),
            result: "ok",
          },
          {
            type: "tool",
            id: "t2",
            name: "edit",
            args: JSON.stringify({
              path: "src/a.ts",
              oldText: "a\nb",
              newText: "a\nb\nc\nd",
            }),
            result: "done",
          },
          {
            type: "tool",
            id: "t3",
            name: "bash",
            args: JSON.stringify({ command: "pnpm test" }),
            result: "fail",
            isError: true,
          },
          { type: "text", text: "改好了" },
        ],
      },
    ],
  });
  expect(groupLabels()).toEqual([
    "读取了 1 个文件",
    "编辑了 1 个文件",
    "运行了 1 条命令",
  ]);
  const groups = [...stream().querySelectorAll<HTMLElement>(".ch-group")];
  // 出错的组默认展开：失败那一行下面是红字输出
  expect(groups[2]?.querySelector(".ch-arg")?.textContent).toBe("pnpm test");
  expect(
    groups[2]?.querySelector('.ch-out[data-kind="error"]')?.textContent,
  ).toBe("fail");
  // 成功的组默认折叠：组头跟着第一行的路径预览，点开才看到各行
  expect(groupHints()).toEqual(["src/a.ts", "src/a.ts", null]);
  expect(groups[1]?.querySelector(".ch-row")).toBeNull();
  fireEvent.click(
    within(groups[1] as HTMLElement).getByRole("button", { name: /编辑了/ }),
  );
  expect(groups[1]?.querySelector(".ch-add")?.textContent).toBe("+4");
  expect(groups[1]?.querySelector(".ch-del")?.textContent).toBe("−2");
  expect(within(stream()).getByText("思考")).toBeTruthy();
});

test("实时工具：已在消息块里的不重复，跑完的折成组带耗时，还在跑的只露一行预览", () => {
  mount({
    messages: [
      {
        role: "assistant",
        text: "",
        blocks: [
          { type: "tool", id: "t1", name: "read", args: "{}", result: "x" },
        ],
      },
    ],
    tools: [
      { id: "t1", name: "read", status: "ok" },
      {
        id: "t2",
        name: "grep",
        status: "ok",
        durationMs: 1500,
        args: { pattern: "foo" },
      },
      { id: "t3", name: "bash", status: "running" },
    ],
    running: true,
  });
  expect(groupLabels()).toEqual(["读取了 1 个文件", "搜索了 1 次"]);
  expect(
    stream().querySelectorAll(".ch-group")[1]?.querySelector(".ch-trail")
      ?.textContent,
  ).toBe("1.5s");
  expect(stream().querySelector(".ch-live")?.textContent).toContain("bash");
  // 有运行中的工具就不再出 typing 占位
  expect(screen.queryByRole("img", { name: "正在输入" })).toBeNull();
});

test("typing 占位：运行中且还没有任何输出时出现，有 partial 后换成光标", () => {
  const h = mount({ running: true });
  expect(stream().querySelector(".ch-typing")).toBeTruthy();
  act(() => h.box.set({ partial: "正在写" }));
  expect(stream().querySelector(".ch-typing")).toBeNull();
  expect(stream().querySelector(".ch-caret")).toBeTruthy();
  expect(screen.getByText("正在写")).toBeTruthy();
});

test("排队的消息显示在输入框上方，不再重复出现在对话流里", () => {
  mount({ running: true, queue: ["下一步改 b.ts"] });
  const dock = document.querySelector(".ch-dock") as HTMLElement;
  expect(dock.textContent).toContain("下一步改 b.ts");
  expect(dock.textContent).toContain("当前步骤结束后送达");
  expect(stream().textContent).not.toContain("下一步改 b.ts");
});

test("空会话显示空态；连接中不显示", () => {
  const h = mount({ conn: "connecting" });
  expect(screen.queryByText("还没有消息")).toBeNull();
  act(() => h.box.set({ conn: "open" }));
  expect(screen.getByText("还没有消息")).toBeTruthy();
});

test("计划不在对话流里：只在右侧状态里出现", () => {
  mount({
    conn: "open",
    messages: [{ role: "assistant", text: "开工" }],
    todos: [{ content: "读代码", status: "in_progress" }],
  });
  expect(stream().textContent).not.toContain("读代码");
  expect(screen.queryByLabelText("执行计划")).toBeNull();
});

test("审批卡：命令 / 原因 / 同步提示；批准是唯一的实心按钮；点击调 answerPrompt", () => {
  const h = mount({ prompts: [approval()] });
  const card = screen.getByLabelText("审批");
  expect(card.textContent).toContain("git push --force-with-lease origin main");
  expect(card.textContent).toContain("该命令会重写远端提交历史");
  expect(card.textContent).toContain("其他已连接的端会同步收起");
  const approve = within(card).getByRole("button", { name: "批准" });
  const deny = within(card).getByRole("button", { name: "拒绝" });
  expect(approve.getAttribute("data-variant")).toBe("primary");
  expect(deny.getAttribute("data-variant")).toBe("outline");
  expect(document.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
  fireEvent.click(approve);
  expect(h.box.actions.answerPrompt).toHaveBeenCalledWith("pa1", {
    optionId: "allow",
  });
});

test("先答先赢：点过一次后第二次点击不再发命令；落定后显示批准文案", () => {
  const h = mount({ prompts: [approval()] });
  const card = screen.getByLabelText("审批");
  fireEvent.click(within(card).getByRole("button", { name: "批准" }));
  fireEvent.click(within(card).getByRole("button", { name: "批准" }));
  fireEvent.click(within(card).getByRole("button", { name: "拒绝" }));
  expect(h.box.actions.answerPrompt).toHaveBeenCalledTimes(1);
  expect(
    (within(card).getByRole("button", { name: "批准" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  // 服务端广播落定：弹窗从 state 消失
  act(() => h.box.set({ prompts: [] }));
  const done = screen.getByLabelText("审批");
  expect(done.getAttribute("data-state")).toBe("approved");
  expect(done.textContent).toMatch(/已批准/);
  expect(done.textContent).toContain("git push --force-with-lease origin main");
  expect(done.textContent).toMatch(/\d\d:\d\d/);
  expect(within(done).queryByRole("button")).toBeNull();
});

test("拒绝：落定后显示拒绝文案", () => {
  const h = mount({ prompts: [approval()] });
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  expect(h.box.actions.answerPrompt).toHaveBeenCalledWith("pa1", {
    optionId: "deny",
  });
  act(() => h.box.set({ prompts: [] }));
  expect(screen.getByLabelText("审批").getAttribute("data-state")).toBe(
    "denied",
  );
  expect(screen.getByLabelText("审批").textContent).toMatch(/已拒绝/);
});

test("命令没发出去（连接未就绪）不占位，可以再点", () => {
  const h = mount({ prompts: [approval()] });
  h.box.actions.answerPrompt.mockReturnValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  expect(h.box.actions.answerPrompt).toHaveBeenCalledTimes(2);
});

test("答复被服务端拒绝：撤回点选并显示原因", () => {
  const h = mount({ prompts: [approval()] });
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  act(() =>
    h.box.set({
      promptError: { promptId: "pa1", message: "已被其他端答复、超时或撤销" },
    }),
  );
  expect(screen.getByRole("alert").textContent).toContain("已被其他端答复");
  expect(
    (screen.getByRole("button", { name: "批准" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("别的端先答：卡片收起为「已由其他端答复」", () => {
  const h = mount({ prompts: [question()] });
  act(() => h.box.set({ prompts: [] }));
  expect(screen.getByLabelText("提问").textContent).toContain("已由其他端答复");
});

test("提问卡：标题 · 选项按钮；答后收成一行「已答复 · xxx」", () => {
  const h = mount({ prompts: [question()] });
  const card = screen.getByLabelText("提问");
  expect(card.textContent).toContain("等待你选择");
  expect(card.textContent).toContain("调研口径按哪种来做？");
  fireEvent.click(within(card).getByRole("button", { name: "6 家 · 对比表" }));
  expect(h.box.actions.answerPrompt).toHaveBeenCalledWith("pq1", {
    optionId: "sheet",
  });
  act(() => h.box.set({ prompts: [] }));
  expect(screen.getByLabelText("提问").textContent).toContain(
    "已答复 · 6 家 · 对比表",
  );
  expect(screen.getByLabelText("提问").querySelector("button")).toBeNull();
});

test("自由输入的提问：Enter 提交文字", () => {
  const h = mount({
    prompts: [question("pq2", { input: "rich", options: [] })],
  });
  const ta = screen.getByRole("textbox", { name: "回答" });
  fireEvent.change(ta, { target: { value: "用 B 方案" } });
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.box.actions.answerPrompt).toHaveBeenCalledWith("pq2", {
    text: "用 B 方案",
  });
});

test("系统回执：/compact 压缩完成，右侧徽标", () => {
  const h = mount({ messages: [{ role: "user", text: "hi" }] });
  act(() =>
    h.box.set({
      compact: {
        summary: "摘要",
        savedPct: 62,
        at: "2026-10-25T10:05:00.000Z",
      },
    }),
  );
  const badges = [...stream().querySelectorAll(".ch-sys-badge")].map(
    (b) => b.textContent,
  );
  expect(badges).toEqual(["/compact"]);
  expect(stream().textContent).toContain("节省 62%");
});

test("刷新后已有的压缩只补一条基线回执；重连快照里内容没变不重复记", () => {
  const compact = () => ({
    summary: "摘要 A",
    savedPct: 40,
    at: "2026-10-25T10:00:00.000Z",
  });
  const h = mount({ compact: compact() });
  expect(stream().querySelectorAll(".ch-sys")).toHaveLength(1);
  act(() => h.box.set({ compact: compact() }));
  expect(stream().querySelectorAll(".ch-sys")).toHaveLength(1);
});

test("目标卡片：每种事件一行回执（带徽标与原因），续跑是很淡的一行不带徽标", () => {
  const g = (
    event: GoalNotice["event"],
    revision: number,
    over: Partial<GoalNotice> = {},
  ) => ({
    kind: "goal" as const,
    at: 1,
    ts: "2026-11-17T08:00:00.000Z",
    goal: { event, goalId: "g1", revision, ...over },
  });
  mount({
    messages: [{ role: "user", text: "hi" }],
    notices: [
      g("set", 1, { by: "model", text: "把测试补齐\n第二行" }),
      g("round", 2, { round: 1, maxRounds: 50 }),
      g("round", 3, { round: 2, maxRounds: null }),
      g("edited", 4, { by: "user", maxRounds: null }),
      g("paused", 5, {
        reason: { code: "request-failed", detail: "502 Bad Gateway" },
      }),
      g("resumed", 6),
      g("blocked", 7, { reason: { code: "round-limit" } }),
      g("complete", 8),
      g("cleared", 9),
    ],
  });
  const t = stream().textContent ?? "";
  const badges = [...stream().querySelectorAll(".ch-sys-badge")].map(
    (b) => b.textContent,
  );
  expect(badges).toEqual([
    "/goal",
    "/goal · 编辑",
    "/goal · 暂停",
    "/goal · 恢复",
    "/goal · 受阻",
    "/goal · 完成",
    "/goal · 删除",
  ]);
  expect(t).toContain("模型设了目标：把测试补齐");
  expect(t).not.toContain("第二行");
  expect(t).toContain("目标 · 第 1 / 50 轮");
  expect(t).toContain("目标 · 第 2 轮");
  expect(t).toContain("轮数上限改为不限");
  expect(t).toContain("目标已暂停：模型请求出错");
  expect(t).toContain("502 Bad Gateway");
  expect(t).toContain("目标受阻：轮数用完");
  expect(stream().querySelectorAll('[data-kind="goal-round"]')).toHaveLength(2);
});

test("连接断开：横幅提示并给重新连接；重连中只提示", () => {
  const h = mount({ conn: "reconnecting" });
  expect(screen.getByRole("alert").textContent).toContain("正在重连");
  expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();
  act(() => h.box.set({ conn: "closed" }));
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  expect(h.box.actions.reconnect).toHaveBeenCalled();
});

test("自动贴底：新内容到来时贴底；上滑后不再跟随并出现「回到底部」", () => {
  const h = mount({ messages: [{ role: "user", text: "a" }] });
  const el = stream();
  const m = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
  sizeScroll(el, m);
  fireEvent.scroll(el);
  m.scrollHeight = 1200;
  act(() =>
    h.box.set({
      messages: [
        { role: "user", text: "a" },
        { role: "assistant", text: "b" },
      ],
    }),
  );
  expect(el.scrollTop).toBe(1200);
  expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();

  // 用户上滑
  el.scrollTop = 300;
  fireEvent.scroll(el);
  expect(screen.getByRole("button", { name: "回到底部" })).toBeTruthy();
  m.scrollHeight = 1400;
  act(() => h.box.set({ partial: "新增的一段" }));
  expect(el.scrollTop).toBe(300);

  fireEvent.click(screen.getByRole("button", { name: "回到底部" }));
  expect(el.scrollTop).toBe(1400);
  expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
});

test("上滑到顶自动加载更早；没有更早时不触发", () => {
  const h = mount({
    loaded: {
      older: [{ index: 5, role: "user", text: "x" }],
      nextBefore: "c",
      compactions: [],
      notices: [],
    },
  });
  const el = stream();
  sizeScroll(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 10 });
  fireEvent.scroll(el);
  expect(h.box.actions.loadEarlier).toHaveBeenCalledTimes(1);

  act(() =>
    h.box.set({
      loaded: {
        older: [{ index: 5, role: "user", text: "x" }],
        nextBefore: null,
        compactions: [],
        notices: [],
      },
    }),
  );
  fireEvent.scroll(el);
  expect(h.box.actions.loadEarlier).toHaveBeenCalledTimes(1);
});

test("历史向前延伸后补偿新增高度，视口停在原消息上", () => {
  const h = mount({
    loaded: {
      older: [{ index: 5, role: "user", text: "旧" }],
      nextBefore: "c",
      compactions: [],
      notices: [],
    },
  });
  const el = stream();
  const m = { scrollHeight: 1000, clientHeight: 400, scrollTop: 10 };
  sizeScroll(el, m);
  fireEvent.scroll(el);
  m.scrollHeight = 1600;
  act(() =>
    h.box.set({
      loaded: {
        older: [
          { index: 3, role: "user", text: "更旧" },
          { index: 5, role: "user", text: "旧" },
        ],
        nextBefore: "d",
        compactions: [],
        notices: [],
      },
    }),
  );
  // 新增的 600px 被补偿，加上原先的 10
  expect(el.scrollTop).toBe(610);
});

// ── 压缩边界卡 ──

test("压缩边界卡按 afterIndex 插在消息之间：默认折叠，展开看摘要 / 压缩前 token / 时间", () => {
  mount({
    loaded: {
      older: [
        { index: 0, role: "user", text: "旧一" },
        { index: 1, role: "assistant", text: "旧二" },
      ],
      nextBefore: null,
      // 窗口从绝对序位 2 开始：锚点 2 在第 1 条窗口消息前，3 在两条窗口消息之间，4 在末尾
      compactions: [
        compactionAnchor(3, 3),
        compactionAnchor(4, 2),
        compactionAnchor(2, 1),
        // 落在还没载入的部分，不显示
        compactionAnchor(9, 9),
      ],
      notices: [],
    },
    messages: [
      { role: "user", text: "窗口一" },
      { role: "assistant", text: "窗口二" },
    ],
  });
  const cards = [...stream().querySelectorAll<HTMLElement>(".ch-compact")];
  expect(cards.map((c) => c.dataset.compaction)).toEqual(["1", "3", "2"]);
  const t = stream().textContent ?? "";
  expect(t.indexOf("旧二")).toBeLessThan(t.indexOf("压缩历史 1"));
  expect(t.indexOf("压缩历史 1")).toBeLessThan(t.indexOf("窗口一"));
  expect(t.indexOf("窗口一")).toBeLessThan(t.indexOf("压缩历史 3"));
  expect(t.indexOf("压缩历史 3")).toBeLessThan(t.indexOf("窗口二"));
  expect(t.indexOf("窗口二")).toBeLessThan(t.indexOf("压缩历史 2"));
  // 默认折叠：摘要 / token / 时间都不显示
  const card = cards[0] as HTMLElement;
  expect(
    within(card)
      .getByRole("button", { name: /压缩历史 1/ })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(t).not.toContain("压缩摘要 1");
  fireEvent.click(within(card).getByRole("button", { name: /压缩历史 1/ }));
  expect(card.textContent).toContain("压缩摘要 1");
  expect(card.textContent).toContain("压缩前 4,096 tok");
  expect(card.textContent).toMatch(/\d\d-\d\d \d\d:\d\d/);
});

test("没有更早的历史时窗口从 0 编号：锚点落在窗口消息之间", () => {
  mount({
    loaded: {
      older: [],
      nextBefore: null,
      compactions: [compactionAnchor(1, 1)],
      notices: [],
    },
    messages: [
      { role: "user", text: "第一条" },
      { role: "assistant", text: "第二条" },
    ],
  });
  const t = stream().textContent ?? "";
  expect(t.indexOf("第一条")).toBeLessThan(t.indexOf("压缩历史 1"));
  expect(t.indexOf("压缩历史 1")).toBeLessThan(t.indexOf("第二条"));
});

// ── 后台任务回调卡 ──

const jobOf = (id: string, over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id,
  kind: "command",
  name: "bash",
  label: `任务 ${id}`,
  ref: null,
  state: "done",
  exitCode: 0,
  startedAt: "2026-11-17T08:00:00.000Z",
  endedAt: `2026-11-17T08:01:00.00${id.length}Z`,
  ...over,
});

const jobCards = () =>
  [...stream().querySelectorAll<HTMLElement>("[data-job-notice]")].map(
    (c) => c.dataset.jobNotice,
  );

test("后台任务回调卡：历史里的按 afterIndex 插，本连接实时收到的按到达时的消息数插，同一张不重复", () => {
  const live = jobOf("live");
  const persisted = jobOf("old");
  mount({
    loaded: {
      older: [
        { index: 0, role: "user", text: "旧一" },
        { index: 1, role: "assistant", text: "旧二" },
      ],
      nextBefore: null,
      compactions: [],
      // 窗口从绝对序位 2 开始：1 在旧二之后（窗口之前），同一张卡实时与历史各有一份
      notices: [
        { kind: "job", afterIndex: 2, job: persisted },
        { kind: "job", afterIndex: 3, job: live },
      ],
    },
    notices: [
      { kind: "job", at: 1, ts: "t", job: live },
      { kind: "job", at: 2, ts: "t", job: jobOf("fresh") },
    ],
    messages: [
      { role: "user", text: "窗口一" },
      { role: "assistant", text: "窗口二" },
    ],
  });
  expect(jobCards()).toEqual(["old", "live", "fresh"]);
  const t = stream().textContent ?? "";
  expect(t.indexOf("旧二")).toBeLessThan(t.indexOf("任务 old"));
  expect(t.indexOf("任务 old")).toBeLessThan(t.indexOf("窗口一"));
  expect(t.indexOf("窗口一")).toBeLessThan(t.indexOf("任务 live"));
  expect(t.indexOf("任务 live")).toBeLessThan(t.indexOf("窗口二"));
  expect(t.indexOf("窗口二")).toBeLessThan(t.indexOf("任务 fresh"));
});

test("后台任务回调卡与压缩边界卡同在一个位置时，压缩边界在前；落在还没载入部分的不显示", () => {
  mount({
    loaded: {
      older: [{ index: 0, role: "user", text: "旧" }],
      nextBefore: "c",
      compactions: [compactionAnchor(1, 1)],
      notices: [
        { kind: "job", afterIndex: 1, job: jobOf("a") },
        { kind: "job", afterIndex: 99, job: jobOf("far") },
      ],
    },
    messages: [{ role: "assistant", text: "窗口" }],
  });
  const t = stream().textContent ?? "";
  expect(jobCards()).toEqual(["a"]);
  expect(t.indexOf("压缩历史 1")).toBeLessThan(t.indexOf("任务 a"));
});

test("流式思考：只露一行预览（最新一行），不展开", () => {
  mount({
    running: true,
    partial: "",
    partialThinking: "第一行\n第二行\n第三行\n第四行\n第五行",
  });
  const live = stream().querySelector(".ch-live");
  expect(live?.querySelector(".ch-live-k")?.textContent).toBe("思考");
  expect(live?.querySelector(".ch-live-t")?.textContent).toBe("第五行");
  expect(stream().querySelector(".ch-caret")).toBeNull();
});

test("运行态那一行可以点开：看目前的全部输出，输出变长时跟到底，再点收起", () => {
  const run = (output: string) => ({
    tools: [
      {
        id: "b1",
        name: "bash",
        status: "running" as const,
        args: { command: "make build" },
        output,
      },
    ],
  });
  const h = mount(run("第一行\n第二行"));
  const live = () => stream().querySelector(".ch-live") as HTMLElement;
  // 默认只有一行预览（最新一行）
  expect(live().querySelector(".ch-live-t")?.textContent).toBe("第二行");
  expect(live().querySelector(".ch-live-body")).toBeNull();
  fireEvent.click(within(live()).getByRole("button", { name: /bash/ }));
  const body = () => live().querySelector(".ch-live-body") as HTMLElement;
  expect(body().textContent).toBe("第一行\n第二行");
  expect(
    within(live())
      .getByRole("button", { name: /bash/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");

  // 输出变长：框里同步更新，预览行仍是最新一行
  act(() => h.box.set(run("第一行\n第二行\n第三行")));
  expect(body().textContent).toBe("第一行\n第二行\n第三行");
  expect(live().querySelector(".ch-live-t")?.textContent).toBe("第三行");

  fireEvent.click(within(live()).getByRole("button", { name: /bash/ }));
  expect(live().querySelector(".ch-live-body")).toBeNull();
});

test("正文开始流出后，思考折成一行，点开看全文", () => {
  mount({
    running: true,
    partial: "结论是",
    partialThinking: "一\n二\n三",
  });
  expect(stream().querySelector(".ch-live")).toBeNull();
  const think = stream().querySelector(".ch-think") as HTMLElement;
  expect(think.querySelector(".ch-think-body")).toBeNull();
  fireEvent.click(within(think).getByRole("button", { name: /思考/ }));
  expect(think.querySelector(".ch-think-body")?.textContent).toBe("一\n二\n三");
});

test("流式工具参数：生成中只露一行预览（参数里最新到达的一行）", () => {
  mount({
    running: true,
    partial: "",
    pendingTools: [
      {
        id: "c1",
        name: "write",
        args: '{"path":"a.ts",\n"content":"a\nb\nc\nd\ne"}',
      },
    ],
  });
  const live = stream().querySelector(".ch-live");
  expect(live?.querySelector(".ch-live-k")?.textContent).toBe("write");
  expect(live?.querySelector(".ch-live-t")?.textContent).toBe("e");
  expect(stream().querySelector(".ch-group")).toBeNull();
});

test("write 执行完成后收进「编辑了 N 个文件」，点开看行数，再点行看代码块", () => {
  const h = mount({
    tools: [
      {
        id: "w1",
        name: "write",
        status: "running",
        args: { path: "a.ts", content: "a\nb\nc\nd" },
      },
    ],
  });
  // 执行中：只有一行预览，没有组
  expect(stream().querySelector(".ch-live-k")?.textContent).toBe("write");
  expect(stream().querySelector(".ch-group")).toBeNull();
  act(() =>
    h.box.set({
      tools: [
        {
          id: "w1",
          name: "write",
          status: "ok",
          args: { path: "a.ts", content: "a\nb\nc\nd" },
        },
      ],
    }),
  );
  expect(stream().querySelector(".ch-live")).toBeNull();
  expect(groupLabels()).toEqual(["编辑了 1 个文件"]);
  // 收起时组头跟着路径预览；点开后各行自己写着，组头不再重复
  expect(groupHints()).toEqual(["a.ts"]);
  fireEvent.click(screen.getByRole("button", { name: /编辑了/ }));
  expect(groupHints()).toEqual([null]);
  expect(stream().querySelector(".ch-arg")?.textContent).toBe("a.ts");
  expect(stream().querySelector(".ch-row .ch-trail")?.textContent).toBe("4 行");
  fireEvent.click(screen.getByRole("button", { name: /a\.ts/ }));
  expect(stream().querySelector(".md-block")?.textContent).toContain(
    "typescript",
  );
});

test("bash 结束后：组里一行是命令，点那一行才看输出", () => {
  mount({
    tools: [
      {
        id: "b1",
        name: "bash",
        status: "ok",
        args: { command: "pnpm test" },
        output: "PASS a\nFAIL b",
      },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: /运行了 1 条命令/ }));
  expect(stream().querySelector(".ch-arg")?.textContent).toBe("pnpm test");
  expect(stream().querySelector(".ch-out")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /pnpm test/ }));
  expect(
    stream().querySelector('.ch-out[data-kind="result"]')?.textContent,
  ).toBe("PASS a\nFAIL b");
});

test("思考完成后折成一行，点开看全文，再点收起", () => {
  mount({
    messages: [
      {
        role: "assistant",
        text: "",
        blocks: [{ type: "thinking", text: "第一行\n第二行" }],
      },
    ],
  });
  const row = () => within(stream()).getByRole("button", { name: /思考/ });
  expect(stream().querySelector(".ch-think-body")).toBeNull();
  fireEvent.click(row());
  expect(stream().querySelector(".ch-think-body")?.textContent).toBe(
    "第一行\n第二行",
  );
  fireEvent.click(row());
  expect(stream().querySelector(".ch-think-body")).toBeNull();
});

test("点开 write / edit 的行：write 是代码块，edit 是 diff 代码块", () => {
  mount({
    tools: [
      {
        id: "w1",
        name: "write",
        status: "ok",
        args: { path: "a.ts", content: "const a = 1;\n" },
      },
      {
        id: "e1",
        name: "edit",
        status: "ok",
        args: {
          path: "a.ts",
          edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
        },
      },
    ],
  });
  expect(groupLabels()).toEqual(["编辑了 2 个文件"]);
  fireEvent.click(screen.getByRole("button", { name: /编辑了 2 个文件/ }));
  const rows = [...stream().querySelectorAll<HTMLElement>(".ch-row")];
  fireEvent.click(within(rows[0] as HTMLElement).getByRole("button"));
  fireEvent.click(within(rows[1] as HTMLElement).getByRole("button"));
  expect(rows[0]?.querySelector(".md-block")?.textContent).toContain(
    "typescript",
  );
  const edit = rows[1] as HTMLElement;
  expect(edit.querySelector(".md-block")?.textContent).toContain("diff");
  expect(edit.textContent).toContain("- const a = 1;");
  expect(edit.textContent).toContain("+ const a = 2;");
});
