import { useCallback, useEffect, useState } from "react";
import {
  deleteSkill,
  getSkillSync,
  listSkills,
  loadToken,
  runSkillSync,
  type SkillInfo,
  type SkillScope,
  type SyncReport,
  type SyncStatus,
  setSkillScope,
} from "../api";
import { actionBtn, dangerBtn, describe } from "../settings/shared";
import { SkillImport } from "./SkillImport";
import { WorkspaceAssign } from "./WorkspaceAssign";

type Unauth = () => void;

const STATUS_TEXT: Record<SyncStatus, string> = {
  added: "已同步（新增）",
  updated: "已同步（更新）",
  unchanged: "已是最新",
  conflict: "冲突",
  failed: "同步失败",
};

// 某工作区对该 skill 的最近同步结果，可手动触发一次同步。
function SyncCell({
  workspaceId,
  skill,
  onUnauthorized,
}: {
  workspaceId: string;
  skill: string;
  onUnauthorized: Unauth;
}) {
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getSkillSync(loadToken(), workspaceId).then((r) => {
      if (!live) return;
      if (r.ok) setReport(r.data);
      else if (r.kind === "unauthorized") onUnauthorized();
    });
    return () => {
      live = false;
    };
  }, [workspaceId, onUnauthorized]);

  const sync = async () => {
    setBusy(true);
    setError(null);
    const r = await runSkillSync(loadToken(), workspaceId);
    setBusy(false);
    if (r.ok) setReport(r.data);
    else {
      if (r.kind === "unauthorized") onUnauthorized();
      setError(r.kind === "server" ? "环境不可用，无法同步" : describe(r));
    }
  };

  const item = report?.items.find((i) => i.name === skill);
  const bad = item?.status === "conflict" || item?.status === "failed";
  return (
    <span className="flex flex-col items-end gap-1 text-xs">
      <span className={bad ? "font-semibold text-acc" : "text-mute"}>
        {item ? STATUS_TEXT[item.status] : "尚未同步"}
        {item?.message ? ` · ${item.message}` : ""}
      </span>
      {error && (
        <span role="alert" className="font-semibold text-acc">
          {error}
        </span>
      )}
      <button
        type="button"
        disabled={busy}
        aria-label={`立即同步 ${workspaceId}`}
        onClick={() => void sync()}
        className="border border-line px-2 py-0.5 font-semibold hover:bg-ink hover:text-bg disabled:opacity-50"
      >
        立即同步
      </button>
    </span>
  );
}

function Detail({
  skill,
  onChanged,
  onDeleted,
  onUnauthorized,
}: {
  skill: SkillInfo;
  onChanged(s: SkillInfo): void;
  onDeleted(name: string): void;
  onUnauthorized: Unauth;
}) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (r: Parameters<typeof describe>[0]) => {
    if (r.kind === "unauthorized") onUnauthorized();
    setError(describe(r));
  };
  const changeScope = async (scope: SkillScope) => {
    setError(null);
    const r = await setSkillScope(loadToken(), skill.name, scope);
    if (r.ok) onChanged(r.data);
    else fail(r);
  };
  const remove = async () => {
    setError(null);
    const r = await deleteSkill(loadToken(), skill.name);
    if (r.ok || r.kind === "not_found") onDeleted(skill.name);
    else fail(r);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-base font-bold">{skill.name}</h3>
        <p className="m-0 text-mute">{skill.description}</p>
        <p className="m-0 font-mono text-xs text-mute">来源：{skill.source}</p>
      </div>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-xs font-semibold">范围</legend>
        {(
          [
            ["global", "全局", "由 agent 引用，会话挂载时同步"],
            ["project", "项目", "分配给工作区，随该工作区的会话同步"],
          ] as const
        ).map(([id, label, hint]) => (
          <label
            key={id}
            className={`grid cursor-pointer grid-cols-[auto_1fr] gap-x-3 border px-3 py-2 ${skill.scope === id ? "border-ink" : "border-line"}`}
          >
            <input
              type="radio"
              name="skill-scope"
              checked={skill.scope === id}
              onChange={() => void changeScope(id)}
              className="mt-1"
            />
            <span className="font-semibold">{label}</span>
            <span className="col-start-2 text-xs text-mute">{hint}</span>
          </label>
        ))}
      </fieldset>

      {skill.scope === "project" ? (
        <WorkspaceAssign
          kind="skills"
          name={skill.name}
          onUnauthorized={onUnauthorized}
          extra={(ws) => (
            <SyncCell
              workspaceId={ws.id}
              skill={skill.name}
              onUnauthorized={onUnauthorized}
            />
          )}
        />
      ) : (
        <p className="m-0 text-mute">全局 skill 在 agent 的能力引用里启用。</p>
      )}

      {error && (
        <p role="alert" className="m-0 font-semibold text-acc">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        {confirm ? (
          <>
            <button
              type="button"
              onClick={() => void remove()}
              className={dangerBtn}
            >
              确认删除
            </button>
            <button
              type="button"
              onClick={() => setConfirm(false)}
              className={actionBtn}
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            className={dangerBtn}
          >
            从库中删除
          </button>
        )}
      </div>
    </div>
  );
}

export function SkillsPanel({ onUnauthorized }: { onUnauthorized: Unauth }) {
  const [list, setList] = useState<SkillInfo[] | "loading" | "failed">(
    "loading",
  );
  // "import" 表示右侧显示从环境导入。
  const [sel, setSel] = useState<string | "import" | null>(null);

  const load = useCallback(async () => {
    setList("loading");
    const r = await listSkills(loadToken());
    if (!r.ok && r.kind === "unauthorized") onUnauthorized();
    setList(r.ok ? r.data : "failed");
    if (r.ok) setSel((cur) => cur ?? r.data[0]?.name ?? "import");
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  if (list === "loading") return <p className="p-6 text-mute">加载中…</p>;
  if (list === "failed")
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p role="alert" className="m-0 font-semibold text-acc">
          skill 库加载失败
        </p>
        <button type="button" onClick={() => void load()} className={actionBtn}>
          重试
        </button>
      </div>
    );

  const current = list.find((s) => s.name === sel);
  return (
    <div className="grid min-h-0 grid-cols-1 border border-ink min-[900px]:grid-cols-[240px_1fr]">
      <div className="border-b border-ink min-[900px]:border-r min-[900px]:border-b-0">
        <ul className="m-0 list-none p-0">
          {list.map((s) => (
            <li key={s.name}>
              <button
                type="button"
                aria-current={s.name === sel ? "true" : undefined}
                onClick={() => setSel(s.name)}
                className={`grid w-full gap-0.5 border-b border-line2 px-4 py-3 text-left hover:bg-ink/5 ${s.name === sel ? "bg-ink/5 shadow-[inset_3px_0_0_var(--ink)]" : ""}`}
              >
                <span className="truncate font-semibold">{s.name}</span>
                <span className="truncate text-xs text-mute">
                  {s.scope === "global" ? "全局" : "项目"} · {s.description}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          aria-current={sel === "import" ? "true" : undefined}
          onClick={() => setSel("import")}
          className="w-full px-4 py-3 text-left font-semibold hover:bg-ink hover:text-bg"
        >
          从环境导入
        </button>
      </div>
      <div className="min-w-0 p-5">
        {sel === "import" || !current ? (
          <SkillImport
            onUnauthorized={onUnauthorized}
            onImported={(s) => {
              setList((cur) => (Array.isArray(cur) ? [...cur, s] : cur));
            }}
          />
        ) : (
          <Detail
            key={current.name}
            skill={current}
            onUnauthorized={onUnauthorized}
            onChanged={(s) =>
              setList((cur) =>
                Array.isArray(cur)
                  ? cur.map((x) => (x.name === s.name ? s : x))
                  : cur,
              )
            }
            onDeleted={(name) => {
              const rest = list.filter((x) => x.name !== name);
              setList(rest);
              setSel(rest[0]?.name ?? "import");
            }}
          />
        )}
      </div>
    </div>
  );
}
