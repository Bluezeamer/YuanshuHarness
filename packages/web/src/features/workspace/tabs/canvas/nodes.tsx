// 画布上的节点类型表。灵感卡（笔记同一个组件）、项目文件引用、网页链接各有自己的文件；分组与其余（别处建的文字节点，只读展示）在这里。
import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { CardNode } from "./CardNode";
import { LinkNode } from "./LinkNode";
import type { FlowNode } from "./model";
import { Handles, Resizer } from "./nodeParts";
import { RefNode } from "./RefNode";

const GroupNode = memo(function GroupNode({
  data,
  selected,
}: NodeProps<FlowNode>) {
  return (
    <div className="cv-node cv-group" data-selected={selected || undefined}>
      <Resizer selected={selected} />
      <Handles />
      {data.label && <div className="cv-glabel t-aux">{data.label}</div>}
    </div>
  );
});

const OtherNode = memo(function OtherNode({
  data,
  selected,
}: NodeProps<FlowNode>) {
  return (
    <div className="cv-node" data-selected={selected || undefined}>
      <Resizer selected={selected} />
      <Handles />
      <div className="cv-box">
        <div className="cv-nbody">
          {data.label ? (
            <div className="t-plain cv-plain">{data.label}</div>
          ) : (
            <div className="cv-muted t-aux">（这种节点界面只显示，不编辑）</div>
          )}
        </div>
      </div>
    </div>
  );
});

export const NODE_TYPES = {
  card: CardNode,
  note: CardNode,
  ref: RefNode,
  link: LinkNode,
  group: GroupNode,
  other: OtherNode,
};
