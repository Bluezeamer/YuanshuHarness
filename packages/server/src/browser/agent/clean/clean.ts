// 清洗器（设计稿 §8.2）：显式 snapshot、没有基线、地址变了走完整路径；否则与基线做元素级 diff。
// 动作之后一律给 diff：内联放不下就截断并声明剩余行数，全文存会话附件，不换路径、不调辅助模型。
// 基线是「agent 最近一次看到的状态」，每次交出内容之后更新；页面关闭才丢，操作权易手不丢。
// 这里永远不抛：纯函数异常兜成完整路径，连完整路径也炸了就给原始快照前一段并写明。
import { type BaselineStore, createBaselines } from "./baseline.js";
import { fitDiff, renderDiff } from "./diff-render.js";
import { diffElements, isUnchanged } from "./elemdiff.js";
import { renderEnvelope } from "./envelope.js";
import { CLEAN_LIMITS } from "./limits.js";
import { originOf, readPage } from "./read.js";
import type {
  AuxCall,
  Cleaner,
  CleanInput,
  CleanOutput,
  PageReader,
} from "./types.js";

export interface CleanerDeps {
  /** 每次现读（辅助模型的配置改了下一步就生效）；没配返回 null，此时一次模型都不调 */
  aux(): AuxCall | null;
  /** 没配 / 不可用返回 null */
  reader(): PageReader | null;
  mask(text: string): string;
  /** 测试注入用 */
  baselines?: BaselineStore;
}

/** 兜底时给的原始快照长度：完整路径全炸了也不能什么都不给。 */
const FALLBACK_RAW_CHARS = 12_000;

export function createCleaner(deps: CleanerDeps): Cleaner {
  const baselines = deps.baselines ?? createBaselines();
  // 快照编号：每次走完整路径加一，给输出里的 s1、s2… 与落盘文件名用。
  let snapshots = 0;
  // diff 编号：每次把全文落成附件加一，同一页面可能连着给好几份 diff。
  let diffs = 0;

  return {
    async clean(input: CleanInput): Promise<CleanOutput> {
      /** 交出内容之后基线换成刚交出去的状态（含 no-changes 与回落）。存不进也不影响这次结果。 */
      const commit = (): void => {
        try {
          baselines.set(input.sessionId, input.pageId, {
            raw: input.raw,
            url: input.url,
          });
        } catch {
          // 基线是优化：存不进去最多下一次走完整路径。
        }
      };

      /** 外壳里除了正文之外的部分，三条路径共用。 */
      const shell = (urlChange?: { from: string; to: string }) => ({
        title: input.title,
        url: input.url,
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(urlChange ? { urlChange } : {}),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      });

      const full = async (urlChange?: {
        from: string;
        to: string;
      }): Promise<CleanOutput> => {
        snapshots += 1;
        const snapshotId = `s${snapshots}`;
        try {
          const out = await readPage(deps, {
            sessionId: input.sessionId,
            pageId: input.pageId,
            raw: input.raw,
            url: input.url,
            title: input.title,
            intent:
              input.intent === undefined || input.intent === ""
                ? null
                : input.intent,
            snapshotId,
            saveText: input.saveText,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          commit();
          return {
            text: renderEnvelope({
              ...shell(urlChange),
              snapshot: `${snapshotId} · ${out.lines} lines`,
              body: out.body,
            }),
            stage: out.stage,
          };
        } catch {
          // readPage 内部已经全回落了；走到这里说明连它也炸了。
          commit();
          return {
            text: renderEnvelope({
              ...shell(urlChange),
              body: `NOTE: page cleaning failed; showing the raw snapshot.\n${input.raw.slice(0, FALLBACK_RAW_CHARS)}`,
            }),
            stage: "fallback",
          };
        }
      };

      try {
        // 1. 显式 snapshot：永远完整路径，不做 diff。
        if (input.explicit) return await full();
        // 2. 没有基线，或地址变了：完整路径（地址变了写 URL: 行）。
        const remembered = baselines.get(input.sessionId, input.pageId);
        if (remembered === undefined) return await full();
        if (remembered.url !== input.url)
          return await full({ from: remembered.url, to: input.url });

        // 3. 与基线做元素级 diff：永远给 diff，放不下就截断并附全文。
        const diff = diffElements(remembered.raw, input.raw);
        if (isUnchanged(diff)) {
          commit();
          return {
            text: renderEnvelope({
              ...shell(),
              body: "NO CHANGES (element tree and text only; scroll position and pixels are not compared)",
            }),
            stage: "no-changes",
          };
        }
        // 图片的同源地址在 diff 里也写成根相对，与机械层一致。
        const r = renderDiff(diff, originOf(input.url));
        const fit = fitDiff(r.lines, CLEAN_LIMITS.diffMaxChars);
        let body = fit.text;
        if (fit.hidden > 0) {
          diffs += 1;
          // 全文落成会话附件（遮罩之后）；存不上就只声明。
          let marker: string | null = null;
          try {
            marker = await input.saveText(
              `diff-${input.pageId}-d${diffs}.txt`,
              deps.mask(r.lines.join("\n")),
            );
          } catch {
            marker = null;
          }
          body += `\n… ${fit.hidden} more lines not shown (${r.added} added, ${r.changed} changed, ${r.removed} removed elements in total)`;
          body +=
            marker === null
              ? "; the full diff could not be saved"
              : `; full diff: ${marker}`;
        }
        commit();
        return { text: renderEnvelope({ ...shell(), body }), stage: "diff" };
      } catch {
        return await full();
      }
    },

    rebase(sessionId, pageId, raw, url) {
      baselines.set(sessionId, pageId, { raw, url });
    },

    forgetPage(pageId) {
      baselines.deletePage(pageId);
    },
  };
}
