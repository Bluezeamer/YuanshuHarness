// 把 terminal.css 里 .ws-term 作用域下的 --ws-term-* 变量解析成 xterm 的主题。
// xterm 不认 var()/oklch 以外的间接写法，所以借一个探针元素让浏览器算出最终颜色
// （不透明颜色 xterm 会经 canvas 转成 rgb，因此变量里不能写半透明）。
import type { ITheme } from "@xterm/xterm";

const KEYS: ReadonlyArray<[keyof ITheme, string]> = [
  ["background", "bg"],
  ["foreground", "fg"],
  ["cursor", "cursor"],
  ["cursorAccent", "bg"],
  ["selectionBackground", "sel"],
  ["selectionInactiveBackground", "sel-off"],
  ["black", "black"],
  ["red", "red"],
  ["green", "green"],
  ["yellow", "yellow"],
  ["blue", "blue"],
  ["magenta", "magenta"],
  ["cyan", "cyan"],
  ["white", "white"],
  ["brightBlack", "bright-black"],
  ["brightRed", "bright-red"],
  ["brightGreen", "bright-green"],
  ["brightYellow", "bright-yellow"],
  ["brightBlue", "bright-blue"],
  ["brightMagenta", "bright-magenta"],
  ["brightCyan", "bright-cyan"],
  ["brightWhite", "bright-white"],
];

export function readTheme(root: HTMLElement): ITheme {
  const probe = document.createElement("i");
  probe.hidden = true;
  root.appendChild(probe);
  const theme: Record<string, string> = {};
  for (const [key, name] of KEYS) {
    probe.style.color = `var(--ws-term-${name})`;
    const c = getComputedStyle(probe).color;
    if (c) theme[key] = c;
  }
  probe.remove();
  return theme as ITheme;
}

/** 读一个返回像素数的令牌（如 --fs-code），读不到用兜底值。 */
export function readPx(root: HTMLElement, name: string, fallback: number) {
  const n = Number.parseFloat(getComputedStyle(root).getPropertyValue(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const readFont = (root: HTMLElement): string =>
  getComputedStyle(root).getPropertyValue("--font-mono").trim() || "monospace";
