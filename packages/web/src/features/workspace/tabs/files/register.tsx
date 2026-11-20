import { useLayoutStore } from "../../layoutContext";
import { registerTab, type TabRenderProps, tabTypeLabel } from "../registry";
import { FilesTab } from "./FilesTab";
import { FolderIcon } from "./icons";
import { baseName } from "./paths";

// 版本视图点文件 → 开「工作区 vs HEAD」的 diff 标签（turn 为 null 表示工作区）。
// 落点规则复用对话里点改动文件的 openDiff：同主机已有预览窗格就放进去，否则新开一个。
function FilesTabWithDiff(props: TabRenderProps) {
  const store = useLayoutStore();
  return (
    <FilesTab
      {...props}
      onOpenDiff={(absPath) =>
        store.openDiff(props.pane.pid, props.tab.id, null, absPath)
      }
    />
  );
}

/** 把 files 标签注册进标签注册表；应用启动时调用一次 */
export function registerFilesTab(): void {
  registerTab("files", {
    icon: <FolderIcon size={11} />,
    title: (tab) => {
      const at = tab.cwd || tab.path;
      return at && at !== "/" ? baseName(at) : tabTypeLabel("files");
    },
    tip: (tab) => tab.cwd || tab.path || "",
    render: (props) => <FilesTabWithDiff {...props} />,
  });
}
