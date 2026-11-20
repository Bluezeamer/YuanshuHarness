// 界面字号：一个基准字号 + 两个可覆盖的阅读档位（正文 / 代码）。
// 只放大要读的字（对话正文、代码、工具输出、文件预览），外壳字（ui/type.css 里的外壳族）、图标、
// 间距都是固定值——整体缩放会把左侧会话卡一起撑胖，那正是用户反馈的问题。
//
// 唯一真源是根元素上的 --fs-read / --fs-code 两个 CSS 变量：引用变量的地方自动跟随，
// 不必各自订阅。xterm 例外（画在 canvas 上不认变量），它订阅下面的变更通知自己同步 options.fontSize。
// 存在 localStorage：纯客户端偏好，不占服务端设置；启动时先应用再渲染，避免刷新时闪一下默认字号。

export interface FontSettings {
  /** 基准字号 px：正文默认等于它，代码按下面的比例推导 */
  base: number;
  /** 覆盖值，null = 跟随基准推导；覆盖后不再随基准变化 */
  read: number | null;
  code: number | null;
}

export interface ResolvedFontSize {
  read: number;
  code: number;
}

export const FONT_SIZE_KEY = "yuanshu.ui.fontsize";

export const BASE_MIN = 12;
export const BASE_MAX = 22;
/** 默认 16px：与上一版「大」档（正文 16 / 代码 14）观感一致，用户已经认这个密度。 */
export const BASE_DEFAULT = 16;

/** 覆盖值范围：低于 9px 读不动，高于 30px 一行放不下几个字。 */
export const OVERRIDE_MIN = 9;
export const OVERRIDE_MAX = 30;

/** 代码 = 基准 × 0.875（16 → 14）：等宽字的字面比同号比例字更满、更难挤，比正文收一档才不显重。 */
export const CODE_RATIO = 0.875;

export const DEFAULT_FONT_SETTINGS: FontSettings = {
  base: BASE_DEFAULT,
  read: null,
  code: null,
};

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

// 取整到 0.5px：亚像素差在这一档看不出来，却会让行高与读条宽度出现半像素抖动。
const half = (n: number) => Math.round(n * 2) / 2;

/** 推导最终两档：正文跟基准，代码按比例，覆盖值优先。 */
export function resolveFontSize(s: FontSettings): ResolvedFontSize {
  const base = half(clamp(s.base, BASE_MIN, BASE_MAX));
  return {
    read: s.read ?? base,
    code: s.code ?? half(base * CODE_RATIO),
  };
}

const px = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isFinite(v) ? half(clamp(v, lo, hi)) : null;

/** 读设置：只认 JSON。上一版的档位枚举（"lg" 这类）解析失败即回默认值——不为它留第二条读路径。 */
export function loadFontSize(): FontSettings {
  try {
    const raw = localStorage.getItem(FONT_SIZE_KEY);
    if (!raw) return DEFAULT_FONT_SETTINGS;
    const v = JSON.parse(raw) as Partial<FontSettings> | null;
    if (!v || typeof v !== "object") return DEFAULT_FONT_SETTINGS;
    const base = px(v.base, BASE_MIN, BASE_MAX);
    if (base === null) return DEFAULT_FONT_SETTINGS;
    return {
      base,
      read: px(v.read, OVERRIDE_MIN, OVERRIDE_MAX),
      code: px(v.code, OVERRIDE_MIN, OVERRIDE_MAX),
    };
  } catch {
    return DEFAULT_FONT_SETTINGS;
  }
}

export function saveFontSize(s: FontSettings): void {
  try {
    localStorage.setItem(FONT_SIZE_KEY, JSON.stringify(s));
  } catch {
    // 写不进去（配额/隐私模式）：本次页面内仍然生效，只是刷新后回到默认值
  }
}

const listeners = new Set<() => void>();

/** 字号变了要跟着动的订阅方（目前只有 xterm）。通知发生在变量写完之后，订阅方按变量读当前值。 */
export function subscribeFontSize(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 把最终值写成根元素上的内联变量；tokens.css 里 html 那一组是没设置过时的兜底默认值。 */
export function applyFontSize(s: FontSettings): ResolvedFontSize {
  const size = resolveFontSize(s);
  const style = document.documentElement.style;
  style.setProperty("--fs-read", `${size.read}px`);
  style.setProperty("--fs-code", `${size.code}px`);
  for (const fn of listeners) fn();
  return size;
}
