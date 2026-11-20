// 会话提示词的形状：预设合成后的结果，直接喂给工厂与扩展。
//
// 分两段落地（与 pi 的机制一致）：
//   preamble（identity 段） → customPrompt，裸文本、永远最前
//   sections（其余段）      → <段名> 包裹的段落，按合成顺序
//   userText（user 段）     → 会话开头尾部注入一次
import type { PresetKind } from "../store/prompt-presets.js";

export interface SessionPrompt {
  preamble: string;
  sections: Record<string, string>;
  /** user 通道正文：首条用户消息前注入一次 */
  userText: string;
  /** 参与合成的预设，便于日志与排错 */
  sources: { kind: PresetKind; id: string; name: string }[];
}

/** 一次会话实际送进 pi 的提示词 */
export interface RenderOutput {
  preamble: string;
  sections: Record<string, string>;
  text: string;
}

/** 把 preamble 与各段拼成完整文本（模型实际看到的样子）。 */
export const promptText = ({
  preamble,
  sections,
}: Pick<SessionPrompt, "preamble" | "sections">): string =>
  [
    preamble,
    ...Object.entries(sections).map(
      ([tag, body]) => `<${tag}>\n${body}\n</${tag}>`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

export const renderOutput = (prompt: SessionPrompt): RenderOutput => ({
  preamble: prompt.preamble,
  sections: prompt.sections,
  text: promptText(prompt),
});
