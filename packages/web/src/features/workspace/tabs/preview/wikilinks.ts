// 笔记里的 `[[…]]` 链接（canvas.md §10）：预览里渲染成可点击的链接。
// 做法：交给 react-markdown 之前，把 `[[目标|别名]]` 换成普通 markdown 链接（`wikilink:<编码后的目标>`），
// 围栏与行内代码里的不动；解析规则与服务端 canvas/wikilink.ts 一致（目标相对 `.canvas/`，缺扩展名先当笔记）。

export const WIKI_SCHEME = "wikilink:";

const LINK_RE = /\[\[([^[\]\n|#]+)(?:#[^[\]\n|]*)?(?:\|([^[\]\n]*))?\]\]/g;
const CODE_RE = /(```[\s\S]*?```|`[^`\n]*`)/;

/** 目标的规范形：反斜杠换成 `/`，去掉开头的 `./`、`/` 与 `.canvas/` */
const normalize = (raw: string): string =>
  raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.?\/)+/, "")
    .replace(/^\.canvas\//, "");

/** 链接文字里的 markdown 记号转义掉，免得别名里的 `*` `_` 被当成强调 */
const escapeLabel = (s: string): string =>
  s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");

/** `(` `)` 也要编码：它们会截断 markdown 链接的地址部分 */
const encodeTarget = (t: string): string =>
  encodeURIComponent(t).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));

/** 把正文里的 `[[…]]` 换成 markdown 链接；代码里的不换 */
export function linkWikilinks(text: string): string {
  return text
    .split(CODE_RE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(LINK_RE, (_m, target: string, alias?: string) => {
            const t = normalize(target);
            if (t === "") return _m;
            const label = (alias ?? "").trim() || target.trim();
            return `[${escapeLabel(label)}](${WIKI_SCHEME}${encodeTarget(t)})`;
          }),
    )
    .join("");
}

/** 链接地址 → 目标（相对 `.canvas/`）；不是 wikilink 返回 null */
export function wikiTargetOf(href: string | undefined): string | null {
  if (!href?.startsWith(WIKI_SCHEME)) return null;
  try {
    return decodeURIComponent(href.slice(WIKI_SCHEME.length));
  } catch {
    return null;
  }
}

/** 预览的文件在某个目录的 `.canvas/` 里时，给出目录与 `.canvas/` 的路径；否则 null（这时不处理 wikilink） */
export function canvasRootOf(
  path: string,
): { dir: string; root: string } | null {
  const i = path.indexOf("/.canvas/");
  return i < 0 ? null : { dir: path.slice(0, i), root: path.slice(0, i + 8) };
}

/** 目标指向什么：`.canvas` 结尾是画布（名字不带后缀），其余是笔记（缺 `.md` 补上） */
export function resolveWikilink(
  root: string,
  target: string,
): { kind: "canvas"; board: string } | { kind: "note"; abs: string } {
  const t = normalize(target);
  if (t.endsWith(".canvas"))
    return { kind: "canvas", board: t.slice(0, -".canvas".length) };
  return { kind: "note", abs: `${root}/${/\.md$/i.test(t) ? t : `${t}.md`}` };
}
