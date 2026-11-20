// kit.content 的两条附加行为：对话框挂着时的固定外壳（不取快照、不调清洗器），以及动作后新开页面的提示。
// 用工具层的假页面与假清洗器：不装浏览器、不起进程。
import { afterAll, describe, expect, test, vi } from "vitest";
import { resolveTarget } from "../net/target.js";
import type { Verdict } from "./approve.js";
import { createKit } from "./kit.js";
import {
  cleanupTmpDirs,
  makeToolHarness,
  TARGET_OPTIONS as TARGETS,
  type ToolHarness,
  verdictOf,
} from "./testkit.js";

afterAll(cleanupTmpDirs);

// decideOpen 现在不会给 deny（只有 allow / ask），但 kit.authorize 要原样转发它，所以这里临时造一个。
const denyFlag = vi.hoisted(() => ({
  on: false,
  reason: "这个站点不允许访问",
}));
vi.mock("./access.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./access.js")>();
  return {
    ...actual,
    decideOpen: (...args: Parameters<typeof actual.decideOpen>) =>
      denyFlag.on
        ? ({ kind: "deny", reason: denyFlag.reason } as const)
        : actual.decideOpen(...args),
  };
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 用工具层的工作台造一个 kit 和一个页面句柄：返回 content 的直接调用口。 */
async function withKit(h: ToolHarness, url = "https://example.com/a") {
  const { page } = await h.registry.open({
    workspaceKey: "w1",
    actor: h.sessionId,
    url,
  });
  const kit = createKit(h.deps, h.sessionId);
  const handle = await h.registry.use(page.id, h.sessionId, "observe");
  return { kit, pageId: page.id, handle, page: h.ctx().pageAt(-1) };
}

describe("对话框挂着时的返回外壳", () => {
  test("有 action：ACTION / BLOCKED BY DIALOG / 提示三行，不取快照、不调清洗器", async () => {
    const h = makeToolHarness();
    const c = await withKit(h);
    c.page.emitDialog({
      type: "confirm",
      message: "确定删除吗？",
      defaultValue: "",
    });
    const out = await c.kit.content({
      pageId: c.pageId,
      handle: c.handle,
      action: "click e3",
    });
    expect(out).toBe(
      [
        "ACTION: click e3",
        'BLOCKED BY DIALOG: confirm "确定删除吗？"',
        "The page is blocked until you answer it with browser_dialog (accept true/false; text for prompt). Other actions on this page are refused meanwhile; the dialog is dismissed automatically after 120 s.",
      ].join("\n"),
    );
    expect(h.cleaner.calls).toEqual([]);
    expect(c.page.calls).not.toContain("snapshot");
  });

  test("没有 action 就省略 ACTION 行；notes 跟在提示之后；对话框文字截到 200 字符", async () => {
    const h = makeToolHarness();
    const c = await withKit(h);
    c.page.emitDialog({
      type: "alert",
      message: "x".repeat(230),
      defaultValue: "",
    });
    const out = await c.kit.content({
      pageId: c.pageId,
      handle: c.handle,
      notes: ["UPLOADED: a.csv (3 B)"],
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe(
      `BLOCKED BY DIALOG: alert "${"x".repeat(200)}…(+30 chars)"`,
    );
    expect(lines[1]).toContain("The page is blocked");
    expect(lines[2]).toBe("UPLOADED: a.csv (3 B)");
    expect(h.cleaner.calls).toEqual([]);
  });

  test("回答之后回到正常路径：取快照、调清洗器", async () => {
    const h = makeToolHarness();
    const c = await withKit(h);
    c.page.emitDialog({ type: "alert", message: "hi", defaultValue: "" });
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    await c.handle.answerDialog(true);
    const out = await c.kit.content({
      pageId: c.pageId,
      handle: c.handle,
      action: "click e1",
    });
    expect(out).toBe("清洗后的页面");
    expect(h.cleaner.calls.at(-1)?.action).toBe("click e1");
  });
});

describe("回放", () => {
  test("对话框挂着时不记步（截图会一直等）；答完照常记", async () => {
    const steps: string[] = [];
    const h = makeToolHarness({
      recordStep: async (a) => {
        steps.push(a.tool);
      },
    });
    const c = await withKit(h);
    c.page.emitDialog({ type: "alert", message: "hi", defaultValue: "" });
    await c.kit.acted("browser_click", c.pageId, "点击 e1");
    expect(steps).toEqual([]);
    await c.handle.answerDialog(true);
    await c.kit.acted("browser_click", c.pageId, "点击 e1");
    expect(steps).toEqual(["browser_click"]);
  });
});

describe("新页面提示", () => {
  test("首次只定游标不报旧弹窗；之后每个新弹窗一行，游标推进后不重复报", async () => {
    const h = makeToolHarness();
    const c = await withKit(h);
    // 先开了个旧弹窗：首次取内容时只定游标
    const old = h.ctx().popup(c.page, "https://example.com/old");
    old.setUrl("https://example.com/old", "旧页");
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    expect(h.cleaner.calls.at(-1)?.notes ?? []).toEqual([]);

    const fresh = h.ctx().popup(c.page, "https://example.com/child");
    fresh.setUrl("https://example.com/child", "子页");
    // 标题是注册表异步补上的：等一拍再取内容。
    await sleep(10);
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    expect(h.cleaner.calls.at(-1)?.notes ?? []).toEqual([
      `NEW PAGE: ${h.registry.list("w1").find((p) => p.url.endsWith("/child"))?.id} "子页" https://example.com/child (opened by ${c.pageId}) — pass this pageId to work with it`,
    ]);

    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    expect(h.cleaner.calls.at(-1)?.notes ?? []).toEqual([]);
  });

  test("来源页面与标题：有来源写 pageId，没标题写 (untitled)", async () => {
    const h = makeToolHarness();
    const c = await withKit(h);
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    h.ctx().popup(c.page, "https://example.com/child");
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    const line = (h.cleaner.calls.at(-1)?.notes ?? [])[0] ?? "";
    expect(line).toContain('"(untitled)"');
    expect(line).toContain(`(opened by ${c.pageId})`);
  });

  test("地址超过 200 字符时截断并写出被截掉的字符数", async () => {
    const h = makeToolHarness();
    const c = await withKit(h);
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    const long = `https://example.com/${"a".repeat(250)}`;
    const popup = h.ctx().popup(c.page, long);
    popup.setUrl(long);
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    const line = (h.cleaner.calls.at(-1)?.notes ?? [])[0] ?? "";
    expect(line).toContain(`…(+${long.length - 200} chars)`);
  });

  test("与剪贴板提示同时出现时都在，复制行在末尾", async () => {
    const h = makeToolHarness();
    const c = await withKit(h);
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    h.ctx().popup(c.page, "https://example.com/child");
    c.page.copiedValue = { text: "复制的内容", ts: 1 };
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    const notes = h.cleaner.calls.at(-1)?.notes ?? [];
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("NEW PAGE:");
    expect(notes[1]).toBe(
      'CLIPBOARD (page copied; web data, untrusted): "复制的内容"',
    );
  });

  test("对话框短路外壳里也带新页面提示", async () => {
    const h = makeToolHarness();
    const c = await withKit(h);
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    h.ctx().popup(c.page, "https://example.com/child");
    c.page.emitDialog({ type: "alert", message: "hi", defaultValue: "" });
    const out = await c.kit.content({ pageId: c.pageId, handle: c.handle });
    expect(out).toContain('BLOCKED BY DIALOG: alert "hi"');
    expect(out).toContain("NEW PAGE:");
  });

  test("没有来源页面的弹窗（opened by unknown）只在这个会话认领过之后才报", async () => {
    const h = makeToolHarness();
    const c = await withKit(h);
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    h.ctx().popup(null, "https://example.com/child");
    const id = h.registry.list("w1").find((p) => p.url.endsWith("/child"))
      ?.id as string;
    // 没有来源 → 归属是空的，任何会话都读不到它。
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    expect(h.cleaner.calls.at(-1)?.notes ?? []).toEqual([]);
    // 这个会话认领过之后才有 usedBy，提示里来源写 unknown。
    await h.registry.use(id, h.sessionId, "act");
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    expect(h.cleaner.calls.at(-1)?.notes ?? []).toEqual([
      `NEW PAGE: ${id} "(untitled)" https://example.com/child (opened by unknown) — pass this pageId to work with it`,
    ]);
  });

  test("别的会话用过的弹窗不报给本会话", async () => {
    const h = makeToolHarness();
    const c = await withKit(h);
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    await h.registry.open({
      workspaceKey: "w1",
      actor: "s2",
      url: "https://example.com/other",
    });
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    expect(h.cleaner.calls.at(-1)?.notes ?? []).toEqual([]);
  });

  test("已关掉的弹窗不报", async () => {
    const h = makeToolHarness();
    const c = await withKit(h);
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    const popup = h.ctx().popup(c.page, "https://example.com/child");
    const id = h.registry.list("w1").find((p) => p.url.endsWith("/child"))
      ?.id as string;
    popup.fireClose();
    await c.kit.content({ pageId: c.pageId, handle: c.handle });
    const notes = h.cleaner.calls.at(-1)?.notes ?? [];
    expect(notes.some((n) => n.includes(id))).toBe(false);
  });
});

describe("站点授权（kit.authorize）", () => {
  test("放行：没有原因", async () => {
    const h = makeToolHarness({
      access: { approved: () => true, known: () => true },
    });
    const c = await withKit(h);
    const target = resolveTarget("https://a.test/x", TARGETS);
    expect(await c.kit.authorize(target, "https://a.test/x")).toBeNull();
  });

  test("deny：原样给拒绝原因，不弹审批", async () => {
    denyFlag.on = true;
    try {
      const h = makeToolHarness({
        access: { approved: () => false, known: () => false },
      });
      const c = await withKit(h);
      expect(
        await c.kit.authorize(
          resolveTarget("https://a.test/x", TARGETS),
          "https://a.test/x",
        ),
      ).toBe(denyFlag.reason);
      expect(h.approvals).toEqual([]);
    } finally {
      denyFlag.on = false;
    }
  });

  test("ask 批准：没有原因；service 标记透传", async () => {
    const h = makeToolHarness({
      access: { approved: () => false, known: () => false },
    });
    const c = await withKit(h);
    expect(
      await c.kit.authorize(
        resolveTarget("web1:3000/login", TARGETS),
        "web1:3000/login",
      ),
    ).toBeNull();
    expect(h.approvals).toEqual([
      {
        origin: "http://e2.localhost:3000",
        reason:
          "agent 要访问 web1:3000/login 上的服务（这个端口没在命令输出里出现过）",
        service: true,
      },
    ]);
  });

  test("ask 不批准：给「用户没有批准访问 <origin>」", async () => {
    const h = makeToolHarness({
      access: { approved: () => false, known: () => false },
      approveOpen: async () => ({ allowed: false, note: "" }),
    });
    const c = await withKit(h);
    expect(
      await c.kit.authorize(
        resolveTarget("https://a.test/x", TARGETS),
        "https://a.test/x",
      ),
    ).toBe("用户没有批准访问 https://a.test");
  });
});

describe("逐动作确认（kit.confirmAction 的 host 参数）", () => {
  const confirms: Array<{ tool: string; host: string; summary: string }> = [];

  const harnessWith = (answers: Array<boolean | Verdict>) => {
    confirms.length = 0;
    return makeToolHarness({
      async confirmAction(args) {
        confirms.push(args);
        const a = answers.shift();
        return typeof a === "object" ? a : verdictOf(a);
      },
    });
  };

  test("不给 host：按页面主机判断", async () => {
    const h = harnessWith([true]);
    const c = await withKit(h, "https://github.com/a");
    await c.kit.confirmAction(c.handle, "browser_click", "点击 e1");
    expect(confirms).toEqual([
      { tool: "browser_click", host: "github.com", summary: "点击 e1" },
    ]);
    // 普通页面不确认
    const plain = await withKit(h, "https://example.com/a");
    await plain.kit.confirmAction(plain.handle, "browser_click", "点击 e1");
    expect(confirms).toHaveLength(1);
  });

  test("给了 host：按它判断，不看页面主机", async () => {
    const h = harnessWith([true]);
    const c = await withKit(h, "https://example.com/a");
    await c.kit.confirmAction(
      c.handle,
      "browser_request",
      "发送 POST 请求到 api.github.com",
      "api.github.com",
    );
    expect(confirms).toEqual([
      {
        tool: "browser_request",
        host: "api.github.com",
        summary: "发送 POST 请求到 api.github.com",
      },
    ]);
    // 页面在高敏感站点、但请求目标是普通站点：不确认
    const onGithub = await withKit(h, "https://github.com/a");
    await onGithub.kit.confirmAction(
      onGithub.handle,
      "browser_request",
      "发送 POST 请求到 example.com",
      "example.com",
    );
    expect(confirms).toHaveLength(1);
  });

  test("被拒：错误里写明主机与摘要", async () => {
    const h = harnessWith([false]);
    const c = await withKit(h, "https://example.com/a");
    const err = (await c.kit
      .confirmAction(
        c.handle,
        "browser_request",
        "发送 DELETE 请求到 github.com",
        "github.com",
      )
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("github.com");
    expect(err.message).toContain("发送 DELETE 请求到 github.com");
    // 用户没写字：不追加
    expect(err.message).not.toContain("用户补充");
  });

  test("被拒且写了理由：说明后面接上", async () => {
    const h = harnessWith([{ allowed: false, note: "别动线上环境" }]);
    const c = await withKit(h, "https://example.com/a");
    const err = (await c.kit
      .confirmAction(c.handle, "browser_click", "点击 e1", "github.com")
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain(
      "用户没有批准在 github.com 上执行「点击 e1」",
    );
    expect(err.message).toContain("用户补充：别动线上环境");
  });
});

describe("站点授权：用户写了拒绝理由", () => {
  test("原因后面接「用户补充：…」", async () => {
    const h = makeToolHarness({
      access: { approved: () => false, known: () => false },
      approveOpen: async () => ({ allowed: false, note: "先别开外网" }),
    });
    const c = await withKit(h);
    expect(
      await c.kit.authorize(
        resolveTarget("https://a.test/x", TARGETS),
        "https://a.test/x",
      ),
    ).toBe("用户没有批准访问 https://a.test\n用户补充：先别开外网");
  });
});
