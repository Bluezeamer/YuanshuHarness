import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// 命名守卫：内部约定（对象键、枚举值、判别字段、前缀标记）用英文标识，不靠中文文字对上暗号。
// 不禁中文本身：界面文案、文件名、用户数据、说明文字照常写中文；要防的只是「中文当键、当取值、当标记」。
// 展示用的名字另走映射（id → label），线上与存储里只放 id。扫服务端、前端的源码与 prompts 里的 JSON。

const SRC = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = path.resolve(SRC, "../..");

const CJK = "[\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef]";
const STR = (inner: string) =>
  `(?:"[^"\\n]*${inner}[^"\\n]*"|'[^'\\n]*${inner}[^'\\n]*')`;

// 每条规则只看一行；注释行不算
const RULES: Array<[string, RegExp]> = [
  // 只看行首的键（对象字面量一行一个键）：一行里 `{名: 值}` 多半是字符串里的说明文字
  ["对象键写成中文", new RegExp(`^\\s*(?:${STR(CJK)}|${CJK}+)\\s*:(?!:)`)],
  ["case 分支比较中文", new RegExp(`\\bcase\\s+${STR(CJK)}`)],
  [
    "与中文字面量做相等比较",
    new RegExp(`(?:[!=]==?\\s*${STR(CJK)}|${STR(CJK)}\\s*[!=]==?)`),
  ],
  [
    "联合类型里的中文字面量",
    new RegExp(
      `(?:(?<!\\|)\\|(?!\\|)\\s*${STR(CJK)}|${STR(CJK)}\\s*\\|(?!\\|))`,
    ),
  ],
];
const JSON_KEY = new RegExp(`^\\s*"[^"\\n]*${CJK}[^"\\n]*"\\s*:`);

function walk(dir: string, exts: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "dist") return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p, exts);
    return exts.some((x) => e.name.endsWith(x)) && !/\.test\.tsx?$/.test(e.name)
      ? [p]
      : [];
  });
}

const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);

function scan(root: string, exts: string[], rules: Array<[string, RegExp]>) {
  return walk(root, exts).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) =>
        isComment(line)
          ? []
          : rules
              .filter(([, re]) => re.test(line))
              .map(
                ([why]) =>
                  `${path.relative(PACKAGES, file)}:${i + 1} ${why}：${line.trim().slice(0, 80)}`,
              ),
      ),
  );
}

describe("命名守卫", () => {
  test("服务端源码里没有中文当键 / 取值 / 判别", () => {
    expect(scan(SRC, [".ts"], RULES)).toEqual([]);
  });

  test("前端源码里没有中文当键 / 取值 / 判别", () => {
    expect(
      scan(path.join(PACKAGES, "web/src"), [".ts", ".tsx"], RULES),
    ).toEqual([]);
  });

  test("提示词资产的 JSON 键是英文", () => {
    expect(
      scan(
        path.join(PACKAGES, "server/prompts"),
        [".json"],
        [["JSON 键写成中文", JSON_KEY]],
      ),
    ).toEqual([]);
  });
});
