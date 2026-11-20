// 「完整路径」（设计稿 §8.1、§8.3）：机械层 → 小页面直给 / 单次辅助调用 / 只读 agent 读大页面。
// 依赖全部注入（辅助模型、读页面 agent、变量遮罩），失败一律回落并写明原因，不静默降级。
import { CLEAN_LIMITS } from "./limits.js";
import { mechanical } from "./mech.js";
import {
  type IntentPointers,
  type OverviewPointers,
  parseIntent,
  parseOverview,
} from "./pointers.js";
import { indexRaw, projectIntent, projectOverview } from "./project.js";
import {
  INTENT_SYSTEM,
  intentUser,
  OVERVIEW_SYSTEM,
  overviewUser,
  readerTask,
} from "./prompts.js";
import { numberLines, structureView } from "./structure.js";
import type { AuxCall, CleanOutput, PageReader } from "./types.js";

export interface ReadDeps {
  /** 每次现读：没配辅助模型返回 null */
  aux(): AuxCall | null;
  /** 没配 / 不可用返回 null */
  reader(): PageReader | null;
  mask(text: string): string;
}

export interface ReadArgs {
  sessionId: string;
  pageId: string;
  raw: string;
  url: string;
  title: string;
  intent: string | null;
  snapshotId: string;
  saveText(name: string, text: string): Promise<string>;
  signal?: AbortSignal;
}

export interface ReadResult {
  body: string;
  stage: CleanOutput["stage"];
  lines: number;
}

/** 页面 origin；`"null"`（about:blank 之类）与解析失败都当空串。 */
export function originOf(url: string): string {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
}

/** 解析失败的原因、agent 没有结果与存不了文件的原因，写进回落说明行。 */
const UNUSABLE = "returned an unusable answer";
const NO_AGENT_RESULT = "reader agent gave no result";
const SAVE_FAILED = "could not save the page text file";

type Parsed =
  | { kind: "overview"; pointers: OverviewPointers }
  | { kind: "intent"; pointers: IntentPointers };

export async function readPage(
  deps: ReadDeps,
  a: ReadArgs,
): Promise<ReadResult> {
  const origin = originOf(a.url);
  const mech = mechanical(a.raw, origin);
  const lines = (mech.endsWith("\n") ? mech.slice(0, -1) : mech).split(
    "\n",
  ).length;
  const chars = mech.length;
  const intent = a.intent === null || a.intent === "" ? null : a.intent;

  const parse = (reply: string): Parsed | null => {
    if (intent !== null) {
      const pointers = parseIntent(reply);
      return pointers === null ? null : { kind: "intent", pointers };
    }
    const pointers = parseOverview(reply);
    return pointers === null ? null : { kind: "overview", pointers };
  };

  /** overview 追加取回行：整份 MechText（遮罩后）落在会话附件区。 */
  const fullTextLine = (marker: string): string =>
    `FULL TEXT (${lines} lines; the L<n> numbers above are its line numbers): ${marker}`;

  const fileName = (): string => `page-${a.pageId}-${a.snapshotId}.txt`;
  const saveMech = (): Promise<string> =>
    a.saveText(fileName(), deps.mask(mech));
  const safeSave = async (): Promise<string | null> => {
    try {
      return await saveMech();
    } catch {
      return null;
    }
  };

  /** 投影：事实从原始快照展开，overview 末尾带取回行的文件标记。 */
  const project = (parsed: Parsed, marker: string | null): string => {
    const idx = indexRaw(a.raw, origin);
    if (parsed.kind === "intent")
      return projectIntent(parsed.pointers, idx, intent ?? "").text;
    const body = projectOverview(parsed.pointers, idx, mech).text;
    return marker === null ? body : `${body}\n${fullTextLine(marker)}`;
  };

  /** 回落：按内联上限给全文或结构视图，最前面一行写明原因。 */
  const fallback = async (
    reason: string,
    marker: string | null,
  ): Promise<ReadResult> => {
    let body = mech;
    if (chars > CLEAN_LIMITS.inlineMaxChars) {
      const saved = marker ?? (await safeSave());
      const view = structureView(mech);
      body = saved === null ? view : `${view}\n${fullTextLine(saved)}`;
    }
    return {
      body: `NOTE: page-reading model unavailable (${reason}); showing the page without a model summary.\n${body}`,
      stage: "fallback",
      lines,
    };
  };

  // 下限：这么小的页面几乎全是有效信息，直接给机械层输出。
  if (chars <= CLEAN_LIMITS.directMaxChars)
    return { body: mech, stage: "direct", lines };

  try {
    const aux = deps.aux();
    if (aux !== null) {
      if (chars <= CLEAN_LIMITS.singleCallMaxChars) {
        const system = intent === null ? OVERVIEW_SYSTEM : INTENT_SYSTEM;
        const user =
          intent === null
            ? overviewUser(deps.mask(numberLines(mech)), lines)
            : intentUser(deps.mask(numberLines(mech)), lines, intent);
        // 解析失败重试一次；两次都不成就回落。
        let parsed: Parsed | null = null;
        for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
          try {
            parsed = parse(await aux({ system, user }));
          } catch {
            parsed = null;
          }
        }
        if (parsed === null) return await fallback(UNUSABLE, null);
        // intent 路径不存文件：要的元素已经逐条展开了。
        if (intent !== null)
          return { body: project(parsed, null), stage: "aux", lines };
        const marker = await safeSave();
        if (marker === null) return await fallback(SAVE_FAILED, null);
        return { body: project(parsed, marker), stage: "aux", lines };
      }

      // 大页面：交给只读 agent 按结构视图自己读那份文件（不重试）。
      const reader = deps.reader();
      if (reader === null) return await fallback(NO_AGENT_RESULT, null);
      const marker = await safeSave();
      if (marker === null) return await fallback(SAVE_FAILED, null);
      const task = readerTask({
        fileMarker: marker,
        totalLines: lines,
        // 结构视图用遮罩后的文本生成，免得隐私变量进 agent 的消息。
        structure: structureView(deps.mask(mech)),
        intent,
      });
      const label = `页面阅读：${a.title.replace(/\s+/g, " ").trim().slice(0, 30)}`;
      let reply: string | null = null;
      try {
        reply = await reader({
          sessionId: a.sessionId,
          task,
          label,
          signal: a.signal,
        });
      } catch {
        reply = null;
      }
      if (reply === null) return await fallback(NO_AGENT_RESULT, marker);
      const parsed = parse(reply);
      if (parsed === null) return await fallback(UNUSABLE, marker);
      return { body: project(parsed, marker), stage: "agent", lines };
    }

    // 没配辅助模型：放得下就整份给，放不下给结构视图 + 文件。
    if (chars <= CLEAN_LIMITS.inlineMaxChars)
      return { body: mech, stage: "inline", lines };
    const marker = await safeSave();
    if (marker === null) return await fallback(SAVE_FAILED, null);
    return {
      body: `${structureView(mech)}\n${fullTextLine(marker)}`,
      stage: "structure",
      lines,
    };
  } catch {
    return await fallback(UNUSABLE, null);
  }
}
