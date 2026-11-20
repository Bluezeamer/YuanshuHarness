// 笔记正文里的 `[[…]]` 链接（canvas.md §10）：扫描与解析，纯函数。
// 目标写成相对 `.canvas/` 的路径（`想法.canvas`、`产品/用户研究.md`），扩展名可省，省了先按笔记找、再按画布找。

const LINK_RE = /\[\[([^[\]\n|#]+)(?:#[^[\]\n|]*)?(?:\|[^[\]\n]*)?\]\]/g;

/** 围栏代码块与行内代码里的 `[[…]]` 只是示例文字，不算链接。 */
const stripCode = (text: string): string =>
  text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

/** 目标路径的规范形：反斜杠换成 `/`，去掉开头的 `./`、`/` 与 `.canvas/`。 */
const normalize = (raw: string): string =>
  raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.?\/)+/, "")
    .replace(/^\.canvas\//, "");

/** 正文里出现过的链接目标（规范化、去重、保持出现顺序；别名与 `#标题` 部分不算）。 */
export function scanWikilinks(text: string): string[] {
  const out: string[] = [];
  for (const m of stripCode(text).matchAll(LINK_RE)) {
    const target = normalize(m[1] as string);
    if (target !== "" && !out.includes(target)) out.push(target);
  }
  return out;
}

/** 目标在已知文件（相对 `.canvas/` 的路径，笔记带 `.md`、画布带 `.canvas`）里对应哪一个；找不到是 null。 */
export function resolveLink(
  target: string,
  known: ReadonlySet<string>,
): string | null {
  for (const c of [target, `${target}.md`, `${target}.canvas`])
    if (known.has(c)) return c;
  return null;
}

const REWRITE_RE = /\[\[([^[\]\n|#]+)((?:#[^[\]\n|]*)?(?:\|[^[\]\n]*)?)\]\]/g;
const CODE_RE = /(```[\s\S]*?```|`[^`\n]*`)/;
const EXT_RE = /\.(?:md|canvas)$/i;

/** 把每个链接的目标交给 newTargetOf（给的是规范化后的目标）：返回新写法就换掉目标，别名与 `#标题` 部分原样留着；代码里的不动。 */
export function rewriteWikilinks(
  text: string,
  newTargetOf: (target: string) => string | null,
): string {
  return text
    .split(CODE_RE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(REWRITE_RE, (m, raw: string, rest: string) => {
            const target = normalize(raw);
            const next = target === "" ? null : newTargetOf(target);
            return next === null ? m : `[[${next}${rest}]]`;
          }),
    )
    .join("");
}

/**
 * 画布 / 笔记被挪到新位置后，正文里指向它们的链接跟着改。moves 是旧路径 → 新路径（都相对 `.canvas/`），
 * known 是挪之前的全部画布与笔记。原来写了扩展名就照写；没写的尽量不加，除非去掉后会指到别的文件。
 */
export function rewriteForMoves(
  text: string,
  moves: ReadonlyMap<string, string>,
  known: ReadonlySet<string>,
): string {
  if (!text.includes("[[")) return text;
  const after = new Set([...known].map((p) => moves.get(p) ?? p));
  return rewriteWikilinks(text, (target) => {
    const hit = resolveLink(target, known);
    const to = hit === null ? undefined : moves.get(hit);
    if (to === undefined) return null;
    const bare = to.replace(EXT_RE, "");
    return EXT_RE.test(target) || resolveLink(bare, after) !== to ? to : bare;
  });
}
