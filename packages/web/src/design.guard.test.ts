// @vitest-environment node
// 设计规则守卫（基线制）：排版、刻度、颜色、控件、标签默认样式五类规则，规则见 ys-ui-design 与 ys-ui-build 的 references。
// 现状里已有的违规记在 design.baseline.json（每条规则、每个文件的处数）：只拦新增；
// 迁移清理后处数变少，要求同步收缩基线，免得清掉的口子又被悄悄占回去。
// 更新基线：UPDATE_BASELINE=1 pnpm --filter yuanshu-harness-web exec vitest run src/design.guard.test.ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { type Counts, countsOf, type Rule, scan } from "./test/guard/scan";

const srcDir = fileURLToPath(new URL("./", import.meta.url));
const baselinePath = fileURLToPath(
  new URL("./design.baseline.json", import.meta.url),
);

const hits = scan(srcDir);
const now = countsOf(hits);

const sorted = (c: Counts): Counts =>
  Object.fromEntries(
    Object.entries(c).map(([rule, files]) => [
      rule,
      Object.fromEntries(
        Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ]),
  ) as Counts;

if (process.env.UPDATE_BASELINE) {
  writeFileSync(baselinePath, `${JSON.stringify(sorted(now), null, 2)}\n`);
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Counts;

const RULES: Array<[Rule, string]> = [
  [
    "type",
    "排版：字号 / 字重 / 字体族 / 行高只能出现在 ui/type.css，组件选字样类（ys-ui-design 的 typography）",
  ],
  [
    "scale",
    "刻度：间距、高度、圆角、层级的 px 取值要在刻度表里（ys-ui-design 的 visual-language §3）",
  ],
  [
    "color",
    "颜色：不得用 *-soft 淡色底令牌，不得对语义色 color-mix 铺底（ys-ui-design 的 visual-language §2）",
  ],
  [
    "control",
    "控件：业务 TSX 不得裸用 select / button / range / checkbox，也不得再定义 ConfirmModal（ys-ui-build 的 components §4）",
  ],
  [
    "tag",
    "标签：不得靠 b / strong / h1–h6 的浏览器默认外观，强调用字样类或颜色（ys-ui-design 的 typography §2）",
  ],
];

for (const [rule, title] of RULES) {
  test(`${rule}：没有新增违规`, () => {
    const added = Object.entries(now[rule])
      .filter(([f, n]) => n > (baseline[rule][f] ?? 0))
      .map(([f, n]) => {
        const sample = hits
          .filter((h) => h.rule === rule && h.file === f)
          .slice(-3)
          .map((h) => `    ${h.what}`)
          .join("\n");
        return `${f}：${baseline[rule][f] ?? 0} → ${n}\n${sample}`;
      });
    expect(added, `${title}\n新增的违规：`).toEqual([]);
  });

  test(`${rule}：清理了的要同步收缩基线`, () => {
    const shrunk = Object.entries(baseline[rule])
      .filter(([f, n]) => (now[rule][f] ?? 0) < n)
      .map(([f, n]) => `${f}：${n} → ${now[rule][f] ?? 0}`);
    expect(shrunk, "运行文件头注释里的命令更新 design.baseline.json").toEqual(
      [],
    );
  });
}
