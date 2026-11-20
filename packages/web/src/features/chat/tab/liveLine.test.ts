import { expect, test } from "vitest";
import { liveLineOf } from "./liveLine";

const base = {
  partial: null as string | null,
  partialThinking: "",
  pendingTools: [] as { id: string; name: string; args: string }[],
  running: [] as {
    id: string;
    name: string;
    status: "running";
    args?: unknown;
    output?: string;
  }[],
};

test("什么都没发生时没有预览", () => {
  expect(liveLineOf(base)).toBeNull();
});

test("思考：露最新一行；正文开始流出后思考不再是当前这一步", () => {
  const think = { ...base, partialThinking: "先看看\n再 grep 一下\n" };
  expect(liveLineOf(think)).toMatchObject({
    kind: "thinking",
    label: "思考",
    text: "再 grep 一下",
  });
  expect(liveLineOf({ ...think, partial: "好的，" })).toBeNull();
});

test("正在生成参数的工具：从残缺的参数 JSON 里取最新一行", () => {
  const args = `{"path":"a.ts","content":"line1\\nline2\\nlin`;
  expect(
    liveLineOf({
      ...base,
      pendingTools: [{ id: "1", name: "write", args }],
    }),
  ).toMatchObject({ kind: "tool", label: "write", text: "lin" });
});

test("执行中的工具：有输出取最新一行，没有就取参数摘要；并行的记个数", () => {
  const run = (id: string, over = {}) => ({
    id,
    name: "bash",
    status: "running" as const,
    args: { command: "pnpm test" },
    ...over,
  });
  expect(liveLineOf({ ...base, running: [run("a")] })?.text).toBe("pnpm test");
  expect(
    liveLineOf({
      ...base,
      running: [run("a"), run("b", { output: "PASS a\nPASS b\n" })],
    }),
  ).toMatchObject({ text: "PASS b", more: 1 });
});

test("body 是点开后看的全文：思考是整段思考，参数生成中的是该字段目前的全部，执行中的是目前的全部输出", () => {
  expect(
    liveLineOf({ ...base, partialThinking: "先看看\n再 grep 一下\n" })?.body,
  ).toBe("先看看\n再 grep 一下\n");
  expect(
    liveLineOf({
      ...base,
      pendingTools: [
        {
          id: "1",
          name: "write",
          args: `{"path":"a.ts","content":"line1\\nline2\\nlin`,
        },
      ],
    })?.body,
  ).toBe("line1\nline2\nlin");
  const run = {
    id: "a",
    name: "bash",
    status: "running" as const,
    args: { command: "pnpm test" },
  };
  expect(
    liveLineOf({ ...base, running: [{ ...run, output: "PASS a\nPASS b\n" }] })
      ?.body,
  ).toBe("PASS a\nPASS b\n");
  // 还没有输出时，点开至少能看到在跑什么
  expect(liveLineOf({ ...base, running: [run] })?.body).toBe("pnpm test");
});

test("参数生成中的工具排在执行中的工具与思考之前", () => {
  const out = liveLineOf({
    ...base,
    partialThinking: "想",
    running: [{ id: "r", name: "bash", status: "running" }],
    pendingTools: [{ id: "p", name: "edit", args: `{"newText":"x` }],
  });
  expect(out?.label).toBe("edit");
});
