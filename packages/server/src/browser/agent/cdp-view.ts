// CDP 命令的结果 → 给模型看的文字与落文件的全文。纯函数：不碰工具与引擎，格式固定。
// 外壳是固定英文，结果是命令交回来的 JSON 文字（原样）。
import { type Budgeted, budgetLines } from "./budget.js";

export interface CdpQuery {
  method: string;
  title: string;
  url: string;
}

export function renderCdp(json: string, query: CdpQuery): Budgeted {
  return budgetLines(
    [
      `CDP: ${query.method} | ${query.title} | ${query.url}`,
      `RESULT (${json.length} chars):`,
    ],
    json.split("\n"),
    "full result",
  );
}
