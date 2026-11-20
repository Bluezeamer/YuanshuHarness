// HTML 文件的另一种预览：交给工作区浏览器（相对链接、本地样式与脚本都能用）。入口是工具条里「预览 / 编辑」旁的一个按钮。
import { useState } from "react";
import { openPage } from "../../../../api/browser";
import { loadToken } from "../../../../api/http";
import { Button, toast } from "../../../../ui";
import { useLayoutStore } from "../../layoutContext";
import { BarPortal } from "./BarSlots";

export function HtmlInBrowser({
  host,
  path,
  fromPid,
}: {
  host: string;
  path: string;
  /** 来源窗格：浏览器标签新开时放在它右侧 */
  fromPid: string;
}) {
  const layout = useLayoutStore();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    const workspaceId = layout.getState().workspaceId;
    if (workspaceId === null) return;
    setBusy(true);
    const r = await openPage(loadToken(), workspaceId, `${host}:${path}`);
    setBusy(false);
    if (!r.ok) toast(r.message, { tone: "danger" });
    else layout.openInBrowser(fromPid, r.data.page.id);
  };

  return (
    <BarPortal slot="lead">
      <Button size="sm" variant="ghost" loading={busy} onClick={open}>
        在浏览器中打开
      </Button>
    </BarPortal>
  );
}
