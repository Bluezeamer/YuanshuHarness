import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { FileRow, SessionFileStore } from "../store/session-files.js";
import { messageText } from "./events.js";

const TRACKED = new Set(["read", "edit", "write"]);
const PATH_MAX = 4096;

// CJK（汉字、假名、谚文）一字约一 token，其余按 3.2 字符一 token。
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 3.2);
}

// read 的结果被截断：超大文件由 SDK 标 details.truncation，带 limit 的分段读取在文末给续读提示。
function truncated(result: { details?: unknown } | undefined, text: string) {
  const d = result?.details as { truncation?: { truncated?: boolean } };
  return (
    d?.truncation?.truncated === true ||
    /Use offset=\d+ to continue\.\]\s*$/.test(text)
  );
}

type Pending = { path: string; tokens: number };

/**
 * 会话内 read / edit / write 命中的文件表：工具开始时记下路径（write 另估内容 token），
 * 成功结束时合并进 session_files。只存路径与计数，不存内容；纯旁路，失败不影响会话。
 */
export class SessionFiles {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly id: string,
    private readonly store: SessionFileStore | undefined,
    // 调用结束时会话所在的环境（切换 directory 后会变）。
    private readonly hostOf: () => string,
    // 表有变化后通知订阅者，参数是当前条数。
    private readonly changed: (count: number) => void,
  ) {}

  observe(e: AgentSessionEvent): void {
    if (!this.store) return;
    if (e.type === "agent_end") {
      this.pending.clear();
    } else if (e.type === "tool_execution_start" && TRACKED.has(e.toolName)) {
      const a = (e.args ?? {}) as { path?: unknown; content?: unknown };
      const path = typeof a.path === "string" ? a.path.trim() : "";
      if (path === "" || path.length > PATH_MAX) return;
      this.pending.set(e.toolCallId, {
        path,
        tokens:
          e.toolName === "write" && typeof a.content === "string"
            ? estimateTokens(a.content)
            : 0,
      });
    } else if (e.type === "tool_execution_end") {
      const p = this.pending.get(e.toolCallId);
      if (!p) return;
      this.pending.delete(e.toolCallId);
      if (!e.isError) this.record(e.toolName, p, e.result);
    }
  }

  private record(tool: string, p: Pending, result: unknown): void {
    const { store } = this;
    if (!store) return;
    try {
      const hostId = this.hostOf();
      const row: FileRow = store.get(this.id, hostId, p.path) ?? {
        path: p.path,
        hostId,
        tokens: 0,
        reads: 0,
        modified: false,
        truncated: false,
        lastAt: "",
      };
      if (tool === "read") {
        const r = result as { content?: unknown; details?: unknown };
        const text = messageText(r?.content);
        // 分段读取时以最大的一次为准，估算文件大小而不是累加。
        row.tokens = Math.max(row.tokens, estimateTokens(text));
        row.reads += 1;
        row.truncated = truncated(r, text);
      } else {
        row.modified = true;
        // write 整体覆盖，内容即新文件；edit 不动 token 估算（没读过则为 0）。
        if (tool === "write") {
          row.tokens = p.tokens;
          row.truncated = false;
        }
      }
      row.lastAt = new Date().toISOString();
      store.put(this.id, row);
      this.changed(store.count(this.id));
    } catch {
      // 见类注释
    }
  }
}
