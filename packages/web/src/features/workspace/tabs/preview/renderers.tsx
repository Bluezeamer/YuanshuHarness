// 富内容渲染的总入口：PreviewTab 只按 state 分流，格式细节都收在这里，
// 新增格式只改这个文件与对应 View，不用再往 PreviewTab 里堆分支。
// 所有富内容都套一层 Ctrl+滚轮缩放（改预览大小，不影响浏览器页面缩放）。
import type { ReactNode } from "react";
import { Button, Empty } from "../../../../ui";
import { DocxView } from "./DocxView";
import { EpubView } from "./EpubView";
import { baseName, type ParseKind } from "./kind";
import { limitHint } from "./limits";
import { PptxView } from "./PptxView";
import { SheetView } from "./SheetView";
import type { PreviewState } from "./usePreview";
import { useWheelZoom, ZoomBadge } from "./useWheelZoom";

/** 需要 RichView 接手的 state。 */
export function isRich(state: PreviewState): boolean {
  return (
    state.kind === "docx" ||
    state.kind === "sheet" ||
    state.kind === "pptx" ||
    state.kind === "epub" ||
    state.kind === "too_large"
  );
}

const parseView = (
  kind: ParseKind,
  bytes: Uint8Array,
  path: string,
): ReactNode => {
  if (kind === "docx") return <DocxView bytes={bytes} />;
  if (kind === "sheet")
    return <SheetView bytes={bytes} name={baseName(path)} />;
  if (kind === "pptx") return <PptxView bytes={bytes} />;
  return <EpubView bytes={bytes} />;
};

export function RichView({
  state,
  path,
  busy,
  onDownload,
}: {
  state: PreviewState;
  path: string;
  busy: boolean;
  onDownload: () => void;
}) {
  const { ref, scale, reset } = useWheelZoom();
  // 「太大」提示不参与缩放，其余富内容都套缩放层
  const zoomable = state.kind !== "too_large";

  const body = ((): ReactNode => {
    if (state.kind === "too_large")
      return (
        <Empty
          title="文件太大，不在这里打开"
          description={limitHint(state.max)}
          action={
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              onClick={onDownload}
            >
              下载
            </Button>
          }
        />
      );
    if (state.kind === "docx" || state.kind === "sheet")
      return parseView(state.kind, state.bytes, path);
    if (state.kind === "pptx" || state.kind === "epub")
      return parseView(state.kind, state.bytes, path);
    return null;
  })();

  return (
    <div className="ws-pv-rich" ref={ref}>
      {zoomable ? (
        <div className="ws-pv-rich-in" style={{ zoom: scale }}>
          {body}
        </div>
      ) : (
        body
      )}
      <ZoomBadge scale={scale} onReset={reset} />
    </div>
  );
}
