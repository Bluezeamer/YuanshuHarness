import { useMemo, useState } from "react";
import { TAB_KINDS } from "../../features/workspace/model/tabKinds";
import type { Tab, TabAfx } from "../../features/workspace/model/types";
import { useTitleRev } from "../../features/workspace/tabs/registry";
import { Loading } from "../../ui";
import { useNav } from "../nav/NavProvider";
import { TopBar } from "../ui/TopBar";
import { BrowserPage } from "./BrowserPage";
import { useTabDef } from "./tabDefs";

// 标签页（文件、终端、画布、预览、执行体、任务）：把桌面的标签渲染器放进「单标签的假窗格」，一页一个标签。
// 标签自己的字段（路径、终端 id…）在 URL 里，patchTab 就是换掉当前这条历史；界面状态（右栏展开之类）只活在这一页。
export function TabPage({ tab }: { tab: Tab }) {
  if (tab.type === "web") return <BrowserPage tab={tab} />;
  if (tab.type === "chat") return null;
  return <RegisteredTab tab={tab} type={tab.type} />;
}

function RegisteredTab({
  tab,
  type,
}: {
  tab: Tab;
  type: Exclude<Tab["type"], "chat" | "web">;
}) {
  const nav = useNav();
  const def = useTabDef(type);
  useTitleRev();
  const [afx, setAfx] = useState<TabAfx>({});
  const shown = useMemo(() => ({ ...tab, afx }), [tab, afx]);

  return (
    <div className="m-page">
      <TopBar
        title={def ? def.title(shown) : TAB_KINDS[type].label}
        onBack={nav.back}
      />
      <div className="m-tabbody">
        {def ? (
          def.render({
            tab: shown,
            pane: {
              pid: "m",
              host: tab.host ?? null,
              tabs: [shown],
              active: shown.id,
            },
            sessionId: tab.sid ?? null,
            active: true,
            patchTab: (patch) =>
              nav.replace({ name: "tab", tab: { ...tab, ...patch } }),
            patchAfx: (patch) => setAfx((a) => ({ ...a, ...patch })),
            close: nav.back,
          })
        ) : (
          <Loading>正在打开…</Loading>
        )}
      </div>
    </div>
  );
}
