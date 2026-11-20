import { useState } from "react";
import { toast } from "../../../ui";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * 设置的草稿（ys-ui-design 的 X06）：页面上直接编辑的值先进草稿，点保存才落库。
 * `onSave` 返回错误文案（失败）或 null（成功）；结果用右下角提示告知，失败时草稿保留。
 */
export function useDraft<T>(
  saved: T,
  onSave: (draft: T) => Promise<string | null>,
) {
  const [draft, setDraft] = useState(saved);
  const [base, setBase] = useState(saved);
  const [saving, setSaving] = useState(false);

  // 已保存的值变了（保存成功后服务端回来、或外部刷新）：草稿没被改过就跟着走，改过的保留
  if (!same(base, saved)) {
    setBase(saved);
    if (same(draft, base)) setDraft(saved);
  }

  const dirty = !same(draft, saved);

  const save = async (): Promise<boolean> => {
    setSaving(true);
    const err = await onSave(draft);
    setSaving(false);
    if (err === null) toast("已保存", { tone: "ok" });
    else toast(`保存失败：${err}`, { tone: "danger" });
    return err === null;
  };
  const discard = () => setDraft(saved);

  return { draft, setDraft, dirty, saving, save, discard };
}
