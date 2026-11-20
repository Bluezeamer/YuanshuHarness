import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { loadToken } from "../../../api/http";
import {
  getSessionConfig,
  type SessionConfig,
} from "../../../api/sessionConfig";
import type { Workspace } from "../../../api/workspaces";
import {
  Button,
  Drill,
  Field,
  InlineNotice,
  Input,
  Modal,
  Select,
  SummaryRow,
  toast,
} from "../../../ui";
import { getSessionView, loadCatalog } from "./api";
import { CapsEditor } from "./editors/CapsEditor";
import { ModelEditor } from "./editors/ModelEditor";
import { ModesEditor } from "./editors/ModesEditor";
import { TierEditor } from "./editors/TierEditor";
import type { Catalog } from "./model/catalog";
import { presetDefaults } from "./model/catalog";
import {
  agentLabel,
  capsChanged,
  capsLabel,
  modelValueLabel,
  modesLabel,
  tierValueLabel,
} from "./model/labels";
import {
  formForWorkspace,
  formFromConfig,
  modelIssue,
  type SessionForm,
  type SessionMode,
  TITLE_MAX,
  withPromptPreset,
} from "./model/session";
import { createSession, saveSession } from "./sessionSubmit";

export interface SessionDialogProps {
  /** create 用工作区默认配置起步；edit 载入已保存配置；from 把源会话的配置灌进来再创建（不复制对话） */
  mode: SessionMode;
  /** 会话所在（create / from 是要建进去）的工作区 */
  workspace: Workspace;
  /** edit：要编辑的会话；from：配置来源的会话 */
  sessionId?: string;
  onClose: () => void;
  /** 创建 / 保存成功后给出会话 id */
  onDone: (id: string) => void;
}

interface Loaded {
  cat: Catalog;
  form: SessionForm;
  /** 恢复与比较的基准 */
  orig: SessionForm;
  /** 编辑时的配置版本号（baseRev） */
  rev: number;
}

async function load(
  mode: SessionMode,
  workspace: Workspace,
  sessionId: string | undefined,
): Promise<Loaded> {
  const token = loadToken();
  const cat = await loadCatalog(token);
  if (mode === "create") {
    const form = formForWorkspace(cat, workspace);
    return { cat, form, orig: form, rev: 0 };
  }
  if (!sessionId) throw new Error("缺少会话 id");
  const [cfg, view] = await Promise.all([
    getSessionConfig(token, sessionId),
    getSessionView(token, sessionId),
  ]);
  const form = formFromConfig(
    cfg,
    { promptPresetId: view.promptPresetId, modePresetIds: view.modePresetIds },
    cat,
    mode === "edit" ? view.title : "",
  );
  return { cat, form, orig: form, rev: mode === "edit" ? cfg.rev : 0 };
}

const HEAD: Record<SessionMode, { title: string; go: string }> = {
  create: { title: "新对话", go: "创建" },
  from: { title: "以此配置新建", go: "创建" },
  edit: { title: "会话设置", go: "保存" },
};

type DrillKey = "model" | "tier" | "caps" | "modes";
const DRILL_TITLE: Record<DrillKey, string> = {
  model: "模型",
  tier: "权限",
  caps: "能力",
  modes: "模式",
};

export function SessionDialog(props: SessionDialogProps) {
  const { mode, workspace, sessionId, onClose } = props;
  const [state, setState] = useState<
    { phase: "loading" } | { phase: "error" } | ({ phase: "ready" } & Loaded)
  >({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 只用来触发重试
  useEffect(() => {
    let alive = true;
    setState({ phase: "loading" });
    load(mode, workspace, sessionId).then(
      (r) => alive && setState({ phase: "ready", ...r }),
      () => alive && setState({ phase: "error" }),
    );
    return () => {
      alive = false;
    };
  }, [mode, workspace, sessionId, attempt]);

  if (state.phase === "ready") return <Body {...props} loaded={state} />;
  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={HEAD[mode].title}
      footer={
        state.phase === "error" && (
          <>
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
              重试
            </Button>
          </>
        )
      }
    >
      <p role={state.phase === "error" ? "alert" : "status"}>
        {state.phase === "error"
          ? "载入配置失败，请检查网络与登录状态后重试。"
          : "正在载入配置…"}
      </p>
    </Modal>
  );
}

function Body({
  mode,
  workspace,
  sessionId,
  onClose,
  onDone,
  loaded,
}: SessionDialogProps & { loaded: Loaded }) {
  const { cat } = loaded;
  const [form, setForm] = useState(loaded.form);
  const orig = useRef(loaded.orig);
  const rev = useRef(loaded.rev);
  const [drill, setDrill] = useState<DrillKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    current: SessionConfig | null;
  } | null>(null);
  const editing = mode === "edit";
  const head = HEAD[mode];

  const patch = (next: Partial<SessionForm>) => {
    setForm((f) => ({ ...f, ...next }));
    setError(null);
  };
  const issue = modelIssue(form, cat);

  const submit = async (baseRev = rev.current) => {
    if (busy || issue) return;
    setBusy(true);
    setError(null);
    const token = loadToken();
    const out = editing
      ? await saveSession(
          token,
          sessionId as string,
          form,
          orig.current,
          baseRev,
        )
      : await createSession(token, workspace.id, form);
    setBusy(false);
    if (out.ok) {
      if (out.later) toast(out.later);
      if (out.note) toast(out.note, { tone: "warn" });
      onDone(out.id);
    } else if ("conflict" in out) setConflict({ current: out.conflict });
    else setError(out.error);
  };

  const currentConfig = async (): Promise<SessionConfig | null> => {
    try {
      return (
        conflict?.current ??
        (await getSessionConfig(loadToken(), sessionId as string))
      );
    } catch {
      setError("读取服务端配置失败，请稍后重试。");
      return null;
    }
  };

  const adopt = async () => {
    const cur = await currentConfig();
    if (!cur) return;
    const base = orig.current;
    const adopted = formFromConfig(
      cur,
      {
        promptPresetId: base.promptPresetId,
        modePresetIds: base.modePresetIds,
      },
      cat,
      base.title,
    );
    orig.current = adopted;
    rev.current = cur.rev;
    setForm((f) => ({ ...adopted, title: f.title }));
    setConflict(null);
  };

  const overwrite = async () => {
    const cur = await currentConfig();
    if (!cur) return;
    rev.current = cur.rev;
    setConflict(null);
    await submit(cur.rev);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!drill) void submit();
    }
  };

  const followModel = form.model.mode === "follow";
  const capsDiffer = capsChanged(cat, form.promptPresetId, form.capabilities);

  return (
    <Modal
      open
      size="md"
      onClose={onClose}
      dismissOnScrim={false}
      title={head.title}
      description={mode === "edit" ? undefined : workspace.name}
      footer={
        drill ? (
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
              onClick={() => submit()}
            >
              {head.go}
            </Button>
          </>
        )
      }
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 只接 ⌘/Ctrl+Enter 提交，输入框里的按键冒泡到这里 */}
      <div onKeyDown={onKeyDown}>
        {drill ? (
          <Drill title={DRILL_TITLE[drill]} onBack={() => setDrill(null)}>
            {drill === "model" && (
              <ModelEditor
                cat={cat}
                value={form.model}
                onChange={(model) => patch({ model })}
              />
            )}
            {drill === "tier" && (
              <TierEditor
                cat={cat}
                value={form.permissionTier}
                onChange={(permissionTier) => patch({ permissionTier })}
              />
            )}
            {drill === "caps" && (
              <CapsEditor
                cat={cat}
                agentId={form.promptPresetId}
                value={form.capabilities}
                onChange={(capabilities) => patch({ capabilities })}
              />
            )}
            {drill === "modes" && (
              <ModesEditor
                cat={cat}
                value={form.modePresetIds}
                onChange={(modePresetIds) => patch({ modePresetIds })}
              />
            )}
          </Drill>
        ) : (
          <>
            <div className="dlg-stack">
              <Field label="名称" hint="可不填，首条消息会自动命名">
                {(c) => (
                  <Input
                    {...c}
                    large
                    value={form.title}
                    maxLength={TITLE_MAX}
                    placeholder="例如：修复登录态丢失"
                    onChange={(e) => patch({ title: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Agent" hint="创建后不能更换。">
                {(c) => (
                  <Select
                    {...c}
                    size="lg"
                    disabled={editing}
                    value={form.promptPresetId}
                    options={
                      cat.agentPresets.length === 0
                        ? [{ value: "", label: "默认预设" }]
                        : cat.agentPresets.map((p) => ({
                            value: p.id,
                            label: p.name,
                            ...(p.description ? { hint: p.description } : {}),
                          }))
                    }
                    onChange={(id) =>
                      setForm((f) => withPromptPreset(f, cat, id))
                    }
                  />
                )}
              </Field>
            </div>
            <div className="dlg-sep" />
            <SummaryRow
              label="模型"
              value={modelValueLabel(cat, form.model)}
              note={followModel ? "跟随默认" : undefined}
              tone={issue ? "danger" : undefined}
              onOpen={() => setDrill("model")}
              onReset={
                followModel
                  ? undefined
                  : () => patch({ model: { ...form.model, mode: "follow" } })
              }
            />
            <SummaryRow
              label="权限"
              value={tierValueLabel(cat, form.permissionTier)}
              note={form.permissionTier === null ? "跟随全局默认" : undefined}
              onOpen={() => setDrill("tier")}
              onReset={
                form.permissionTier === null
                  ? undefined
                  : () => patch({ permissionTier: null })
              }
            />
            <SummaryRow
              label="能力"
              value={capsLabel(form.capabilities)}
              note={
                capsDiffer
                  ? "已改动"
                  : `${agentLabel(cat, form.promptPresetId)} 基线`
              }
              onOpen={() => setDrill("caps")}
              onReset={
                capsDiffer
                  ? () =>
                      patch({
                        capabilities: presetDefaults(cat, form.promptPresetId)
                          .capabilities,
                      })
                  : undefined
              }
              resetLabel="恢复基线"
            />
            <SummaryRow
              label="模式"
              value={modesLabel(cat, form.modePresetIds)}
              onOpen={() => setDrill("modes")}
            />
            {issue && (
              <InlineNotice tone="danger" className="dlg-notice">
                {issue}。点「模型」改成跟随全局默认，或重新选一个。
              </InlineNotice>
            )}
            {conflict && (
              <InlineNotice tone="warn" className="dlg-notice">
                <span>配置已被别处修改。</span>{" "}
                <Button size="sm" variant="ghost" onClick={adopt}>
                  采用服务端版本
                </Button>
                <Button size="sm" variant="ghost" onClick={overwrite}>
                  覆盖
                </Button>
              </InlineNotice>
            )}
            {error && (
              <InlineNotice tone="danger" className="dlg-notice">
                {error}
              </InlineNotice>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
