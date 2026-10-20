import { useCallback, useEffect, useState } from "react";
import { loadToken } from "../api";
import { actionBtn, dangerBtn, describe, field } from "../settings/shared";
import {
  type BlockInfo,
  createBlock,
  deleteBlock,
  listBlocks,
  patchBlock,
} from "./agentsApi";
import { Field } from "./Field";

// 组装时固定的三个分组；其余分组名按自定义分组处理。
const PRESET_GROUPS = ["角色定义", "全局约定", "项目约定"];

interface Draft {
  name: string;
  group: string;
  dimension: string;
  content: string;
}
const EMPTY: Draft = {
  name: "",
  group: PRESET_GROUPS[0] as string,
  dimension: "",
  content: "",
};
const toDraft = (b: BlockInfo): Draft => ({
  name: b.name,
  group: b.group,
  dimension: b.dimension ?? "",
  content: b.content,
});

export function PromptBlocksPanel({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const [blocks, setBlocks] = useState<BlockInfo[] | "loading" | "failed">(
    "loading",
  );
  // null：未选；"new"：新建；否则为块 id。
  const [sel, setSel] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await listBlocks(loadToken());
    if (!r.ok && r.kind === "unauthorized") onUnauthorized();
    setBlocks(r.ok ? r.data : "failed");
  }, [onUnauthorized]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const pick = (b: BlockInfo) => {
    setSel(b.id);
    setDraft(toDraft(b));
    setError(null);
  };
  const startNew = () => {
    setSel("new");
    setDraft(EMPTY);
    setError(null);
  };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft((cur) => ({ ...cur, [k]: v }));

  const list = Array.isArray(blocks) ? blocks : [];
  const groups = [...new Set([...PRESET_GROUPS, ...list.map((b) => b.group)])];
  const valid = draft.name.trim() && draft.group.trim() && draft.content.trim();

  const fail = (r: Parameters<typeof describe>[0]) => {
    if (r.kind === "unauthorized") onUnauthorized();
    setError(
      describe(r, {
        bad_request: "请检查名称、分组、内容是否填写，且未超过长度上限",
        not_found: "该块已被删除，请刷新",
      }),
    );
  };

  const save = async () => {
    if (!sel) return;
    setBusy(true);
    setError(null);
    const body = {
      name: draft.name.trim(),
      group: draft.group.trim(),
      dimension: draft.dimension.trim() || null,
      content: draft.content,
    };
    const r =
      sel === "new"
        ? await createBlock(loadToken(), body)
        : await patchBlock(loadToken(), sel, body);
    setBusy(false);
    if (!r.ok) return fail(r);
    setSel(r.data.id);
    setDraft(toDraft(r.data));
    await reload();
  };

  const remove = async () => {
    if (!sel || sel === "new") return;
    setBusy(true);
    setError(null);
    const r = await deleteBlock(loadToken(), sel);
    setBusy(false);
    if (!r.ok) return fail(r);
    setSel(null);
    await reload();
  };

  return (
    <div className="flex flex-col gap-3">
      {blocks === "loading" && <p className="m-0 text-mute">加载中…</p>}
      {blocks === "failed" && (
        <p role="alert" className="m-0 font-semibold text-acc">
          提示词块加载失败
        </p>
      )}
      <div className="grid min-h-[360px] grid-cols-[minmax(180px,260px)_1fr] border border-ink max-[900px]:grid-cols-1">
        <div className="flex flex-col border-r border-ink max-[900px]:border-b max-[900px]:border-r-0">
          <ul
            aria-label="提示词块"
            className="m-0 flex-1 list-none overflow-y-auto p-0"
          >
            {list.map((b) => (
              <li key={b.id} className="border-b border-line2">
                <button
                  type="button"
                  aria-current={sel === b.id}
                  onClick={() => pick(b)}
                  className={`flex w-full flex-col gap-0.5 border-l-[3px] px-3 py-2 text-left ${sel === b.id ? "border-ink bg-panel" : "border-transparent hover:bg-panel"}`}
                >
                  <span className="font-semibold">{b.name}</span>
                  <span className="text-xs text-mute">
                    {b.group}
                    {b.dimension ? ` · ${b.dimension}` : ""}
                  </span>
                </button>
              </li>
            ))}
            {blocks !== "loading" && list.length === 0 && (
              <li className="px-3 py-2 text-mute">还没有提示词块</li>
            )}
          </ul>
          <button
            type="button"
            onClick={startNew}
            className="border-t border-ink px-3 py-2 text-left font-semibold hover:bg-ink hover:text-bg"
          >
            新建块
          </button>
        </div>
        <div className="p-4">
          {sel === null ? (
            <p className="m-0 text-mute">选择左侧的块进行编辑，或新建一个。</p>
          ) : (
            <form
              aria-label={sel === "new" ? "新建提示词块" : "编辑提示词块"}
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) void save();
              }}
              className="flex flex-col gap-3"
            >
              <Field label="名称" id="pb-name">
                <input
                  id="pb-name"
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  className={field}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
                <Field label="分组" id="pb-group">
                  <input
                    id="pb-group"
                    list="pb-groups"
                    value={draft.group}
                    onChange={(e) => set("group", e.target.value)}
                    className={field}
                  />
                  <datalist id="pb-groups">
                    {groups.map((g) => (
                      <option key={g} value={g} />
                    ))}
                  </datalist>
                </Field>
                <Field label="维度（可选）" id="pb-dim">
                  <input
                    id="pb-dim"
                    value={draft.dimension}
                    onChange={(e) => set("dimension", e.target.value)}
                    className={field}
                  />
                </Field>
              </div>
              <Field label="内容" id="pb-content">
                <textarea
                  id="pb-content"
                  rows={12}
                  value={draft.content}
                  onChange={(e) => set("content", e.target.value)}
                  className={`${field} font-mono text-xs`}
                />
              </Field>
              <p className="m-0 text-xs text-mute">
                分组决定拼接顺序：角色定义 → 全局约定 → 项目约定 →
                自定义分组。块被 agent 引用，改动对下一次同步生效。
              </p>
              {error && (
                <p role="alert" className="m-0 font-semibold text-acc">
                  {error}
                </p>
              )}
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={busy || !valid}
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
