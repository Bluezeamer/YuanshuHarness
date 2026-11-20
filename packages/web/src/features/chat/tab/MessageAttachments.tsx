// 历史消息里的附件卡片：图片缩略图走 content 接口，点图片看大图、点其它直接下载。
import { useState } from "react";
import type { MessageAttachment } from "../../../api";
import { ImageViewer } from "../../../ui";
import { isInlineImageMime } from "../model/attachmentMime";
import { AttachmentChip } from "./AttachmentChip";
import { saveAttachment } from "./download";
import { useAttachmentSrcs } from "./useAttachmentSrcs";

const isImage = (a: MessageAttachment): boolean => isInlineImageMime(a.mime);

export function MessageAttachments({
  sessionId,
  attachments,
}: {
  sessionId: string;
  attachments: readonly MessageAttachment[];
}) {
  const items = attachments.flatMap((a) =>
    isImage(a) ? [{ key: a.path, mimeType: a.mime, path: a.path }] : [],
  );
  const srcs = useAttachmentSrcs(items, sessionId);
  const [viewing, setViewing] = useState<number | null>(null);
  const viewerImages = attachments.flatMap((a) => {
    const src = srcs.get(a.path);
    return isImage(a) && src ? [{ id: a.path, name: a.name, src }] : [];
  });

  const open = (a: MessageAttachment) => {
    const i = isImage(a) ? viewerImages.findIndex((v) => v.id === a.path) : -1;
    if (i >= 0) {
      setViewing(i);
      return;
    }
    // 图片还在取缩略图时先不响应；其它类型直接下载。
    if (!isImage(a)) void saveAttachment(sessionId, a.path, a.name);
  };

  return (
    <>
      <ul className="ch-filelist ch-filelist-msg" aria-label="附件">
        {attachments.map((a) => (
          <AttachmentChip
            key={a.path}
            name={a.name}
            mimeType={a.mime}
            sizeText={a.sizeText}
            status="ready"
            src={srcs.get(a.path) ?? null}
            onOpen={() => open(a)}
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
