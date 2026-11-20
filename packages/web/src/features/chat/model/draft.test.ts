import { expect, test } from "vitest";
import { makeQuote, QUOTE_MAX, withQuotes } from "./draft";

test("withQuotes：多条各自成块；引用里带围栏时外层围栏更长", () => {
  const a = makeQuote("f:/a:L1", "plain");
  const b = makeQuote("f:/b:L1", "```js\nx\n```");
  const out = withQuotes(
    [
      { id: "1", quote: a },
      { id: "2", quote: b },
    ],
    "问题",
  );
  expect(out).toContain("Quote f:/a:L1\n```\nplain\n```");
  expect(out).toContain("Quote f:/b:L1\n````\n```js\nx\n```\n````");
  expect(out.endsWith("\n\n问题")).toBe(true);
  expect(withQuotes([], "光问题")).toBe("光问题");
});

test("makeQuote：超长选区截断并注明原字数", () => {
  const q = makeQuote("f:/a:L1", "x".repeat(QUOTE_MAX + 5));
  expect(q.text).toContain(`已截断，原选区 ${QUOTE_MAX + 5} 字`);
  expect(q.text.length).toBeLessThan(QUOTE_MAX + 60);
});
