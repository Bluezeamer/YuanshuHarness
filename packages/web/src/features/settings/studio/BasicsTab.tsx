import { useState } from "react";
import type { StudioPreset } from "../../../api/studio";
import { deletePreset } from "../../../api/studio";
import { Button, ConfirmDialog, Input, SettingRow } from "../../../ui";
import type { Draft } from "./usePresetDraft";
import { useStudio } from "./useStudio";

// 设定页：名称、描述、删除。被会话引用的 Agent 不能删。
export function BasicsTab({
  preset,
  draft,
  edit,
  noun,
  onDeleted,
}: {
  preset: StudioPreset;
  draft: Draft;
  edit: (patch: Partial<Draft>) => void;
  /** 「Agent」或「模式」，写进说明里 */
  noun: string;
  onDeleted: () => void;
}) {
  const { reload } = useStudio();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = preset.refCount ?? 0;
  const remove = async () => {
    const r = await deletePreset(preset.id);
    if (!r.ok) return setError("删除失败，可能刚刚有会话引用了它");
    setAsking(false);
    await reload();
    onDeleted();
  };
  return (
    <>
      <section className="st-block" aria-label="基本信息">
        <header className="st-block-h t-group">基本信息</header>
        <SettingRow label="名称" description="创建会话时在下拉里看到的名字">
          {(c) => (
            <Input
              {...c}
              value={draft.name}
              onChange={(e) => edit({ name: e.target.value })}
            />
          )}
        </SettingRow>
        <SettingRow label="描述" description="列表卡片上的一句话">
          {(c) => (
            <Input
              {...c}
              value={draft.description}
              onChange={(e) => edit({ description: e.target.value })}
            />
          )}
        </SettingRow>
      </section>
      <section className="st-block" aria-label="删除">
        <header className="st-block-h t-group">删除</header>
        <SettingRow
          label={`删除这个${noun}`}
          description={
            refs > 0
              ? `${refs} 个会话正在用它，不能删。先删掉这些会话，或建一个新的 ${noun} 替代`
              : "删除后不能恢复；卡片库里的卡片不受影响"
          }
        >
          <Button
            variant="danger"
            disabled={refs > 0}
            onClick={() => setAsking(true)}
          >
            删除
          </Button>
        </SettingRow>
      </section>
      <ConfirmDialog
        open={asking}
        title={`删除${noun}`}
        confirmLabel="删除"
        error={error}
        onClose={() => setAsking(false)}
        onConfirm={() => void remove()}
      >
        删除「{preset.name}」？它的段与分组会一起删掉，卡片库里的卡片还在。
      </ConfirmDialog>
    </>
  );
}
