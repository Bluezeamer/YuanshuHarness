// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const css = readFileSync(
  new URL("./exec.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

test("类名都带 ch-ex- 前缀，且不用视口媒体查询", () => {
  const classes = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(
    (m) => m[1] ?? "",
  );
  expect(classes.length).toBeGreaterThan(10);
  for (const c of classes) expect(/^(ch-ex(-|$)|u-)/.test(c), c).toBe(true);
  expect(css).not.toMatch(/@media\s*\(\s*(max|min)-width/);
});
