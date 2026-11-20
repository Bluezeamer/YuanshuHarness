import { useState } from "react";
import {
  Button,
  Chip,
  ConfirmDialog,
  IconButton,
  Input,
  Menu,
  Select,
  SettingRow,
  toast,
} from "../../../ui";
import { BackIcon } from "../../../ui/icons";
import { useBindDirty, useLeaveGuard } from "../../settings/frame/leave";
import { PageTabs } from "../../settings/frame/PageTabs";
import { SaveBar } from "../../settings/frame/SaveBar";
import { useDraft } from "../../settings/frame/useDraft";
import { CapsTab } from "../StudioCaps";
import { NameDialog, type useActivate } from "./Dialogs";
import { cardsOf, NOUN, type Preset, type Store } from "./data";
import { Workspace } from "./Workspace";

const SUB: Record<Preset["kind"], (p: Preset) => string> = {
  gmd: () => "全局 · 生效时写入 ~/.ys/AGENTS.md",
  pmd: () => "项目模板 · 创建工作区时可选作起点",
  extra: () => "全局附加提示词 · 同一时间只有一个生效",
  agent: (p) => (p.refs ? `${p.refs} 个会话在用` : "未被引用"),
  mode: () => "模式",
};

const OVERALL_FILE = {
  gmd: {
    title: "最终内容",
    note: "激活后原文写进 ~/.ys/AGENTS.md，不按模型变化。",
  },
  pmd: {
    title: "最终内容",
    note: "创建工作区时原文写进主目录的 AGENTS.md，不按模型变化。",
  },
} as const;

const OVERALL_EXTRA = {
  title: "最终内容",
  modelLabel: "创建会话时的模型",
  note: "每次建会话按当时的模型选出内容，注入对话开头；会话换模型时整体重建。",
};

// 设定页：名称、描述、默认模型、思考强度、删除。都进草稿，点保存才落库。
function BasicsPane({
  preset,
  draft,
  set,
  onDelete,
}: {
  preset: Preset;
  draft: { name: string; desc: string };
  set: (p: Partial<{ name: string; desc: string }>) => void;
  onDelete: () => void;
}) {
  const [model, setModel] = useState("");
  const [think, setThink] = useState("");
  const noun = NOUN[preset.kind];
  return (
    <div className="st-scroll">
      <div className="st-form">
        <section className="st-block" aria-label="基本信息">
          <header className="st-block-h t-group">基本信息</header>
          <SettingRow label="名称" description="创建会话时在下拉里看到的名字">
            {(c) => (
              <Input
                {...c}
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            )}
          </SettingRow>
          <SettingRow label="描述" description="列表卡片上的一句话">
            {(c) => (
              <Input
                {...c}
                value={draft.desc}
                onChange={(e) => set({ desc: e.target.value })}
              />
            )}
          </SettingRow>
        </section>
        <section className="st-block" aria-label="默认值">
          <header className="st-block-h t-group">默认值</header>
          <SettingRow
            label="默认模型"
            description="创建时手选的优先；其次是这里；再其次是工作区、全局的默认配置"
          >
            {(c) => (
              <Select
                {...c}
                value={model}
                onChange={setModel}
                options={[
                  { value: "", label: "不指定", hint: "跟随默认配置" },
                  { value: "qwen", label: "Qwen3.8-27B", hint: "本地部署" },
                  {
                    value: "claude",
                    label: "claude-sonnet-5",
                    hint: "Anthropic",
                  },
                ]}
              />
            )}
          </SettingRow>
          <SettingRow label="思考强度" description="只列该模型支持的档位">
            {(c) => (
              <Select
                {...c}
                value={think}
                onChange={setThink}
                options={[
                  { value: "", label: "不指定" },
                  { value: "low", label: "low" },
                  { value: "high", label: "high" },
                  { value: "xhigh", label: "xhigh" },
                ]}
              />
            )}
          </SettingRow>
        </section>
        <section className="st-block" aria-label="危险操作">
          <header className="st-block-h t-group">删除</header>
          <SettingRow
            label={`删除这个${noun}`}
            description={
              preset.refs
                ? `${preset.refs} 个会话正在用它，不能删。先删掉这些会话，或建一个新的${noun}替代`
                : "删除后不能恢复；卡片库里的卡片还在"
            }
          >
            <Button
              variant="danger"
              disabled={Boolean(preset.refs)}
              onClick={onDelete}
            >
              删除
            </Button>
          </SettingRow>
        </section>
      </div>
    </div>
  );
}

// 编辑页：页头（返回、名字、一句话、状态与操作）+ 内容。Agent / 模式有「提示词 / 能力 / 设定」三页，
// 其余三种只有提示词。改动进草稿，保存条浮在编辑区底部；离开前先问。
export function Editor({
  preset,
  store,
  activate,
  onBack,
}: {
  preset: Preset;
  store: Store;
  activate: ReturnType<typeof useActivate>;
  onBack: () => void;
}) {
  const guard = useLeaveGuard();
  const d = useDraft(
    { name: preset.name, desc: preset.desc, segs: preset.segs },
    async (x) => {
      store.patch(preset.id, x);
      return null;
    },
  );
  useBindDirty({
    dirty: d.dirty,
    save: d.save,
    discard: d.discard,
  });
  const [tab, setTab] = useState("prompt");
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const k = preset.kind;
  const full = k === "agent" || k === "mode";
  const noun = NOUN[k];
  const set = (p: Partial<{ name: string; desc: string }>) =>
    d.setDraft({ ...d.draft, ...p });
  const versioned = k === "gmd" || k === "extra";

  return (
    <div className="sp-ed">
      <header className="sp-head" data-line={!full || undefined}>
        <IconButton
          label={`返回${noun}列表`}
          icon={<BackIcon />}
          onClick={() => guard(onBack)}
        />
        <span className="t-page">{d.draft.name}</span>
        <span className="t-aux sp-head-sub">
          {k === "agent" || k === "mode" ? `${d.draft.desc} · ` : ""}
          {SUB[k](preset)} · {cardsOf(d.draft.segs)} 张卡片
        </span>
        <span className="sp-sp" />
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
              {k === "gmd" ? "激活此版本" : "设为生效"}
            </Button>
          ))}
        {full && (
          <Button
            variant="ghost"
            onClick={() => {
              store.copy(preset.id);
              toast(`已复制为「${preset.name} 副本」`, { tone: "ok" });
            }}
          >
            复制为新 {noun}
          </Button>
        )}
        {!full && (
          <Menu
            label="更多操作"
            items={[
              {
                id: "rename",
                label: "重命名…",
                onSelect: () => setRenaming(true),
              },
              {
                id: "copy",
                label: "复制",
                onSelect: () => {
                  store.copy(preset.id);
                  toast(`已复制「${preset.name}」`, { tone: "ok" });
                },
              },
              {
                id: "del",
                label: "删除",
                tone: "danger",
                separatorBefore: true,
                disabled: Boolean(preset.active),
                ...(preset.active ? { hint: "先激活别的版本" } : {}),
                onSelect: () => setDeleting(true),
              },
            ]}
          />
        )}
      </header>
      {full && (
        <PageTabs
          idBase="sp-ed"
          aria-label={`${noun}编辑`}
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "prompt", label: "提示词" },
            { id: "caps", label: "能力", count: 13 },
            { id: "basics", label: "设定" },
          ]}
        />
      )}
      {tab === "prompt" && (
        <Workspace
          segs={d.draft.segs}
          onChange={(segs) => d.setDraft({ ...d.draft, segs })}
          flat={k !== "agent"}
          plain={k === "gmd" || k === "pmd"}
          {...(k === "extra"
            ? { overall: OVERALL_EXTRA }
            : k === "gmd" || k === "pmd"
              ? { overall: OVERALL_FILE[k] }
              : {})}
        />
      )}
      {full && tab === "caps" && (
        <div className="st-scroll">
          <div className="st-form">
            <CapsTab />
          </div>
        </div>
      )}
      {full && tab === "basics" && (
        <BasicsPane
          preset={preset}
          draft={d.draft}
          set={set}
          onDelete={() => setDeleting(true)}
        />
      )}
      <SaveBar
        dirty={d.dirty}
        saving={d.saving}
        onSave={() => void d.save()}
        onDiscard={d.discard}
      />
      {renaming && (
        <NameDialog
          open
          title={`重命名${noun}`}
          initial={{ name: d.draft.name, desc: d.draft.desc }}
          onClose={() => setRenaming(false)}
          onSubmit={(v) => {
            set(v);
            setRenaming(false);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        title={`删除${noun}`}
        confirmLabel="删除"
        onClose={() => setDeleting(false)}
        onConfirm={() => {
          store.remove(preset.id);
          toast("已删除", { tone: "ok" });
          onBack();
        }}
      >
        删除「{preset.name}」？它的段与分组会一起删掉，卡片库里的卡片还在。
      </ConfirmDialog>
    </div>
  );
}
