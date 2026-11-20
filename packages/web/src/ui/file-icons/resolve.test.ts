import { expect, test } from "vitest";
import { ICONS } from "./file-icons.generated";
import { dirIconName, fileIconName } from "./resolve";

test("文件名：特殊文件名先于前缀、复合后缀、扩展名，大小写不敏感", () => {
  const cases: Record<string, string> = {
    "package.json": "package-json",
    "PACKAGE.JSON": "package-json",
    Dockerfile: "docker",
    "Dockerfile.dev": "docker",
    ".env.local": "env",
    "tsconfig.build.json": "typescript-config",
    "vite.config.ts": "vite",
    "types.d.ts": "typescript-def",
    "a.test.ts": "typescript-test",
    "a.ts": "typescript",
    "App.tsx": "typescript-react",
    "README.md": "readme",
    "notes.md": "markdown",
    "logo.PNG": "image",
    "pnpm-lock.yaml": "pnpm-lock",
    "x.config.mjs": "javascript-config",
  };
  for (const [name, icon] of Object.entries(cases))
    expect(fileIconName(name), name).toBe(icon);
});

test("没有扩展名或不认识的扩展名退回通用文件；点开头的隐藏文件不当成扩展名", () => {
  expect(fileIconName("noext")).toBe("file");
  expect(fileIconName("weird.zzzz")).toBe("file");
  expect(fileIconName(".hiddenrc")).toBe("file");
});

test("目录：认得的名字用专属图标，展开取 -open，不认得的是通用文件夹", () => {
  expect(dirIconName("src")).toBe("folder-src");
  expect(dirIconName("src", true)).toBe("folder-src-open");
  expect(dirIconName("node_modules")).toBe("folder-node");
  expect(dirIconName(".github")).toBe("folder-github");
  expect(dirIconName("whatever")).toBe("folder");
  expect(dirIconName("whatever", true)).toBe("folder-open");
});

test("映射里出现的每一个图标都在生成的图标表里，且没有写死的色值", () => {
  for (const name of ["a.ts", "a.png", "Dockerfile", "x.d.ts", "zzz", "src"]) {
    const n = name === "src" ? dirIconName(name) : fileIconName(name);
    expect(ICONS[n], n).toBeTruthy();
  }
  for (const [n, body] of Object.entries(ICONS))
    expect(body, n).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
});
