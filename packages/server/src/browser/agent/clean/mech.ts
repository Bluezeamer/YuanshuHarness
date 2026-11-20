// 机械层（设计稿 §4）：对引擎的 ariaSnapshot 原文做无损、确定性的改写。
// 消掉可点元素上冗余的游标、链接的 `/url` 与图片的 `/src` 子行，同源地址写成根相对路径，
// 空壳 generic 折叠，整段行内正文并成一行。其余一律原样：状态标记、表格结构、编号都留着。
import { nodeName, parseSnapshot, type SnapNode, splitLine } from "./parse.js";
import { INTERACTIVE_ROLES } from "./roles.js";

/** 行内渲染认得的角色：这些节点能安全地压成一行文字。 */
const INLINE_ROLES: ReadonlySet<string> = new Set([
  "text",
  "link",
  "strong",
  "emphasis",
  "code",
  "time",
  "generic",
  "img",
  "superscript",
  "subscript",
  "mark",
  "deletion",
  "insertion",
  "abbr",
]);

/** 行内记号：角色 → 两侧包住的记号。 */
const MARKS: Record<string, string> = {
  code: "`",
  emphasis: "*",
  strong: "**",
  deletion: "~~",
};

const bodyOf = (n: SnapNode): string => splitLine(n.text).body;

/** 地址子行：链接的 `/url`、图片的 `/src`，机械层把它们并进元素行。 */
const ADDRESS_ROLES: ReadonlySet<string> = new Set(["/url", "/src"]);

const urlOf = (n: SnapNode): string | null => {
  const u = n.children.find((c) => ADDRESS_ROLES.has(c.role));
  return u ? bodyOf(u) : null;
};

/** 去掉地址子行的孩子：它们已经并进元素行了。 */
const kidsOf = (n: SnapNode): SnapNode[] =>
  n.children.filter((c) => !ADDRESS_ROLES.has(c.role));

/** 无名、无文字、不可点的空壳：折掉它不丢信息。 */
const nameless = (n: SnapNode): boolean =>
  n.role === "generic" &&
  !nodeName(n) &&
  !bodyOf(n) &&
  !n.flags.has("cursor=pointer");

/** 同源绝对地址写成根相对路径（页面源在 PAGE: 行里，可还原），其余原样。 */
export function fixUrl(url: string | null, origin: string): string | null {
  if (url === null || !url.startsWith(`${origin}/`)) return url;
  return url.slice(origin.length);
}

/** 节点行头：角色 + 名字 + 保留下来的标记；去掉可点元素上的游标、空壳的编号。 */
function head(n: SnapNode): string {
  let h = splitLine(n.text).head.replace(/:$/, "");
  if (
    (n.role === "link" || n.role === "button") &&
    n.flags.has("cursor=pointer")
  )
    h = h.replace(/ \[cursor=pointer\]/g, "");
  // 空壳 generic 不是投影的目标，编号去掉；有名字、有文字的 generic 与其余角色的编号留着
  // （截图、滚动到元素都可能指向它们）。
  if (n.ref !== null && nameless(n)) h = h.replace(/ \[ref=[^\]]*\]/g, "");
  return h;
}

/** 纯行内渲染成文字；遇到会丢信息的（名字 + 孩子、time、带标记）返回 null。 */
function inline(n: SnapNode, origin: string): string | null {
  const body = bodyOf(n);
  if (n.role === "text") return body;
  if (!INLINE_ROLES.has(n.role)) return null;
  // time 与带标记的节点不并：标记里是状态，压成文字就丢了。
  if (n.role === "time" || [...n.flags].some((f) => f !== "cursor=pointer"))
    return null;
  const kids = kidsOf(n).map((c) => inline(c, origin));
  if (kids.some((x) => x === null)) return null;
  if (n.role === "link") {
    const name = nodeName(n) || kids.join(" ");
    // 行内链接的方括号要转义，免得和 markdown 记号混起来。
    const shown = /[[\]]/.test(name) ? name.replace(/([[\]])/g, "\\$1") : name;
    const ref = n.ref ? `{${n.ref}}` : "";
    return `[${shown}](${fixUrl(urlOf(n), origin) ?? ""})${ref}`;
  }
  const name = nodeName(n);
  // 名字与孩子同时存在（带 title 的 span、带精确时间戳的 time）：行内化会丢名字。
  if (name && kids.length > 0) return null;
  const inner = [name && kids.length === 0 ? name : "", body, ...kids]
    .filter(Boolean)
    .join(" ");
  // 行内图片：有地址时与行内链接同形、编号写在花括号里；没有地址时一字不动，真实页面基线才不变。
  if (n.role === "img" && urlOf(n) !== null) {
    const ref = n.ref ? `{${n.ref}}` : "";
    return `![${inner}](${fixUrl(urlOf(n), origin)})${ref}`;
  }
  const mark = MARKS[n.role];
  if (mark) return `${mark}${inner}${mark}`;
  if (n.role === "superscript") return `^${inner}`;
  if (n.role === "subscript") return `_${inner}`;
  if (n.role === "img") return `![${inner}]`;
  return inner;
}

function render(
  n: SnapNode,
  depth: number,
  out: string[],
  siblings: number,
  origin: string,
): void {
  if (n.role === "/url" || n.role === "/src") return;
  const kids = kidsOf(n);
  const pad = "  ".repeat(depth);
  /** 整段行内正文并成一行；有一个孩子不满足行内条件就返回 null。 */
  const proseOf = (): string | null => {
    if (
      kids.length === 0 ||
      INTERACTIVE_ROLES.has(n.role) ||
      n.role === "text" ||
      !kids.some((c) => c.role === "text")
    )
      return null;
    const parts = kids.map((c) => inline(c, origin));
    return parts.some((x) => x === null)
      ? null
      : [bodyOf(n), ...parts].filter(Boolean).join(" ");
  };
  if (nameless(n) && kids.length > 0) {
    const prose = proseOf();
    if (prose !== null) {
      out.push(`${pad}- text: ${prose}`);
      return;
    }
    // 唯一子节点就地替换；是父节点唯一孩子时把孩子上提（成组关系不变）。
    if (kids.length === 1) {
      render(kids[0] as SnapNode, depth, out, siblings, origin);
      return;
    }
    if (siblings === 0) {
      for (const c of kids) render(c, depth, out, kids.length - 1, origin);
      return;
    }
  }
  const prose = proseOf();
  if (prose !== null) {
    out.push(`${pad}- ${head(n)}: ${prose}`);
    return;
  }
  const url = urlOf(n);
  const body = bodyOf(n);
  // 链接与图片都把地址写在行尾（`→ 目标` / `→ 地址`）。
  const inlineUrl = (n.role === "link" || n.role === "img") && url !== null;
  let line = `${pad}- ${head(n)}`;
  if (inlineUrl) line += ` → ${fixUrl(url, origin)}`;
  if (body) line += `: ${body}`;
  else if (kids.length > 0 || (url !== null && !inlineUrl)) line += ":";
  out.push(line);
  if (url !== null && !inlineUrl)
    out.push(
      `${pad}  - ${n.children.find((c) => ADDRESS_ROLES.has(c.role))?.role}: ${fixUrl(url, origin)}`,
    );
  for (const c of kids) render(c, depth + 1, out, kids.length - 1, origin);
}

/**
 * 机械层（设计稿 §4）：无损、确定性。raw 是引擎的 ariaSnapshot（ai 模式）原文，
 * origin 是页面的 origin（如 "https://lobste.rs"），同源的绝对地址改写成根相对路径。
 */
export function mechanical(raw: string, origin: string): string {
  const roots = parseSnapshot(raw);
  const out: string[] = [];
  for (const r of roots) render(r, 0, out, roots.length - 1, origin);
  return out.join("\n");
}
