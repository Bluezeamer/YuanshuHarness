// 输入框草稿文本的本地持久化（刷新不丢）。只存文本：引用 chip 与附件引用依赖会话内的上传状态，不落盘。
// 按会话 id 一个键；空文本就删键，避免留下一堆空条目。读写走 app/localState。
import {
  decodeLocal,
  localKey,
  localPrefix,
  readLocal,
  removeLocal,
  writeLocal,
} from "../../../app/localState";

const NS = "chat.draft";
const asText = (v: unknown) => (typeof v === "string" ? v : null);

export const draftKey = (id: string) => localKey(NS, id);

/** 反查键对应的会话 id；不是草稿键返回 null。 */
export const idOfDraftKey = (key: string | null): string | null =>
  key?.startsWith(localPrefix(NS))
    ? decodeURIComponent(key.slice(localPrefix(NS).length))
    : null;

/** storage 事件里的原始值（别的浏览器标签写的）转成文本；被删了是空串 */
export const draftTextOf = (raw: string | null): string =>
  decodeLocal(raw, asText) ?? "";

export const loadDraftText = (id: string): string =>
  readLocal(draftKey(id), asText) ?? "";

export function saveDraftText(id: string, text: string): void {
  if (text === "") removeLocal(draftKey(id));
  else writeLocal(draftKey(id), text);
}
