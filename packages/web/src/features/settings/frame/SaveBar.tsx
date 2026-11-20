import { useEffect, useRef } from "react";
import { Button, Dot } from "../../../ui";

/**
 * 保存条：有未保存的修改时才浮在滚动区底部，没有修改不占位。Ctrl+S 同样保存。
 * 放在滚动区里、内容之后（sticky 贴底）。
 */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const save = useRef(onSave);
  save.current = onSave;
  useEffect(() => {
    if (!dirty) return;
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save.current();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [dirty]);

  if (!dirty && !saving) return null;
  return (
    <section className="st-save" aria-label="保存">
      <Dot tone="warn" />
      <span className="t-aux">有未保存的修改</span>
      <Button variant="ghost" disabled={saving} onClick={onDiscard}>
        放弃
      </Button>
      <Button variant="primary" loading={saving} onClick={onSave}>
        保存
      </Button>
    </section>
  );
}
