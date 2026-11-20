// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { countsOf, scan } from "./scan";

// 扫描器本身的冒烟：造一个小目录，确认五类规则各能认出自己的违规、也放行该放行的。
const dir = mkdtempSync(join(tmpdir(), "guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const put = (rel: string, text: string) => {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
};

put(
  "ui/type.css",
  ".t-entry { font: 500 13px/20px sans-serif; } .t-x { line-height: 20px }",
);
put(
  "features/a.css",
  `.row { font-size: 11px; padding: 8px 10px; gap: 8px; z-index: 5; height: 26px; }
   .ok { padding: 12px; height: 32px; border-radius: 8px; z-index: 20; }
   .dot svg { height: 12px; }
   .tint { background: var(--danger-soft); }
   .mix { background: color-mix(in oklch, var(--warn) 10%, white); }`,
);
put(
  "features/B.tsx",
  `export const B = () => <div style={{ fontSize: 12 }}><button>x</button><b>y</b><h2 className="t-block">ok</h2><h1>z</h1></div>;
   const ConfirmModal = () => null;`,
);
put("ui/Own.tsx", "export const O = () => <button>ok</button>;");

test("五类规则各认出自己的违规，放行刻度内与图标尺寸", () => {
  const c = countsOf(scan(dir));
  expect(c.type).toEqual({ "features/a.css": 1, "features/B.tsx": 1 });
  expect(c.scale).toEqual({ "features/a.css": 3 });
  expect(c.color).toEqual({ "features/a.css": 2 });
  expect(c.control).toEqual({ "features/B.tsx": 2 });
  expect(c.tag).toEqual({ "features/B.tsx": 2 });
});
