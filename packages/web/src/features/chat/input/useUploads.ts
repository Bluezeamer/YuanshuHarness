// 附件上传：把选中的文件逐个上传到会话附件区，进度与结果写回附件列表（会话草稿或某个输入框自己的存放）。
// 失败保留原始 File 供重试；同一会话的多个标签共用模块级缓存（附件 id 全局唯一，见 attachments.ts）。
import { useCallback } from "react";
import { uploadAttachment } from "../../../api/attachments";
import { loadToken } from "../../../api/http";
import { isInlineImageMime } from "../model/attachmentMime";
import type { Attachment } from "../model/draft";
import type { AttachmentSink } from "./attachments";

const originals = new Map<string, File>();

export interface AttachmentUploads {
  add(files: readonly File[]): void;
  retry(att: Attachment): void;
  forget(id: string): void;
}

export function useUploads(
  sessionId: string,
  sink: Pick<AttachmentSink, "add" | "update">,
): AttachmentUploads {
  // 只依赖两个函数本身：本地存放每次渲染都是新对象，函数是稳定的
  const { add: sinkAdd, update: sinkUpdate } = sink;
  const upload = useCallback(
    async (att: Attachment) => {
      const file = originals.get(att.id);
      if (!file) {
        sinkUpdate(att.id, {
          status: "error",
          progress: null,
          error: "原始文件已不可用，请重新选择",
        });
        return;
      }
      sinkUpdate(att.id, {
        status: "uploading",
        progress: 0,
        error: undefined,
      });
      const r = await uploadAttachment(
        loadToken(),
        sessionId,
        file,
        (percent) => {
          sinkUpdate(att.id, { progress: percent });
        },
      );
      if (r.ok) {
        originals.delete(att.id);
        sinkUpdate(att.id, {
          status: "ready",
          path: r.data.path,
          name: r.data.name,
          mimeType: r.data.mime,
          size: r.data.size,
          progress: 100,
          error: undefined,
        });
      } else {
        sinkUpdate(att.id, {
          status: "error",
          progress: null,
          error: r.message,
        });
      }
    },
    [sinkUpdate, sessionId],
  );

  const add = useCallback(
    (files: readonly File[]) => {
      for (const file of files) {
        const att = sinkAdd({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          path: "",
          status: "uploading",
          progress: 0,
          // 上传中先用本地 objectURL 当缩略图，完成后改用 content 接口；GIF 等按文件显示
          ...(isInlineImageMime(file.type)
            ? { previewUrl: URL.createObjectURL(file) }
            : {}),
        });
        originals.set(att.id, file);
        void upload(att);
      }
    },
    [sinkAdd, upload],
  );

  const retry = useCallback((att: Attachment) => void upload(att), [upload]);

  /** 移除附件时清掉原始文件，避免重试缓存越积越多 */
  const forget = useCallback((id: string) => void originals.delete(id), []);

  return { add, retry, forget };
}
