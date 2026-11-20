// 页面资源清单与保存结果 → 给模型看的文字。纯函数：不碰工具与引擎，渲染规则固定，方便单独推定格式。
// 外壳是固定的英文，页面内容（地址、alt）保持原文。
import { describeSrc } from "../engine/img-src.js";
import type { PageAsset } from "../engine/types.js";
import { sizeText } from "./network-view.js";

/** 清单最多列这么多行，多出来的只写个数。 */
const ROW_MAX = 100;

export interface AssetQuery {
  title: string;
  url: string;
  /** 生效的元素范围（ref 编号）；没给就没有这一项 */
  ref?: string;
  /** 生效的类型（已小写、已去重）；缺省是 image 与 media */
  types: string[];
}

export interface SaveRow {
  url: string;
  ok: boolean;
  /** 成功：`[attach_file]` 标记行、mime 与字节数 */
  marker?: string;
  mime?: string;
  size?: number;
  /** 成功：是走了新请求（不在浏览器缓存里） */
  viaRequest?: boolean;
  /** 失败原因 */
  reason?: string;
}

/** 一行资源：`#1 image image/png 70 B 40×40 alt「普通图」 http://host/a.png`。 */
function assetLine(n: number, a: PageAsset): string {
  const mime = a.mime === "" ? "-" : a.mime;
  const size = a.size === null ? "-" : sizeText(a.size);
  // 宽高只有图片且有自然尺寸时才有，其余写 `-` 占位。
  const dims =
    a.width === undefined || a.height === undefined
      ? "-"
      : `${a.width}×${a.height}`;
  const alt = a.alt === undefined || a.alt === "" ? "" : ` alt「${a.alt}」`;
  const where = a.frame === "sub" ? " [iframe]" : "";
  return `#${n} ${a.type} ${mime} ${size} ${dims}${alt} ${describeSrc(a.url)}${where}`;
}

/** 生效的范围与类型：只写给了 ref 的那一项（类型总是写出来）。 */
function scopeLine(query: AssetQuery): string {
  const parts = [
    ...(query.ref === undefined ? [] : [`ref ${query.ref}`]),
    `type=${query.types.join(",")}`,
  ];
  return `SCOPE: ${parts.join(" | ")}`;
}

/** 清单：外壳两行 + 每行一个资源；超过行数上限只写前 100 行并说明还有多少。 */
export function renderAssetList(
  assets: readonly PageAsset[],
  query: AssetQuery,
): string {
  const types = new Set(query.types);
  const matched = assets.filter((a) => types.has(a.type.toLowerCase()));
  const shown = matched.slice(0, ROW_MAX);
  const rest = matched.length - shown.length;
  return [
    `ASSETS: ${query.title} | ${query.url}`,
    scopeLine(query),
    ...(shown.length === 0
      ? ["No assets matched."]
      : shown.map((a, i) => assetLine(i + 1, a))),
    ...(rest === 0
      ? []
      : [`… ${rest} more rows not listed (narrow with type or ref)`]),
  ].join("\n");
}

/** 保存结果：头行计数，然后逐个成功项，再逐个失败项（失败只计数没法排查）。 */
export function renderSaveResult(rows: readonly SaveRow[]): string {
  const saved = rows.filter((r) => r.ok);
  const head = `Saved ${saved.length} of ${rows.length} assets`;
  const lines = saved.map(
    (r) =>
      `${r.marker ?? ""}  ${r.mime ?? ""}  ${sizeText(r.size ?? 0)}  ${r.url}${r.viaRequest === true ? "  (new request)" : ""}`,
  );
  const failed = rows
    .filter((r) => !r.ok)
    .map((r) => `FAILED ${r.url}: ${r.reason ?? ""}`);
  return [head, ...lines, ...failed].join("\n");
}
