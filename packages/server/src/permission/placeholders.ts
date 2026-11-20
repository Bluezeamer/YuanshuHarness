// 隐私变量占位符（ADR-0051）：识别命令里的 `@name` 与 `{{@name}}`，改写成对环境变量的引用。
// 值本身从不拼进命令文本，所以值里的引号、$、换行都无法注入或破坏命令。
import type { Node } from "web-tree-sitter";
import { getParser } from "./bash.js";

export const ENV_PREFIX = "YUANSHU_VAR_";

// 环境变量名：旧文法的名字（字母数字下划线）原样拼接；新文法含 . 和 -，不是合法 shell 变量名，
// 编码成 `0` + 名字的 hex。变量名不会以数字开头，所以两种形式互不冲突。
export const envKey = (name: string): string =>
  /^[A-Za-z][A-Za-z0-9_]*$/.test(name)
    ? `${ENV_PREFIX}${name}`
    : `${ENV_PREFIX}0${Buffer.from(name).toString("hex")}`;

/** 命令里所有 `{{@名称}}` 形态的引用名（不论是否登记）；用于给未定义的引用留记录。 */
export function bracedNames(command: string): string[] {
  const esc = new Set(
    [...command.matchAll(PLACEHOLDER_ESCAPED)].map((m) => m.index),
  );
  const names = new Set<string>();
  for (const m of command.matchAll(PLACEHOLDER_NEW))
    if (!esc.has(m.index - 1)) names.add(m[1] as string);
  return [...names];
}

// 旧形态：前面不能是单词字符或 @ . \ $ / -（邮箱、路径、转义、$@）；
// 后面不能接 / 或 .x -x（@scope/pkg、@a.example.com）。名字取最长匹配，再按登记表精确查。
const PLACEHOLDER_BARE =
  /(?<![\w@.\\$/-])@([A-Za-z][A-Za-z0-9_]{0,63})(?![\w/]|[.-][A-Za-z0-9])/g;
// 新形态（S4b）：`{{@名称}}`；匹配新旧两种文法的名称。不需要前置分隔符检查，到第一个 `}` 就停。
const PLACEHOLDER_NEW = /\{\{@([a-z][a-z0-9_.-]{2,47})\}\}/g;
// `\{{@` 转义：保留字面量，不作占位符。
const PLACEHOLDER_ESCAPED = /\\\{\{@/g;

export interface Hit {
  name: string;
  start: number;
  end: number;
  /** 原始形态：true = `{{@name}}`；false = `@name` */
  braced: boolean;
}

/** 命令里出现的、已登记的占位符（按位置排序）。未登记的 `@xxx` 不算。 */
export function findPlaceholders(
  command: string,
  known: ReadonlySet<string>,
): Hit[] {
  const hits: Hit[] = [];
  for (const m of command.matchAll(PLACEHOLDER_BARE)) {
    const name = m[1] as string;
    // `{{@name}}` 与转义的 `\{{@name}}` 里的 @name 不按旧形态算：前者归新形态，后者是字面量。
    if (command.slice(Math.max(0, m.index - 2), m.index) === "{{") continue;
    if (known.has(name))
      hits.push({
        name,
        start: m.index,
        end: m.index + m[0].length,
        braced: false,
      });
  }
  for (const m of command.matchAll(PLACEHOLDER_NEW)) {
    const name = m[1] as string;
    if (known.has(name))
      hits.push({
        name,
        start: m.index,
        end: m.index + m[0].length,
        braced: true,
      });
  }
  // 被转义的新形态（`\{{@`）是字面量，不算占位符；bash 自己会把 `\{` 还原成 `{`，无需改写。
  const esc = new Set(
    [...command.matchAll(PLACEHOLDER_ESCAPED)].map((m) => m.index),
  );
  return hits
    .filter((h) => !(h.braced && esc.has(h.start - 1)))
    .sort((a, b) => a.start - b.start);
}

type Ctx = "plain" | "double" | "single" | "heredoc" | "comment";

// 自占位符位置向上找最近的引号环境；$(...) 里重新回到无引号。
function contextAt(root: Node, index: number): Ctx {
  for (let n = root.descendantForIndex(index); n; n = n.parent) {
    switch (n.type) {
      case "raw_string":
      case "ansi_c_string":
        return "single";
      case "string":
        return "double";
      case "heredoc_body":
        return "heredoc";
      case "comment":
        return "comment";
      case "command_substitution":
      case "process_substitution":
        return "plain";
    }
  }
  return "plain";
}

/**
 * 把已登记的占位符改写成 `"${YUANSHU_VAR_name}"`（按所处引号环境调整），
 * 并给出需要注入该进程的环境变量。注释里的占位符不动。
 * braced 形态(`{{@name}}`)的替换位置更长,但生成的环境变量引用相同。
 */
export async function substitute(
  command: string,
  values: ReadonlyMap<string, string>,
): Promise<{ command: string; env: Record<string, string> }> {
  const hits = findPlaceholders(command, new Set(values.keys()));
  if (hits.length === 0) return { command, env: {} };
  const tree = (await getParser()).parse(command);
  if (!tree) throw new Error("命令解析失败，无法替换隐私变量");
  try {
    const env: Record<string, string> = {};
    let out = command;
    // 从后往前改，前面的下标不受影响。
    for (const h of hits.reverse()) {
      const key = envKey(h.name);
      const ref = `\${${key}}`;
      const ctx = contextAt(tree.rootNode, h.start);
      if (ctx === "comment") continue;
      env[key] = values.get(h.name) as string;
      const text =
        ctx === "plain" ? `"${ref}"` : ctx === "single" ? `'"${ref}"'` : ref;
      out = out.slice(0, h.start) + text + out.slice(h.end);
    }
    return { command: out, env };
  } finally {
    tree.delete();
  }
}
