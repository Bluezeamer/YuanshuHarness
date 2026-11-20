// 代码块高亮：highlight.js 按语言懒加载，结果按 (语言, 源码) 缓存。
// 输出按行切成独立的 HTML 片段，卡片就能给每一行单独画行号，并且换行开关不影响行号对齐。
import type { HLJSApi, LanguageFn } from "highlight.js";

type Loader = () => Promise<{ default: LanguageFn }>;

// 语言名 → 动态加载入口。只收常见语言，未知语言按纯文本处理。
const LOADERS: Record<string, Loader> = {
  clojure: () => import("highlight.js/lib/languages/clojure"),
  cmake: () => import("highlight.js/lib/languages/cmake"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  dart: () => import("highlight.js/lib/languages/dart"),
  elixir: () => import("highlight.js/lib/languages/elixir"),
  erlang: () => import("highlight.js/lib/languages/erlang"),
  fsharp: () => import("highlight.js/lib/languages/fsharp"),
  gradle: () => import("highlight.js/lib/languages/gradle"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  http: () => import("highlight.js/lib/languages/http"),
  julia: () => import("highlight.js/lib/languages/julia"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  latex: () => import("highlight.js/lib/languages/latex"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  nginx: () => import("highlight.js/lib/languages/nginx"),
  nim: () => import("highlight.js/lib/languages/nim"),
  nix: () => import("highlight.js/lib/languages/nix"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  properties: () => import("highlight.js/lib/languages/properties"),
  protobuf: () => import("highlight.js/lib/languages/protobuf"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  scala: () => import("highlight.js/lib/languages/scala"),
  scss: () => import("highlight.js/lib/languages/scss"),
  swift: () => import("highlight.js/lib/languages/swift"),
  toml: () => import("highlight.js/lib/languages/ini"),
  vim: () => import("highlight.js/lib/languages/vim"),
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  python: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
  sql: () => import("highlight.js/lib/languages/sql"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

// 围栏里常见的别名（同一目标只写一次，重复键 TypeScript 会直接报错）。
const ALIASES: Record<string, string> = {
  // 与语言名不同的常见写法
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  ts: "typescript",
  tsx: "typescript",
  html: "xml",
  htm: "xml",
  svg: "xml",
  vue: "xml",
  yml: "yaml",
  py: "python",
  rb: "ruby",
  rs: "rust",
  md: "markdown",
  cs: "csharp",
  fs: "fsharp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  h: "c",
  kt: "kotlin",
  kts: "kotlin",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  pl: "perl",
  ps1: "powershell",
  proto: "protobuf",
  gql: "graphql",
  tex: "latex",
  docker: "dockerfile",
  conf: "nginx",
  // hljs 没有独立的 toml 语法，官方建议用 ini
  toml: "ini",
};

const MAX_HIGHLIGHT_CHARS = 120_000;
const CACHE_MAX = 80;

let core: Promise<HLJSApi> | null = null;
const loadCore = (): Promise<HLJSApi> => {
  core ??= import("highlight.js/lib/core").then((m) => m.default);
  return core;
};

const loaded = new Set<string>();
async function ensureLanguage(hljs: HLJSApi, lang: string): Promise<boolean> {
  const name = ALIASES[lang] ?? lang;
  if (hljs.getLanguage(name)) return true;
  const loader = LOADERS[name];
  if (!loader) return false;
  try {
    const mod = await loader();
    hljs.registerLanguage(name, mod.default);
    loaded.add(name);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/**
 * 把 highlight.js 的整段 HTML 按换行切成逐行片段；跨行的标签在行尾闭合、下一行重新打开，
 * 保证每个片段都是合法 HTML，且不影响多行字符串/注释的着色。
 */
export function splitHighlightedLines(html: string): string[] {
  const root = document.createElement("div");
  root.innerHTML = html;
  const lines: string[] = [""];
  const stack: Array<{ open: string; close: string }> = [];
  const push = (s: string) => {
    lines[lines.length - 1] += s;
  };
  const closeAll = () => {
    for (let i = stack.length - 1; i >= 0; i--) push(stack[i]?.close ?? "");
  };
  const reopen = () => {
    for (const tag of stack) push(tag.open);
  };
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      const parts = text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          closeAll();
          lines.push("");
          reopen();
        }
        const part = parts[i] as string;
        if (part !== "") push(escapeHtml(part));
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    const attrs = [...el.attributes]
      .map((a) => ` ${a.name}="${escapeAttr(a.value)}"`)
      .join("");
    stack.push({ open: `<${tag}${attrs}>`, close: `</${tag}>` });
    push(`<${tag}${attrs}>`);
    for (const child of el.childNodes) walk(child);
    stack.pop();
    push(`</${tag}>`);
  };
  for (const child of root.childNodes) walk(child);
  return lines;
}

const cache = new Map<string, string[]>();

/** 高亮并切成行；语言不支持或源码过大时返回 null（调用方按纯文本渲染）。 */
export async function highlightedLines(
  code: string,
  lang: string,
): Promise<string[] | null> {
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const key = `${lang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const hljs = await loadCore();
  if (!(await ensureLanguage(hljs, lang))) return null;
  const name = ALIASES[lang] ?? lang;
  let lines: string[];
  try {
    lines = splitHighlightedLines(
      hljs.highlight(code, { language: name, ignoreIllegals: true }).value,
    );
  } catch {
    return null;
  }
  cache.set(key, lines);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return lines;
}

export const highlightedLanguage = (lang: string): boolean =>
  LOADERS[ALIASES[lang] ?? lang] !== undefined;
