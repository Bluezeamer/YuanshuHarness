// ariaSnapshot 文本与节点树之间的转换：清洗层其余模块只处理这棵树，不直接加工文本。
// 解析必须无损：认不得的行原样当普通节点留下，节点的 text 就是原始行。

export interface SnapNode {
  /** 原始行（不含缩进与前导 "- "） */
  text: string;
  /** 角色：行首第一个词，如 button / link / textbox / generic / paragraph / heading … */
  role: string;
  /** 元素编号，如 "e12"、"f1e3"；没有编号的节点为 null */
  ref: string | null;
  /** 带 [disabled] / [hidden] 之类标记 */
  flags: Set<string>;
  children: SnapNode[];
}

const REF_RE = /\[ref=([^\]]+)\]/;
const META_RE = /\[[^\]]*\]/g;
// 名字用引号包住，内部的引号是 \" 转义（实测 Chromium 的 ariaSnapshot 如此）。
const NAME_RE = /^\s*['"`]?\S+\s+"((?:[^"\\]|\\.)*)"/;
const TRAIL_RE = /^['"]?:\s?([\s\S]*)$/;

/** 行首第一个词去引号、去结尾冒号后当角色；认不出的行拿第一个词，拿不到就空串。 */
function roleOf(text: string): string {
  const token = text.split(/\s+/, 1)[0] ?? "";
  return token.replace(/^['"`]+/, "").replace(/:$/, "");
}

/**
 * 头部是角色 + 名字 + 紧跟着的 `[..]` 标记。标记只在名字之后、值与正文之前认：
 * 名字、值、正文里恰好写着 `[hidden]`、`[ref=e9]` 之类的字，都不能当成节点的标记。
 * marks 是标记区的起止，end 是头部的终点。
 */
function headSpan(text: string): { marks: [number, number]; end: number } {
  const first = /^\S+/.exec(text)?.[0] ?? "";
  // 带值的形式（`text: 正文`、`/url: /x`）：角色后面直接是值，没有名字与标记。
  if (first.endsWith(":"))
    return { marks: [first.length, first.length], end: first.length };
  let start = first.length;
  const name = NAME_RE.exec(text);
  if (name) start = Math.max(start, (name.index ?? 0) + name[0].length);
  const end =
    start + (/^(?:\s*\[[^\]]*\])*/.exec(text.slice(start))?.[0].length ?? 0);
  return { marks: [start, end], end };
}

function makeNode(text: string): SnapNode {
  const span = headSpan(text);
  const marks = text.slice(...span.marks);
  const flags = new Set<string>();
  for (const m of marks.matchAll(META_RE)) {
    const v = m[0].slice(1, -1);
    if (!v.startsWith("ref=")) flags.add(v);
  }
  return {
    text,
    role: roleOf(text),
    ref: REF_RE.exec(marks)?.[1] ?? null,
    flags,
    children: [],
  };
}

export function parseSnapshot(raw: string): SnapNode[] {
  const roots: SnapNode[] = [];
  // 缩进两级一层；层级跳变（深层直接接在浅层后）靠弹栈兜住。
  const stack: { level: number; node: SnapNode }[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed.trim()) continue;
    const level = Math.floor((trimmed.length - trimmed.trimStart().length) / 2);
    const node = makeNode(trimmed.trimStart().replace(/^- /, ""));
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level)
      stack.pop();
    const parent = stack[stack.length - 1]?.node;
    (parent ? parent.children : roots).push(node);
    stack.push({ level, node });
  }
  return roots;
}

/** 元素名字：角色后第一个被引号包住的串；属性行（`/url: …`）没有名字。 */
export function nodeName(node: SnapNode): string {
  return NAME_RE.exec(node.text)?.[1] ?? "";
}

/** 拆成「角色 + 名字 + 各个 [..] 标记」与行尾的文字，文字没有就空串。 */
export function splitLine(text: string): { head: string; body: string } {
  const first = /^\S+/.exec(text)?.[0] ?? "";
  // 角色行带值的形式（`text: 正文`、`/url: /x`）：值在角色后面，不包引号。
  if (first.endsWith(":"))
    return { head: first.slice(0, -1), body: text.slice(first.length).trim() };
  const { end } = headSpan(text);
  const body = TRAIL_RE.exec(text.slice(end))?.[1]?.trim() ?? "";
  return { head: body ? text.slice(0, end) : text, body };
}

/** 表单控件的值：引擎把像数字的值写成 YAML 引号串（`: "2"`），读成值时去掉这层引号。 */
export function fieldValue(body: string): string {
  if (!/^"(?:[^"\\]|\\.)*"$/.test(body)) return body;
  try {
    return JSON.parse(body) as string;
  } catch {
    return body;
  }
}

/** 行尾的文字部分：表单值、正文、状态这类。 */
export function nodeText(node: SnapNode): string {
  return splitLine(node.text).body;
}
