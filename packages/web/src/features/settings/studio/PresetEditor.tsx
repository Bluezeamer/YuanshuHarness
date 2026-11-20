import { useState } from "react";
import {
  copyPreset,
  deletePreset,
  type StudioPreset,
} from "../../../api/studio";
import {
  Button,
  Chip,
  ConfirmDialog,
  Empty,
  Field,
  FormDialog,
  IconButton,
  Input,
  Loading,
  Menu,
  toast,
} from "../../../ui";
import { BackIcon } from "../../../ui/icons";
import { useBindDirty, useLeaveGuard } from "../frame/leave";
import { PageTabs } from "../frame/PageTabs";
import { SaveBar } from "../frame/SaveBar";
import { DiskModifiedDialog, type useActivate } from "./activate";
import { BasicsTab } from "./BasicsTab";
import { CapsTab } from "./CapsTab";
import { cardCount } from "./model/eval";
import { NOUN } from "./PresetList";
import { PromptWorkspace } from "./PromptWorkspace";
import { usePresetDraft } from "./usePresetDraft";
import { useStudio } from "./useStudio";

const KIND_SUB: Partial<Record<StudioPreset["kind"], string>> = {
  "global-agentsmd": "全局 · 生效时写入 ~/.ys/AGENTS.md",
  "project-agentsmd": "项目模板 · 创建工作区时可选作起点",
  "global-extra": "全局附加提示词 · 同一时间只有一个生效",
};

const OVERALL = {
  "global-agentsmd": {
    title: "最终内容",
    note: "激活后原文写进 ~/.ys/AGENTS.md，不按模型变化。",
  },
  "project-agentsmd": {
    title: "最终内容",
    note: "创建工作区时原文写进主目录的 AGENTS.md，不按模型变化。",
  },
  "global-extra": {
    title: "最终内容",
    modelLabel: "创建会话时的模型",
    note: "每次建会话按当时的模型选出内容，注入对话开头；会话换模型时整体重建。",
  },
} as const;

// 名称与描述改在草稿里（和提示词一起点保存），不是立即提交
function RenameDialog({
  name,
  description,
  noun,
  onClose,
  onSubmit,
}: {
  name: string;
  description: string;
  noun: string;
  onClose: () => void;
  onSubmit: (v: { name: string; description: string }) => void;
}) {
  const [n, setN] = useState(name);
  const [d, setD] = useState(description);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={`重命名${noun}`}
      canSubmit={n.trim() !== ""}
      onSubmit={() => onSubmit({ name: n.trim(), description: d })}
    >
      <Field label="名称">
        {(c) => (
          <Input
            {...c}
            autoFocus
            value={n}
            onChange={(e) => setN(e.target.value)}
          />
        )}
      </Field>
      <Field label="描述">
        {(c) => (
          <Input {...c} value={d} onChange={(e) => setD(e.target.value)} />
        )}
      </Field>
    </FormDialog>
  );
}

// 编辑页：页头（返回、名字、一句话、状态与操作）+ 内容。Agent / 模式有「提示词 / 能力 / 设定」三页，
// 其余三种只有提示词。改动先在草稿里，保存条浮在编辑区底部；离开前先问。
export function PresetEditor({
  preset,
  activate,
  path,
  onBack,
}: {
  preset: StudioPreset;
  activate: ReturnType<typeof useActivate>;
  /** 全局 AGENTS.md 文件的路径，磁盘被手改时写进提示里 */
  path: string;
  onBack: () => void;
}) {
  const guard = useLeaveGuard();
  const { reload } = useStudio();
  const d = usePresetDraft(preset.id);
  useBindDirty({
    dirty: d.dirty,
    save: () => d.save(),
    discard: d.discard,
  });
  const [tab, setTab] = useState("prompt");
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const k = preset.kind;
  const mode = k === "mode";
  const full = k === "agent" || mode;
  const noun = NOUN[k];
  const versioned = k === "global-agentsmd" || k === "global-extra";

  if (d.failed)
    return (
      <Empty
        tone="danger"
        title="读取失败"
        action={<Button onClick={() => void d.reloadSaved()}>重试</Button>}
      />
    );
  if (!d.draft) return <Loading>正在读取…</Loading>;
  const draft = d.draft;

  const copy = async () => {
    const r = await copyPreset(preset.id);
    if (r.ok) {
      await reload();
      toast(`已复制为「${r.data.name}」`, { tone: "ok" });
    } else toast("复制失败", { tone: "danger" });
  };

  const capsCount = mode
    ? draft.capsAdd.length +
      draft.capsRemove.length +
      (draft.capabilities?.length ?? 0)
    : (draft.capabilities?.length ?? 0);
  const sub = [
    full ? draft.description : null,
    k === "agent" && (preset.refCount ?? 0) > 0
      ? `${preset.refCount} 个会话在用`
      : null,
    KIND_SUB[k] ?? null,
    `${draft.nodes.reduce((a, s) => a + cardCount(s), 0)} 张卡片`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="sd-ed">
      <header className="sd-head" data-line={!full || undefined}>
        <IconButton
          label={`返回${noun}列表`}
          icon={<BackIcon />}
          onClick={() => guard(onBack)}
        />
        <span className="t-page">{draft.name}</span>
        <span className="t-aux sd-head-sub">{sub}</span>
        <span className="sd-sp" />
        {versioned &&
          (preset.active ? (
            <Chip tone="live" dot>
              生效中
            </Chip>
          ) : (
            <Button
              variant="outline"
              disabled={d.dirty}
              title={d.dirty ? "先保存修改再激活" : undefined}
              onClick={() => activate.request(preset)}
            >
              {k === "global-agentsmd" ? "激活此版本" : "设为生效"}
            </Button>
          ))}
        {full ? (
          <Button variant="ghost" onClick={() => void copy()}>
            复制为新 {noun}
          </Button>
        ) : (
          <Menu
            label="更多操作"
            items={[
              {
                id: "rename",
                label: "重命名…",
                onSelect: () => setRenaming(true),
              },
              { id: "copy", label: "复制", onSelect: () => void copy() },
              {
                id: "del",
                label: "删除",
                tone: "danger",
                separatorBefore: true,
                disabled: preset.active,
                ...(preset.active ? { hint: "先把别的版本设为生效" } : {}),
                onSelect: () => setDeleting(true),
              },
            ]}
          />
        )}
      </header>
      {full && (
        <PageTabs
          idBase="sd-ed"
          aria-label={`${noun}编辑`}
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "prompt", label: "提示词" },
            {
              id: "caps",
              label: "能力",
              ...(capsCount > 0 || (!mode && draft.capabilities)
                ? { count: capsCount }
                : {}),
            },
            { id: "basics", label: "设定" },
          ]}
        />
      )}
      {tab === "prompt" && (
        <PromptWorkspace
          segs={draft.nodes}
          onChange={(nodes) => d.edit({ nodes })}
          flat={k !== "agent"}
          noGroups={k === "global-agentsmd" || k === "project-agentsmd"}
          {...(k in OVERALL
            ? { overall: OVERALL[k as keyof typeof OVERALL] }
            : {})}
        />
      )}
      {full && tab === "caps" && (
        <div className="st-scroll">
          <div className="st-form">
            <CapsTab mode={mode} draft={draft} edit={d.edit} />
          </div>
        </div>
      )}
      {full && tab === "basics" && (
        <div className="st-scroll">
          <div className="st-form">
            <BasicsTab
              preset={preset}
              draft={draft}
              edit={d.edit}
              noun={noun}
              onDeleted={onBack}
            />
          </div>
        </div>
      )}
      <SaveBar
        dirty={d.dirty}
        saving={d.saving}
        onSave={() => void d.save()}
        onDiscard={d.discard}
      />
      {renaming && (
        <RenameDialog
          name={draft.name}
          description={draft.description}
          noun={noun}
          onClose={() => setRenaming(false)}
          onSubmit={(v) => {
            d.edit(v);
            setRenaming(false);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        title={`删除${noun}`}
        confirmLabel="删除"
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          const r = await deletePreset(preset.id);
          if (!r.ok) return toast("删除失败", { tone: "danger" });
          setDeleting(false);
          await reload();
          onBack();
        }}
      >
        删除「{preset.name}」？它的段与分组会一起删掉，卡片库里的卡片还在。
      </ConfirmDialog>
      <DiskModifiedDialog
        open={d.diskConflict}
        path={path}
        verb="保存这个版本"
        busy={d.saving}
        onCancel={d.cancelConflict}
        onOverwrite={() => void d.save(true)}
      />
    </div>
  );
}
