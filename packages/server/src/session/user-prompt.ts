// user 通道的预设片段：走尾部注入（before_agent_start 返回 message），
// 与其他通知同一套机制；会话开头只注入一次，且 display:false 不污染可见历史。
//
// 为什么不用"拼进首条用户消息"：那会改写出用户输入的原文，历史与附件投影都会带上它。
// 尾部注入是 pi 提供的正式通道，属于 design 里说的"尾部注入点"。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export function userPromptExtension(
  getText: () => string | null,
): ExtensionFactory {
  return (pi) => {
    let sent = false;
    pi.on("before_agent_start", () => {
      if (sent) return undefined;
      const text = getText()?.trim();
      if (!text) return undefined;
      sent = true;
      return {
        message: {
          customType: "yuanshu.user_prompt",
          content: text,
          display: false,
        },
      };
    });
  };
}
