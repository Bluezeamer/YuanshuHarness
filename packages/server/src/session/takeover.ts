import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { HEAD_TYPE, readHead, withDescriptions } from "./frozen.js";
import type { StateMapping } from "./state-map.js";

/**
 * 接管开头系统消息：每次请求前把转录里 pi 写的全部系统条目换成冻结物。
 * 没有冻结物（新会话 / 刚重建）就取 pi 此刻回放出的状态冻结下来并落进会话文件。
 * 可执行的工具集与声明给模型的工具相互独立：冻结声明之外的工具 pi 照常执行。
 */
export function takeoverExtension(opts: {
  descriptions: () => Record<string, string> | undefined;
  state: () => StateMapping;
}): ExtensionFactory {
  return (pi) => {
    pi.on("context_with_system", (e, ctx) => {
      let { data, stale } = readHead(ctx.sessionManager.getBranch());
      if (!data || stale) {
        const head = getCurrentSystemMessage(e.messages);
        if (!head) return undefined;
        data = {
          head: withDescriptions(head, opts.descriptions()),
          state: opts.state(),
        };
        pi.appendEntry(HEAD_TYPE, data);
      }
      return {
        messages: [data.head, ...e.messages.filter((m) => m.role !== "system")],
      };
    });
  };
}
