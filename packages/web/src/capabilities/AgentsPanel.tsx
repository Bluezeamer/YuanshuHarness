import { useCallback, useEffect, useState } from "react";
import { listModels, loadToken, type ModelInfo } from "../api";
import { actionBtn, dangerBtn, describe } from "../settings/shared";
import { type AgentDraft, AgentForm, EMPTY_DRAFT, toDraft } from "./AgentForm";
import {
  type AgentInfo,
  type AgentInput,
  type BlockInfo,
  createAgent,
  deleteAgent,
  listAgents,
  listBlocks,
  listTools,
  patchAgent,
  type ToolInfo,
} from "./agentsApi";

interface Refs {
  models: ModelInfo[];
  blocks: BlockInfo[];
  tools: ToolInfo[];
}

const toInput = (d: AgentDraft): AgentInput => ({
  name: d.name.trim(),
  description: d.description.trim(),
  promptBlocks: d.promptBlocks,
  capabilities: d.capabilities,
  model: d.model || null,
  defaultThinkingLevel: d.thinking || null,
  defaultMode: d.mode,
});

// agent 定义编辑器：左列表 + 右表单。块 / 模型 / 工具目录一并加载，供表单选择。
export function AgentsPanel({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const [agents, setAgents] = useState<AgentInfo[] | "loading" | "failed">(
    "loading",
  );
  const [refs, setRefs] = useState<Refs>({ models: [], blocks: [], tools: [] });
  // null：未选；"new"：新建；否则为 agent id。
  const [sel, setSel] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const token = loadToken();
    const [a, m, b, t] = await Promise.all([
      listAgents(token),
      listModels(token),
      listBlocks(token),
      listTools(token),
    ]);
    for (const r of [a, m, b, t])
      if (!r.ok && r.kind === "unauthorized") onUnauthorized();
    setAgents(a.ok ? a.data : "failed");
    setRefs({
      models: m.ok ? m.data : [],
      blocks: b.ok ? b.data : [],
      tools: t.ok ? t.data : [],
    });
  }, [onUnauthorized]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const pick = (a: AgentInfo) => {
    setSel(a.id);
    setDraft(toDraft(a));
    setError(null);
  };
  const startNew = () => {
    setSel("new");
    setDraft(EMPTY_DRAFT);
    setError(null);
  };

  const fail = (
    r: Parameters<typeof describe>[0],
    ctx: Parameters<typeof describe>[1],
  ) => {
    if (r.kind === "unauthorized") onUnauthorized();
    setError(describe(r, ctx));
  };

  const save = async () => {
    if (!sel) return;
    setBusy(true);
    setError(null);
    const r =
      sel === "new"
        ? await createAgent(loadToken(), toInput(draft))
        : await patchAgent(loadToken(), sel, toInput(draft));
    setBusy(false);
    if (!r.ok)
      return fail(r, {
        bad_request: "请检查名称与所选工具是否有效",
        not_found: "该 agent 已被删除，请刷新",
      });
    setSel(r.data.id);
    setDraft(toDraft(r.data));
    await reload();
  };

  const remove = async () => {
    if (!sel || sel === "new") return;
    setBusy(true);
    setError(null);
    const r = await deleteAgent(loadToken(), sel);
    setBusy(false);
    if (!r.ok)
      return fail(r, {
        bad_request: "默认 agent 不能删除",
        conflict: "仍有会话在使用该 agent，不能删除",
        not_found: "该 agent 已被删除，请刷新",
      });
    setSel(null);
    await reload();
  };

  const list = Array.isArray(agents) ? agents : [];

  return (
    <div className="flex flex-col gap-3">
      {agents === "loading" && <p className="m-0 text-mute">加载中…</p>}
      {agents === "failed" && (
        <p role="alert" className="m-0 font-semibold text-acc">
          agent 列表加载失败
        </p>
      )}
      <div className="grid min-h-[360px] grid-cols-[minmax(180px,260px)_1fr] border border-ink max-[900px]:grid-cols-1">
        <div className="flex flex-col border-r border-ink max-[900px]:border-b max-[900px]:border-r-0">
          <ul
            aria-label="agent 定义"
            className="m-0 flex-1 list-none overflow-y-auto p-0"
          >
            {list.map((a) => (
              <li key={a.id} className="border-b border-line2">
                <button
                  type="button"
                  aria-current={sel === a.id}
                  onClick={() => pick(a)}
                  className={`flex w-full flex-col gap-0.5 border-l-[3px] px-3 py-2 text-left ${sel === a.id ? "border-ink bg-panel" : "border-transparent hover:bg-panel"}`}
                >
                  <span className="font-semibold">{a.name}</span>
                  <span className="truncate text-xs text-mute">
                    {a.defaultMode ?? "build"}
                    {a.description ? ` · ${a.description}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={startNew}
            className="border-t border-ink px-3 py-2 text-left font-semibold hover:bg-ink hover:text-bg"
          >
            新建 agent
          </button>
        </div>
        <div className="p-4">
          {sel === null ? (
            <p className="m-0 text-mute">
              选择左侧的 agent 进行编辑，或新建一个。
            </p>
          ) : (
            <form
              aria-label={sel === "new" ? "新建 agent" : "编辑 agent"}
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.name.trim()) void save();
              }}
              className="flex flex-col gap-4"
            >
              <AgentForm
                draft={draft}
                onChange={setDraft}
                onUnauthorized={onUnauthorized}
                {...refs}
              />
              {error && (
                <p role="alert" className="m-0 font-semibold text-acc">
                  {error}
                </p>
              )}
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={busy || !draft.name.trim()}
                  className={actionBtn}
                >
                  保存
                </button>
                {sel !== "new" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove()}
                    className={dangerBtn}
                  >
                    删除
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
