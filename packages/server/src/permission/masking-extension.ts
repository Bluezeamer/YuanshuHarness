// 工具结果遮罩（ADR-0053）：tool_result 钩子早于 tool_execution_end 与消息落盘，
// 所以读文件、grep、MCP 以及工具抛出的错误文本都在这里统一换回占位符。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Masker, type MaskVar } from "./masking.js";

export function maskingExtension(
  variables: () => readonly MaskVar[],
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", (e) => {
      const m = new Masker(variables());
      if (m.empty) return undefined;
      return {
        // 图片块不动，避免对大段 base64 做匹配
        content: e.content.map((c) =>
          c.type === "text" ? { ...c, text: m.mask(c.text) } : c,
        ),
        // 不显式给出时 SDK 会丢弃 structuredContent；bash 的 output 字段同样要遮罩
        ...(e.structuredContent === undefined
          ? {}
          : { structuredContent: m.maskDeep(e.structuredContent) }),
        ...(e.details === undefined ? {} : { details: m.maskDeep(e.details) }),
      };
    });
  };
}
