// diff 用的树（设计稿 §8.2）：原始快照 → 每个有内容的节点一个 DNode，带条目、对齐签名与子树条目数。
// 「哪些节点算一个元素」与身份的写法都收在这里，对齐与渲染只看这棵树。
import {
  fieldValue,
  nodeName,
  parseSnapshot,
  type SnapNode,
  splitLine,
} from "./parse.js";
import { FIELD_ROLES, INTERACTIVE_ROLES } from "./roles.js";

export interface DiffItem {
  kind: "ctl" | "txt";
  role: string;
  /** ctl：名字（无名则取第一个有名字的子孙 / 第一段文字）；txt：文字内容 */
  label: string;
  /** 元素编号，没有就 null */
  ref: string | null;
  /** link 的目标 / img 的地址（原样，不改写） */
  url: string | null;
  /** 表单控件的当前值，没有就空串 */
  value: string;
  /** checked / pressed / expanded / selected / disabled */
  states: string[];
  key: string;
}

export interface DNode {
  /** 自己的条目；纯容器（list、listitem、没有文字的 generic、main …）是 null */
  item: DiffItem | null;
  role: string;
  children: DNode[];
  /** 对齐用的签名：有条目就是自己的 key，纯容器是「角色 + 前两个后代 key」 */
  sig: string;
  /** 子树里（含自己）条目的个数 */
  elements: number;
}

/** 单独比较的五个状态标记。 */
const STATE_FLAGS = ["checked", "pressed", "expanded", "selected", "disabled"];
/** 文字写在名字里的角色（没有行尾正文时用名字当文字）：标题、告警、表格单元、generic… */
const NAME_IS_TEXT: ReadonlySet<string> = new Set([
  "heading",
  "alert",
  "status",
  "paragraph",
  "text",
  "dialog",
  "tooltip",
  "cell",
  "listitem",
  "generic",
]);
/** 只过滤纯标点 / 符号 / 空白；短文字（「A」「B」）照样参与比较。 */
const ONLY_MARKS = /^[\p{P}\p{S}\s]+$/u;
/** 签名里每个后代 key 保留多少字符：容器靠前两个后代区分，长的部分对对齐没用。 */
const SIG_KEY_MAX = 80;

const bodyOf = (n: SnapNode): string => splitLine(n.text).body;

/** 地址子行：链接的 `/url`、图片的 `/src`（机械层才并进元素行，原始快照里是子行）。 */
const ADDRESS_ROLES: ReadonlySet<string> = new Set(["/url", "/src"]);

const urlOf = (n: SnapNode): string | null => {
  const u = n.children.find((c) => ADDRESS_ROLES.has(c.role));
  return u ? bodyOf(u) : null;
};

/** 带地址的图片：只有原始快照里写了 `/src` 的才算（没有地址的 img 不进 diff）。 */
const IMG = "img";
const isSourcedImage = (n: SnapNode): boolean =>
  n.role === IMG && n.children.some((c) => c.role === "/src");

/** 身份里的链接目标：忽略查询串与片段，只改 `?x=1#y` 不算新增。 */
const pathOf = (url: string | null): string =>
  (url ?? "").replace(/[?#][\s\S]*$/, "");

/** 无名控件的名字：预序里第一个有名字的子孙，再退到第一段文字；都没有就是空串。 */
export function borrowName(n: SnapNode): string {
  const find = (ns: SnapNode[], pick: (c: SnapNode) => string): string => {
    for (const c of ns) {
      const v = pick(c);
      if (v) return v;
      const deep = find(c.children, pick);
      if (deep) return deep;
    }
    return "";
  };
  return (
    find(n.children, (c) => nodeName(c)) ||
    find(n.children, (c) => (c.role === "text" ? bodyOf(c) : ""))
  );
}

/** 单个节点自己是不是条目：控件一类，有文字的节点（含 generic）一类；带地址的图片也算控件那一类。 */
function itemOf(n: SnapNode): DiffItem | null {
  const name = nodeName(n);
  const body = bodyOf(n);
  const states = STATE_FLAGS.filter((s) => n.flags.has(s));
  if (INTERACTIVE_ROLES.has(n.role)) {
    const url = urlOf(n);
    const label = name || borrowName(n);
    return {
      kind: "ctl",
      role: n.role,
      label,
      ref: n.ref,
      url,
      // 值只对表单控件有意义；其他角色行尾的文字不是它的值。
      value: FIELD_ROLES.has(n.role) ? fieldValue(body) : "",
      states,
      key: `${n.role}|${label}|${n.role === "link" ? pathOf(url) : ""}`,
    };
  }
  if (isSourcedImage(n)) {
    // 有名字的图片身份是 alt：换了 src 算变化而不是「消失 + 新增」（地址进「地址」那一栏）。
    // 无名的图片（占位图、装饰图）只有地址能区分，以地址为身份：换了 src 就是消失 + 新增。
    const url = urlOf(n);
    return {
      kind: "ctl",
      role: n.role,
      label: name,
      ref: n.ref,
      url,
      value: "",
      states,
      key: `${n.role}|${name}|${name ? "" : url}`,
    };
  }
  // 有文字的节点都算（含 generic、行内记号）：正文优先；没有正文时只有上面那几个
  // 角色用名字（`nav "Menu"` 这种名字不是页面上的文字，img 的 alt 也不是）。
  const text = body || (NAME_IS_TEXT.has(n.role) ? name : "");
  if (text.trim() && !ONLY_MARKS.test(text.trim()))
    return {
      kind: "txt",
      role: n.role,
      label: text,
      ref: n.ref,
      url: null,
      value: "",
      states: [],
      key: `${n.role}|${text}`,
    };
  return null;
}

/**
 * generic 且没有自己条目：一层透明的包装。渲染不写它的头、不缩进；
 * 对不上的缺口里先把它拆开再对齐（引擎的快照会把只剩一个孩子的 generic 折叠掉，包装层时有时无）。
 */
export const transparent = (n: DNode): boolean =>
  n.role === "generic" && n.item === null;

/** 建树时的中间结果：node 之外带着子树前两个条目的 key，供父节点算签名（每个节点只算一次）。 */
interface Built {
  node: DNode;
  head: string[];
}

/**
 * 原始快照 → 树。跳过 `/url`、`/src` 子行（地址并进了元素行），
 * 自己和子树里都没有条目的节点不建（不留空壳）。
 */
export function buildTree(raw: string): DNode[] {
  const walk = (n: SnapNode): Built | null => {
    // 地址子行并进了元素行，两边都不建
    if (ADDRESS_ROLES.has(n.role)) return null;
    const item = itemOf(n);
    const kids: Built[] = [];
    for (const c of n.children) {
      const b = walk(c);
      if (b !== null) kids.push(b);
    }
    const elements =
      (item ? 1 : 0) + kids.reduce((s, k) => s + k.node.elements, 0);
    if (elements === 0) return null;
    // 预序前两个条目：自己有就是自己，否则按子节点顺序接。
    const head = (item ? [item.key] : kids.flatMap((k) => k.head)).slice(0, 2);
    const sig = item
      ? item.key
      : `${n.role}|${head.map((k) => k.slice(0, SIG_KEY_MAX)).join(" ¦ ")}`;
    return {
      node: {
        item,
        role: n.role,
        children: kids.map((k) => k.node),
        sig,
        elements,
      },
      head,
    };
  };
  const roots: DNode[] = [];
  for (const n of parseSnapshot(raw)) {
    const b = walk(n);
    if (b !== null) roots.push(b.node);
  }
  return roots;
}
