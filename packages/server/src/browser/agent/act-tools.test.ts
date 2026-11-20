// 动作类工具（act-tools）的行为：每个工具的正常路径、参数校验、确认范围、审计与 ACTION 行。
// 全部用替身：不装浏览器、不起进程、不连网络。
import { afterAll, describe, expect, test } from "vitest";
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

/** 经工具打开一个站点：返回页面编号与它的假页面。 */
async function openViaTool(h: ToolHarness, target = "https://example.com/a") {
  await h.run("browser_open", { target });
  const pageId = h.registry.list("w1")[0]?.id as string;
  return { pageId, page: h.ctx().pageAt(-1) };
}

/** 带确认替身的工作台：confirms 记下每次确认的入参。 */
function harness(overrides: Parameters<typeof makeToolHarness>[0] = {}) {
  const confirms: Array<{ tool: string; host: string; summary: string }> = [];
  const h = makeToolHarness({
    async confirmAction(args) {
      confirms.push(args);
      return { allowed: true };
    },
    ...overrides,
  });
  return { h, confirms };
}

describe("browser_click", () => {
  test("ref：count 与 button 透传，ACTION 行带次数与右键", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const r = await h.run("browser_click", {
      pageId,
      ref: "e12",
      count: 2,
      button: "right",
    });
    expect(textOf(r)).toBe("清洗后的页面");
    expect(page.calls).toContain("click e12 2 right");
    expect(h.cleaner.calls.at(-1)?.action).toBe("click e12 ×2 (right button)");
    expect(h.cleaner.calls.at(-1)?.explicit).toBe(false);
    expect(h.audit.at(-1)).toEqual({
      tool: "browser_click",
      pageId,
      summary: "双击 e12（右键）",
    });
  });

  test("缺省：单击左键，ACTION 行不带后缀", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_click", { pageId, ref: "e1" });
    expect(page.calls).toContain("click e1 1 left");
    expect(h.cleaner.calls.at(-1)?.action).toBe("click e1");
  });

  test("确认摘要里写清次数与右键", async () => {
    const { h, confirms } = harness();
    const { pageId } = await openViaTool(h, "https://github.com/a");
    await h.run("browser_click", { pageId, ref: "e1", count: 2 });
    await h.run("browser_click", { pageId, ref: "e1", count: 3 });
    await h.run("browser_click", { pageId, ref: "e1", button: "right" });
    await h.run("browser_click", { pageId, x: 10, y: 20, intent: "找回帖" });
    expect(confirms.map((c) => c.summary)).toEqual([
      "双击 e1",
      "三击 e1",
      "右键点击 e1",
      "点击 (10,20)",
    ]);
  });

  test("x + y：走 clickAt，ACTION 行写坐标", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_click", { pageId, x: 100, y: 200, count: 3 });
    expect(page.calls).toContain("clickAt 100,200 3 left");
    expect(h.cleaner.calls.at(-1)?.action).toBe("click (100,200) ×3");
  });

  test("不给目标：点当前鼠标位置；没有位置时引擎的报错原样给模型", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    // 假页面还没有鼠标位置：clickAt(null) 自己会抛，这里由替身模拟引擎的报错
    const original = page.clickAt.bind(page);
    page.clickAt = async () => {
      throw new Error(
        "还没有鼠标位置：先用 browser_move 移动鼠标，或者给 ref、坐标",
      );
    };
    const msg = await error(h.run("browser_click", { pageId }));
    expect(msg).toBe(
      "还没有鼠标位置：先用 browser_move 移动鼠标，或者给 ref、坐标",
    );
    expect(h.audit.map((a) => a.tool)).not.toContain("browser_click");

    page.clickAt = original;
    page.mouseAt = { x: 120, y: 80 };
    await h.run("browser_click", { pageId });
    expect(page.calls).toContain("clickAt 120,80 1 left");
    expect(h.cleaner.calls.at(-1)?.action).toBe("click at mouse (120,80)");
    expect(h.audit.at(-1)?.summary).toBe("点击当前鼠标位置");
  });

  test("ref 与 x、y 同给、只给一个坐标：报错并写清三种用法", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    for (const params of [
      { pageId, ref: "e1", x: 1, y: 2 },
      { pageId, x: 1 },
      { pageId, y: 2 },
    ]) {
      const msg = await error(h.run("browser_click", params));
      expect(msg).toContain("ref");
      expect(msg).toContain("只给 x 或只给 y");
    }
    expect(
      await error(h.run("browser_click", { pageId, ref: "12" })),
    ).toContain("ref 必须是最近一次快照里的元素编号");
  });

  test("count 非法被拒；坐标越界说明视口", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    for (const count of [0, 4]) {
      const msg = await error(
        h.run("browser_click", { pageId, ref: "e1", count }),
      );
      expect(msg, String(count)).toContain("count 只能是 1、2、3");
    }
    const msg = await error(h.run("browser_click", { pageId, x: 1280, y: 10 }));
    expect(msg).toContain("超出视口");
    expect(msg).toContain("1280×800");
  });
});

describe("browser_type", () => {
  test("perKey 透传，ACTION 行带 per-key 与 Enter", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_type", {
      pageId,
      ref: "e12",
      text: "hello",
      perKey: true,
      submit: true,
    });
    expect(page.calls).toContain("type e12 hello true perKey");
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "type 5 chars into e12, per-key, Enter",
    );
    expect(h.audit.at(-1)?.summary).toBe("输入到 e12，5 字，逐键，回车");
  });

  test("不给 perKey 是整段：不带 perKey 标记", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_type", { pageId, ref: "e12", text: "hello" });
    await h.run("browser_type", { pageId, text: "world" });
    expect(page.calls).toContain("type e12 hello false");
    expect(page.calls).toContain("input text world");
  });

  test("逐键限 200 字符，整段仍是 2000", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    const msg = await error(
      h.run("browser_type", { pageId, text: "x".repeat(201), perKey: true }),
    );
    expect(msg).toBe(
      "逐键输入最长 200 字符，现在 201 字符：请分段输入，或改用默认的整段输入",
    );
    await expect(
      h.run("browser_type", { pageId, text: "x".repeat(2000) }),
    ).resolves.toBeTruthy();
    expect(
      await error(h.run("browser_type", { pageId, text: "x".repeat(2001) })),
    ).toContain("text 最长 2000 字符");
  });

  test("不带 ref：输入到聚焦元素；不带 submit 不开下载窗口", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    h.collects.length = 0;
    await h.run("browser_type", { pageId, text: "你好" });
    expect(page.calls).toContain("input text 你好");
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "type 2 chars into focused element",
    );
    expect(h.collects).toEqual([]);

    await h.run("browser_type", { pageId, text: "x", submit: true });
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "type 1 chars into focused element, Enter",
    );
    expect(h.collects).toEqual([{ pageId }]);
  });

  test("审计与确认摘要都只写字数，不含原文", async () => {
    const { h, confirms } = harness();
    const { pageId } = await openViaTool(h, "https://github.com/a");
    await h.run("browser_type", { pageId, ref: "e3", text: "my-secret-pw" });
    expect(JSON.stringify(h.audit)).not.toContain("my-secret-pw");
    expect(JSON.stringify(confirms)).not.toContain("my-secret-pw");
    expect(h.audit.at(-1)?.summary).toBe("输入到 e3，12 字");
    expect(confirms[0]?.summary).toContain("12");
  });

  test("ref 指到原生下拉框：ACTION 行写选中了哪些选项", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.selectResult = { selected: ["北京"] };
    await h.run("browser_type", { pageId, ref: "e12", text: "北京" });
    expect(page.calls).toContain("type e12 北京 false");
    expect(h.cleaner.calls.at(-1)?.action).toBe('select "北京" in e12');
  });

  test("多选下拉框：ACTION 行逐个写选项", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.selectResult = { selected: ["A", "B"] };
    await h.run("browser_type", { pageId, ref: "e12", text: "A\nB" });
    expect(h.cleaner.calls.at(-1)?.action).toBe('select "A", "B" in e12');
  });

  test("描述写明 ref 可以指原生下拉框", async () => {
    const h = makeToolHarness();
    const tools = new Map<string, { description?: string }>();
    const { browserTools } = await import("./tools.js");
    browserTools(
      h.deps,
      h.sessionId,
    )({
      registerTool: (t: { name: string; description?: string }) =>
        tools.set(t.name, t),
    } as never);
    expect(tools.get("browser_type")?.description).toContain(
      "ref 指到原生下拉框（<select>，快照里是 combobox）时，text 是要选的选项（按文字或 value 匹配；多选框用换行分隔多项），不是输入文字。",
    );
  });
});

describe("browser_press", () => {
  test("按键、ACTION 行与审计", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_press", { pageId, key: "PageDown" });
    expect(page.calls).toContain("press PageDown");
    expect(h.cleaner.calls.at(-1)?.action).toBe("press PageDown");
    expect(h.audit.at(-1)?.summary).toBe("按键 PageDown");
  });
});

describe("browser_dialog", () => {
  /** 打开页面并挂上一个对话框（模拟点「删除」弹出 confirm）。 */
  async function withDialog(
    h: ToolHarness,
    dialog: {
      type: "alert" | "confirm" | "prompt" | "beforeunload";
      message: string;
      defaultValue: string;
    } = { type: "confirm", message: "确定删除吗？", defaultValue: "" },
    target = "https://example.com/a",
  ) {
    const { pageId, page } = await openViaTool(h, target);
    page.emitDialog(dialog);
    return { pageId, page };
  }

  test("参数形状：pageId 与 accept 必填，text 最长 2000", async () => {
    const h = makeToolHarness();
    const { pageId } = await withDialog(h);
    expect(await error(h.run("browser_dialog", { pageId }))).toBe(
      "accept 必须是 true（确定）或 false（取消）",
    );
    expect(await error(h.run("browser_dialog", { accept: true }))).toBe(
      "pageId 必须是 browser_pages 或 browser_open 给出的页面编号",
    );
    expect(
      await error(h.run("browser_dialog", { pageId, accept: true, text: 3 })),
    ).toBe("text 必须是字符串：prompt 的输入文字");
    expect(
      await error(
        h.run("browser_dialog", {
          pageId,
          accept: true,
          text: "x".repeat(2001),
        }),
      ),
    ).toBe("text 最长 2000 字符，现在 2001 字符");

    const tools = new Map<
      string,
      {
        parameters?: {
          properties?: Record<string, unknown>;
          required?: string[];
        };
      }
    >();
    const { browserTools } = await import("./tools.js");
    browserTools(
      h.deps,
      h.sessionId,
    )({
      registerTool: (t: {
        name: string;
        parameters?: {
          properties?: Record<string, unknown>;
          required?: string[];
        };
      }) => tools.set(t.name, t),
    } as never);
    const params = tools.get("browser_dialog")?.parameters;
    expect(params?.required).toEqual(["pageId", "accept"]);
    expect(Object.keys(params?.properties ?? {}).sort()).toEqual([
      "accept",
      "intent",
      "pageId",
      "text",
    ]);
  });

  test("没有挂着的对话框：报错且不写审计", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    expect(await error(h.run("browser_dialog", { pageId, accept: true }))).toBe(
      "这个页面现在没有等待回答的对话框（可能已被用户回答，或超时自动取消了）",
    );
    expect(h.audit.map((a) => a.tool)).not.toContain("browser_dialog");
  });

  test("确定 confirm：回答、审计、ACTION 行与回答后的页面内容", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await withDialog(h);
    const r = await h.run("browser_dialog", { pageId, accept: true });
    expect(page.calls).toContain("answerDialog accept");
    expect(page.dialog()).toBeNull();
    expect(h.audit.at(-1)).toEqual({
      tool: "browser_dialog",
      pageId,
      summary: "确定对话框「确定删除吗？」",
    });
    expect(textOf(r)).toBe("清洗后的页面");
    expect(h.cleaner.calls.at(-1)?.action).toBe("accept confirm dialog");
  });

  test("取消 prompt / 确定 prompt：ACTION 行带输入长度，审计不写输入", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await withDialog(h, {
      type: "prompt",
      message: "名字？",
      defaultValue: "x",
    });
    await h.run("browser_dialog", { pageId, accept: true, text: "小红" });
    expect(page.calls).toContain("answerDialog accept 小红");
    expect(h.cleaner.calls.at(-1)?.action).toBe("accept prompt dialog");
    expect(h.audit.at(-1)?.summary).toBe("确定对话框「名字？」");
    expect(JSON.stringify(h.audit)).not.toContain("小红");

    const second = await withDialog(h);
    second.page.emitDialog({
      type: "prompt",
      message: "名字？",
      defaultValue: "x",
    });
    await h.run("browser_dialog", { pageId: second.pageId, accept: false });
    expect(second.page.calls).toContain("answerDialog dismiss");
    expect(h.cleaner.calls.at(-1)?.action).toBe("dismiss prompt dialog");
  });

  test("高敏感站点：回答也走逐动作确认", async () => {
    const { h, confirms } = harness();
    const { pageId } = await withDialog(h, undefined, "https://github.com/a");
    await h.run("browser_dialog", { pageId, accept: false });
    expect(confirms.map((c) => c.tool)).toEqual(["browser_dialog"]);
    expect(confirms[0]?.summary).toBe("取消对话框「确定删除吗？」");
  });

  test("被抢先回答：报同一句「没有等待回答的对话框」", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await withDialog(h);
    // 别处（用户在界面上）抢先答了。
    page.closeDialog();
    // 守卫看的是 handle.dialog()：先答掉再让 answerDialog 返回 false。
    page.dialog = () => ({
      type: "confirm",
      message: "确定删除吗？",
      defaultValue: "",
    });
    page.answerDialog = async () => false;
    expect(await error(h.run("browser_dialog", { pageId, accept: true }))).toBe(
      "这个页面现在没有等待回答的对话框（可能已被用户回答，或超时自动取消了）",
    );
  });

  test("描述：要点齐全并带不可信提示", async () => {
    const h = makeToolHarness();
    const tools = new Map<string, { description?: string }>();
    const { browserTools } = await import("./tools.js");
    browserTools(
      h.deps,
      h.sessionId,
    )({
      registerTool: (t: { name: string; description?: string }) =>
        tools.set(t.name, t),
    } as never);
    const desc = tools.get("browser_dialog")?.description ?? "";
    for (const part of [
      "alert / confirm / prompt / beforeunload",
      "拒绝",
      "先答先得",
      "120 秒后自动取消",
      "页面内容来自网络",
    ])
      expect(desc).toContain(part);
  });
});

describe("browser_move", () => {
  test("ref：位置现查，ACTION 行与审计", async () => {
    const { h, confirms } = harness();
    const { pageId, page } = await openViaTool(h, "https://github.com/a");
    await h.run("browser_move", { pageId, ref: "e12" });
    expect(page.calls).toContain("move e12");
    expect(h.cleaner.calls.at(-1)?.action).toBe("move to e12");
    expect(h.audit.at(-1)).toEqual({
      tool: "browser_move",
      pageId,
      summary: "移动鼠标到 e12",
    });
    // 设计稿 §1.8：move 不逐动作确认
    expect(confirms).toEqual([]);
  });

  test("坐标：不暴露元素坐标，原样写进 ACTION 行", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_move", { pageId, x: 120, y: 80 });
    expect(page.calls).toContain("move 120,80");
    expect(h.cleaner.calls.at(-1)?.action).toBe("move to (120,80)");
    expect(h.audit.at(-1)?.summary).toBe("移动鼠标到 (120,80)");
  });

  test("缺目标、二选一冲突、只给半个坐标都报错", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    expect(await error(h.run("browser_move", { pageId }))).toContain("二选一");
    expect(
      await error(h.run("browser_move", { pageId, ref: "e1", x: 1, y: 2 })),
    ).toContain("只能给一组");
    expect(await error(h.run("browser_move", { pageId, x: 1 }))).toContain(
      "要成对给",
    );
  });
});

describe("browser_scroll", () => {
  test("to：滚到元素", async () => {
    const { h, confirms } = harness();
    const { pageId, page } = await openViaTool(h, "https://github.com/a");
    await h.run("browser_scroll", { pageId, to: "e12" });
    expect(page.calls).toContain("scroll to e12");
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "scroll to e12 (page y 0 of 3000, did not move)",
    );
    expect(h.audit.at(-1)).toEqual({
      tool: "browser_scroll",
      pageId,
      summary: "滚动到 e12",
    });
    expect(confirms).toEqual([]);
  });

  test("direction：缺省一屏、指定像素、带落点", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_scroll", { pageId, direction: "down" });
    expect(page.calls).toContain("scroll down");
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "scroll down one screen (page y 0 of 3000, did not move)",
    );
    expect(h.audit.at(-1)?.summary).toBe("向下滚动一屏");

    await h.run("browser_scroll", { pageId, direction: "down", amount: 800 });
    expect(page.calls).toContain("scroll down 800");
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "scroll down 800px (page y 0 of 3000, did not move)",
    );
    expect(h.audit.at(-1)?.summary).toBe("向下滚动 800 像素");

    await h.run("browser_scroll", {
      pageId,
      direction: "left",
      amount: 600,
      ref: "e7",
    });
    expect(page.calls).toContain("scroll left 600 @e7");
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "scroll left 600px at e7 (page x 0 of 3000, did not move, at left)",
    );
    expect(h.audit.at(-1)?.summary).toBe("向左滚动 600 像素（在 e7 处）");

    await h.run("browser_scroll", { pageId, direction: "up", x: 10, y: 20 });
    expect(page.calls).toContain("scroll up @10,20");
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "scroll up one screen at (10,20) (page y 0 of 3000, did not move, at top)",
    );
  });

  test("ACTION 行带页面位置：变了写前后，没变写 did not move", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const moved = async () => {
      await h.run("browser_scroll", { pageId, direction: "down", amount: 800 });
      return h.cleaner.calls.at(-1)?.action;
    };

    // 没变：只写当前，并注明没动（页面里的滚动容器吃掉滚轮时确实就是这样）
    page.scrollBefore = { ...page.scrollAfter, y: 800, height: 8748 };
    page.scrollAfter = { ...page.scrollBefore };
    expect(await moved()).toBe(
      "scroll down 800px (page y 800 of 8748, did not move)",
    );

    // 变了：前后都写
    page.scrollAfter = { ...page.scrollBefore, y: 1600 };
    expect(await moved()).toBe("scroll down 800px (page y 800 → 1600 of 8748)");
  });

  test("到底 / 到顶在括号里再加一句", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);

    page.scrollBefore = {
      x: 0,
      y: 7948,
      width: 1280,
      height: 8748,
      viewWidth: 1280,
      viewHeight: 800,
    };
    page.scrollAfter = { ...page.scrollBefore, y: 8748 };
    await h.run("browser_scroll", { pageId, direction: "down" });
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "scroll down one screen (page y 7948 → 8748 of 8748, at bottom)",
    );

    // 已经到底再往下滚：没动也要写到底
    page.scrollBefore = { ...page.scrollAfter };
    await h.run("browser_scroll", { pageId, direction: "down" });
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "scroll down one screen (page y 8748 of 8748, did not move, at bottom)",
    );

    page.scrollBefore = { ...page.scrollBefore, y: 800, height: 8748 };
    page.scrollAfter = { ...page.scrollBefore, y: 0 };
    await h.run("browser_scroll", { pageId, direction: "up" });
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "scroll up one screen (page y 800 → 0 of 8748, at top)",
    );
  });

  test("水平方向用 x 与宽度", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.scrollBefore = {
      x: 0,
      y: 0,
      width: 3000,
      height: 800,
      viewWidth: 1280,
      viewHeight: 800,
    };
    page.scrollAfter = { ...page.scrollBefore, x: 1280 };
    await h.run("browser_scroll", { pageId, direction: "right" });
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "scroll right one screen (page x 0 → 1280 of 3000)",
    );

    page.scrollBefore = { ...page.scrollBefore, x: 1720 };
    page.scrollAfter = { ...page.scrollBefore, x: 1720 };
    await h.run("browser_scroll", { pageId, direction: "right" });
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "scroll right one screen (page x 1720 of 3000, did not move, at right)",
    );
  });

  test("to 某个 ref 也报竖直位置", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.scrollBefore = {
      x: 0,
      y: 0,
      width: 1280,
      height: 8748,
      viewWidth: 1280,
      viewHeight: 800,
    };
    page.scrollAfter = { ...page.scrollBefore, y: 2948 };
    await h.run("browser_scroll", { pageId, to: "e20" });
    expect(h.cleaner.calls.at(-1)?.action).toBe(
      "scroll to e20 (page y 0 → 2948 of 8748)",
    );
  });

  test("to 与 direction 恰好给一个；amount 与落点只能跟 direction", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    expect(await error(h.run("browser_scroll", { pageId }))).toContain(
      "给且只给一个",
    );
    expect(
      await error(
        h.run("browser_scroll", { pageId, to: "e1", direction: "down" }),
      ),
    ).toContain("给且只给一个");
    expect(
      await error(h.run("browser_scroll", { pageId, to: "e1", amount: 100 })),
    ).toContain("只能跟 direction 一起给");
    expect(
      await error(h.run("browser_scroll", { pageId, to: "e1", ref: "e2" })),
    ).toContain("只能跟 direction 一起给");
    expect(
      await error(h.run("browser_scroll", { pageId, direction: "up", x: 1 })),
    ).toContain("要成对给");
    expect(
      await error(
        h.run("browser_scroll", {
          pageId,
          direction: "up",
          x: 1,
          y: 2,
          ref: "e2",
        }),
      ),
    ).toContain("只能给一组");
  });

  test("amount 超界被拒", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    for (const amount of [0, -1, 20001, 1.5]) {
      expect(
        await error(
          h.run("browser_scroll", { pageId, direction: "up", amount }),
        ),
        String(amount),
      ).toContain("1–20000 之间的整数");
    }
    await expect(
      h.run("browser_scroll", { pageId, direction: "up", amount: 20000 }),
    ).resolves.toBeTruthy();
  });
});

describe("browser_drag", () => {
  test("两端各自 ref 或坐标；逐动作确认 + 审计", async () => {
    const { h, confirms } = harness();
    const { pageId, page } = await openViaTool(h, "https://github.com/a");
    await h.run("browser_drag", { pageId, fromRef: "e5", toRef: "e9" });
    expect(page.calls).toContain("drag e5 e9");
    expect(h.cleaner.calls.at(-1)?.action).toBe("drag e5 to e9");
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.summary).toBe("拖拽 e5 → e9");
    expect(h.audit.at(-1)?.summary).toBe("拖拽 e5 → e9");

    await h.run("browser_drag", {
      pageId,
      fromX: 10,
      fromY: 10,
      toX: 300,
      toY: 40,
    });
    expect(page.calls).toContain("drag 10,10 300,40");
    expect(h.cleaner.calls.at(-1)?.action).toBe("drag (10,10) to (300,40)");
    expect(confirms[1]?.summary).toBe("拖拽 (10,10) → (300,40)");
  });

  test("确认被拒就不动手", async () => {
    const h = makeToolHarness({
      async confirmAction() {
        return { allowed: false, note: "" };
      },
    });
    const { pageId, page } = await openViaTool(h, "https://github.com/a");
    const msg = await error(
      h.run("browser_drag", { pageId, fromRef: "e1", toRef: "e2" }),
    );
    expect(msg).toContain("没有批准");
    expect(page.calls).not.toContain("drag e1 e2");
  });

  test("两端缺目标、二选一冲突、半个坐标都报错", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    expect(
      await error(h.run("browser_drag", { pageId, toRef: "e2" })),
    ).toContain("起点给 fromRef");
    expect(
      await error(h.run("browser_drag", { pageId, fromRef: "e1" })),
    ).toContain("终点给 toRef");
    expect(
      await error(
        h.run("browser_drag", {
          pageId,
          fromRef: "e1",
          fromX: 1,
          fromY: 2,
          toRef: "e2",
        }),
      ),
    ).toContain("只能给一组");
    expect(
      await error(
        h.run("browser_drag", {
          pageId,
          fromRef: "e1",
          toX: 5,
          toY: 6,
          toRef: "e2",
        }),
      ),
    ).toContain("只能给一组");
    expect(
      await error(h.run("browser_drag", { pageId, fromRef: "e1", toX: 5 })),
    ).toContain("要成对给");
  });

  test("引擎的「不在视口内」原样给模型", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.drag = async () => {
      throw new Error("拖动的起点或终点不在视口内，先滚动到位");
    };
    expect(
      await error(
        h.run("browser_drag", { pageId, fromX: 0, fromY: 0, toX: 10, toY: 10 }),
      ),
    ).toBe("拖动的起点或终点不在视口内，先滚动到位");
  });
});

describe("browser_nav", () => {
  test.each([
    ["back", "back", "后退"],
    ["forward", "forward", "前进"],
    ["reload", "reload", "刷新"],
  ])(
    "%s：调引擎、ACTION 行直接写动作名、不确认",
    async (action, call, summary) => {
      const { h, confirms } = harness();
      const { pageId, page } = await openViaTool(h, "https://github.com/a");
      await h.run("browser_nav", { pageId, action });
      expect(page.calls).toContain(call);
      expect(h.cleaner.calls.at(-1)?.action).toBe(action);
      expect(h.audit.at(-1)).toEqual({
        tool: "browser_nav",
        pageId,
        summary,
      });
      expect(confirms).toEqual([]);
    },
  );

  test("back / forward 返回 false 时报错，reload 不报错", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.back = async () => false;
    page.forward = async () => false;
    h.audit.length = 0;
    expect(await error(h.run("browser_nav", { pageId, action: "back" }))).toBe(
      "没有上一页，后退没有生效",
    );
    expect(
      await error(h.run("browser_nav", { pageId, action: "forward" })),
    ).toBe("没有下一页，前进没有生效");
    await expect(
      h.run("browser_nav", { pageId, action: "reload" }),
    ).resolves.toBeTruthy();
    expect(h.audit.map((a) => a.summary)).toEqual(["刷新"]);
  });

  test("action 不是这三个就报错", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    for (const action of [undefined, "goto", 1]) {
      expect(
        await error(h.run("browser_nav", { pageId, action })),
        String(action),
      ).toBe("action 只能是 back、forward、reload");
    }
  });
});

describe("browser_upload", () => {
  test("ACTION 行写文件数与 ref，notes 里是 UPLOADED 行", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const r = await h.run("browser_upload", {
      pageId,
      ref: "e5",
      files: ["/work/a.png", "/work/b.txt"],
    });
    // 假的 resolveUpload 一律回 3 B
    expect(textOf(r)).toBe("清洗后的页面");
    expect(page.uploads).toHaveLength(1);
    expect(h.cleaner.calls.at(-1)?.action).toBe("upload 2 files to e5");
    expect(h.cleaner.calls.at(-1)?.notes).toEqual([
      "UPLOADED: a.png (3 B), b.txt (3 B)",
    ]);
    expect(h.audit.at(-1)?.summary).toBe("上传 a.png、b.txt 到 e5");
  });
});

describe("租约：用户正在操作的页面", () => {
  test("动手类的每个工具都被拒（含不确认的 move / scroll / nav）", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    h.registry.control(pageId, "user");
    const cases = [
      ["browser_click", { ref: "e1" }],
      ["browser_type", { text: "x" }],
      ["browser_press", { key: "Enter" }],
      ["browser_move", { ref: "e1" }],
      ["browser_scroll", { to: "e1" }],
      ["browser_drag", { fromRef: "e1", toRef: "e2" }],
      ["browser_nav", { action: "reload" }],
      ["browser_upload", { ref: "e1", files: ["/work/a.txt"] }],
    ] as const;
    for (const [tool, params] of cases)
      expect(await error(h.run(tool, { pageId, ...params })), tool).toContain(
        "用户正在操作",
      );
    // 一次都没真动页面
    expect(page.calls.filter((c) => !c.startsWith("goto "))).toEqual([
      "snapshot",
    ]);
    expect(h.audit.map((a) => a.tool)).toEqual(["browser_open"]);
  });
});

describe("回放：动作类工具都记一步", () => {
  test("move / scroll / drag / nav 的摘要与审计一致", async () => {
    const recorded: Array<{ tool: string; summary: string }> = [];
    const h = makeToolHarness({
      access: { approved: () => true, known: () => true },
      recordStep: async (a) => {
        recorded.push({ tool: a.tool, summary: a.summary });
      },
    });
    await h.run("browser_open", { target: "https://a.test/" });
    const pageId = h.registry.list("w1")[0]?.id as string;
    recorded.length = 0;
    await h.run("browser_move", { pageId, ref: "e1" });
    await h.run("browser_scroll", { pageId, direction: "down", amount: 800 });
    await h.run("browser_drag", { pageId, fromRef: "e1", toRef: "e2" });
    await h.run("browser_nav", { pageId, action: "reload" });
    expect(recorded.map((r) => r.tool)).toEqual([
      "browser_move",
      "browser_scroll",
      "browser_drag",
      "browser_nav",
    ]);
    expect(recorded.map((r) => r.summary)).toEqual(
      h.audit.slice(1).map((a) => a.summary),
    );
  });
});

describe("intent 与 signal", () => {
  test("intent 原样传给清洗器；signal 从 execute 透传", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    const ctl = new AbortController();
    await h.run(
      "browser_move",
      { pageId, ref: "e1", intent: "找菜单" },
      ctl.signal,
    );
    expect(h.cleaner.calls.at(-1)?.intent).toBe("找菜单");
    expect(h.cleaner.calls.at(-1)?.signal).toBe(ctl.signal);
    await h.run("browser_scroll", { pageId, to: "e1" });
    expect(h.cleaner.calls.at(-1)?.intent).toBeUndefined();
    expect(h.cleaner.calls.at(-1)?.signal).toBeUndefined();
    expect(
      await error(
        h.run("browser_drag", {
          pageId,
          fromRef: "e1",
          toRef: "e2",
          intent: 3,
        }),
      ),
    ).toBe("intent 必须是字符串");
  });
});
