// 页面原始 DOM 的确定性读取（browser_dom 的下层）：按选择器 / 快照编号 / 整个文档读一棵规整过的树。
// 规整全部在页面里做（截断、省略孩子、节点上限），只把纯数据带回来；只有这个文件和 page.ts 碰 Playwright。
import type { Frame, Page } from "playwright-core";
import { needRef, STALE } from "./ref.js";
import type {
  DomAttr,
  DomCapture,
  DomElement,
  DomGroup,
  DomTarget,
  DomText,
} from "./types.js";

// 一次读的上限：命中数（每个 frame 各取前这么多个）、节点数（每个 frame 各计）、递归深度、文本与属性值的截断长度。
const MAX_MATCHES = 200;
const MAX_NODES = 20_000;
const MAX_DEPTH = 200;
const MAX_TEXT = 2_000;
const MAX_ATTR = 4_000;
const ACTION_TIMEOUT_MS = 5_000;
// Playwright 解析选择器失败的特征；其余错误（frame 刚被摘掉等）不是 agent 的错。
const SELECTOR_ERROR =
  /while parsing (?:css )?selector|is not a valid selector/i;

/** 页面函数拿不到模块作用域，上限经参数交进去。 */
interface DomLimits {
  maxMatches: number;
  maxNodes: number;
  maxDepth: number;
  textMax: number;
  attrMax: number;
}

const LIMITS: DomLimits = {
  maxMatches: MAX_MATCHES,
  maxNodes: MAX_NODES,
  maxDepth: MAX_DEPTH,
  textMax: MAX_TEXT,
  attrMax: MAX_ATTR,
};

// 浏览器里的 DOM 形状（server 的 tsconfig 不含 dom 库）。
interface DomNode {
  nodeType: number;
  nodeValue: string | null;
  textContent: string | null;
  tagName: string;
  attributes: ArrayLike<{ name: string; value: string }>;
  childNodes: ArrayLike<DomNode>;
  shadowRoot: { childNodes: ArrayLike<DomNode> } | null;
  ownerDocument: { baseURI: string } | null;
  currentSrc?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  getBoundingClientRect(): {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  querySelectorAll(selectors: string): ArrayLike<DomNode>;
}

/** 页面函数的返回：total 是匹配总数（roots 只含前 maxMatches 个）。 */
interface DomReadResult {
  total: number;
  roots: DomElement[];
  nodeCapHit: boolean;
}

/**
 * 在页面里读一个元素 / 一组元素（会被序列化进浏览器执行，只能引用 DOM 与自己的参数）。
 * 单个元素（ref、整个文档）与 evaluateAll 的数组共用这一份：按 Array.isArray 区分。
 * 返回的是 JSON 串：Playwright 自己的序列化器对嵌套深度有上限（约 60 层），深页面直接交树
 * 会报 `object reference chain is too long`，成串回来再解析就没有这个限制。
 */
function serializeDom(input: DomNode | DomNode[], limits: DomLimits): string {
  const list: DomNode[] = Array.isArray(input) ? input : [input];
  let nodes = 0;
  // 节点上限触发：不再往下读（已经读到的保留）。
  let stopped = false;
  let capHit = false;

  /** 占一个节点额度；超了就置位并让调用方停下。 */
  const take = (): boolean => {
    if (nodes >= limits.maxNodes) {
      stopped = true;
      capHit = true;
      return false;
    }
    nodes += 1;
    return true;
  };

  const clip = (value: string, max: number): string =>
    value.length > max ? value.slice(0, max) : value;

  const attrValue = (el: DomNode, name: string): string | null => {
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      if (a?.name === name) return a.value;
    }
    return null;
  };

  /** src 属性按文档 baseURI 解析后的地址；没有 src 属性是空串。 */
  const resolvedSrc = (el: DomNode): string => {
    const raw = attrValue(el, "src");
    if (raw === null) return "";
    try {
      return new URL(raw, el.ownerDocument?.baseURI ?? "").href;
    } catch {
      return raw;
    }
  };

  const readAttrs = (el: DomNode): DomAttr[] => {
    const out: DomAttr[] = [];
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      if (!a) continue;
      out.push({
        name: a.name,
        value: clip(a.value, limits.attrMax),
        length: a.value.length,
      });
    }
    return out;
  };

  const readText = (value: string): DomText | null => {
    const text = value.replace(/\s+/g, " ").trim();
    if (text === "") return null;
    return { text: clip(text, limits.textMax), length: text.length };
  };

  const readNodes = (
    children: ArrayLike<DomNode>,
    depth: number,
  ): (DomElement | DomText)[] => {
    const out: (DomElement | DomText)[] = [];
    for (let i = 0; i < children.length; i++) {
      if (stopped) break;
      const node = children[i];
      if (!node) continue;
      if (node.nodeType === 1) {
        const el = readElement(node, depth, false);
        if (el) out.push(el);
      } else if (node.nodeType === 3) {
        if (!take()) break;
        const text = readText(node.nodeValue ?? "");
        if (text) out.push(text);
      }
    }
    return out;
  };

  const readElement = (
    el: DomNode,
    depth: number,
    root: boolean,
  ): DomElement | null => {
    if (!take()) return null;
    const tag = el.tagName.toLowerCase();
    const out: DomElement = { tag, attrs: readAttrs(el), kids: [] };
    if (root) {
      const r = el.getBoundingClientRect();
      out.box = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    }
    if (tag === "img")
      out.natural = {
        width: el.naturalWidth ?? 0,
        height: el.naturalHeight ?? 0,
      };
    if (tag === "img" || tag === "video" || tag === "audio") {
      const current = el.currentSrc ?? "";
      if (current !== "" && current !== resolvedSrc(el))
        out.currentSrc = current;
    }
    if (tag === "script") {
      // 外链脚本没有正文可省；行内脚本只说长度，不把代码带回来。
      if (attrValue(el, "src") === null)
        out.summary = `inline script, ${(el.textContent ?? "").length} chars`;
    } else if (tag === "style") {
      out.summary = `${(el.textContent ?? "").length} chars`;
    } else if (tag === "svg") {
      out.summary = `svg: ${el.querySelectorAll("*").length} elements`;
    } else if (tag === "template") {
      out.summary = "template content";
    } else if (depth >= limits.maxDepth) {
      out.summary = "depth limit";
    } else {
      out.kids = readNodes(el.childNodes, depth + 1);
      const shadow = el.shadowRoot;
      if (shadow && !stopped)
        out.shadow = readNodes(shadow.childNodes, depth + 1);
    }
    return out;
  };

  const roots: DomElement[] = [];
  for (const el of list.slice(0, limits.maxMatches)) {
    if (stopped) break;
    const root = readElement(el, 0, true);
    if (root) roots.push(root);
  }
  const result: DomReadResult = {
    total: list.length,
    roots,
    nodeCapHit: capHit,
  };
  return JSON.stringify(result);
}

/** 页面交回来的 JSON 串 → 结果。 */
function parseRead(json: string): DomReadResult {
  return JSON.parse(json) as DomReadResult;
}

function firstLine(m: string): string {
  return (
    m
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? m
  );
}

/** 在一个 frame 里按选择器读；0 命中返回 null，frame 刚被摘掉也当作这个 frame 没命中。 */
async function readSelectorFrame(
  frame: Frame,
  selector: string,
): Promise<DomReadResult | null> {
  try {
    const read = parseRead(
      await frame.locator(selector).evaluateAll(serializeDom, LIMITS),
    );
    return read.total === 0 ? null : read;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (SELECTOR_ERROR.test(msg))
      throw new Error(`选择器无法解析：${firstLine(msg)}`);
    return null;
  }
}

/** 按目标读页面 DOM：selector 每个 frame 各查一遍，ref 读该元素的子树，null 读整个文档。 */
export async function readDom(
  page: Page,
  target: DomTarget,
): Promise<DomCapture> {
  if (target === null) {
    const read = parseRead(
      await page
        .locator("html")
        .evaluate(serializeDom, LIMITS, { timeout: ACTION_TIMEOUT_MS }),
    );
    return {
      groups: [
        { frame: { url: page.url(), main: true }, total: 1, roots: read.roots },
      ],
      nodeCapHit: read.nodeCapHit,
    };
  }
  if ("ref" in target) {
    needRef(target.ref);
    const locator = page.locator(`aria-ref=${target.ref}`);
    if ((await locator.count()) === 0) throw new Error(STALE);
    const read = parseRead(
      await locator.evaluate(serializeDom, LIMITS, {
        timeout: ACTION_TIMEOUT_MS,
      }),
    );
    // 元素所在的 frame：iframe 里的编号（f1e3）要说明是哪个 frame。
    const frame = await (
      await locator.elementHandle({ timeout: ACTION_TIMEOUT_MS })
    )?.ownerFrame();
    return {
      groups: [
        {
          frame: {
            url: frame?.url() ?? page.url(),
            main: frame === page.mainFrame(),
          },
          total: 1,
          roots: read.roots,
        },
      ],
      nodeCapHit: read.nodeCapHit,
    };
  }
  const groups: DomGroup[] = [];
  let nodeCapHit = false;
  const main = page.mainFrame();
  // 主 frame 在前（page.frames() 的顺序）。
  for (const frame of page.frames()) {
    const read = await readSelectorFrame(frame, target.selector);
    if (read === null) continue;
    nodeCapHit = nodeCapHit || read.nodeCapHit;
    groups.push({
      frame: { url: frame.url(), main: frame === main },
      total: read.total,
      roots: read.roots,
    });
  }
  return { groups, nodeCapHit };
}
