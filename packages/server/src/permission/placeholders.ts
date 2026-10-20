// 隐私变量占位符（ADR-0051）：识别命令里的 `@name`，改写成对环境变量的引用。
// 值本身从不拼进命令文本，所以值里的引号、$、换行都无法注入或破坏命令。
import type { Node } from "web-tree-sitter";
import { getParser } from "./bash.js";

export const ENV_PREFIX = "YUANSHU_VAR_";

// 前面不能是单词字符或 @ . \ $ / -（邮箱、路径、转义、$@）；
// 后面不能接 / 或 .x -x（@scope/pkg、@a.example.com）。名字取最长匹配，再按登记表精确查。
const PLACEHOLDER =
  /(?<![\w@.\\$/-])@([A-Za-z][A-Za-z0-9_]{0,63})(?![\w/]|[.-][A-Za-z0-9])/g;

export interface Hit {
  name: string;
  start: number;
  end: number;
}

/** 命令里出现的、已登记的占位符（按位置排序）。未登记的 `@xxx` 不算。 */
export function findPlaceholders(
  command: string,
  known: ReadonlySet<string>,
): Hit[] {
  const hits: Hit[] = [];
  for (const m of command.matchAll(PLACEHOLDER)) {
    const name = m[1] as string;
    if (known.has(name))
      hits.push({ name, start: m.index, end: m.index + m[0].length });
  }
  return hits;
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
      const ref = `\${${ENV_PREFIX}${h.name}}`;
      const ctx = contextAt(tree.rootNode, h.start);
      if (ctx === "comment") continue;
      env[`${ENV_PREFIX}${h.name}`] = values.get(h.name) as string;
      const text =
        ctx === "plain" ? `"${ref}"` : ctx === "single" ? `'"${ref}"'` : ref;
      out = out.slice(0, h.start) + text + out.slice(h.end);
    }
    return { command: out, env };
  } finally {
    tree.delete();
  }
}
