// 新建笔记 / 画布 / 文件夹的对话框：两栏——位置（下拉：根与所有文件夹，默认当前所在的文件夹，可改）和名字（只填最后一段），
// 不再让人手写「文件夹/名字」。拼出完整路径交给调用方去建。
import { useMemo, useState } from "react";
import { Field, FormDialog, Input, Select } from "../../../../ui";
import { joinLocation, locationOptions } from "./navTree";

export type NewKind = "note" | "board" | "folder";

const COPY: Record<
  NewKind,
  { title: string; description: string; placeholder: string; optional: boolean }
> = {
  note: {
    title: "新建笔记",
    description:
      "笔记是 .canvas 里的 markdown 文件，不属于哪块画布。要放上画布，把它从左边的树里拖到画布上。",
    placeholder: "例如：用户研究",
    optional: false,
  },
  board: {
    title: "新建画布",
    description: "名字可以留空，会用当前时间命名。",
    placeholder: "例如：产品想法",
    optional: true,
  },
  folder: {
    title: "新建文件夹",
    description: "画布与笔记可以放进文件夹，文件夹里还能再建文件夹。",
    placeholder: "例如：调研",
    optional: false,
  },
};

export interface NewItemDialogProps {
  kind: NewKind;
  /** 现有的文件夹（相对 `.canvas/` 的路径） */
  folders: readonly string[];
  /** 默认的位置；不在 folders 里（链接指到的新路径）也能选，建的时候会一并建出来 */
  folder: string;
  /** 默认的名字 */
  name: string;
  busy: boolean;
  error: string | null;
  onClose(): void;
  /** 位置与名字拼好的完整路径（名字可以是空，只有画布允许） */
  onSubmit(path: string, parts: { folder: string; name: string }): void;
}

export function NewItemDialog({
  kind,
  folders,
  folder: initialFolder,
  name: initialName,
  busy,
  error,
  onClose,
  onSubmit,
}: NewItemDialogProps) {
  const [folder, setFolder] = useState(initialFolder);
  const [name, setName] = useState(initialName);
  const copy = COPY[kind];
  const options = useMemo(
    () => locationOptions(folders, initialFolder),
    [folders, initialFolder],
  );
  const trimmed = name.trim();
  return (
    <FormDialog
      open
      onClose={onClose}
      title={copy.title}
      description={copy.description}
      confirmLabel="新建"
      canSubmit={copy.optional || trimmed !== ""}
      busy={busy}
      error={error}
      onSubmit={() =>
        onSubmit(joinLocation(folder, trimmed), { folder, name: trimmed })
      }
    >
      <Field label="位置">
        {(ctl) => (
          <Select
            {...ctl}
            value={folder}
            onChange={setFolder}
            options={options}
          />
        )}
      </Field>
      <Field label="名字">
        {(ctl) => (
          <Input
            {...ctl}
            large
            autoFocus
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={copy.placeholder}
          />
        )}
      </Field>
    </FormDialog>
  );
}
