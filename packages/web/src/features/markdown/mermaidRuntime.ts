// mermaid 运行时：懒加载、单次初始化、离屏渲染、SVG 缓存。
// 关键点（见 docs/model/chat-render.md）：
// - 渲染放进离屏容器（visibility:hidden + 移出视口），避免 ELK 跨帧布局时把临时节点画到页面上；
// - 每次 render 用唯一 id；缓存命中时如果该 id 还在页面里就重新渲染，避免重复 id；
// - 不先 parse：mermaid.render 内部会解析，suppressErrorRendering 已开启，失败时抛错由组件兜底。
import { buildMermaidTheme } from "./mermaidTheme";

type MermaidApi = typeof import("mermaid").default;

let loading: Promise<MermaidApi> | null = null;
let themeVersion = "base";
const cache = new Map<string, Rendered>();
const inflight = new Map<string, Promise<Rendered>>();
const CACHE_MAX = 60;
let seq = 0;

export interface Rendered {
  svg: string;
  /** mermaid 为这份 SVG 生成的节点 id（缓存复用时用来查重） */
  id: string;
}

const fontsReady = async (): Promise<void> => {
  if (typeof document === "undefined") return;
  await document.fonts?.ready;
};

function offscreen(width: number): HTMLDivElement {
  const box = document.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:0",
    `width:${Math.max(320, Math.round(width))}px`,
    "visibility:hidden",
    "pointer-events:none",
    "contain:layout style",
  ].join(";");
  document.body.appendChild(box);
  return box;
}

function load(): Promise<MermaidApi> {
  loading ??= (async () => {
    const { default: mermaid } = await import("mermaid");
    await fontsReady();
    let theme: Record<string, unknown> = {
      theme: "base",
      look: "neo",
      layout: "elk",
      htmlLabels: true,
    };
    try {
      const built = buildMermaidTheme();
      theme = built.config;
      themeVersion = built.version;
    } catch {
      // 拿不到设计令牌（例如测试环境没有样式表）：退回 base 默认主题。
      themeVersion = "base";
    }
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      ...theme,
    });
    return mermaid;
  })();
  return loading;
}

async function renderOnce(code: string, width: number): Promise<Rendered> {
  const mermaid = await load();
  const id = `mmd-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const box = offscreen(width);
  try {
    const { svg } = await mermaid.render(id, code, box);
    return { svg, id };
  } finally {
    box.remove();
  }
}

/** 渲染一段 mermaid 源码；同代码共享一次渲染结果。失败时抛出错误信息。 */
export async function renderMermaid(
  code: string,
  width: number,
): Promise<Rendered> {
  await load();
  const key = `${themeVersion}\u0000${code}`;
  const hit = cache.get(key);
  // 缓存项在别的块里还活着时不能复用：同一份 SVG 的 id 在页面里只能出现一次。
  if (hit && !document.getElementById(hit.id)) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = renderOnce(code, width);
  inflight.set(key, task);
  try {
    const out = await task;
    cache.set(key, out);
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return out;
  } finally {
    inflight.delete(key);
  }
}

/** 把 mermaid 的异常整理成一行可读文本（原始 message 可能很长）。 */
export function mermaidErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split("\n").find((s) => s.trim() !== "") ?? raw;
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

export { themeVersion as mermaidThemeVersion };
