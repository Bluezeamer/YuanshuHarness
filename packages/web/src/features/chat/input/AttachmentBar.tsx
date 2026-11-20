// 附件条：一个输入框里待发送的附件（缩略图 / 文件卡片，上传进度、失败重试、移除），点图片看大图、点文件下载。
// 主输入框、提问回答、目标编辑、排队编辑共用；附件放在哪里由 AttachmentSink 决定。

import { useState } from "react";
import { ImageViewer } from "../../../ui";
import { isInlineImageMime } from "../model/attachmentMime";
import type { Attachment } from "../model/draft";
import { AttachmentChip } from "../tab/AttachmentChip";
import { saveAttachment } from "../tab/download";
import { sizeText } from "../tab/format";
import { useAttachmentSrcs } from "../tab/useAttachmentSrcs";
import type { AttachmentSink } from "./attachments";
import type { AttachmentUploads } from "./useUploads";

export function AttachmentBar({
  sessionId,
  sink,
  uploads,
}: {
  sessionId: string;
  sink: AttachmentSink;
  uploads: AttachmentUploads;
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  const images = sink.list.filter((a) => isInlineImageMime(a.mimeType));
  const srcs = useAttachmentSrcs(
    images
      .filter((a) => a.status === "ready")
      .map((a) => ({ key: a.id, mimeType: a.mimeType, path: a.path })),
    sessionId,
  );
  // 图片缩略图：上传中用本地 objectURL，完成后优先用 content 接口的 blob。
  const srcOf = (a: Attachment): string | null =>
    a.status === "ready"
      ? (srcs.get(a.id) ?? a.previewUrl ?? null)
      : (a.previewUrl ?? null);
  const viewerImages = images.flatMap((a) => {
    const src = srcOf(a);
    return src ? [{ id: a.id, name: a.name, src }] : [];
  });

  const open = (a: Attachment) => {
    const i = viewerImages.findIndex((v) => v.id === a.id);
    if (i >= 0) {
      setViewing(i);
      return;
    }
    // 图片还在取缩略图时先不响应；其它类型（含 GIF）直接下载。
    if (!isInlineImageMime(a.mimeType))
      void saveAttachment(sessionId, a.path, a.name);
  };

  const remove = (a: Attachment) => {
    uploads.forget(a.id);
    if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    sink.remove(a.id);
  };

  if (sink.list.length === 0) return null;
  return (
    <>
      <ul className="ch-filelist" aria-label="附件" data-attach-row="">
        {sink.list.map((a) => (
          <AttachmentChip
            key={a.id}
            name={a.name}
            mimeType={a.mimeType}
            sizeText={a.sizeText ?? sizeText(a.size)}
            status={a.status}
            progress={a.progress}
            error={a.error}
            src={srcOf(a)}
            onOpen={a.status === "ready" ? () => open(a) : undefined}
            onRetry={a.status === "error" ? () => uploads.retry(a) : undefined}
            onRemove={() => remove(a)}
          />
        ))}
      </ul>
      {viewing !== null && viewerImages[viewing] && (
        <ImageViewer
          images={viewerImages}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}
