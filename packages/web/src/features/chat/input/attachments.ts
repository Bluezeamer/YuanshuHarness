// 附件列表的读写口：会话草稿、提问回答、目标编辑、排队编辑各有各的存放处，
// 上传链路与附件条只认这个口，所以「哪里都能带附件」不用每处各写一套。

import { useCallback, useState } from "react";
import type { MessageAttachment } from "../../../api";
import type { ChatActions } from "../hooks";
import type { Attachment } from "../model/draft";

export interface AttachmentSink {
  list: readonly Attachment[];
  add(file: Omit<Attachment, "id">): Attachment;
  update(id: string, patch: Partial<Attachment>): void;
  remove(id: string): void;
}

// 上传链路按附件 id 缓存原始文件，id 要全局唯一：本地存放的 id 带 l 前缀，不会与会话草稿的 a<n> 撞，
// 计数器放在模块里，同时存在的几个输入框（提问回答、目标编辑……）之间也不会撞。
let localSeq = 0;
const withId = (file: Omit<Attachment, "id">): Attachment => ({
  ...file,
  id: `l${++localSeq}`,
});

/** 本地存放（组件自己的状态）：用于不属于会话草稿的输入框。 */
export function useLocalAttachments(
  initial: readonly Omit<Attachment, "id">[] = [],
): AttachmentSink & { reset(next: readonly Omit<Attachment, "id">[]): void } {
  const [list, setList] = useState<readonly Attachment[]>(() =>
    initial.map(withId),
  );
  return {
    list,
    add: useCallback((file) => {
      const att = withId(file);
      setList((l) => [...l, att]);
      return att;
    }, []),
    update: useCallback(
      (id, patch) =>
        setList((l) => l.map((a) => (a.id === id ? { ...a, ...patch } : a))),
      [],
    ),
    remove: useCallback(
      (id) => setList((l) => l.filter((a) => a.id !== id)),
      [],
    ),
    reset: useCallback((next) => setList(next.map(withId)), []),
  };
}

/** 会话草稿里的附件：存放在会话 store 里，同一会话的几个标签共用，切走再回来还在。 */
export const draftSink = (
  list: readonly Attachment[],
  actions: Pick<
    ChatActions,
    "addAttachment" | "updateAttachment" | "removeAttachment"
  >,
): AttachmentSink => ({
  list,
  add: actions.addAttachment,
  update: actions.updateAttachment,
  remove: actions.removeAttachment,
});

/** 服务端给的附件引用（历史消息、目标、排队消息）→ 已就绪的附件：文件早已在附件区，不用再上传。 */
export function refToAttachment(
  ref: MessageAttachment,
): Omit<Attachment, "id"> {
  return {
    name: ref.name,
    mimeType: ref.mime,
    size: 0,
    sizeText: ref.sizeText,
    path: ref.path,
    status: "ready",
    progress: 100,
  };
}

/** 发出去的附件引用：只带路径，字节与类型由服务端按磁盘重新识别。 */
export const attachmentPaths = (
  list: readonly Attachment[],
): { path: string }[] => list.map((a) => ({ path: a.path }));

/** 还有附件没就绪时给出不能发送的原因，全部就绪返回 null。 */
export function pendingReason(list: readonly Attachment[]): string | null {
  if (list.some((a) => a.status === "uploading"))
    return "附件还在上传，请稍候再发送";
  if (list.some((a) => a.status === "error"))
    return "有附件上传失败，请重试或移除";
  return null;
}
