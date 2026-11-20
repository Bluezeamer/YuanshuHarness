import { useState } from "react";
import {
  useHostName,
  useLayoutDirectories,
} from "../../features/workspace/layoutContext";
import type { TabInit } from "../../features/workspace/model/l2";
import { orderHostChoices } from "../../features/workspace/model/l2";
import type { TabType } from "../../features/workspace/model/types";
import { ListRow, Sheet } from "../../ui";
import {
  CanvasIcon,
  ChatIcon,
  FileIcon,
  GlobeIcon,
  TerminalIcon,
} from "../../ui/icons";
import { mobileTab } from "../layout/mobileLayout";
import { useNav } from "../nav/NavProvider";

// 工具抽屉：在当前工作区新建文件、终端、浏览器、画布标签页；对话页里还多一个「审计」入口。
// 选中后用 replace 把这一层换成目标页（不是再 push），返回一次就回到发起它的页面。
export function ToolsSheet({
  sid,
  withAudit = false,
}: {
  sid: string;
  /** 对话页里多一个「审计」入口 */
  withAudit?: boolean;
}) {
  const nav = useNav();
  const directories = useLayoutDirectories();
  const hostName = useHostName();
  const [picking, setPicking] = useState<"term" | "files" | null>(null);

  // 工作区级标签都带上这条会话：它既是「借一条会话流」的锚点，也让深链接能找回所属工作区
  const go = (type: TabType, init: TabInit = {}) =>
    nav.replace({ name: "tab", tab: mobileTab(type, { ...init, sid }) });

  const hosts = orderHostChoices(
    null,
    directories.map((d) => d.host),
  );
  const open = (type: "term" | "files", host: string) => {
    const path = directories.find((d) => d.host === host)?.path;
    go(type, {
      host,
      ...(type === "term" && path ? { cwd: path } : {}),
      ...(type === "files" && path ? { path } : {}),
    });
  };
  const choose = (type: "term" | "files") => {
    if (hosts.length <= 1) return open(type, hosts[0] ?? "server");
    setPicking(type);
  };
  // 画布跟着工作区的主目录走，不用选主机
  const canvas = () => {
    const main = directories[0];
    if (main) go("canvas", { host: main.host, path: main.path });
  };

  if (picking)
    return (
      <Sheet
        title={`${picking === "term" ? "终端" : "文件"} · 选择主机`}
        onClose={nav.back}
      >
        {hosts.map((h) => (
          <ListRow
            key={h}
            className="m-row"
            label={hostName(h)}
            onClick={() => open(picking, h)}
          />
        ))}
      </Sheet>
    );

  return (
    <Sheet title="工具" onClose={nav.back}>
      <ListRow
        className="m-row"
        lead={<FileIcon />}
        label="文件"
        onClick={() => choose("files")}
      />
      <ListRow
        className="m-row"
        lead={<TerminalIcon />}
        label="终端"
        onClick={() => choose("term")}
      />
      <ListRow
        className="m-row"
        lead={<GlobeIcon />}
        label="浏览器"
        onClick={() => go("web")}
      />
      <ListRow
        className="m-row"
        lead={<CanvasIcon />}
        label="画布"
        disabled={directories.length === 0}
        onClick={canvas}
      />
      {withAudit && (
        <ListRow
          className="m-row"
          lead={<ChatIcon />}
          label="审计"
          onClick={() => nav.replace({ name: "chat", sid, audit: true })}
        />
      )}
    </Sheet>
  );
}
