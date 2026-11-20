// 笔记里的相对图片链接（`![](./.assets/访谈/a.png)`）：笔记改名时资源夹跟着改名，链接要改到新资源夹。
// 地址里的空格、括号等按浏览器端写链接时的规则转义（`%20`、`%28`），中文原样；这里按解码后的名字比对。

/** 一段路径放进 markdown 链接地址：空格、括号、百分号等转义，中文保持原样 */
export const encodeLinkSeg = (s: string): string =>
  s.replace(/[%\s()<>#?]/g, (c) =>
    c.charCodeAt(0) < 128
      ? `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
      : encodeURIComponent(c),
  );

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * 笔记改名（旧名 oldStem → 新名 newStem，都不带 `.md`）：指向旧资源夹 `.assets/<oldStem>/` 的链接地址改到新资源夹，
 * 别的原样；保留地址前面的 `./`。
 */
export function rewriteAssetLinks(
  text: string,
  oldStem: string,
  newStem: string,
): string {
  return text.replace(
    /\]\((\.\/)?\.assets\/([^/)\s]+)(\/[^)\s]+)\)/g,
    (m, dot: string | undefined, stem: string, rest: string) =>
      decode(stem) === oldStem
        ? `](${dot ?? ""}.assets/${encodeLinkSeg(newStem)}${rest})`
        : m,
  );
}
