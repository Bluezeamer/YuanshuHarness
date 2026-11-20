import type { PackageSource } from "@earendil-works/pi-coding-agent";

export const sourceOf = (p: PackageSource): string =>
  typeof p === "string" ? p : p.source;

/**
 * 会话要加载的包：只留开着的，并且一律用字符串写法。
 * 开关是整包的（扩展、技能、提示词一起进或一起不进），pi 登记里给 TUI 用的 extensions / skills 过滤不在这里生效。
 */
export function loadableSources(
  packages: readonly PackageSource[] | undefined,
  enabled: ReadonlySet<string>,
): string[] {
  return (packages ?? []).map(sourceOf).filter((s) => enabled.has(s));
}
