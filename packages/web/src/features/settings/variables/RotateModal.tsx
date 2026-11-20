import { useState } from "react";
import type { VariableView } from "../../../api/variables";
import { Button, fmtDateTime, Modal, toast } from "../../../ui";
import { ErrorLine } from "./actions";
import type { VariablesStore } from "./store";
import {
  draftError,
  emptyDraft,
  type ValueDraft,
  ValueField,
} from "./ValueField";

export interface RotateModalProps {
  /** 要轮换的变量；null 表示关闭。 */
  target: VariableView | null;
  store: VariablesStore;
  onClose: () => void;
}

export function RotateModal({ target, store, onClose }: RotateModalProps) {
  return target ? (
    <Form key={target.id} v={target} store={store} onClose={onClose} />
  ) : null;
}

function expiryNote(v: VariableView): string {
  if (v.expiry.kind === "days") return "到期时间从今天重新计算。";
  if (v.expiry.kind === "never") return "永久有效：轮换不改变有效期。";
  return `到期时间不变：${fmtDateTime(v.expiry.at)}。`;
}

function Form({
  v,
  store,
  onClose,
}: {
  v: VariableView;
  store: VariablesStore;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ValueDraft>(emptyDraft(v.kind));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const bad = draftError(draft);
    if (bad) return setError(bad);
    setBusy(true);
    const r = await store.rotate(v.id, {
      value:
        draft.kind === "file" ? (draft.file?.text ?? "") : draft.text.trim(),
      ...(draft.kind === "file" && draft.file
        ? { fileName: draft.file.name }
        : {}),
    });
    setBusy(false);
    if (r.ok) {
      toast("已轮换", { tone: "ok" });
      onClose();
    } else setError(r.message);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="轮换值"
      description={`${v.name} 的旧值立即失效；命令与审计里仍然只有占位符。${expiryNote(v)}`}
      dismissOnScrim={false}
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
            轮换
          </Button>
        </>
      }
    >
      <div className="vr-form">
        <ValueField
          draft={draft}
          onChange={setDraft}
          lockKind
          currentFile={v.file?.name}
        />
        <p className="t-aux">类型在创建时确定，轮换只换值。</p>
        <ErrorLine error={error} />
      </div>
    </Modal>
  );
}
