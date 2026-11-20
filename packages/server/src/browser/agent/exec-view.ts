// 脚本执行的结果 → 给模型看的文字与落文件的全文。纯函数：不碰工具与引擎，格式固定。
// 外壳是固定英文，脚本交回来的结果原样（它是页面里的 JSON 文字）。
import type { ExecOutcome } from "../engine/types.js";
import { type Budgeted, budgetLines } from "./budget.js";

export interface ExecQuery {
  title: string;
  url: string;
}

export function renderExec(outcome: ExecOutcome, query: ExecQuery): Budgeted {
  const head = `EXEC: ${query.title} | ${query.url}`;
  if (outcome.kind === "threw") {
    const full = [head, "THREW:", outcome.message].join("\n");
    return { text: full, elided: false, full };
  }
  if (outcome.json === "undefined") {
    const full = [head, "RESULT: undefined"].join("\n");
    return { text: full, elided: false, full };
  }
  return budgetLines(
    [head, `RESULT (${outcome.json.length} chars):`],
    outcome.json.split("\n"),
    "full result",
  );
}
