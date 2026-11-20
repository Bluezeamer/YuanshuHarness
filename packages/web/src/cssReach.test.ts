// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const srcDir = fileURLToPath(new URL("./", import.meta.url));

// 样式文件只要没有被入口（main.tsx）经 import 链引到，真实打包里就不存在；jsdom 测试看不出来。
const IMPORT =
  /(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\s*\(?\s*["']([^"']+)["']|@import\s*["']([^"']+)["']/g;

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  const cands = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  return cands.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(tsx?|css)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const next = resolveSpec(file, m[1] ?? m[2] ?? m[3] ?? "");
      if (next) queue.push(next);
    }
  }
  return seen;
}

function cssUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return cssUnder(full);
    return full.endsWith(".css") ? [full] : [];
  });
}

test("新界面的每份样式都能从 main.tsx 的导入链到达", () => {
  const reached = reachableFrom(join(srcDir, "main.tsx"));
  const missing = ["features", "ui", "app"]
    .flatMap((d) => cssUnder(join(srcDir, d)))
    .filter((f) => !reached.has(f))
    .map((f) => f.slice(srcDir.length));
  expect(missing).toEqual([]);
});
