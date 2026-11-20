// 标签类型的真实渲染器按需加载：终端、CodeMirror、画布、PDF 这些重依赖不进手机入口的主包，打开那一类标签页时才取。
// 加载后注册进桌面同一份注册表（registerXxxTab 幂等）；浏览器标签不走注册表，手机用自己的只读画面页（BrowserPage）。
import { useEffect, useState } from "react";
import type { TabType } from "../../features/workspace/model/types";
import { getTabDef, type TabDef } from "../../features/workspace/tabs/registry";

type Loadable = Exclude<TabType, "chat" | "web">;

const LOADERS: Record<Loadable, () => Promise<void>> = {
  sub: () => import("../../features/chat/exec").then((m) => m.registerSubTab()),
  job: () => import("../../features/chat/job").then((m) => m.registerJobTab()),
  term: () =>
    import("../../features/workspace/tabs/terminal/wiring").then((m) =>
      m.registerTerminalTab(),
    ),
  files: () =>
    import("../../features/workspace/tabs/files").then((m) =>
      m.registerFilesTab(),
    ),
  preview: () =>
    import("../../features/workspace/tabs/preview").then((m) =>
      m.registerPreviewTab(),
    ),
  canvas: () =>
    import("../../features/workspace/tabs/canvas").then((m) =>
      m.registerCanvasTab(),
    ),
};

const loaded = new Set<Loadable>();

/** 取这个类型的渲染器；还在加载时返回 null */
export function useTabDef(type: Loadable): TabDef | null {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (loaded.has(type)) return;
    let alive = true;
    void LOADERS[type]().then(() => {
      loaded.add(type);
      if (alive) rerender((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [type]);
  return loaded.has(type) ? getTabDef(type) : null;
}
