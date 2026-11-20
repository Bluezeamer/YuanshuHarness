import { useState } from "react";
import { Button, Input, Modal } from "../../../ui";
import type { NameDialogSpec } from "./controller";

// 起名 / 改名的小弹窗：一个输入框，回车提交。空名字不提交。
export function NameDialog({
  spec,
  onClose,
}: {
  spec: NameDialogSpec | null;
  onClose: () => void;
}) {
  return spec ? <Body spec={spec} onClose={onClose} /> : null;
}

function Body({
  spec,
  onClose,
}: {
  spec: NameDialogSpec;
  onClose: () => void;
}) {
  const [name, setName] = useState(spec.initial);
  const value = name.trim();
  const submit = () => {
    if (value === "") return;
    spec.onSubmit(value);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={spec.title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={value === ""} onClick={submit}>
            {spec.confirmLabel}
          </Button>
        </>
      }
    >
      <Input
        large
        aria-label={spec.label}
        placeholder={spec.label}
        value={name}
        maxLength={spec.maxLength}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
        }}
      />
    </Modal>
  );
}
