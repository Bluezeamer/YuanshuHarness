// watchDialogs 的行为：挂起不自动回答、回答、超时、页面关闭、动作被打断。全部用假 Page / 假 Dialog。
import type { Dialog, Page } from "playwright-core";
import { expect, test } from "vitest";
import { DIALOG_TIMEOUT_MS, watchDialogs } from "./dialog.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface FakeDialog extends Dialog {
  calls: string[];
}

function fakeDialog(
  type: string,
  message = "确定删除吗？",
  defaultValue = "",
  fail = false,
): FakeDialog {
  const calls: string[] = [];
  const guard = () => {
    if (fail)
      throw new Error("Target page, context or browser has been closed");
  };
  return {
    calls,
    type: () => type,
    message: () => message,
    defaultValue: () => defaultValue,
    page: () => null,
    async accept(text?: string) {
      calls.push(`accept ${text ?? ""}`.trim());
      guard();
    },
    async dismiss() {
      calls.push("dismiss");
      guard();
    },
  };
}

/** 假 Playwright Page：只提供 watchDialogs 用到的事件订阅。 */
function fakePage() {
  const listeners = new Map<string, ((arg: unknown) => void)[]>();
  const page = {
    on: (name: string, fn: (arg: unknown) => void) => {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
    },
  } as unknown as Page;
  const emit = (name: string, arg: unknown) => {
    for (const fn of listeners.get(name) ?? []) fn(arg);
  };
  return {
    page,
    dialog: (d: Dialog) => emit("dialog", d),
    close: () => emit("close", {}),
  };
}

test("对话框出现时挂起、不自动回答，状态可读", () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  const dialog = fakeDialog("confirm");
  f.dialog(dialog);
  expect(watch.current()).toEqual({
    type: "confirm",
    message: "确定删除吗？",
    defaultValue: "",
  });
  expect(dialog.calls).toEqual([]);
});

test("prompt 带默认值；其它类型默认值是空串", () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  f.dialog(fakeDialog("prompt", "名字？", "x"));
  expect(watch.current()).toEqual({
    type: "prompt",
    message: "名字？",
    defaultValue: "x",
  });
  f.close();
  const g = fakePage();
  const w = watchDialogs(g.page);
  g.dialog(fakeDialog("alert", "hi", "ignored"));
  expect(w.current()?.defaultValue).toBe("");
});

test("answer：accept 与 dismiss 各自落到 Playwright，返回 true 并清状态", async () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  const dialog = fakeDialog("confirm");
  f.dialog(dialog);
  expect(await watch.answer(true)).toBe(true);
  expect(dialog.calls).toEqual(["accept"]);
  expect(watch.current()).toBeNull();

  const other = fakePage();
  const w = watchDialogs(other.page);
  const second = fakeDialog("alert");
  other.dialog(second);
  expect(await w.answer(false)).toBe(true);
  expect(second.calls).toEqual(["dismiss"]);
  expect(w.current()).toBeNull();
});

test("prompt：给了 text 用 text，没给用默认值", async () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  const dialog = fakeDialog("prompt", "名字？", "默认名");
  f.dialog(dialog);
  await watch.answer(true, "小红");
  expect(dialog.calls).toEqual(["accept 小红"]);

  const g = fakePage();
  const w = watchDialogs(g.page);
  const second = fakeDialog("prompt", "名字？", "默认名");
  g.dialog(second);
  await w.answer(true);
  expect(second.calls).toEqual(["accept 默认名"]);
});

test("没有挂着的对话框：answer 返回 false", async () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  expect(await watch.answer(true)).toBe(false);
});

test("Playwright 的 accept 抛错（页面已关）也照样清状态并返回 true", async () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  f.dialog(fakeDialog("alert", "hi", "", true));
  expect(await watch.answer(true)).toBe(true);
  expect(watch.current()).toBeNull();
});

test("超时自动取消并通知订阅者", async () => {
  const f = fakePage();
  const watch = watchDialogs(f.page, 50);
  const dialog = fakeDialog("alert");
  const seen: (string | null)[] = [];
  watch.onChange(() => seen.push(watch.current()?.type ?? null));
  f.dialog(dialog);
  expect(seen).toEqual(["alert"]);
  await sleep(120);
  expect(dialog.calls).toEqual(["dismiss"]);
  expect(watch.current()).toBeNull();
  expect(seen).toEqual(["alert", null]);
});

test("已经有挂着的：新来的直接取消，不排队", () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  const first = fakeDialog("alert", "第一个");
  const second = fakeDialog("confirm", "第二个");
  f.dialog(first);
  f.dialog(second);
  expect(watch.current()?.message).toBe("第一个");
  expect(first.calls).toEqual([]);
  expect(second.calls).toEqual(["dismiss"]);
});

test("页面关闭：清状态、清计时器、通知订阅者", () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  const seen: (string | null)[] = [];
  watch.onChange(() => seen.push(watch.current()?.type ?? null));
  const dialog = fakeDialog("alert");
  f.dialog(dialog);
  f.close();
  expect(watch.current()).toBeNull();
  expect(seen).toEqual(["alert", null]);
  // 页面没了就不用回答
  expect(dialog.calls).toEqual([]);
});

test("onChange 退订后不再回调", () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  let n = 0;
  const off = watch.onChange(() => n++);
  f.dialog(fakeDialog("alert"));
  off();
  f.close();
  expect(n).toBe(1);
});

test("interrupted：动作先完成时原样返回，抛错也原样抛", async () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  expect(await watch.interrupted(async () => 7, -1)).toBe(7);
  const boom = new Error("点击失败：编号已失效");
  await expect(
    watch.interrupted(async () => {
      throw boom;
    }, -1),
  ).rejects.toBe(boom);
});

test("interrupted：对话框先出现就返回 fallback，后到的拒绝不产生未处理拒绝", async () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    // 对话框先到（10ms），动作后到并被拒绝（40ms）。
    setTimeout(() => f.dialog(fakeDialog("confirm")), 10);
    const result = await watch.interrupted(async () => {
      await sleep(40);
      throw new Error("点击失败");
    }, "fallback");
    expect(result).toBe("fallback");
    // 动作的拒绝发生在返回之后。
    await sleep(80);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("interrupted：对话框在自己的动作里弹出时返回 fallback", async () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  const result = await watch.interrupted(async () => {
    // 模拟「点删除 → 弹 confirm」：动作永远不返回，但对话框先到。
    f.dialog(fakeDialog("confirm"));
    await sleep(1000);
    return "never";
  }, "blocked");
  expect(result).toBe("blocked");
  expect(watch.current()?.type).toBe("confirm");
});

test("interrupted：开始时就已经有挂着的对话框，不执行动作", async () => {
  const f = fakePage();
  const watch = watchDialogs(f.page);
  f.dialog(fakeDialog("alert"));
  let ran = false;
  const result = await watch.interrupted(async () => {
    ran = true;
    return "value";
  }, "blocked");
  expect(result).toBe("blocked");
  expect(ran).toBe(false);
});

test("超时时间默认 120 秒", () => {
  expect(DIALOG_TIMEOUT_MS).toBe(120_000);
});
