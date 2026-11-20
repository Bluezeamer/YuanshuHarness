import { lazy, Suspense } from "react";
import { Loading } from "../../../../ui";
import { registerTab, tabTypeLabel } from "../registry";

// 画布组件库自带一批色值，按需加载，不进入口包（与 mermaid 同理）
const CanvasTab = lazy(() =>
  import("./CanvasTab").then((m) => ({ default: m.CanvasTab })),
);

/** 把 canvas 标签注册进标签注册表；应用启动时调用一次。标题取画布名，提示里放它所在的目录 */
export function registerCanvasTab(): void {
  registerTab("canvas", {
    icon: (
      <svg
        width="11"
        height="11"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2.5 3.5h5v4h-5zM9 9h4.5v4H9zM7.5 5.5H11V9" />
      </svg>
    ),
    title: (tab) => tab.canvas ?? tabTypeLabel("canvas"),
    tip: (tab) => tab.path ?? "",
    render: (props) => (
      <Suspense fallback={<Loading>正在读取</Loading>}>
        <CanvasTab {...props} />
      </Suspense>
    ),
  });
}
