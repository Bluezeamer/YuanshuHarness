// 保存冲突：磁盘上的内容被别人改过，给三个明确的选择，不做静默覆盖。
import { useMemo, useState } from "react";
import { Button, Modal, Segmented } from "../../../../ui";
import { DiffLines } from "./DiffLines";
import { diffLines, trimDiff } from "./diffLines";
import { MergeEditor } from "./MergeEditor";

export function ConflictDialog({
  path,
  diskText,
  mineText,
  onOverwrite,
  onKeepDisk,
  onMerge,
  onCancel,
}: {
  path?: string;
  diskText: string;
  mineText: string;
  onOverwrite(): void;
  onKeepDisk(): void;
  /** 合并模式：把用户改好的结果整体存回磁盘 */
  onMerge(text: string): void;
  onCancel(): void;
}) {
  const [view, setView] = useState<"diff" | "mine" | "disk" | "merge">("diff");
  const lines = useMemo(
    () => trimDiff(diffLines(diskText, mineText)),
    [diskText, mineText],
  );
  const changed = lines.filter((l) => l.kind !== "same").length;

  return (
    <Modal
      open
      onClose={onCancel}
      size={view === "merge" ? "full" : "md"}
      className="ws-pv-merge-modal"
      title="文件已被改动"
      description={`磁盘上的内容与你打开时不一样（${changed} 处差异）。选择怎么处理，不会替你静默覆盖。`}
      dismissOnScrim={false}
      footer={
        view === "merge" ? undefined : (
          <>
            <Button variant="ghost" onClick={onCancel}>
              取消
            </Button>
            <Button onClick={onKeepDisk}>放弃我的修改</Button>
            <Button variant="primary" onClick={onOverwrite}>
              覆盖磁盘内容
            </Button>
          </>
        )
      }
    >
      <div className="ws-pv-conflict">
        <Segmented
          aria-label="查看方式"
          options={[
            { value: "diff", label: "差异" },
            { value: "mine", label: "我的内容" },
            { value: "disk", label: "磁盘内容" },
            { value: "merge", label: "合并" },
          ]}
          value={view}
          onChange={setView}
        />
        {view === "diff" ? (
          <DiffLines lines={lines} />
        ) : view === "merge" ? (
          <MergeEditor
            mineText={mineText}
            diskText={diskText}
            path={path ?? ""}
            onSave={onMerge}
            onCancel={onCancel}
          />
        ) : (
          <pre className="ws-pv-plain t-mono">
            {view === "mine" ? mineText : diskText}
          </pre>
        )}
      </div>
    </Modal>
  );
}
