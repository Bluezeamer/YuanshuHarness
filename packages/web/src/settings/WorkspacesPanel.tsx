import { useCallback, useEffect, useState } from "react";
import {
  createWorkspace,
  deleteRule,
  deleteWorkspace,
  listRules,
  listWorkspaces,
  loadToken,
  patchWorkspace,
  type RuleInfo,
  type Tier,
  type WorkspaceInfo,
} from "../api";
import { type DirChoice, DirPicker } from "./DirPicker";
import {
  actionBtn,
  dangerBtn,
  describe,
  FULL_RISK,
  field,
  TIERS,
} from "./shared";

type Unauth = () => void;

function Rules({ ws, onUnauthorized }: { ws: string; onUnauthorized: Unauth }) {
  const [rules, setRules] = useState<RuleInfo[] | "loading" | "failed">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRules("loading");
    void listRules(loadToken(), ws).then((r) => {
      if (!live) return;
      if (!r.ok && r.kind === "unauthorized") onUnauthorized();
      setRules(r.ok ? r.data : "failed");
    });
    return () => {
      live = false;
    };
  }, [ws, onUnauthorized]);

  const remove = async (rule: RuleInfo) => {
    setError(null);
    const r = await deleteRule(loadToken(), ws, rule.id);
    if (r.ok || r.kind === "not_found")
      setRules((cur) =>
        Array.isArray(cur) ? cur.filter((x) => x.id !== rule.id) : cur,
      );
    else {
      if (r.kind === "unauthorized") onUnauthorized();
      setError(describe(r));
    }
  };

  const label = (r: RuleInfo) =>
    r.kind === "command"
      ? "命令"
      : `路径 · ${r.access === "write" ? "读写" : "只读"}`;

  return (
    <section aria-label="已记住的规则" className="flex flex-col gap-2">
      <h3 className="m-0 text-sm font-bold">已记住的规则</h3>
      {rules === "loading" && <p className="m-0 text-mute">加载中…</p>}
      {rules === "failed" && (
        <p role="alert" className="m-0 font-semibold text-acc">
          规则加载失败
        </p>
      )}
      {Array.isArray(rules) && rules.length === 0 && (
        <p className="m-0 text-mute">还没有记住的规则</p>
      )}
      {Array.isArray(rules) && rules.length > 0 && (
        <ul className="m-0 list-none border-t border-ink p-0">
          {rules.map((r) => (
            <li
              key={r.id}
              className="grid grid-cols-[84px_1fr_auto] items-center gap-3 border-b border-line2 py-2"
            >
              <span className="text-xs font-semibold text-mute">
                {label(r)}
              </span>
              <code className="break-all font-mono text-xs">{r.value}</code>
              <button
                type="button"
                aria-label={`删除规则 ${r.value}`}
                onClick={() => void remove(r)}
                className="border border-line px-2 py-0.5 text-xs font-semibold hover:bg-ink hover:text-bg"
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="m-0 font-semibold text-acc">
          {error}
        </p>
      )}
    </section>
  );
}

function Editor({
  ws,
  onSaved,
  onDeleted,
  onUnauthorized,
}: {
  ws: WorkspaceInfo;
  onSaved(w: WorkspaceInfo): void;
  onDeleted(id: string): void;
  onUnauthorized: Unauth;
}) {
  const [name, setName] = useState(ws.name);
  const [tier, setTier] = useState<Tier>(ws.tier);
  const [confirm, setConfirm] = useState<"full" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const trimmed = name.trim();
  const changed = trimmed !== ws.name || tier !== ws.tier;

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const body: { name?: string; tier?: Tier } = {};
    if (trimmed !== ws.name) body.name = trimmed;
    if (tier !== ws.tier) body.tier = tier;
    const r = await patchWorkspace(loadToken(), ws.id, body);
    setBusy(false);
    setConfirm(null);
    if (r.ok) {
      setSaved(true);
      onSaved(r.data);
    } else {
      if (r.kind === "unauthorized") onUnauthorized();
      setError(describe(r, { bad_request: "名称或档位无效" }));
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    const r = await deleteWorkspace(loadToken(), ws.id);
    setBusy(false);
    setConfirm(null);
    if (r.ok) onDeleted(ws.id);
    else {
      if (r.kind === "unauthorized") onUnauthorized();
      setError(describe(r, { conflict: "仍有会话使用该工作区，无法删除" }));
    }
  };

  const onSave = () => {
    // 升到完全允许必须二次确认。
    if (tier === "full" && ws.tier !== "full") setConfirm("full");
    else void save();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <label htmlFor="ws-name" className="text-xs font-semibold">
          名称
        </label>
        <input
          id="ws-name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          className={field}
        />
        <p className="m-0 font-mono text-xs text-mute">
          {ws.path} · 环境：{ws.environmentId}
        </p>
      </div>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-xs font-semibold">权限档位</legend>
        {TIERS.map((t) => (
          <label
            key={t.id}
            className={`grid cursor-pointer grid-cols-[auto_1fr] gap-x-3 border px-3 py-2 ${tier === t.id ? "border-ink" : "border-line"}`}
          >
            <input
              type="radio"
              name="tier"
              value={t.id}
              checked={tier === t.id}
              onChange={() => setTier(t.id)}
              className="mt-1"
            />
            <span className="font-semibold">{t.label}</span>
            <span className="col-start-2 text-xs text-mute">{t.hint}</span>
          </label>
        ))}
        {tier === "full" && (
          <p
            role="note"
            className="m-0 border border-acc px-3 py-2 text-sm font-semibold text-acc"
          >
            {FULL_RISK}
          </p>
        )}
      </fieldset>

      {confirm === "full" && (
        <div
          role="alertdialog"
          aria-label="确认设为完全允许"
          className="flex flex-col gap-3 border border-acc p-3"
        >
          <p className="m-0 font-semibold text-acc">
            确认把「{ws.name}」设为完全允许？{FULL_RISK}
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void save()}
              className={dangerBtn}
            >
              确认设为完全允许
            </button>
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className={actionBtn}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="m-0 font-semibold text-acc">
          {error}
        </p>
      )}
      {saved && !changed && <p className="m-0 text-ok">已保存</p>}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy || !changed || !trimmed || confirm === "full"}
          onClick={onSave}
          className={actionBtn}
        >
          保存
        </button>
        {confirm === "delete" ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className={dangerBtn}
            >
              确认删除
            </button>
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className={actionBtn}
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirm("delete")}
            className={dangerBtn}
          >
            删除工作区
          </button>
        )}
      </div>

      <Rules ws={ws.id} onUnauthorized={onUnauthorized} />
    </div>
  );
}

function AddForm({
  onCreated,
  onUnauthorized,
}: {
  onCreated(w: WorkspaceInfo): void;
  onUnauthorized: Unauth;
}) {
  const [picked, setPicked] = useState<DirChoice | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked) return;
    setBusy(true);
    setError(null);
    const r = await createWorkspace(loadToken(), {
      path: picked.path,
      ...(name.trim() ? { name: name.trim() } : {}),
    });
    setBusy(false);
    if (r.ok) onCreated(r.data);
    else {
      if (r.kind === "unauthorized") onUnauthorized();
      setError(
        describe(r, {
          bad_request: "路径无效：须为本机已存在的绝对目录",
          conflict: "该目录已登记",
        }),
      );
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="m-0 text-mute">
        登记目录等于授予 agent 在该目录下的默认读写范围。
      </p>
      <DirPicker onChange={setPicked} onUnauthorized={onUnauthorized} />
      <div className="flex flex-col gap-1">
        <label htmlFor="ws-new-name" className="text-xs font-semibold">
          名称（可选，默认取目录名）
        </label>
        <input
          id="ws-new-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={field}
        />
      </div>
      {error && (
        <p role="alert" className="m-0 font-semibold text-acc">
          {error}
        </p>
      )}
      <div>
        <button
          type="submit"
          disabled={busy || !picked?.usable}
          className={actionBtn}
        >
          添加
        </button>
      </div>
    </form>
  );
}

export function WorkspacesPanel({
  onUnauthorized,
}: {
  onUnauthorized: Unauth;
}) {
  const [list, setList] = useState<WorkspaceInfo[] | "loading" | "failed">(
    "loading",
  );
  // "new" 表示右侧显示新增表单。
  const [sel, setSel] = useState<string | "new" | null>(null);

  const load = useCallback(async () => {
    setList("loading");
    const r = await listWorkspaces(loadToken());
    if (!r.ok && r.kind === "unauthorized") onUnauthorized();
    setList(r.ok ? r.data : "failed");
    if (r.ok) setSel((cur) => cur ?? r.data[0]?.id ?? "new");
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  if (list === "loading") return <p className="p-6 text-mute">加载中…</p>;
  if (list === "failed")
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p role="alert" className="m-0 font-semibold text-acc">
          工作区加载失败
        </p>
        <button type="button" onClick={() => void load()} className={actionBtn}>
          重试
        </button>
      </div>
    );

  const current = list.find((w) => w.id === sel);
  return (
    <div className="grid min-h-0 grid-cols-1 border border-ink min-[900px]:grid-cols-[240px_1fr]">
      <div className="border-b border-ink min-[900px]:border-r min-[900px]:border-b-0">
        <ul className="m-0 list-none p-0">
          {list.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                aria-current={w.id === sel ? "true" : undefined}
                onClick={() => setSel(w.id)}
                className={`grid w-full gap-0.5 border-b border-line2 px-4 py-3 text-left hover:bg-ink/5 ${w.id === sel ? "bg-ink/5 shadow-[inset_3px_0_0_var(--ink)]" : ""}`}
              >
                <span className="truncate font-semibold">{w.name}</span>
                <span className="truncate font-mono text-xs text-mute">
                  {w.path}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          aria-current={sel === "new" ? "true" : undefined}
          onClick={() => setSel("new")}
          className="w-full px-4 py-3 text-left font-semibold hover:bg-ink hover:text-bg"
        >
          新增工作区
        </button>
      </div>
      <div className="min-w-0 p-5">
        {sel === "new" || !current ? (
          <AddForm
            onUnauthorized={onUnauthorized}
            onCreated={(w) => {
              setList((cur) => (Array.isArray(cur) ? [...cur, w] : cur));
              setSel(w.id);
            }}
          />
        ) : (
          <Editor
            key={current.id}
            ws={current}
            onUnauthorized={onUnauthorized}
            onSaved={(w) =>
              setList((cur) =>
                Array.isArray(cur)
                  ? cur.map((x) => (x.id === w.id ? w : x))
                  : cur,
              )
            }
            onDeleted={(id) => {
              const rest = list.filter((x) => x.id !== id);
              setList(rest);
              setSel(rest[0]?.id ?? "new");
            }}
          />
        )}
      </div>
    </div>
  );
}
