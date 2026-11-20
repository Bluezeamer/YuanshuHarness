import type { PluginView } from "../../../../api/pluginLibrary";

// ---- 名字 ----

// npm:@scope/name@1.2.3 / npm:name / git:github.com/owner/repo@ref / 本地相对路径：去掉协议与版本，留一个读得出来的名字。
export function nameOf(source: string): string {
  const s = source.trim().replace(/^(npm|git|https?|ssh):\/*/i, "");
  const noRef = s.replace(/@[^/@]+$/, "");
  const parts = noRef.split("/").filter(Boolean);
  const last = parts.at(-1) ?? source;
  // @scope/name 这种保留 scope：只取最后一段会让 @a/tasks 与 @b/tasks 重名
  return parts.length >= 2 && parts.at(-2)?.startsWith("@")
    ? `${parts.at(-2)}/${last}`
    : last.replace(/\.git$/, "");
}

/** 来源的类型：给行副标题与安装弹窗的提示用。 */
export type SourceKind = "npm" | "git" | "local";
export function kindOf(source: string): SourceKind {
  if (/^npm:/i.test(source)) return "npm";
  if (/^(git:|https?:|ssh:|git@)/i.test(source)) return "git";
  return "local";
}

export const KIND_TEXT: Record<SourceKind, string> = {
  npm: "npm",
  git: "git",
  local: "本地",
};

// ---- 状态 ----

export type StatusKey = "busy" | "missing" | "off" | "ok";
export interface RowStatus {
  key: StatusKey;
  text: string;
  tone?: "warn" | "live" | "danger";
}

/** 行状态：操作中 > 登记了但没装上 > 已停用 > 已启用。 */
export function statusOf(p: PluginView, busy: string | null): RowStatus {
  if (busy) return { key: "busy", text: busy, tone: "warn" };
  if (!p.installed) return { key: "missing", text: "未装上", tone: "danger" };
  if (!p.enabled) return { key: "off", text: "已停用" };
  return { key: "ok", text: "已启用", tone: "live" };
}

export const versionText = (p: PluginView): string =>
  p.version ? `v${p.version}` : "无版本";

/** 一句话说这个包带来什么；停用时仍写出包里有什么（计数在停用时为 0，不能当「没有」）。 */
export function contentText(p: PluginView): string {
  if (!p.installed) return "包体没有就位，重装后才有内容";
  if (!p.enabled) return "已停用，整包不加载";
  const parts = [
    p.extensionCount > 0 ? `${p.extensionCount} 个扩展` : null,
    p.skillCount > 0 ? `${p.skillCount} 个技能` : null,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(" · ") : "没有扩展与技能";
}

export const matchesPlugin = (p: PluginView, q: string): boolean => {
  const s = q.trim().toLowerCase();
  return s === "" || p.source.toLowerCase().includes(s);
};

// ---- 安装弹窗 ----

export interface InstallInput {
  ok: true;
  source: string;
}
export interface InstallProblem {
  ok: false;
  message: string;
}

/** 校验输入框里的来源：只做明显的错（空、含空白），其余交给服务端的预览去判断。 */
export function checkSource(raw: string): InstallInput | InstallProblem | null {
  const source = raw.trim();
  if (source === "") return null;
  if (/\s/.test(source))
    return { ok: false, message: "来源里不能有空格，只填一个包名或地址" };
  return { ok: true, source };
}

/** 来源没写前缀时的提示：npm 包要写 npm:，git 仓库要写 git: 或完整网址。 */
export function prefixHint(source: string): string | null {
  const s = source.trim();
  if (s === "" || /^(npm:|git:|https?:|ssh:|git@|\.|\/|~)/i.test(s))
    return null;
  return "没写前缀会被当成本地路径；npm 包写 npm:包名，git 仓库写 git:地址";
}
