import { useState } from "react";
import { Button, Dot, Field, IconButton, Input, Modal } from "../../../ui";
import type { GroupDialogSpec } from "./controller";

/** 分组色：0 是中性灰，1…6 对应色相令牌 */
const TONES = [0, 1, 2, 3, 4, 5, 6] as const;

// 编辑分组：名称 + 颜色。空名字不提交。
export function GroupDialog({
  spec,
  onClose,
}: {
  spec: GroupDialogSpec | null;
  onClose: () => void;
}) {
  return spec ? <Body spec={spec} onClose={onClose} /> : null;
}

function Body({
  spec,
  onClose,
}: {
  spec: GroupDialogSpec;
  onClose: () => void;
}) {
  const [name, setName] = useState(spec.name);
  const [tone, setTone] = useState(spec.tone);
  const value = name.trim();
  const submit = () => {
    if (value !== "") spec.onSubmit(value, tone);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="编辑分组"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={value === ""} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <div className="rl-gdlg">
        <Field label="分组名称">
          {(c) => (
            <Input
              {...c}
              large
              value={name}
              maxLength={24}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
              }}
            />
          )}
        </Field>
        <Field label="颜色">
          <div className="rl-swatches">
            {TONES.map((t) => (
              <IconButton
                key={t}
                label={t === 0 ? "无色" : `颜色 ${t}`}
                pressed={tone === t}
                className="rl-swatch"
                icon={<Dot className="rl-tone" data-hue={t} />}
                onClick={() => setTone(t)}
              />
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
