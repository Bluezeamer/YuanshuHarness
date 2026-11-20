import { useEffect, useState } from "react";
import { copyCard, patchCard, type StudioCard } from "../../../api/studio";
import { Field, FormDialog, Input, Select, Textarea } from "../../../ui";
import { MarkdownView } from "../../workspace/tabs/preview/MarkdownView";
import { useStudio } from "./useStudio";

// 卡片编辑（悬浮窗）：左边改，右边是渲染后的样子。内置卡片只读，主按钮是「复制一份」。
// 卡片是库里共用的，改它会影响所有引用它的预设；打开这个弹窗不会丢掉页面上没保存的编辑。
export function CardEditorModal({
  card,
  onClose,
}: {
  card: StudioCard | null;
  onClose: () => void;
}) {
  const { reload, groups } = useStudio();
  const [title, setTitle] = useState("");
  const [group, setGroup] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTitle(card?.title ?? "");
    setGroup(card?.group ?? "");
    setBody(card?.body ?? "");
    setError(null);
  }, [card]);

  const done = async () => {
    await reload();
    onClose();
  };
  const run = async (f: () => Promise<{ ok: boolean }>) => {
    setBusy(true);
    const r = await f();
    setBusy(false);
    if (r.ok) await done();
    else setError("保存失败，请稍后重试");
  };

  const builtin = card?.builtin === true;
  return (
    <FormDialog
      open={card !== null}
      onClose={onClose}
      size="xl"
      title={card?.title ?? ""}
      description={
        builtin
          ? "内置卡片只读，请先复制一份再改"
          : `卡片库 · ${card?.group ?? ""}${card && card.usedBy > 1 ? ` · 改动会同时影响 ${card.usedBy} 个预设` : ""}`
      }
      confirmLabel={builtin ? "复制一份" : "保存"}
      cancelLabel="关闭"
      busy={busy}
      error={error}
      onSubmit={() =>
        card &&
        void run(() =>
          builtin
            ? copyCard(card.id)
            : patchCard(card.id, { title, body, group }),
        )
      }
    >
      <Field label="标题">
        {(c) => (
          <Input
            {...c}
            value={title}
            readOnly={builtin}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="分组"
        hint={builtin ? undefined : "改了分组，卡片就挪到那个分组里"}
      >
        {(c) => (
          <Select
            {...c}
            value={group}
            disabled={builtin}
            onChange={setGroup}
            options={groups.map((g) => ({ value: g.group, label: g.group }))}
          />
        )}
      </Field>
      <div className="sd-ced-panes">
        <Field label="正文">
          {(c) => (
            <Textarea
              {...c}
              mono
              rows={14}
              value={body}
              readOnly={builtin}
              onChange={(e) => setBody(e.target.value)}
            />
          )}
        </Field>
        <div className="sd-ced-view">
          <div className="t-aux">渲染后</div>
          <MarkdownView text={body || "（空）"} />
        </div>
      </div>
    </FormDialog>
  );
}
