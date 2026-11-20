// 辅助模型与读大页面 agent 的全部提示词（英文）。只有标 <…> 的占位符由代码填。
// 提示词的要点（设计稿 §5、§8.3）：不调工具、只回一个 JSON、所有值都是指针、不复制页面文字。

export const OVERVIEW_SYSTEM =
  "You are a page-reading component inside a browser tool. You receive a line-numbered, cleaned accessibility snapshot of one web page. You NEVER call tools, never browse. You reply with ONE JSON object and nothing else (no markdown fence). The reader of your output is another AI agent that has NOT seen the snapshot and needs to know what this page is and what it can do here. Facts (names, links, text) are expanded by the host from the refs you give; do not copy or paraphrase page text into your own words beyond short captions.";

export const INTENT_SYSTEM =
  "You are a page-reading component inside a browser tool. You receive a line-numbered, cleaned accessibility snapshot of one web page. You NEVER call tools, never browse, never write prose about the page. You reply with ONE JSON object and nothing else (no markdown fence, no commentary). Every value you output must be a pointer into the snapshot: an element ref (like e27) or a line number. The host expands pointers into the page's original text; any text you invent is discarded, so do not copy or paraphrase page text.";

const OVERVIEW_TASK = (
  total: number,
): string => `TASK: describe this page for that reader.

OUTPUT SCHEMA:
{"gist":"<one sentence: what this page is for and what one can do on it>",
 "parts":[{"caption":"<short phrase naming this part of the page>","lines":[start,end],"refs":["eN"],"quote":[[start,end]]}]}
Rules:
- The snapshot has ${total} lines. Every line number you output must be between 1 and ${total}.
- Choose freely what parts matter and how to name them; there is no fixed list of part types.
- "lines": the first and last line number (inclusive) of the WHOLE part, so the reader can later ask for everything in it. Parts must not overlap. Cover every part that has interactive elements or headings.
- "refs": up to 6 element refs that best represent the part for a reader who will not see the rest (e.g. the title links of the first few records, not their vote or tag links; the search box; the login button). Pick elements that have a name; avoid empty or duplicate ones.
- "quote": optional. Short line ranges (a few lines each) whose exact text the reader needs but that have no element ref, such as a status sentence or a price. The host copies those lines verbatim. Use sparingly.
- Do not count items. Do not invent anything the snapshot does not show.`;

const INTENT_TASK = (
  intent: string,
  total: number,
): string => `INTENT: ${intent}

OUTPUT SCHEMA:
{"groups":[{"refs":["e27","e41"]}], "unresolved":""}
Rules:
- The snapshot has ${total} lines.
- "refs": element refs that exist in the snapshot, in page order. Include only what the INTENT needs.
- One group per logical unit (e.g. one record, one form). Put refs that belong together in the same group.
- "unresolved": empty string, or ONE short sentence naming what you could not find.`;

/** 用户消息的公共开头：怎么读这份带行号的快照。 */
const snapshotHead = (total: number): string =>
  `SNAPSHOT (${total} lines; each line starts with its line number and "|"; element refs look like eN; "→" precedes a link target or an image source; a {eN} after a link in a prose line is that link's ref):`;

/** 单次调用的用户消息：带行号的快照 + 任务 */
export function overviewUser(numberedMech: string, totalLines: number): string {
  return `${snapshotHead(totalLines)}\n${numberedMech}\n\n${OVERVIEW_TASK(totalLines)}`;
}

export function intentUser(
  numberedMech: string,
  totalLines: number,
  intent: string,
): string {
  return `${snapshotHead(totalLines)}\n${numberedMech}\n\n${INTENT_TASK(intent, totalLines)}`;
}

/** 读大页面 agent 的开场任务文字 */
export function readerTask(a: {
  fileMarker: string;
  totalLines: number;
  structure: string;
  intent: string | null;
}): string {
  const task =
    a.intent === null || a.intent === ""
      ? OVERVIEW_TASK(a.totalLines)
      : INTENT_TASK(a.intent, a.totalLines);
  return `PAGE TEXT FILE: ${a.fileMarker}
The file has ${a.totalLines} lines. Read line ranges with the read tool (path from the marker line above; use offset and limit), search with grep. Line numbers below are the file's line numbers.

STRUCTURE VIEW:
${a.structure}

${task}

When done, call deliver once: summary = "done", report = the JSON document only.`;
}
