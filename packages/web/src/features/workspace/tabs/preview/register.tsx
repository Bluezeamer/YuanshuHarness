import { environmentIdOf } from "../../../../app/shell/hosts";
import { DiffTab } from "../diff/DiffTab";
import { FileIcon } from "../files/icons";
import { registerTab, tabTypeLabel } from "../registry";
import { baseName } from "./kind";
import { PreviewTab } from "./PreviewTab";

/** 把 preview 标签注册进标签注册表；应用启动时调用一次。标题取文件名 */
export function registerPreviewTab(): void {
  registerTab("preview", {
    icon: <FileIcon size={11} />,
    title: (tab) =>
      tab.diff
        ? `${baseName(tab.diff.path)} 改动`
        : tab.path
          ? baseName(tab.path)
          : tabTypeLabel("preview"),
    tip: (tab) => (tab.diff ? "" : (tab.path ?? "")),
    render: (props) =>
      props.tab.diff ? (
        <DiffTab
          sessionId={props.sessionId}
          env={environmentIdOf(props.tab.host ?? "server")}
          turn={props.tab.diff.turn}
          team={props.tab.diff.team === true}
          path={props.tab.diff.path}
        />
      ) : (
        <PreviewTab {...props} />
      ),
  });
}
