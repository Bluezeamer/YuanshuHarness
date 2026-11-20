// ask_user 的问法与结果文字：直接拿工具定义跑一遍（不经过会话与模型）。
import { describe, expect, test } from "vitest";
import type { PromptResult, PromptSpec } from "./prompts.js";
import { askUserExtension } from "./tools.js";

function tool(answer: PromptResult) {
  const asked: PromptSpec[] = [];
  let exec: ((id: string, params: unknown) => Promise<unknown>) | undefined;
  askUserExtension(async (spec) => {
    asked.push(spec);
    return answer;
  })({
    registerTool: (t: {
      execute: (id: string, params: unknown) => Promise<unknown>;
    }) => {
      exec = t.execute;
    },
    on: () => {},
  } as never);
  const run = async (params: Record<string, unknown>) => {
    const r = (await exec?.("t1", params)) as {
      content: Array<{ type: string; text?: string }>;
    };
    return r.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  };
  return { asked, run };
}

const picked = { outcome: "answered", optionId: "1" } as PromptResult;

describe("ask_user：问法", () => {
  test("有没有 options 都给输入框；描述写明用户总能自己回答", async () => {
    const withOptions = tool(picked);
    await withOptions.run({ question: "选哪个？", options: ["甲", "乙"] });
    expect(withOptions.asked[0]).toEqual({
      source: "question",
      title: "选哪个？",
      options: [
        { id: "0", label: "甲" },
        { id: "1", label: "乙" },
      ],
      input: "rich",
    });

    const free = tool({ outcome: "answered", text: "x" });
    await free.run({ question: "叫什么？" });
    expect(free.asked[0]).toEqual({
      source: "question",
      title: "叫什么？",
      input: "rich",
    });

    // 空数组当没给：不弹「有选项但一个都没有」的卡片
    const empty = tool({ outcome: "answered", text: "x" });
    await empty.run({ question: "q", options: [] });
    expect(empty.asked[0]).toEqual({
      source: "question",
      title: "q",
      input: "rich",
    });

    const def = askUserExtension(() => Promise.resolve(picked)) as never as (
      pi: unknown,
    ) => void;
    let description = "";
    def({
      registerTool: (t: { description: string }) => {
        description = t.description;
      },
      on: () => {},
    } as never);
    // 选项只是建议的快捷回复，自由回答是一等输入
    expect(description).toContain("in their own words");
    expect(description).toContain("suggested quick replies");
  });
});

describe("ask_user：结果文字", () => {
  const cases: Array<[string, PromptResult, string, Record<string, unknown>]> =
    [
      [
        "只选了选项",
        { outcome: "answered", optionId: "1" },
        "The user selected: 乙",
        { question: "q", options: ["甲", "乙"] },
      ],
      [
        "只写了字（有选项）",
        { outcome: "answered", text: "都要" },
        "The user did not pick a listed option and replied: 都要",
        { question: "q", options: ["甲", "乙"] },
      ],
      [
        "只写了字（没有选项）",
        { outcome: "answered", text: "小明" },
        "The user replied: 小明",
        { question: "q" },
      ],
      [
        "选项 + 文字",
        { outcome: "answered", optionId: "0", text: "补一句" },
        "The user selected: 甲\nThe user also wrote: 补一句",
        { question: "q", options: ["甲", "乙"] },
      ],
      [
        "超时",
        { outcome: "timeout" },
        "The user did not answer (timed out).",
        { question: "q" },
      ],
      [
        "取消",
        { outcome: "cancelled" },
        "The question was cancelled.",
        { question: "q" },
      ],
    ];
  for (const [name, answer, expected, params] of cases)
    test(name, async () => {
      const t = tool(answer);
      expect(await t.run(params)).toBe(expected);
    });

  test("答复带图片：文字块后面每张图一个 image 块", async () => {
    const asked: PromptSpec[] = [];
    let exec: ((id: string, params: unknown) => Promise<unknown>) | undefined;
    askUserExtension(async (spec) => {
      asked.push(spec);
      return {
        outcome: "answered",
        text: "看图",
        images: [{ mimeType: "image/png", data: "QUJD" }],
      };
    })({
      registerTool: (t: {
        execute: (id: string, params: unknown) => Promise<unknown>;
      }) => {
        exec = t.execute;
      },
      on: () => {},
    } as never);
    const r = (await exec?.("t1", { question: "q" })) as {
      content: Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }>;
    };
    expect(r.content).toEqual([
      { type: "text", text: "The user replied: 看图" },
      { type: "image", data: "QUJD", mimeType: "image/png" },
    ]);
  });
});
