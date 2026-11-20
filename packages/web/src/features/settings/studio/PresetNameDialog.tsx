import { useEffect, useState } from "react";
import {
  createPreset,
  type PresetKind,
  patchPreset,
  type StudioPreset,
} from "../../../api/studio";
import { Field, FormDialog, Input } from "../../../ui";
import { useStudio } from "./useStudio";

// 新建 / 重命名一份预设：只填名称与描述，内容在编辑器里做。
export function PresetNameDialog({
  open,
  kind,
  noun,
  editing,
  onClose,
  onDone,
}: {
  open: boolean;
  kind: PresetKind;
  /** 「Agent」「模式」「版本」，写进标题里 */
  noun: string;
  /** 重命名哪一份；null = 新建 */
  editing: StudioPreset | null;
  onClose: () => void;
  onDone: (preset: StudioPreset) => void;
}) {
  const { reload } = useStudio();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setDescription(editing?.description ?? "");
    setError(null);
  }, [open, editing]);

  const submit = async () => {
    setBusy(true);
    const r = editing
      ? await patchPreset(editing.id, { name: name.trim(), description })
      : await createPreset({ kind, name: name.trim(), description });
    setBusy(false);
    if (!r.ok) return setError("保存失败，请稍后重试");
    await reload();
    onDone(
      editing
        ? { ...editing, name: name.trim(), description }
        : (r.data as StudioPreset),
    );
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={editing ? `重命名${noun}` : `新建${noun}`}
      confirmLabel={editing ? "确定" : "创建"}
      canSubmit={name.trim() !== ""}
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
    >
      <Field label="名称">
        {(c) => (
          <Input
            {...c}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field label="描述">
        {(c) => (
          <Input
            {...c}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        )}
      </Field>
    </FormDialog>
  );
}
