// 内容超预算时的整行截断：dom / exec / storage 的结果共用同一套预算与提示行。
// 纯函数：不碰工具与引擎。

/** 给模型看的内容上限：超过就把全文落成附件。 */
export const INLINE_MAX = 12_000;
/** 超预算时保留的内容长度（按整行切）。 */
const KEEP_MAX = 6_000;

export interface Budgeted {
  /** 给模型看的文字（含外壳；不含附件标记行） */
  text: string;
  /** 内容超预算：调用方要把 full 落成附件 */
  elided: boolean;
  /** 不省略的完整文字（含外壳） */
  full: string;
}

/**
 * head 是外壳行，body 是内容行；内容不超预算就原样给。
 * 超了按整行留前 KEEP_MAX 个字符（一行就超预算就一行都不留），其余只报行数；what 写进提示行。
 */
export function budgetLines(
  head: string[],
  body: string[],
  what: string,
): Budgeted {
  const full = [...head, ...body].join("\n");
  if (body.join("\n").length <= INLINE_MAX)
    return { text: full, elided: false, full };

  const kept: string[] = [];
  let used = 0;
  for (const line of body) {
    const cost = line.length + 1;
    if (used + cost > KEEP_MAX) break;
    kept.push(line);
    used += cost;
  }
  const rest = body.length - kept.length;
  const text = [
    ...head,
    ...kept,
    `… ${rest} more lines (${body.length} lines total); ${what} is saved as an attachment`,
  ].join("\n");
  return { text, elided: true, full };
}
