import { useEffect, useRef, useState } from "react";
import { gitStatus } from "../../../api/git";
import { loadToken } from "../../../api/http";
import type { DirectoryPreview, Workspace } from "../../../api/workspaces";
import {
  Button,
  Drill,
  Field,
  InlineNotice,
  Input,
  ListRow,
  Modal,
  Segmented,
  Select,
  SummaryRow,
  Textarea,
} from "../../../ui";
import { PlusIcon } from "../../../ui/icons";
import {
  type CapabilityPick,
  loadCapabilityPick,
  loadCatalog,
  loadVariablePick,
  type VariablePick,
} from "./api";
import { CapabilitiesEditor } from "./editors/CapabilitiesEditor";
import { blankDir, DirRow } from "./editors/DirRow";
import { ModelEditor } from "./editors/ModelEditor";
import { ModesEditor } from "./editors/ModesEditor";
import { TierEditor } from "./editors/TierEditor";
import { VariablesEditor } from "./editors/VariablesEditor";
import type { Catalog } from "./model/catalog";
import {
  capsNote,
  capsValue,
  modelValueLabel,
  modesLabel,
  reviewValue,
  tierValueLabel,
} from "./model/labels";
import { isAbsolute, normDir } from "./model/path";
import {
  blankDefaults,
  blankWorkspaceForm,
  DESCRIPTION_MAX,
  DIRECTORIES_MAX,
  defaultName,
  formFromWorkspace,
  NAME_MAX,
  overriddenCount,
  ownerOf,
  REVIEW_POLICY_MAX,
  type WorkspaceForm,
  type WorkspaceMode,
  workspaceIssue,
} from "./model/workspace";
import {
  applyAgentsMdStep,
  applyDirsStep,
  createWorkspaceStep,
  patchWorkspaceStep,
  previewDirsStep,
  setCapabilitiesStep,
  setVariablesStep,
} from "./workspaceSubmit";

export interface WorkspaceDialogProps {
  mode: WorkspaceMode;
  /** edit：要编辑的工作区 */
  workspace?: Workspace;
  /** 现有的工作区：新建时用来发现「这个主目录已经有工作区了」 */
  workspaces: readonly Workspace[];
  onClose: () => void;
  /** created = 这次新建了工作区（调用方据此再建一个新对话）；打开已有的、编辑保存都是 false */
  onDone: (ws: Workspace, created: boolean) => void;
}

type Drilled =
  | "extras"
  | "defaults"
  | "review"
  | "variables"
  | "capabilities"
  | "template";
const DRILL_TITLE: Record<Drilled, string> = {
  extras: "附加目录",
  defaults: "新会话默认配置",
  review: "审核要求",
  variables: "隐私变量",
  capabilities: "技能与 MCP",
  template: "项目 AGENTS.md",
};

type Phase =
  | { kind: "form" }
  /** 要移除的目录会连带删掉什么，让用户确认 */
  | { kind: "dirs"; ws: Workspace; preview: DirectoryPreview }
  /** 主目录里已经有 AGENTS.md：问追加 / 覆盖 / 不写 */
  | { kind: "agents"; ws: Workspace };

export function WorkspaceDialog(props: WorkspaceDialogProps) {
  const [cat, setCat] = useState<Catalog | null | "error">(null);
  const [pick, setPick] = useState<VariablePick | null>(null);
  const [capPick, setCapPick] = useState<CapabilityPick | null>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 只用来触发重试
  useEffect(() => {
    let alive = true;
    setCat(null);
    const token = loadToken();
    Promise.all([
      loadCatalog(token),
      loadVariablePick(token, props.workspace?.id),
      loadCapabilityPick(token, props.workspace?.id),
    ]).then(
      ([c, p, k]) => {
        if (!alive) return;
        setPick(p);
        setCapPick(k);
        setCat(c);
      },
      () => alive && setCat("error"),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  if (cat !== null && cat !== "error" && pick && capPick)
    return <Body {...props} cat={cat} pick={pick} capPick={capPick} />;
  return (
    <Modal
      open
      size="sm"
      onClose={props.onClose}
      title={props.mode === "edit" ? "编辑工作区" : "新建工作区"}
      footer={
        cat === "error" && (
          <>
            <Button variant="ghost" onClick={props.onClose}>
              关闭
            </Button>
            <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
              重试
            </Button>
          </>
        )
      }
    >
      <p role={cat === "error" ? "alert" : "status"}>
        {cat === "error"
          ? "载入配置失败，请检查网络与登录状态后重试。"
          : "正在载入配置…"}
      </p>
    </Modal>
  );
}

function Body({
  mode,
  workspace,
  workspaces,
  onClose,
  onDone,
  cat,
  pick,
  capPick,
}: WorkspaceDialogProps & {
  cat: Catalog;
  pick: VariablePick;
  capPick: CapabilityPick;
}) {
  const editing = mode === "edit" && workspace !== undefined;
  const orig = useRef(
    editing ? formFromWorkspace(workspace, cat) : blankWorkspaceForm(cat),
  );
  const [form, setForm] = useState(orig.current);
  const [enabled, setEnabled] = useState(pick.enabled);
  const [caps, setCaps] = useState(capPick.picked);
  // 新建时选的项目 AGENTS.md 模板（预设 id）；空 = 不用
  const [template, setTemplate] = useState("");
  const [drill, setDrill] = useState<Drilled | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [git, setGit] = useState<"repo" | "none" | null>(null);

  const patch = (next: Partial<WorkspaceForm>) => {
    setForm((f) => ({ ...f, ...next }));
    setError(null);
  };

  const owner = editing ? undefined : ownerOf(workspaces, form.primary);
  const issue =
    workspaceIssue(form) ??
    (editing && !form.name.trim() ? "名称不能为空。" : null);

  // 非 git 目录给个不拦人的提示；路径还没写完整、目录读不了都不提示
  const { host, path, id } = form.primary;
  useEffect(() => {
    setGit(null);
    if (id !== undefined || !isAbsolute(path)) return;
    let alive = true;
    const t = setTimeout(() => {
      void gitStatus(loadToken(), host, normDir(path)).then((r) => {
        if (alive && r.ok) setGit(r.data.root === null ? "none" : "repo");
      });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [host, path, id]);

  const fail = (text: string) => {
    setBusy(false);
    setError(text);
  };

  const finish = (ws: Workspace, created: boolean) => onDone(ws, created);

  // 启用的变量与勾选的技能 / MCP 变了才写；工作区本身已经建好 / 改好，所以失败只提示这一步，再点一次保存会重试
  const varsChanged = JSON.stringify(enabled) !== JSON.stringify(pick.enabled);
  const capsChanged = JSON.stringify(caps) !== JSON.stringify(capPick.picked);
  const finishWithSettings = async (ws: Workspace, created: boolean) => {
    if (varsChanged) {
      const r = await setVariablesStep(ws.id, enabled);
      if (!r.ok) return fail(`隐私变量没有保存：${r.error}`);
    }
    if (capsChanged) {
      const r = await setCapabilitiesStep(ws.id, caps);
      if (!r.ok) return fail(`技能与 MCP 的勾选没有保存：${r.error}`);
    }
    if (!editing && template) return writeTemplate(ws);
    return finish(ws, created);
  };

  // 模板写进主目录；已有文件时停下来问，mode 是用户的选择
  const writeTemplate = async (
    ws: Workspace,
    mode?: "overwrite" | "append",
  ) => {
    setBusy(true);
    const r = await applyAgentsMdStep(ws.id, template, mode);
    if (!r.ok) {
      setPhase({ kind: "form" });
      return fail(`项目 AGENTS.md 没有写入：${r.error}`);
    }
    if (r.value === "exists") {
      setBusy(false);
      return setPhase({ kind: "agents", ws });
    }
    return finish(ws, true);
  };

  const submit = async () => {
    if (busy || issue) return;
    if (owner) return finish(owner, false);
    setBusy(true);
    setError(null);
    if (!editing) {
      const created = await createWorkspaceStep(form);
      if (!created.ok) return fail(created.error);
      return finishWithSettings(created.value, true);
    }
    const patched = await patchWorkspaceStep(workspace, form, orig.current);
    if (!patched.ok) return fail(patched.error);
    const preview = await previewDirsStep(patched.value, form, orig.current);
    if (!preview.ok) return fail(preview.error);
    if (preview.value === null) return finishWithSettings(patched.value, false);
    if (preview.value.removed.length > 0) {
      setBusy(false);
      return setPhase({
        kind: "dirs",
        ws: patched.value,
        preview: preview.value,
      });
    }
    const applied = await applyDirsStep(patched.value, form);
    return applied.ok
      ? finishWithSettings(applied.value, false)
      : fail(applied.error);
  };

  const confirmDirs = async () => {
    if (phase.kind !== "dirs") return;
    setBusy(true);
    const applied = await applyDirsStep(phase.ws, form);
    if (!applied.ok) {
      setPhase({ kind: "form" });
      return fail(applied.error);
    }
    setPhase({ kind: "form" });
    return finishWithSettings(applied.value, false);
  };

  const overridden = overriddenCount(form.defaults);
  const head = editing ? "编辑工作区" : "新建工作区";

  return (
    <Modal
      open
      size="md"
      onClose={onClose}
      dismissOnScrim={false}
      title={head}
      footer={
        phase.kind === "dirs" ? (
          <>
            <Button
              variant="ghost"
              size="lg"
              onClick={() => setPhase({ kind: "form" })}
            >
              返回
            </Button>
            <Button
              variant="danger"
              size="lg"
              loading={busy}
              onClick={confirmDirs}
            >
              移除并保存
            </Button>
          </>
        ) : phase.kind === "agents" ? (
          <>
            <Button
              variant="ghost"
              size="lg"
              disabled={busy}
              onClick={() => finish(phase.ws, true)}
            >
              不写入
            </Button>
            <Button
              variant="outline"
              size="lg"
              loading={busy}
              onClick={() => void writeTemplate(phase.ws, "append")}
            >
              追加到末尾
            </Button>
            <Button
              variant="danger"
              size="lg"
              loading={busy}
              onClick={() => void writeTemplate(phase.ws, "overwrite")}
            >
              覆盖
            </Button>
          </>
        ) : drill ? (
          <Button variant="primary" size="lg" onClick={() => setDrill(null)}>
            完成
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="lg" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="lg"
              disabled={issue !== null}
              loading={busy}
              onClick={submit}
            >
              {editing ? "保存" : owner ? "打开" : "创建"}
            </Button>
          </>
        )
      }
    >
      {phase.kind === "agents" ? (
        <div className="dlg-stack">
          <p className="t-plain">
            工作区已经建好，但主目录里已经有一个 AGENTS.md。
          </p>
          <p className="t-aux">
            追加：把模板接在原有内容后面；覆盖：用模板替换原有内容；不写入：保持原样，不用模板。
          </p>
          {error && <InlineNotice tone="danger">{error}</InlineNotice>}
        </div>
      ) : phase.kind === "dirs" ? (
        <div className="dlg-stack">
          <p className="t-plain">要从工作区里移除这些目录：</p>
          {phase.preview.removed.map((d) => (
            <div key={d.id} className="dlg-impact">
              <span className="t-plain">{d.name}</span>
              <span className="t-mono">{d.path}</span>
              <span className="t-aux">
                {d.removed
                  ? `没有别的工作区在用，会连同 ${d.rules} 条规则、${d.hooks} 个 hook 一起删除`
                  : "还有别的工作区在用，目录本身保留"}
              </span>
            </div>
          ))}
        </div>
      ) : drill ? (
        <Drill title={DRILL_TITLE[drill]} onBack={() => setDrill(null)}>
          {drill === "extras" && (
            <div className="dlg-stack">
              {form.extras.map((r) => (
                <DirRow
                  key={r.key}
                  row={r}
                  cat={cat}
                  onChange={(next) =>
                    patch({
                      extras: form.extras.map((x) =>
                        x.key === r.key ? next : x,
                      ),
                    })
                  }
                  onRemove={() =>
                    patch({
                      extras: form.extras.filter((x) => x.key !== r.key),
                    })
                  }
                />
              ))}
              {form.extras.length === 0 && (
                <p className="t-aux">还没有附加目录。</p>
              )}
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<PlusIcon aria-hidden />}
                  disabled={form.extras.length + 1 >= DIRECTORIES_MAX}
                  onClick={() =>
                    patch({
                      extras: [...form.extras, blankDir(form.primary.host)],
                    })
                  }
                >
                  添加目录
                </Button>
              </div>
              <p className="t-aux">
                附加目录可以在别的主机上；agent 用 switch_directory
                在主目录和它们之间切换。最多 {DIRECTORIES_MAX - 1} 个。
              </p>
            </div>
          )}
          {drill === "template" && (
            <div className="dlg-stack">
              <p className="t-aux">
                创建后把所选模板写进主目录的
                AGENTS.md，之后这个文件归项目自己，不再随模板变。模板在「设置 ·
                提示词与能力 · 项目 AGENTS.md」里管理。
              </p>
              <div>
                <ListRow
                  label="不使用"
                  current={template === ""}
                  onClick={() => setTemplate("")}
                />
                {cat.agentsTemplates.map((p) => (
                  <ListRow
                    key={p.id}
                    label={p.name}
                    {...(p.description ? { sub: p.description } : {})}
                    current={template === p.id}
                    onClick={() => setTemplate(p.id)}
                  />
                ))}
              </div>
            </div>
          )}
          {drill === "variables" && (
            <VariablesEditor
              variables={pick.variables}
              value={enabled}
              onChange={setEnabled}
            />
          )}
          {drill === "capabilities" && (
            <CapabilitiesEditor
              pick={capPick}
              value={caps}
              onChange={setCaps}
            />
          )}
          {drill === "review" && (
            <div className="dlg-stack">
              <p className="t-aux">
                「模型」权限档下，规则外的动作先交审批模型判定。这里写这个工作区的特殊要求，保存后下一次审核就生效；留空就跟随全局的判别准则（在「设置
                · 提示词与能力 · 审核提示词」里改）。
              </p>
              <Field label="写法">
                <Segmented
                  aria-label="审核要求的写法"
                  value={form.reviewPolicy.mode}
                  options={[
                    { value: "append", label: "追加" },
                    { value: "override", label: "覆盖" },
                  ]}
                  onChange={(mode) =>
                    patch({ reviewPolicy: { ...form.reviewPolicy, mode } })
                  }
                />
              </Field>
              <Field
                label="这个工作区的要求"
                hint={
                  form.reviewPolicy.mode === "append"
                    ? "接在全局判别准则后面；例如「禁止联网」「只许改 docs/ 下的文件」"
                    : "整段替换全局判别准则；输出格式与防注入的固定部分始终保留"
                }
              >
                {(c) => (
                  <Textarea
                    {...c}
                    mono
                    rows={8}
                    maxLength={REVIEW_POLICY_MAX}
                    value={form.reviewPolicy.text}
                    onChange={(e) =>
                      patch({
                        reviewPolicy: {
                          ...form.reviewPolicy,
                          text: e.target.value,
                        },
                      })
                    }
                  />
                )}
              </Field>
            </div>
          )}
          {drill === "defaults" && (
            <div className="dlg-stack">
              <p className="t-aux">
                只在新建对话时套用并拷进会话，之后改这里不影响已有会话。没覆盖的跟随全局。
              </p>
              <Field label="Agent">
                {(c) => (
                  <Select
                    {...c}
                    value={form.defaults.agentPresetId}
                    options={[
                      {
                        value: "",
                        label: `跟随全局 · ${cat.agentPresets[0]?.name ?? "默认"}`,
                      },
                      ...cat.agentPresets.map((p) => ({
                        value: p.id,
                        label: p.name,
                      })),
                    ]}
                    onChange={(agentPresetId) =>
                      patch({ defaults: { ...form.defaults, agentPresetId } })
                    }
                  />
                )}
              </Field>
              <Field label="模型">
                <ModelEditor
                  cat={cat}
                  value={form.defaults.model}
                  onChange={(model) =>
                    patch({ defaults: { ...form.defaults, model } })
                  }
                />
              </Field>
              <Field label="权限">
                <TierEditor
                  cat={cat}
                  value={form.defaults.permissionTier}
                  onChange={(permissionTier) =>
                    patch({ defaults: { ...form.defaults, permissionTier } })
                  }
                />
              </Field>
              <Field label="可切换的模式">
                <ModesEditor
                  cat={cat}
                  value={form.defaults.modePresetIds}
                  onChange={(modePresetIds) =>
                    patch({ defaults: { ...form.defaults, modePresetIds } })
                  }
                />
              </Field>
            </div>
          )}
        </Drill>
      ) : (
        <>
          <div className="dlg-stack">
            <Field
              label="主目录"
              hint={editing ? "主目录不能更换。" : undefined}
            >
              <DirRow
                large
                row={form.primary}
                cat={cat}
                onChange={(primary) => patch({ primary })}
              />
            </Field>
            {owner && (
              <InlineNotice>
                这个目录已是「{owner.name}」的主目录，点「打开」直接进入它。
              </InlineNotice>
            )}
            {git === "none" && !owner && (
              <InlineNotice>
                这里不是 git 仓库：版本视图和轮末 diff 用不了，其余照常。
              </InlineNotice>
            )}
            {!owner && (
              <>
                <Field
                  label="名称"
                  hint={editing ? undefined : "留空就用目录名"}
                >
                  {(c) => (
                    <Input
                      {...c}
                      large
                      value={form.name}
                      maxLength={NAME_MAX}
                      placeholder={defaultName(form) || "例如：我的项目"}
                      onChange={(e) => patch({ name: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="描述（可选）" hint="只给人看，不进提示词">
                  {(c) => (
                    <Input
                      {...c}
                      value={form.description}
                      maxLength={DESCRIPTION_MAX}
                      onChange={(e) => patch({ description: e.target.value })}
                    />
                  )}
                </Field>
              </>
            )}
          </div>
          {!owner && (
            <>
              <div className="dlg-sep" />
              <SummaryRow
                label="附加目录"
                value={form.extras.length ? `${form.extras.length} 个` : "无"}
                onOpen={() => setDrill("extras")}
              />
              <SummaryRow
                label="新会话默认"
                value={
                  overridden === 0
                    ? "全部跟随全局"
                    : `${modelValueLabel(cat, form.defaults.model)} · ${tierValueLabel(cat, form.defaults.permissionTier)} · 模式 ${modesLabel(cat, form.defaults.modePresetIds)}`
                }
                note={overridden === 0 ? undefined : `覆盖 ${overridden} 项`}
                onOpen={() => setDrill("defaults")}
                onReset={
                  overridden === 0
                    ? undefined
                    : () => patch({ defaults: blankDefaults(cat) })
                }
                resetLabel="全部跟随"
              />
              {editing && (
                <SummaryRow
                  label="审核要求"
                  value={reviewValue(form.reviewPolicy)}
                  note={
                    form.reviewPolicy.text.trim() === ""
                      ? undefined
                      : `${form.reviewPolicy.text.trim().length} 字`
                  }
                  onOpen={() => setDrill("review")}
                  onReset={
                    form.reviewPolicy.text.trim() === ""
                      ? undefined
                      : () =>
                          patch({
                            reviewPolicy: { ...form.reviewPolicy, text: "" },
                          })
                  }
                  resetLabel="跟随全局"
                />
              )}
              {!editing && (
                <SummaryRow
                  label="项目 AGENTS.md"
                  value={
                    cat.agentsTemplates.length === 0
                      ? "还没有模板"
                      : template === ""
                        ? "不使用"
                        : (cat.agentsTemplates.find((p) => p.id === template)
                            ?.name ?? "不使用")
                  }
                  note={template === "" ? undefined : "创建时写入主目录"}
                  onOpen={() => setDrill("template")}
                  onReset={template === "" ? undefined : () => setTemplate("")}
                  resetLabel="不使用"
                />
              )}
              <SummaryRow
                label="隐私变量"
                value={
                  pick.variables.length === 0
                    ? "还没有隐私变量"
                    : enabled.length === 0
                      ? "都不启用"
                      : `已启用 ${enabled.length} 个`
                }
                note={
                  pick.variables.length === 0
                    ? undefined
                    : enabled.length === 0
                      ? "默认"
                      : `共 ${pick.variables.length} 个可选`
                }
                onOpen={() => setDrill("variables")}
                onReset={
                  enabled.length === 0 ? undefined : () => setEnabled([])
                }
                resetLabel="全部关闭"
              />
              <SummaryRow
                label="技能与 MCP"
                value={capsValue(capPick, caps)}
                note={capsNote(capPick)}
                onOpen={() => setDrill("capabilities")}
                onReset={
                  caps.skill.length + caps.mcp.length === 0
                    ? undefined
                    : () => setCaps({ skill: [], mcp: [] })
                }
                resetLabel="全部取消"
              />
            </>
          )}
          {issue && form.primary.path !== "" && (
            <InlineNotice tone="danger" className="dlg-notice">
              {issue}
            </InlineNotice>
          )}
          {error && (
            <InlineNotice tone="danger" className="dlg-notice">
              {error}
            </InlineNotice>
          )}
        </>
      )}
    </Modal>
  );
}
