// 生产接线：把槽位渲染的结果送进 pi。
//
// 两条通道，与 pi 的机制一致：
//   preamble（identity 槽） → customPrompt，通过 resourceLoader 的 systemPromptOverride 提供
//   sections（其余槽位）    → 扩展在 before_agent_start 里写入 systemPromptOptions.sections
//
// 为什么要接管：pi 把 preamble/tools/rules/docs 的正文硬编码在代码里，我们既改不了也审查不了；
// 接管后这些内容来自 prompts/base 的资产，可以按槽位自由重组。
//
// 两个已知的 pi 约束（不是我们能改的）：
//   1. customPrompt 一旦设置，pi 就不再构建 tools/rules/docs —— 必须由我们提供
//   2. cwd 段 pi 无条件产出，只能按同名覆盖；自定义段一律追加在它之后
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { RenderOutput } from "./prompt-source.js";

export type RenderProvider = () => RenderOutput | null;

// skills 段由 pi 自己渲染，重复声明会变成两段。
const PI_OWNED_TAGS = new Set(["skills"]);

/** 注入除 preamble 之外的段；preamble 走 customPrompt，不在这里 */
export function promptSectionsExtension(
  getRender: RenderProvider,
): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const { sections } = event.systemPromptOptions;
      const out = getRender();
      if (!out) return undefined;
      for (const [tag, body] of Object.entries(out.sections)) {
        // skills 由 pi 自己渲染，重复声明会变成两段
        if (PI_OWNED_TAGS.has(tag)) continue;
        if (body) sections[tag] = body;
        else delete sections[tag];
      }
      return undefined;
    });
  };
}
