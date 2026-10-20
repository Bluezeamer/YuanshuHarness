// 页面快照：在页面里收集可交互元素并编号，格式化成给模型看的文本。
// 元素引用存在页面全局数组里（不改 DOM），编号 = 数组下标 + 1，每次快照重建。

export const ITEMS_MAX = 200;
export const TEXT_MAX = 8000;
export const TYPE_MAX = 2000;

export interface SnapItem {
  ref: number;
  tag: string;
  role: string | null;
  type: string | null;
  text: string;
  href: string | null;
  value: string | null;
  checked: boolean | null;
  disabled: boolean;
}

export interface RawSnapshot {
  url: string;
  title: string;
  items: SnapItem[];
  text: string;
}

// 在页面里执行的表达式（字符串形式：Server 的 tsconfig 没有 DOM 类型）。
export const COLLECT_SCRIPT = `(() => {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[onclick],[contenteditable=""],[contenteditable="true"]';
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const els = [];
  const seen = new Set();
  for (const e of document.querySelectorAll(SEL)) {
    if (els.length >= ${ITEMS_MAX}) break;
    if (!seen.has(e) && vis(e)) { seen.add(e); els.push(e); }
  }
  window.__yuanshuRefs = els;
  const clip = (s, n) => String(s || '').trim().replace(/\\s+/g, ' ').slice(0, n);
  const items = els.map((e, i) => {
    const tag = e.tagName.toLowerCase();
    const type = tag === 'input' ? (e.type || 'text') : null;
    const secret = type === 'password';
    return {
      ref: i + 1,
      tag,
      role: e.getAttribute('role'),
      type,
      text: clip(e.getAttribute('aria-label') || e.innerText || e.placeholder || e.title || e.alt || (type === 'submit' || type === 'button' ? e.value : ''), 80),
      href: tag === 'a' ? e.href : null,
      // 密码框的内容不外带
      value: (tag === 'input' || tag === 'textarea' || tag === 'select') && !secret ? clip(e.value, 80) : null,
      checked: type === 'checkbox' || type === 'radio' ? e.checked : null,
      disabled: !!e.disabled,
    };
  });
  return {
    url: location.href,
    title: document.title,
    items,
    text: clip(document.body ? document.body.innerText : '', ${TEXT_MAX}),
  };
})()`;

// 取第 ref 个元素（1 起）的表达式；ref 必须先校验为整数。
export const refExpr = (ref: number): string =>
  `(window.__yuanshuRefs && window.__yuanshuRefs[${ref - 1}]) || null`;

// 聚焦并选中已有内容，之后键入会替换它。
export const focusScript = (ref: number): string => `(() => {
  const n = ${refExpr(ref)};
  if (!n) return false;
  n.scrollIntoView({ block: 'center' });
  n.focus();
  if (typeof n.select === 'function') n.select();
  else if (n.isContentEditable) getSelection().selectAllChildren(n);
  return true;
})()`;

const KIND: Record<string, string> = {
  a: "链接",
  button: "按钮",
  select: "下拉框",
  textarea: "文本框",
  summary: "折叠项",
};

function describe(i: SnapItem): string {
  const kind =
    i.tag === "input"
      ? i.type === "checkbox"
        ? "复选框"
        : i.type === "radio"
          ? "单选框"
          : i.type === "submit" || i.type === "button"
            ? "按钮"
            : `输入框(${i.type})`
      : (KIND[i.tag] ?? i.role ?? i.tag);
  const parts = [`[${i.ref}] ${kind}`];
  if (i.text) parts.push(JSON.stringify(i.text));
  if (i.value) parts.push(`值=${JSON.stringify(i.value)}`);
  if (i.checked !== null) parts.push(i.checked ? "已选中" : "未选中");
  if (i.disabled) parts.push("不可用");
  if (i.href) parts.push(`-> ${i.href}`);
  return parts.join(" ");
}

export function formatSnapshot(s: RawSnapshot): string {
  const out = [`页面：${s.title || "（无标题）"}`, `地址：${s.url}`, ""];
  out.push(
    s.items.length
      ? "可交互元素（用编号调用 browser_click / browser_type）："
      : "没有可交互元素。",
  );
  for (const i of s.items) out.push(describe(i));
  if (s.items.length >= ITEMS_MAX)
    out.push(`（只列出前 ${ITEMS_MAX} 个可见元素）`);
  out.push("", "页面文字：", s.text || "（空）");
  if (s.text.length >= TEXT_MAX) out.push("（文字已截断）");
  return out.join("\n");
}
