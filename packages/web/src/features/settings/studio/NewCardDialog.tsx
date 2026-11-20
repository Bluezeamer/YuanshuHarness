import { useState } from "react";
import { createCard } from "../../../api/studio";
import { Field, FormDialog, Input, Select, Textarea } from "../../../ui";
import { useStudio } from "./useStudio";

// 新建卡片：标题、分组、正文。onBack 给了就多一个「返回」（从添加卡片里进来时回到上一页）。
export function NewCardDialog({
  open,
  onClose,
  onBack,
  onCreated,
  defaultGroup,
}: {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  /** 默认选哪个分组（卡片库里正看着某个分组时） */
  defaultGroup?: string;
  onCreated: (id: string) => Promise<void>;
}) {
  const { groups } = useStudio();
  const names = groups.map((g) => g.group);
  const [title, setTitle] = useState("");
  const [group, setGroup] = useState(
    defaultGroup && names.includes(defaultGroup)
      ? defaultGroup
      : names.includes("项目约定")
        ? "项目约定"
        : (names[0] ?? "项目约定"),
  );
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    const r = await createCard({ group, title: title.trim(), body });
    setBusy(false);
    if (r.ok) await onCreated(r.data.id);
    else setError("新建失败，请稍后重试");
  };
  return (
    <FormDialog
      open={open}
      onClose={onBack ?? onClose}
      size="lg"
      title="新建卡片"
      description={
        onBack
          ? "建好后自动选中，回到上一页一起添加"
          : "卡片库里的卡片，所有预设都能引用"
      }
      confirmLabel="新建"
      cancelLabel={onBack ? "返回" : "取消"}
      canSubmit={title.trim() !== ""}
      busy={busy}
      error={error}
      onSubmit={() => void create()}
    >
      <Field label="标题">
        {(c) => (
          <Input
            {...c}
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
      </Field>
      <Field label="分组">
        {(c) => (
          <Select
            {...c}
            value={group}
            onChange={setGroup}
            options={names.map((n) => ({ value: n, label: n }))}
          />
        )}
      </Field>
      <Field label="正文">
        {(c) => (
          <Textarea
            {...c}
            mono
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        )}
      </Field>
    </FormDialog>
  );
}
