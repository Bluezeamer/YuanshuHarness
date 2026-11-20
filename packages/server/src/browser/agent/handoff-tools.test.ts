// handoff-tools.ts 的行为：browser_handoff 的方向（按页面操作者）、browser_show 的送达与结果文字。
// 全部用替身：不装浏览器、不起进程、不连网络。
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  cleanupTmpDirs,
  makeToolHarness,
  type ToolHarness,
} from "./testkit.js";

afterAll(cleanupTmpDirs);

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

const error = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(Error);
  return (e as Error).message;
};

/** 经工具打开一个公网站点：返回页面编号与它的假页面。 */
async function openViaTool(h: ToolHarness, target = "https://example.com/a") {
  await h.run("browser_open", { target });
  const pageId = h.registry.list("w1")[0]?.id as string;
  return { pageId, page: h.ctx().pageAt(-1) };
}

/** 提问一直挂着，只在被撤销时落定：模拟用户还没在聊天里答。 */
const hangingAsk = () => {
  const seen: { signal: AbortSignal | undefined } = { signal: undefined };
  const ask = (_spec: unknown, signal?: AbortSignal) =>
    new Promise<{ outcome: "cancelled" }>((ok) => {
      seen.signal = signal;
      signal?.addEventListener("abort", () => ok({ outcome: "cancelled" }));
    });
  return { ask, seen };
};

describe("browser_handoff：方向由页面操作者决定", () => {
  test("agent 的页面 → operate 文案；done 后页面仍是 agent 的，返回页面内容", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.cleaner.calls.length = 0;
    h.cleaner.forgot.length = 0;

    const r = await h.run("browser_handoff", { pageId, reason: "需要登录" });
    expect(textOf(r)).toBe("清洗后的页面");
    expect(h.asks[0]?.title).toBe("agent 请你接管页面：https://example.com/a");
    expect(h.asks[0]?.options).toEqual([
      { id: "done", label: "我已操作完成" },
      { id: "refuse", label: "拒绝" },
    ]);
    // 操作权易手不丢基线：不调 forgetPage，照常与交出前的状态比较
    expect(h.cleaner.forgot).toEqual([]);
    expect(h.cleaner.calls.at(-1)).toMatchObject({
      pageId,
      explicit: false,
      action: "handoff: user finished and returned the page",
    });
    expect(h.registry.get(pageId)?.controller).toBe("agent");
    expect(h.registry.get(pageId)?.handoffPending).toBe(false);
  });

  test("用户的页面 → claim 文案；done 把页面交给 agent（epoch 加一、claim 的 ACTION 与摘要）", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.registry.control(pageId, "user");
    const before = h.registry.get(pageId)?.epoch as number;
    h.cleaner.calls.length = 0;

    const r = await h.run("browser_handoff", { pageId, reason: "需要这样看" });
    expect(textOf(r)).toBe("清洗后的页面");
    expect(h.asks[0]?.title).toBe("agent 请求使用页面：https://example.com/a");
    expect(h.asks[0]?.body).toBe(
      "原因：需要这样看\n页面：https://example.com/a",
    );
    expect(h.asks[0]?.options).toEqual([
      { id: "done", label: "交给 agent" },
      { id: "refuse", label: "拒绝" },
    ]);
    expect(h.registry.get(pageId)?.controller).toBe("agent");
    expect(h.registry.get(pageId)?.epoch).toBe(before + 1);
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "handoff: user handed the page to the agent",
    );
    expect(h.audit.at(-1)).toMatchObject({
      tool: "browser_handoff",
      summary: "用户把页面交给了 agent",
    });
    expect(h.registry.get(pageId)?.handoffPending).toBe(false);
  });

  test("operate 的 refused：沿用「用户拒绝了接管请求」", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.replies.push(
      { outcome: "answered", optionId: "refuse", text: "我不能在这里登录" },
      { outcome: "answered", optionId: "refuse", text: "" },
    );
    expect(
      textOf(await h.run("browser_handoff", { pageId, reason: "登录" })),
    ).toBe("用户拒绝了接管请求：我不能在这里登录");
    // 理由为空串时沿用原来的句号写法
    expect(
      textOf(await h.run("browser_handoff", { pageId, reason: "登录" })),
    ).toBe("用户拒绝了接管请求。");
    expect(h.registry.get(pageId)?.controller).toBe("agent");
  });

  test("claim 的 refused：有理由接「：理由」，没理由不带冒号", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.registry.control(pageId, "user");
    h.replies.push(
      { outcome: "answered", optionId: "refuse", text: "我还要用" },
      { outcome: "answered", optionId: "refuse" },
    );
    expect(
      textOf(await h.run("browser_handoff", { pageId, reason: "看数据" })),
    ).toBe("用户拒绝了使用这个页面的请求：我还要用");
    expect(
      textOf(await h.run("browser_handoff", { pageId, reason: "看数据" })),
    ).toBe("用户拒绝了使用这个页面的请求");
    expect(h.registry.get(pageId)?.controller).toBe("user");
  });

  test("done 带一句补充：接在页面内容后面", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.replies.push({
      outcome: "answered",
      optionId: "done",
      text: "已经登录了",
    });
    expect(
      textOf(await h.run("browser_handoff", { pageId, reason: "登录" })),
    ).toBe("清洗后的页面\n用户补充：已经登录了");
  });

  test("只写字没选选项：当作拒绝，写的话就是理由", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.replies.push({ outcome: "answered", text: "这个页面我不给" });
    expect(
      textOf(await h.run("browser_handoff", { pageId, reason: "登录" })),
    ).toBe("用户拒绝了接管请求：这个页面我不给");
    expect(h.registry.get(pageId)?.controller).toBe("agent");
  });

  test("timeout / cancelled 两个方向都一样", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.replies.push({ outcome: "timeout" }, { outcome: "cancelled" });
    expect(
      textOf(await h.run("browser_handoff", { pageId, reason: "登录" })),
    ).toBe("用户没有回应");
    expect(
      textOf(await h.run("browser_handoff", { pageId, reason: "登录" })),
    ).toBe("已取消");
  });

  test("等答复期间页面标记为待接管，答复后复位；ask 抛错也复位", async () => {
    let pendingDuringAsk: boolean | undefined;
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.deps.ask = async () => {
      pendingDuringAsk = h.registry.get(pageId)?.handoffPending;
      return { outcome: "answered", optionId: "done" };
    };
    await h.run("browser_handoff", { pageId, reason: "登录" });
    expect(pendingDuringAsk).toBe(true);
    expect(h.registry.get(pageId)?.handoffPending).toBe(false);

    const broken = makeToolHarness({
      ask: async () => {
        throw new Error("弹窗通道坏了");
      },
    });
    const b = await openViaTool(broken);
    expect(
      await error(
        broken.run("browser_handoff", { pageId: b.pageId, reason: "登录" }),
      ),
    ).toBe("弹窗通道坏了");
    expect(broken.registry.get(b.pageId)?.handoffPending).toBe(false);
  });

  test("等用户答复时浏览器崩溃：交还后取快照用的是新的真页面", async () => {
    const h = makeToolHarness();
    const { pageId, page: oldPage } = await openViaTool(h);
    h.registry.control(pageId, "user");
    h.deps.ask = async () => {
      h.registry.onEngineCrash();
      oldPage.closed = true;
      oldPage.snapshotError = new Error("Target closed");
      return { outcome: "answered", optionId: "done" };
    };
    const r = await h.run("browser_handoff", { pageId, reason: "需要登录" });
    expect(textOf(r)).toBe("清洗后的页面");
    expect(oldPage.calls.filter((c) => c === "snapshot")).toHaveLength(1);
  });

  test("用户在页面上点「交给 agent」：先到先得，聊天里的提问卡片被撤销", async () => {
    const hang = hangingAsk();
    const h = makeToolHarness({ ask: hang.ask });
    const { pageId } = await openViaTool(h);
    h.registry.control(pageId, "user");
    const run = h.run("browser_handoff", { pageId, reason: "登录" });
    await vi.waitFor(() =>
      expect(h.registry.get(pageId)?.handoffPending).toBe(true),
    );

    expect(h.registry.answerHandoff(pageId, { kind: "done" })).toBe(true);
    expect(textOf(await run)).toBe("清洗后的页面");
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "handoff: user handed the page to the agent",
    );
    expect(hang.seen.signal?.aborted).toBe(true);
    expect(h.registry.get(pageId)?.controller).toBe("agent");
    expect(h.registry.get(pageId)?.handoffPending).toBe(false);
  });

  test("工具栏的「交还 agent」同样结算等着的请求，epoch 只加一次", async () => {
    const hang = hangingAsk();
    const h = makeToolHarness({ ask: hang.ask });
    const { pageId } = await openViaTool(h);
    h.registry.control(pageId, "user");
    const before = h.registry.get(pageId)?.epoch as number;
    const run = h.run("browser_handoff", { pageId, reason: "登录" });
    await vi.waitFor(() =>
      expect(h.registry.get(pageId)?.handoffPending).toBe(true),
    );
    h.registry.control(pageId, "agent");
    expect(textOf(await run)).toBe("清洗后的页面");
    expect(h.registry.get(pageId)?.epoch).toBe(before + 1);
  });

  test("聊天里先答复：页面上的等待随之结束，之后再点没有效果", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.replies.push({ outcome: "answered", optionId: "done" });
    await h.run("browser_handoff", { pageId, reason: "登录" });
    expect(h.registry.answerHandoff(pageId, { kind: "done" })).toBe(false);
  });

  test("页面不存在时不提问", async () => {
    const h = makeToolHarness();
    expect(
      await error(h.run("browser_handoff", { pageId: "nope", reason: "x" })),
    ).toContain("没有这个页面");
    expect(h.asks).toEqual([]);
  });

  test("描述写清两种用法与「不能自行夺取」", async () => {
    const descriptions = new Map<string, string>();
    const { browserTools } = await import("./tools.js");
    const h = makeToolHarness();
    browserTools(
      h.deps,
      h.sessionId,
    )({
      registerTool: (t: { name: string; description?: string }) =>
        descriptions.set(t.name, t.description ?? ""),
    } as never);
    const desc = descriptions.get("browser_handoff") ?? "";
    expect(desc).toContain("请用户接管");
    expect(desc).toContain("请求使用它");
    expect(desc).toContain("交给 agent");
    expect(desc).toContain("job_start");
  });
});

describe("browser_show", () => {
  test("送达 > 0：广播一次（标题、地址来自页面）、写审计、不记回放步", async () => {
    const recorded: unknown[] = [];
    const h = makeToolHarness({
      recordStep: async (a) => {
        recorded.push(a);
      },
    });
    const { pageId } = await openViaTool(h);
    // 标题由页面写进注册表（onChange 里异步取），先读一次再改
    await h.registry.use(pageId, h.sessionId, "observe");
    h.ctx().pageAt(-1).setTitle("示例页");
    await vi.waitFor(() =>
      expect(h.registry.get(pageId)?.title).toBe("示例页"),
    );
    recorded.length = 0;
    h.audit.length = 0;
    h.cleaner.calls.length = 0;

    const r = await h.run("browser_show", {
      pageId,
      note: "这是你要的表格",
    });
    expect(textOf(r)).toBe(
      "已向 1 个在线界面发出展示提示；用户点「查看」才会切到这个页面，你不会收到用户是否查看的通知。需要用户反馈请用 ask_user。",
    );
    expect(h.shows).toEqual([
      {
        pageId,
        title: "示例页",
        url: "https://example.com/a",
        note: "这是你要的表格",
      },
    ]);
    expect(h.audit).toEqual([
      {
        tool: "browser_show",
        pageId,
        summary: "展示页面给用户：这是你要的表格",
      },
    ]);
    expect(recorded).toEqual([]);
    // 不返回页面内容，也不动清洗层的基线
    expect(h.cleaner.calls).toEqual([]);
  });

  test("没有 note：说明为空串、审计摘要不带冒号", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    await h.run("browser_show", { pageId });
    expect(h.shows[0]?.note).toBe("");
    expect(h.audit.at(-1)?.summary).toBe("展示页面给用户");
  });

  test("送达 = 0：如实写提示未送达", async () => {
    const h = makeToolHarness();
    h.showDelivered = 0;
    const { pageId } = await openViaTool(h);
    expect(textOf(await h.run("browser_show", { pageId }))).toBe(
      "没有在线的界面，提示未送达，用户现在看不到这个页面。",
    );
  });

  test("多个在线界面时报个数", async () => {
    const h = makeToolHarness();
    h.showDelivered = 3;
    const { pageId } = await openViaTool(h);
    expect(textOf(await h.run("browser_show", { pageId }))).toContain(
      "已向 3 个在线界面发出展示提示",
    );
  });

  test("页面不存在或不在本工作区：报错且不广播", async () => {
    const h = makeToolHarness();
    await openViaTool(h);
    expect(await error(h.run("browser_show", { pageId: "nope" }))).toBe(
      "页面 nope 不存在或不在本工作区",
    );
    // 别的工作区的页面：注册表里有，但不属于这个会话的工作区
    const other = makeToolHarness({ workspaceKey: () => "w2" });
    const mine = await other.registry.open({
      workspaceKey: "w1",
      actor: "s9",
      url: "https://other.test/",
    });
    expect(
      await error(other.run("browser_show", { pageId: mine.page.id })),
    ).toBe(`页面 ${mine.page.id} 不存在或不在本工作区`);
    expect(other.shows).toEqual([]);
  });

  test("不调 registry.use：休眠页不被唤醒，也不要求租约", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.registry.sleep(pageId);
    const pages = h.ctx().pages.length;
    expect(h.registry.get(pageId)?.state).toBe("sleeping");
    page.calls.length = 0;

    const r = await h.run("browser_show", { pageId });
    expect(textOf(r)).toContain("已向 1 个在线界面");
    expect(h.registry.get(pageId)?.state).toBe("sleeping");
    expect(page.calls).toEqual([]);
    expect(h.ctx().pages).toHaveLength(pages);
  });

  test("参数：note 只能是字符串，且上限 300；没有 intent", async () => {
    const tools = new Map<
      string,
      { parameters?: { properties?: Record<string, { maxLength?: number }> } }
    >();
    const { browserTools } = await import("./tools.js");
    const h = makeToolHarness();
    browserTools(
      h.deps,
      h.sessionId,
    )({
      registerTool: (t: {
        name: string;
        parameters?: { properties?: Record<string, { maxLength?: number }> };
      }) => tools.set(t.name, t),
    } as never);
    const props = tools.get("browser_show")?.parameters?.properties ?? {};
    expect(props.note?.maxLength).toBe(300);
    expect(props).not.toHaveProperty("intent");

    const { pageId } = await openViaTool(h);
    expect(await error(h.run("browser_show", { pageId, note: 3 }))).toContain(
      "note 必须是字符串",
    );
  });
});
