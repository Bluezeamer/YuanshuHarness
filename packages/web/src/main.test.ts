// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// 真实打包里 CSS 的顺序决定 @layer 的优先级；jsdom 看不出来，所以只守住入口文件的导入次序。
test("main.tsx 的第一份导入是 tokens.css，随后是 ui.css", () => {
  const src = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
  const imports = src.split("\n").filter((l) => l.startsWith("import "));
  expect(imports[0]).toBe('import "./ui/tokens.css";');
  expect(imports[1]).toBe('import "./ui/ui.css";');
});
