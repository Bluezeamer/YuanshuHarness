import { describe, expect, test } from "vitest";
import { type ExtensionUiAsk, makeExtensionUiContext } from "./ui-context.js";

// 通道用假的会话两侧：只看问出去的 PromptSpec，以及单向事件的方法与字段。

function channel() {
  const asked: ExtensionUiAsk[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  let answer: (r: {
    outcome: "answered" | "timeout" | "cancelled";
    optionId?: string;
    text?: string;
  }) => void = () => {};
  const ctx = () =>
    makeExtensionUiContext({
      ask: (spec) => {
        asked.push(spec);
        return new Promise((ok) => {
          answer = ok;
        });
      },
      publish: (type, data) => {
        events.push({ type, data });
      },
    });
  return {
    asked,
    events,
    answer: (r: {
      outcome: "answered" | "timeout" | "cancelled";
      optionId?: string;
      text?: string;
    }) => answer(r),
    ctx,
  };
}

describe("Web 版 ExtensionUIContext", () => {
  test("select 发只有选项的弹窗（没有输入框），optionId 映射回原字符串", async () => {
    const c = channel();
    const ctx = c.ctx();
    const picked = ctx.select("选一个", ["a", "b"]);
    expect(c.asked[0]).toEqual({
      source: "question",
      title: "选一个",
      options: [
        { id: "0", label: "a" },
        { id: "1", label: "b" },
      ],
    });
    expect(c.asked[0]).not.toHaveProperty("input");
    c.answer({ outcome: "answered", optionId: "1" });
    await expect(picked).resolves.toBe("b");
  });

  test("confirm 问确认 / 取消，只有 yes 为 true", async () => {
    const c = channel();
    const ctx = c.ctx();
    const confirmed = ctx.confirm("确认", "要装吗");
    expect(c.asked[0]).toEqual({
      source: "question",
      title: "确认",
      body: "要装吗",
      options: [
        { id: "yes", label: "确认" },
        { id: "no", label: "取消" },
      ],
    });
    c.answer({ outcome: "answered", optionId: "yes" });
    await expect(confirmed).resolves.toBe(true);

    const rejected = ctx.confirm("确认", "要装吗");
    c.answer({ outcome: "answered", optionId: "no" });
    await expect(rejected).resolves.toBe(false);
  });

  test("input 与 editor 都是「有输入框、没有选项」，占位与预填进 body", async () => {
    const c = channel();
    const ctx = c.ctx();

    const typed = ctx.input("名字", "占位");
    expect(c.asked[0]).toEqual({
      source: "question",
      title: "名字",
      body: "占位",
      input: "text",
    });
    c.answer({ outcome: "answered", text: "x" });
    await expect(typed).resolves.toBe("x");

    const edited = ctx.editor("正文", "预填");
    expect(c.asked[1]).toEqual({
      source: "question",
      title: "正文",
      body: "预填",
      input: "text",
    });
    c.answer({ outcome: "answered", text: "长文" });
    await expect(edited).resolves.toBe("长文");
  });

  test("撤销、超时、未答复都按「用户没答」收尾", async () => {
    const c = channel();
    const ctx = c.ctx();

    const cancelled = ctx.select("选一个", ["a"]);
    c.answer({ outcome: "cancelled" });
    await expect(cancelled).resolves.toBeUndefined();

    const timedOut = ctx.confirm("确认", "问");
    c.answer({ outcome: "timeout" });
    await expect(timedOut).resolves.toBe(false);

    const empty = ctx.input("名字");
    c.answer({ outcome: "answered" });
    await expect(empty).resolves.toBeUndefined();
  });

  test("opts.timeout 比弹窗表更短时，自己按没答收尾", async () => {
    const c = channel();
    const ctx = c.ctx();
    await expect(ctx.confirm("确认", "问", { timeout: 5 })).resolves.toBe(
      false,
    );
    await expect(
      ctx.input("名字", undefined, { timeout: 5 }),
    ).resolves.toBeUndefined();
  });

  test("已中止的 signal 直接返回默认值，不发请求", async () => {
    const c = channel();
    const ctx = c.ctx();
    const controller = new AbortController();
    controller.abort();
    await expect(
      ctx.confirm("确认", "问", { signal: controller.signal }),
    ).resolves.toBe(false);
    expect(c.asked).toEqual([]);
  });

  test("单向方法发 extension.ui 事件、不等答复", () => {
    const c = channel();
    const ctx = c.ctx();
    ctx.notify("提示", "warning");
    ctx.setStatus("k", "状态");
    ctx.setWidget("w", ["一行"]);
    ctx.setTitle("标题");
    ctx.setEditorText("文本");
    // 组件工厂在 Web 端不渲染，不发出任何事件
    ctx.setWidget("w2", () => ({ render: () => [] }) as never);
    expect(c.events.map((e) => e.type)).toEqual([
      "extension.ui",
      "extension.ui",
      "extension.ui",
      "extension.ui",
      "extension.ui",
    ]);
    expect(c.events.map((e) => e.data.method)).toEqual([
      "notify",
      "setStatus",
      "setWidget",
      "setTitle",
      "set_editor_text",
    ]);
    expect(c.events[0]?.data).toMatchObject({
      message: "提示",
      notifyType: "warning",
    });
    expect(c.events[1]?.data).toMatchObject({
      statusKey: "k",
      statusText: "状态",
    });
    expect(c.events[2]?.data).toMatchObject({
      widgetKey: "w",
      widgetLines: ["一行"],
    });
    expect(c.events[3]?.data).toMatchObject({ title: "标题" });
    expect(c.events[4]?.data).toMatchObject({ text: "文本" });
  });

  test("终端专属能力按空操作处理，theme 仍可用", () => {
    const c = channel();
    const ctx = c.ctx();
    expect(ctx.getEditorText()).toBe("");
    expect(ctx.getToolsExpanded()).toBe(false);
    expect(ctx.setTheme("dark")).toMatchObject({ success: false });
    expect(ctx.getTheme("dark")).toBeUndefined();
    expect(ctx.getAllThemes()).toEqual([]);
    expect(typeof ctx.theme.fg("accent", "x")).toBe("string");
  });
});
