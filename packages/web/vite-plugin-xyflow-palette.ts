// 构建期把 @xyflow/react 的 base.css 色值改写成调色板变量。
//
// 为什么需要：设计守卫（tokens.test.ts）会扫构建产物里所有 CSS 的裸色值，第三方库自带
// 的 rgba()/hex 会直接判红。我们不引它全量 style.css，只借 base.css 的结构样式（布局与
// 交互必需的那几十条），色值在这里一次性换成 var(--*)，主题全部走我们自己的令牌。
//
// 表外色值不是"忽略"而是**构建失败**：升级 xyflow 后若新增色值，会立刻大声报错，
// 而不是静默漏进产物。
import type { Plugin } from "vite";

/** base.css 里出现的色值 → 调色板变量。键是原文字面量。 */
const COLOR_MAP: [string, string][] = [
  // 连线 / 连接线
  ["#b1b1b7", "var(--border-strong)"],
  ["#555", "var(--accent)"],
  ["#727272", "var(--accent-line)"],
  ["#3e3e3e", "var(--border-strong)"],
  // 背景 / 表面
  ["rgba(255, 255, 255, 0.5)", "var(--surface)"],
  ["rgba(150, 150, 150, 0.25)", "var(--surface-2)"],
  ["rgba(240, 240, 240, 0.6)", "var(--surface-3)"],
  ["rgba(60, 60, 60, 0.6)", "var(--surface-3)"],
  ["#fff", "var(--surface)"],
  ["#eee", "var(--surface-3)"],
  ["#e2e2e2", "var(--border)"],
  ["#141414", "var(--bg)"],
  ["#2b2b2b", "var(--surface-2)"],
  // 前景 / 次要
  ["#999", "var(--muted)"],
  ["#f8f8f8", "var(--fg)"],
  ["#91919a", "var(--meta)"],
  ["#333", "var(--fg)"],
  // 选中 / 焦点
  [
    "rgba(150, 150, 180, 0.1)",
    "color-mix(in oklch, var(--accent) 10%, transparent)",
  ],
  ["1px dotted rgba(155, 155, 155, 0.8)", "1px dashed var(--accent-line)"],
  ["#3367d9", "var(--accent)"],
  // 节点描边
  ["1px solid #bbb", "1px solid var(--border)"],
  ["1px solid #555", "1px solid var(--accent)"],
];

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

/**
 * 把 base.css 的色值替换成调色板变量。返回未登记的残留色值（空数组 = 全部覆盖）。
 * 抽成纯函数便于直接对上游 CSS 做单测，不必依赖 vite 构建。
 */
export function paletteRewrite(code: string): {
  css: string;
  leftover: string[];
} {
  let css = code;
  for (const [from, to] of COLOR_MAP) css = css.split(from).join(to);
  const leftover = [
    ...new Set([...css.matchAll(COLOR_RE)].map((m) => m[0])),
  ].filter((c) => !c.startsWith("var("));
  return { css, leftover };
}

export function xyflowPalette(): Plugin {
  return {
    name: "yuanshu:xyflow-palette",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@xyflow/react/dist/base.css")) return null;
      const { css, leftover } = paletteRewrite(code);
      if (leftover.length > 0) {
        this.error(
          `xyflow base.css 出现未登记的色值：${leftover.join("、")}。` +
            "请在 vite-plugin-xyflow-palette.ts 的 COLOR_MAP 里补映射。",
        );
      }
      return { code: css, map: null };
    },
  };
}
