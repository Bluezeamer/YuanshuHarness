import type { SystemMessage } from "@earendil-works/pi-ai";
import type { StateMapping } from "./state-map.js";

// 冻结物：会话文件里的 custom 条目 `yuanshu.head`，不进模型上下文，保存「发给模型的开头系统消息」
// （提示词 + 工具声明）。之后每次请求都用它顶替 pi 自己写的系统条目，所以设置变了、工具增减了，
// 前缀也不变；只有「重建」才换一份。重建 = 在会话里追加一条 `yuanshu.rebuild` 标记，
// 下一次请求发现标记比冻结物新，就按当时 pi 回放出的状态重新冻结。

export const HEAD_TYPE = "yuanshu.head";
export const REBUILD_TYPE = "yuanshu.rebuild";
/** 模型在运行中自己切了模式：通知内容已经随工具结果给了它，记一个承载者免得下一轮重复通知。 */
export const STATEMARK_TYPE = "yuanshu.statemark";

export interface HeadData {
  head: SystemMessage;
  /** 冻结那一刻的状态映射，之后的差异都相对它（或更新的通知）算 */
  state: StateMapping;
}

interface BranchEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

/** 整条路径上最近一份冻结物，以及它是否已被后来的重建标记作废（没有冻结物也算作废）。 */
export function readHead(branch: readonly BranchEntry[]): {
  data: HeadData | null;
  stale: boolean;
} {
  let data: HeadData | null = null;
  let stale = true;
  for (const e of branch) {
    if (e.type !== "custom") continue;
    if (e.customType === HEAD_TYPE) {
      data = e.data as HeadData;
      stale = false;
    } else if (e.customType === REBUILD_TYPE) {
      stale = true;
    }
  }
  return { data, stale };
}

/** 工具页调优的描述覆盖，冻结时写进工具声明；之后改覆盖要等下一次重建才生效。 */
export function withDescriptions(
  head: SystemMessage,
  overrides: Record<string, string> | undefined,
): SystemMessage {
  if (!overrides || !head.toolsAdded) return head;
  return {
    ...head,
    toolsAdded: head.toolsAdded.map((t) =>
      overrides[t.name] === undefined
        ? t
        : { ...t, description: overrides[t.name] as string },
    ),
  };
}
