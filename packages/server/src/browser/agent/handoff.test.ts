// 接管提问：两个方向（operate = 请用户接管、claim = 请求使用用户的页面）的卡片与四种结果。
// 弹窗表用替身，只看发给它的 PromptSpec。
import { expect, test } from "vitest";
import type { PromptResult, PromptSpec } from "../../session/prompts.js";
import { askHandoff, type HandoffDirection } from "./handoff.js";

const args = {
  pageTitle: "登录页",
  url: "https://example.com/login",
  reason: "需要登录",
  direction: "operate" as HandoffDirection,
};

function answer(result: PromptResult, direction: HandoffDirection = "operate") {
  const asks: PromptSpec[] = [];
  const ask = async (spec: PromptSpec) => {
    asks.push(spec);
    return result;
  };
  return { asks, run: askHandoff(ask, { ...args, direction }) };
}

test("operate 方向的标题、正文与两个选项", async () => {
  const { asks, run } = answer({ outcome: "answered", optionId: "done" });
  await run;
  const spec = asks[0] as PromptSpec;
  expect(spec.source).toBe("question");
  expect(spec.input).toBe("text");
  expect(spec.title).toBe("agent 请你接管页面：登录页");
  expect(spec.body).toContain("需要登录");
  expect(spec.body).toContain("https://example.com/login");
  expect(spec.options).toEqual([
    { id: "done", label: "我已操作完成" },
    { id: "refuse", label: "拒绝" },
  ]);
});

test("claim 方向：标题换成请求使用，选项「交给 agent / 拒绝」，正文一致", async () => {
  const { asks, run } = answer(
    { outcome: "answered", optionId: "done" },
    "claim",
  );
  await run;
  const spec = asks[0] as PromptSpec;
  expect(spec.source).toBe("question");
  expect(spec.input).toBe("text");
  expect(spec.title).toBe("agent 请求使用页面：登录页");
  expect(spec.body).toBe("原因：需要登录\n页面：https://example.com/login");
  expect(spec.options).toEqual([
    { id: "done", label: "交给 agent" },
    { id: "refuse", label: "拒绝" },
  ]);
});

test("没有标题时用地址当标题；理由为空时正文不放原因", async () => {
  let spec: PromptSpec | null = null;
  await askHandoff(
    async (s) => {
      spec = s;
      return { outcome: "answered", optionId: "done" };
    },
    {
      pageTitle: "",
      url: "http://x.test/",
      reason: "  ",
      direction: "claim",
    },
  );
  expect((spec as unknown as PromptSpec).title).toBe(
    "agent 请求使用页面：http://x.test/",
  );
  expect((spec as unknown as PromptSpec).body).toBe("页面：http://x.test/");
});

test("四种结果（两个方向的映射一致）", async () => {
  for (const direction of ["operate", "claim"] as const) {
    expect(
      await answer({ outcome: "answered", optionId: "done" }, direction).run,
    ).toEqual({ kind: "done" });
    // 选「完成」时也可以顺带写一句
    expect(
      await answer(
        { outcome: "answered", optionId: "done", text: "登录好了" },
        direction,
      ).run,
    ).toEqual({ kind: "done", note: "登录好了" });
    expect(
      await answer(
        {
          outcome: "answered",
          optionId: "refuse",
          text: "我不能登录",
        },
        direction,
      ).run,
    ).toEqual({ kind: "refused", reason: "我不能登录" });
    // 没选选项、只写了字：也算拒绝，写的话就是理由
    expect(
      await answer({ outcome: "answered", text: "我不想给这个页面" }, direction)
        .run,
    ).toEqual({ kind: "refused", reason: "我不想给这个页面" });
    // 理由允许空串
    expect(
      await answer(
        { outcome: "answered", optionId: "refuse", text: "" },
        direction,
      ).run,
    ).toEqual({ kind: "refused", reason: "" });
    expect(
      await answer({ outcome: "answered", optionId: "refuse" }, direction).run,
    ).toEqual({ kind: "refused", reason: "" });
    expect(await answer({ outcome: "timeout" }, direction).run).toEqual({
      kind: "timeout",
    });
    expect(await answer({ outcome: "cancelled" }, direction).run).toEqual({
      kind: "cancelled",
    });
  }
});
