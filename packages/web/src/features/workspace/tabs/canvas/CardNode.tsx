// 灵感卡与笔记：平时显示渲染好的 markdown，双击就地换成编辑器。
// 卡片名在卡片上方用灰字标出；随手记默认的时间名不显示，用户改过名才显示。
// 笔记不属于这块画布，上方一律标「笔记 · 路径」，一眼和灵感卡区分。
import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { cx } from "../../../../ui/cx";
import { InlineEditor } from "./InlineEditor";
import { type FlowNode, isAutoTitle } from "./model";
import { useNodeCtx } from "./nodeCtx";
import {
  CardMarkdown,
  Handles,
  NodeBody,
  NodeLabel,
  Resizer,
} from "./nodeParts";

export const CardNode = memo(function CardNode({
  id,
  data,
  selected,
}: NodeProps<FlowNode>) {
  const ctx = useNodeCtx();
  const editing = ctx.editing === id;
  const missing = data.info !== null && !data.info.exists;
  const note = data.kind === "note";
  const title = note
    ? `笔记 · ${data.title}`
    : data.draft || isAutoTitle(data.title)
      ? ""
      : data.title;
  const preview = data.info?.preview ?? "";

  return (
    <div
      className="cv-node cv-card"
      data-selected={selected || undefined}
      data-missing={missing || undefined}
      data-editing={editing || undefined}
      onKeyDownCapture={(e) => {
        if (!editing || e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        ctx.exitEdit();
      }}
    >
      <Resizer selected={selected} />
      <Handles />
      {(title || data.dirty) && (
        <NodeLabel dirty={data.dirty}>
          {title && (
            <span className="cv-labtext" title={data.file}>
              {title}
            </span>
          )}
        </NodeLabel>
      )}
      <div className="cv-box">
        <NodeBody
          className={cx(
            editing ? "nodrag nopan nowheel nokey" : selected && "nowheel",
          )}
          data-cut={!editing && data.info?.truncated ? "" : undefined}
        >
          {editing ? (
            <InlineEditor file={data.file} />
          ) : missing ? (
            <div className="cv-muted t-aux cv-pad">文件缺失</div>
          ) : preview ? (
            <CardMarkdown text={preview} />
          ) : (
            <div className="cv-muted t-aux">
              {note ? "空笔记，双击编辑" : "空卡片，双击编辑"}
            </div>
          )}
        </NodeBody>
      </div>
    </div>
  );
});
