// 画布的连线：两层。点击感应层（透明、屏幕上 12px 宽）留在连线本来的位置（卡片之下），免得挡住卡片与连接点的操作；
// 看得见的线、箭头与标签画在 EdgeLabelRenderer 里（样式里把它抬到卡片之上），不接收鼠标。
// 线宽 2px 靠 vector-effect 不随缩放变；箭头、标签、感应宽度按缩放倒数换算，所以缩放时大小不变。
import {
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  useStore,
} from "@xyflow/react";
import { memo, useState } from "react";
import { ARROW_PX, arrowPoints, EDGE_HIT_PX } from "./edgeGeom";

const zoomOf = (s: { transform: [number, number, number] }) => s.transform[2];

export const CanvasEdge = memo(function CanvasEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  label,
}: EdgeProps) {
  const zoom = useStore(zoomOf);
  const [hover, setHover] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const color = selected
    ? "var(--accent)"
    : hover
      ? "var(--fg-3)"
      : "var(--cv-edge)";
  return (
    <>
      <path
        className="react-flow__edge-interaction"
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={EDGE_HIT_PX / zoom}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
      />
      <EdgeLabelRenderer>
        <svg className="cv-edge-over" aria-hidden="true">
          <path
            d={path}
            fill="none"
            stroke={color}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          <polygon
            points={arrowPoints(
              targetX,
              targetY,
              targetPosition,
              ARROW_PX / zoom,
            )}
            fill={color}
          />
        </svg>
        {typeof label === "string" && label !== "" && (
          <div
            className="cv-edge-label t-aux"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${1 / zoom})`,
            }}
          >
            {label}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
});
