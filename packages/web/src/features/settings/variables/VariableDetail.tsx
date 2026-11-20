import { useState } from "react";
import type { VariableView, VarPolicy } from "../../../api/variables";
import {
  Button,
  Dot,
  Field,
  IconButton,
  Input,
  Menu,
  Segmented,
  Select,
  SettingRow,
  Textarea,
  toast,
} from "../../../ui";
import { CopyIcon, VariablesIcon } from "../../../ui/icons";
import { FormColumn } from "../frame/layout";
import { useBindDirty } from "../frame/leave";
import { SaveBar } from "../frame/SaveBar";
import { useDraft } from "../frame/useDraft";
import { ExpiryEditor } from "./ExpiryEditor";
import {
  DESC_MAX,
  type Editable,
  editableOf,
  expiryLine,
  GROUP_MAX,
  groupNames,
  POLICIES,
  POLICY_HINT,
  POLICY_LABEL,
  relTime,
  statusOf,
} from "./model";
import type { VariablesStore, WorkspaceBrief } from "./store";
import { ValueSection } from "./ValueSection";
import { WorkspacePicker } from "./WorkspacePicker";

const NEW_GROUP = " new";
const NO_GROUP = " none";

export interface VariableDetailProps {
  v: VariableView;
  all: readonly VariableView[];
  workspaces: readonly WorkspaceBrief[];
  store: VariablesStore;
  now: number;
  onRotate: () => void;
  onRemove: () => void;
  onOpenRefs: () => void;
}

// 一个变量的全部设置。值与动作（显示 / 复制 / 轮换 / 删除）立即生效；
// 有效期、启用的工作区、策略、变量组、描述进草稿，点保存才落（ys-ui-design 的 X06）。
export function VariableDetail({
  v,
  all,
  workspaces,
  store,
  now,
  onRotate,
  onRemove,
  onOpenRefs,
}: VariableDetailProps) {
  const d = useDraft(editableOf(v), async (draft) => {
    const r = await store.save(v, draft);
    return r.ok ? null : r.message;
  });
  useBindDirty(d);
  const [naming, setNaming] = useState<string | null>(null);

  const draft = d.draft;
  const patch = (c: Partial<Editable>) => d.setDraft({ ...draft, ...c });
  const st = statusOf(v);
  const ref = `{{@${v.name}}}`;
  const groups = groupNames(all);

  return (
    <>
      <FormColumn>
        <article aria-label={`${v.name} 详情`}>
          <header className="vr-head">
            <span className="vr-tile" aria-hidden="true">
              <VariablesIcon size={18} />
            </span>
            <div className="vr-head-text">
              <span className="t-block">{v.name}</span>
              <span className="vr-head-sub t-aux">
                引用写法 <span className="t-mono">{ref}</span>
                <IconButton
                  size="sm"
                  label="复制引用写法"
                  icon={<CopyIcon />}
                  onClick={() => toast("已复制引用写法", { tone: "ok" })}
                />
                {v.lastUsedAt ? (
                  <>
                    · 最近引用 {relTime(v.lastUsedAt, now)}
                    <Button size="sm" variant="ghost" onClick={onOpenRefs}>
                      查看记录
                    </Button>
                  </>
                ) : (
                  "· 还没被引用过"
                )}
              </span>
            </div>
            <span className="vr-grow" />
            <span className="vr-status t-aux">
              <Dot tone={st.tone} />
              {st.label}
            </span>
            <Menu
              label="更多操作"
              items={[
                {
                  id: "remove",
                  label: "删除变量",
                  tone: "danger",
                  onSelect: onRemove,
                },
              ]}
            />
          </header>

          <section className="st-block" aria-label="值">
            <header className="st-block-h t-group">值</header>
            <ValueSection v={v} store={store} onRotate={onRotate} />
            <SettingRow
              label="有效期"
              description={expiryLine(draft.expiry, v, now)}
            >
              <ExpiryEditor
                value={draft.expiry}
                now={now}
                onChange={(expiry) => patch({ expiry })}
              />
            </SettingRow>
          </section>

          <section className="st-block" aria-label="启用于工作区">
            <header className="st-block-h t-group">
              <span>启用于工作区</span>
              <span className="t-mono">
                {draft.workspaces.length} / {workspaces.length}
              </span>
            </header>
            <p className="vr-note t-aux">
              默认哪个工作区都不启用。勾上的工作区，里面所有会话下一轮起都能引用它；没勾的看不到它。
            </p>
            <WorkspacePicker
              workspaces={workspaces}
              on={new Set(draft.workspaces)}
              onToggle={(id, on) =>
                patch({
                  workspaces: (on
                    ? [...draft.workspaces, id]
                    : draft.workspaces.filter((x) => x !== id)
                  ).sort(),
                })
              }
            />
          </section>

          <section className="st-block" aria-label="引用与说明">
            <header className="st-block-h t-group">引用与说明</header>
            <SettingRow
              label="引用策略"
              description={POLICY_HINT[draft.policy]}
            >
              <Segmented
                size="sm"
                aria-label="引用策略"
                value={draft.policy}
                onChange={(policy: VarPolicy) => patch({ policy })}
                options={POLICIES.map((p) => ({
                  value: p,
                  label: POLICY_LABEL[p],
                }))}
              />
            </SettingRow>
            <SettingRow
              label="变量组"
              description="同组的变量，在「编辑工作区」里可以一起勾选。"
            >
              {naming === null ? (
                <Select
                  aria-label="变量组"
                  value={draft.group ?? NO_GROUP}
                  options={[
                    { value: NO_GROUP, label: "不分组" },
                    ...groups.map((g) => ({ value: g, label: g })),
                    ...(draft.group && !groups.includes(draft.group)
                      ? [{ value: draft.group, label: draft.group }]
                      : []),
                    { value: NEW_GROUP, label: "新建变量组…" },
                  ]}
                  onChange={(g) => {
                    if (g === NEW_GROUP) setNaming("");
                    else patch({ group: g === NO_GROUP ? null : g });
                  }}
                />
              ) : (
                <Input
                  autoFocus
                  aria-label="新变量组名称"
                  placeholder="变量组名称，回车确认"
                  maxLength={GROUP_MAX}
                  value={naming}
                  onChange={(e) => setNaming(e.target.value)}
                  onBlur={() => setNaming(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setNaming(null);
                    if (e.key === "Enter" && naming.trim()) {
                      patch({ group: naming.trim() });
                      setNaming(null);
                    }
                  }}
                />
              )}
            </SettingRow>
            <Field
              label="描述"
              hint="进入上下文，写「什么时候用」。不要写值、内网地址或密钥前缀。下一回合生效。"
            >
              {(c) => (
                <Textarea
                  {...c}
                  rows={3}
                  maxLength={DESC_MAX}
                  spellCheck={false}
                  value={draft.desc}
                  onChange={(e) => patch({ desc: e.target.value })}
                />
              )}
            </Field>
          </section>
        </article>
      </FormColumn>
      <SaveBar
        dirty={d.dirty}
        saving={d.saving}
        onSave={() => void d.save()}
        onDiscard={d.discard}
      />
    </>
  );
}
