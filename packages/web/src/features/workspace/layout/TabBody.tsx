import type { CSSProperties, ReactNode } from "react";
import { isZoomable } from "../model/tabKinds";
import type { Tab } from "../model/types";
import { TabZoomBadge, TabZoomProvider, useTabZoom } from "../tabs/tabZoom";

// 当前标签的内容区：撑满窗格，并给能缩放的类型接上 Ctrl+滚轮缩放（--tab-zoom 由 ui/type.css 的内容族字号乘上）。
export function TabBody({
  tab,
  label,
  children,
}: {
  tab: Tab;
  label: string;
  children: ReactNode;
}) {
  const zoomable = isZoomable(tab.type);
  const { ref, scale, reset } = useTabZoom(tab.id, zoomable);
  const style =
    scale === 1 ? undefined : ({ "--tab-zoom": scale } as CSSProperties);
  return (
    <div
      ref={ref}
      className="ws-tabbody"
      role="tabpanel"
      data-tid={tab.id}
      aria-label={label}
      style={style}
    >
      <TabZoomProvider value={scale}>{children}</TabZoomProvider>
      {zoomable && <TabZoomBadge scale={scale} onReset={reset} />}
    </div>
  );
}
