// exec-view 的渲染规则：RESULT / THREW / undefined、预算与整行截断、full 不省略。
import { describe, expect, test } from "vitest";
import type { ExecOutcome } from "../engine/types.js";
import { renderExec } from "./exec-view.js";

const query = { title: "示例页", url: "https://x.test/app" };

describe("renderExec", () => {
  test("值：EXEC 外壳 + RESULT 带字符数 + 结果原文", () => {
    const outcome: ExecOutcome = { kind: "value", json: '{\n  "a": 1\n}' };
    expect(renderExec(outcome, query)).toEqual({
      text: [
        "EXEC: 示例页 | https://x.test/app",
        "RESULT (12 chars):",
        "{",
        '  "a": 1',
        "}",
      ].join("\n"),
      elided: false,
      full: [
        "EXEC: 示例页 | https://x.test/app",
        "RESULT (12 chars):",
        "{",
        '  "a": 1',
        "}",
      ].join("\n"),
    });
  });

  test("undefined 结果：一行 RESULT: undefined，不写字符数", () => {
    expect(renderExec({ kind: "value", json: "undefined" }, query).text).toBe(
      ["EXEC: 示例页 | https://x.test/app", "RESULT: undefined"].join("\n"),
    );
  });

  test("抛异常：THREW 行后面照写 message 的多行", () => {
    expect(
      renderExec(
        { kind: "threw", message: "TypeError: 坏了\n    at foo" },
        query,
      ).text,
    ).toBe(
      [
        "EXEC: 示例页 | https://x.test/app",
        "THREW:",
        "TypeError: 坏了",
        "    at foo",
      ].join("\n"),
    );
  });

  test("长结果：按整行留前 6000 字符、报剩余行数，full 是完整的", () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `"line ${i} ${"x".repeat(50)}"`,
    );
    const json = lines.join("\n");
    const view = renderExec({ kind: "value", json }, query);
    expect(view.elided).toBe(true);
    const out = view.text.split("\n");
    expect(out[0]).toBe("EXEC: 示例页 | https://x.test/app");
    expect(out[1]).toBe(`RESULT (${json.length} chars):`);
    expect(out.at(-1)).toMatch(
      /^… \d+ more lines \(400 lines total\); full result is saved as an attachment$/,
    );
    // 内联部分不超过预算，且都是整行。
    const kept = out.slice(2, -1);
    expect(kept.join("\n").length).toBeLessThanOrEqual(6000);
    expect(kept[0]).toMatch(/^"line 0 /);
    expect(kept.at(-1)).toMatch(/^"line \d+ /);
    // 全文不省略。
    expect(view.full.split("\n")).toHaveLength(2 + 400);
    expect(view.full).toContain('"line 399 ');
  });

  test("一行就超预览预算：一行都不留，只报总行数", () => {
    const json = `"${"a".repeat(13_000)}"`;
    const view = renderExec({ kind: "value", json }, query);
    expect(view.elided).toBe(true);
    expect(view.text.split("\n").slice(2)).toEqual([
      "… 1 more lines (1 lines total); full result is saved as an attachment",
    ]);
    expect(view.full).toContain("a".repeat(13_000));
  });

  test("恰好在上限上：内联，不落附件", () => {
    expect(
      renderExec({ kind: "value", json: "x".repeat(12_000) }, query).elided,
    ).toBe(false);
    expect(
      renderExec({ kind: "value", json: "x".repeat(12_001) }, query).elided,
    ).toBe(true);
  });

  test("抛异常再长也不落附件（它本来就是一句）", () => {
    const view = renderExec(
      { kind: "threw", message: "E".repeat(20_000) },
      query,
    );
    expect(view.elided).toBe(false);
  });
});
