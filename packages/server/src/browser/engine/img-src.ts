// 快照里 img 节点的地址：引擎的 ariaSnapshot 只给链接写 `/url` 子行，图片没有任何地址，
// 懒加载页面里 agent 看不出图片此刻是占位图还是真图。这里只做纯文本处理（认编号、写地址行），
// 读页面里的地址在 page.ts。

/** 名字用引号包住（内部引号是 \" 转义）：名字里恰好写着 `[ref=e9]` 时，那不是这一行的编号。 */
const NAME_RE = /^\s*"((?:[^"\\]|\\.)*)"/;

/** 这一行是带编号的 img 节点时给出编号，其余（`image`、`imgx`、没有编号、别的角色）都给 null。 */
function imgRefOf(line: string): string | null {
  const head = /^\s*- (\S+)/.exec(line);
  if (head === null || head[1] !== "img") return null;
  let rest = line.slice(head[0].length);
  const name = NAME_RE.exec(rest);
  if (name) rest = rest.slice(name[0].length);
  return /\[ref=([^\]\s]+)\]/.exec(rest)?.[1] ?? null;
}

/** 快照原文里带编号的 img 节点的编号（按出现顺序）；角色必须正好是 img。 */
export function imageRefs(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const ref = imgRefOf(line);
    if (ref !== null) out.push(ref);
  }
  return out;
}

/** 页面里读到的地址 → 快照里写的样子：普通地址原样；data: 地址只写 mime 与原串长度，不写 base64。 */
export function describeSrc(src: string): string {
  if (!src.startsWith("data:")) return src;
  const mime = /^data:([^;,]*)/.exec(src)?.[1] ?? "";
  return `data:${mime} (${src.length} chars)`;
}

/**
 * 把地址写回快照：每个有地址的 img 节点后面插一行 `- /src: <地址>`（比 img 行深两格，与链接的
 * `/url` 子行同形）；img 行末尾没有冒号的补上（它现在有孩子了）。没有地址的节点原样不动。
 * srcs 的值是快照里要写的样子（data: 地址已由 describeSrc 描述过）。
 */
export function injectImageSources(
  raw: string,
  srcs: ReadonlyMap<string, string>,
): string {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const ref = imgRefOf(line);
    const src = (ref === null ? undefined : srcs.get(ref)) ?? "";
    if (!src) {
      out.push(line);
      continue;
    }
    out.push(line.endsWith(":") ? line : `${line}:`);
    const indent = /^(\s*)/.exec(line)?.[1] ?? "";
    out.push(`${indent}  - /src: ${src}`);
  }
  return out.join("\n");
}
