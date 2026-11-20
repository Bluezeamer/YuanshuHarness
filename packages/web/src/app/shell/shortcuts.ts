// 全局快捷键：事件 → 动作名。纯函数，与 React 解耦。
// mod 在 macOS 是 ⌘，其余是 Ctrl。⌘K 面板、⌘⇧O 总览、⌘⇧N 新窗口、⌘N 新会话、⌘\ 折叠左轨、⌘1…6 切窗口、⌘, 设置。

export type ShortcutAction =
  | { kind: "palette" }
  | { kind: "overview" }
  | { kind: "newWindow" }
  | { kind: "newSession" }
  | { kind: "toggleRail" }
  | { kind: "settings" }
  | { kind: "window"; index: number };

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export const isMac = (platform: string): boolean =>
  /mac|iphone|ipad/i.test(platform);

/**
 * @param modal 创建/编辑会话面板或设置页等全屏层是否打开：此时只响应面板自己的 Esc / ⌘Enter，全局键一律不抢。
 */
export function matchShortcut(
  e: KeyLike,
  platform: string,
  modal: boolean,
): ShortcutAction | null {
  if (modal) return null;
  const mod = isMac(platform) ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === "k" && !e.shiftKey) return { kind: "palette" };
  if (k === "o" && e.shiftKey) return { kind: "overview" };
  if (k === "n")
    return e.shiftKey ? { kind: "newWindow" } : { kind: "newSession" };
  if (k === "\\" && !e.shiftKey) return { kind: "toggleRail" };
  if (k === "," && !e.shiftKey) return { kind: "settings" };
  if (!e.shiftKey && /^[1-6]$/.test(k))
    return { kind: "window", index: Number(k) - 1 };
  return null;
}
