import { describe, expect, it } from "vitest";
import { budgetLines, INLINE_MAX } from "./budget.js";

describe("budgetLines", () => {
  it("内容不超预算：原样给，不落附件", () => {
    const r = budgetLines(["HEAD"], ["a", "b"], "full text");
    expect(r).toEqual({
      text: "HEAD\na\nb",
      elided: false,
      full: "HEAD\na\nb",
    });
  });

  it("恰好等于上限不算超", () => {
    const body = ["x".repeat(INLINE_MAX)];
    expect(budgetLines(["H"], body, "full text").elided).toBe(false);
  });

  it("超预算：按整行留前 6000 字符，提示行写剩余行数与 what", () => {
    const body = Array.from(
      { length: 300 },
      (_, i) => `${i}:${"y".repeat(97)}`,
    );
    const r = budgetLines(["HEAD"], body, "full list");
    const lines = r.text.split("\n");
    // 每行 100 字符 + 换行：6000 以内留 59 行
    expect(lines.slice(0, 1)).toEqual(["HEAD"]);
    expect(lines).toHaveLength(1 + 59 + 1);
    expect(lines.at(-1)).toBe(
      "… 241 more lines (300 lines total); full list is saved as an attachment",
    );
    expect(r.elided).toBe(true);
    expect(r.full).toBe(["HEAD", ...body].join("\n"));
  });

  it("一行就超预算：一行都不留", () => {
    const r = budgetLines(["H"], ["z".repeat(INLINE_MAX + 1)], "full text");
    expect(r.text).toBe(
      "H\n… 1 more lines (1 lines total); full text is saved as an attachment",
    );
  });
});
