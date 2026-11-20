import { readFileSync } from "node:fs";
import { splitAttachmentMarkers } from "../session/attachments.js";
import { messageText } from "../session/events.js";

// 列表标题的种子：首条用户消息的前若干个字。与 name 一样进索引表缓存。
export const PREVIEW_MAX = 48;

export type PreviewEntry = {
  type: string;
  message?: { role?: unknown; content?: unknown };
};

// 用户消息文本 → 标题种子：去掉附件尾行、折叠空白，按码点截断。
export function previewOf(text: string): string | null {
  const clean = splitAttachmentMarkers(text).text.replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  const chars = [...clean];
  return chars.length <= PREVIEW_MAX
    ? clean
    : chars.slice(0, PREVIEW_MAX).join("");
}

// 单条目 → 标题种子；非用户消息或清完为空都返回 null。
function entryPreview(e: PreviewEntry): string | null {
  if (e.type !== "message" || e.message?.role !== "user") return null;
  return previewOf(messageText(e.message.content));
}

export function firstPreview(entries: readonly PreviewEntry[]): string | null {
  for (const e of entries) {
    const text = entryPreview(e);
    if (text !== null) return text;
  }
  return null;
}

// 逐行解析 JSONL，坏行跳过，找到第一条有内容的用户消息就停。
export function readPreview(file: string): string | null {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"role":"user"')) continue;
    try {
      const text = entryPreview(JSON.parse(line) as PreviewEntry);
      if (text !== null) return text;
    } catch {}
  }
  return null;
}
