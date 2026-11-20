// 读页面里截获的复制：只读各 frame 的变量，不碰浏览器剪贴板本身。
import type { Page } from "playwright-core";
import { describe, expect, test } from "vitest";
import { CLIPBOARD_INIT, readCopied } from "./clipboard.js";

/** 假 frame：evaluate 返回值、或按需抛错。 */
function frame(value: unknown, fail = false) {
  return {
    evaluate: async () => {
      if (fail) throw new Error("Frame was detached");
      return value;
    },
  };
}

const pageOf = (frames: unknown[]) =>
  ({ frames: () => frames }) as unknown as Page;

describe("readCopied", () => {
  test("取各 frame 里 ts 最大的那个", async () => {
    const p = pageOf([
      frame({ text: "旧的", ts: 10 }),
      frame({ text: "新的", ts: 30 }),
      frame({ text: "中间", ts: 20 }),
    ]);
    expect(await readCopied(p)).toEqual({ text: "新的", ts: 30 });
  });

  test("跨源 iframe 里的复制也算", async () => {
    const p = pageOf([frame(null), frame({ text: "框里的", ts: 5 })]);
    expect(await readCopied(p)).toEqual({ text: "框里的", ts: 5 });
  });

  test("frame 读失败（已分离）当作没有", async () => {
    const p = pageOf([
      frame(undefined, true),
      frame({ text: "还在的", ts: 7 }),
    ]);
    expect(await readCopied(p)).toEqual({ text: "还在的", ts: 7 });
  });

  test("都没复制过返回 null", async () => {
    expect(
      await readCopied(pageOf([frame(null), frame(undefined)])),
    ).toBeNull();
    expect(await readCopied(pageOf([]))).toBeNull();
  });

  test("形状不对的值当作没有", async () => {
    expect(
      await readCopied(
        pageOf([frame({ text: "没有时间" }), frame({ ts: 3 }), frame(1)]),
      ),
    ).toBeNull();
  });
});

describe("CLIPBOARD_INIT", () => {
  test("四条复制路径都包住，结果记在 __ysClip", () => {
    for (const part of [
      "__ysClip",
      "writeText",
      "cb.write",
      "setData",
      'addEventListener("copy"',
    ])
      expect(CLIPBOARD_INIT).toContain(part);
    // 整体包在 try/catch 里：注入失败也不能影响页面自己的脚本
    expect(CLIPBOARD_INIT.startsWith("(() => {\n  try {")).toBe(true);
  });
});
