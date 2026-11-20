// 附件卡片：Composer 草稿与历史消息共用。图片显示缩略图，其余显示回形针；
// 上传中给进度条、失败给重试，右侧可移除（历史卡片没有这些动作）。
import { Button, IconButton, ProgressBar } from "../../../ui";
import { cx } from "../../../ui/cx";
import { CloseIcon, RefreshIcon } from "../../../ui/icons";
import { isInlineImageMime } from "../model/attachmentMime";
import { ClipGlyph } from "./glyphs";

export interface AttachmentChipProps {
  name: string;
  mimeType: string;
  sizeText: string;
  status: "uploading" | "ready" | "error";
  /** 上传进度 0–100；null 表示未知 */
  progress?: number | null;
  /** 上传失败说明 */
  error?: string;
  /** 图片缩略图 URL；没有时显示占位图标 */
  src?: string | null;
  /** 点击卡片：图片看大图、其它下载；缺省表示暂不可点 */
  onOpen?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}

export function AttachmentChip({
  name,
  mimeType,
  sizeText,
  status,
  progress = null,
  error,
  src,
  onOpen,
  onRetry,
  onRemove,
}: AttachmentChipProps) {
  const image = isInlineImageMime(mimeType);
  const meta =
    status === "uploading"
      ? progress === null
        ? "上传中…"
        : `上传中 ${progress}%`
      : status === "error"
        ? (error ?? "上传失败")
        : `${mimeType || "未知类型"} · ${sizeText}`;
  const thumb = (
    <span className="ch-file-thumb">
      {src ? (
        <img src={src} alt={name} />
      ) : (
        <ClipGlyph size={image ? 14 : 12} />
      )}
    </span>
  );
  // 图片只显示缩略图，不显示名称与类型（名称放 title / alt / aria-label，悬停可见）。
  const content = image ? (
    thumb
  ) : (
    <>
      {thumb}
      <span className="ch-file-text">
        <span className="ch-file-name t-aux" title={name}>
          {name}
        </span>
        <span className="ch-file-meta t-aux" data-status={status}>
          {meta}
        </span>
      </span>
    </>
  );
  return (
    <li
      className={cx("ch-file", image && "is-image")}
      data-status={status}
      title={image ? name : undefined}
    >
      {onOpen ? (
        <Button
          variant="ghost"
          className="ch-file-main"
          aria-label={image ? `查看大图 ${name}` : `下载附件 ${name}`}
          onClick={onOpen}
        >
          {content}
        </Button>
      ) : (
        <span className="ch-file-main">{content}</span>
      )}
      {status === "uploading" && (
        <ProgressBar
          value={progress}
          label={`上传进度 ${name}`}
          className="ch-file-progress"
        />
      )}
      {status === "error" && onRetry && (
        <IconButton
          size="sm"
          className="ch-file-action"
          label="重试"
          icon={<RefreshIcon size={12} />}
          onClick={onRetry}
        />
      )}
      {onRemove && (
        <IconButton
          size="sm"
          className="ch-file-x"
          label={`移除附件 ${name}`}
          icon={<CloseIcon size={12} />}
          onClick={onRemove}
        />
      )}
    </li>
  );
}
