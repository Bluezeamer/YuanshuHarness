import { useState } from "react";
import { Button, Field, Input, Modal, toast } from "../../../ui";
import { ErrorLine } from "./actions";
import { GROUP_ERROR, GROUP_MAX } from "./model";
import type { VariablesStore } from "./store";

// 改组名。改到已有的组名 = 合并，写在提示里。
export function RenameGroupDialog({
  from,
  existing,
  store,
  onClose,
}: {
  from: string;
  existing: readonly string[];
  store: VariablesStore;
  onClose: () => void;
}) {
  const [to, setTo] = useState(from);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = to.trim();
  const merges = next !== from && existing.includes(next);

  const submit = async () => {
    if (next === "" || next.length > GROUP_MAX) return setError(GROUP_ERROR);
    if (next === from) return onClose();
    setBusy(true);
    const r = await store.renameGroup(from, next);
    setBusy(false);
    if (r.ok) {
      toast("已改名", { tone: "ok" });
      onClose();
    } else setError(r.message);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="重命名变量组"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void submit()}
          >
            改名
          </Button>
        </>
      }
    >
      <div className="vr-form">
        <Field
          label="名称"
          hint={merges ? "已有同名的组，改完会合并到它。" : undefined}
        >
          {(c) => (
            <Input
              {...c}
              autoFocus
              maxLength={GROUP_MAX}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          )}
        </Field>
        <ErrorLine error={error} />
      </div>
    </Modal>
  );
}
