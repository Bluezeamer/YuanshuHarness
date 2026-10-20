import { useEffect, useState } from "react";
import {
  type EnvironmentInfo,
  type EnvSkillInfo,
  importEnvSkill,
  listEnvironments,
  listWorkspaces,
  loadToken,
  type SkillInfo,
  type SkillScope,
  scanEnvSkills,
  type WorkspaceInfo,
} from "../api";
import { actionBtn, describe, field } from "../settings/shared";

// 从环境里已有的 skill 目录纳入库；原件不动。选工作区时一并扫该项目目录。
export function SkillImport({
  onImported,
  onUnauthorized,
}: {
  onImported(s: SkillInfo): void;
  onUnauthorized(): void;
}) {
  const [envs, setEnvs] = useState<EnvironmentInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [envId, setEnvId] = useState("");
  const [wsId, setWsId] = useState("");
  const [scope, setScope] = useState<SkillScope>("global");
  const [found, setFound] = useState<EnvSkillInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [e, w] = await Promise.all([
        listEnvironments(loadToken()),
        listWorkspaces(loadToken()),
      ]);
      for (const r of [e, w])
        if (!r.ok && r.kind === "unauthorized") onUnauthorized();
      if (e.ok) {
        setEnvs(e.data);
        setEnvId((cur) => cur || (e.data[0]?.id ?? ""));
      }
      if (w.ok) setWorkspaces(w.data);
    })();
  }, [onUnauthorized]);

  const inEnv = workspaces.filter((w) => w.environmentId === envId);

  const scan = async () => {
    setBusy(true);
    setError(null);
    const r = await scanEnvSkills(loadToken(), envId, wsId || undefined);
    setBusy(false);
    if (r.ok) setFound(r.data);
    else {
      if (r.kind === "unauthorized") onUnauthorized();
      setFound(null);
      setError(
        r.kind === "server"
          ? "无法连接该环境"
          : describe(r, { bad_request: "工作区不属于该环境" }),
      );
    }
  };

  const doImport = async (s: EnvSkillInfo) => {
    setBusy(true);
    setError(null);
    const r = await importEnvSkill(loadToken(), {
      environmentId: envId,
      dir: s.dir,
      scope,
      ...(wsId ? { workspaceId: wsId } : {}),
    });
    setBusy(false);
    if (r.ok) {
      setFound((cur) =>
        cur
          ? cur.map((x) => (x.dir === s.dir ? { ...x, inLibrary: true } : x))
          : cur,
      );
      onImported(r.data);
    } else {
      if (r.kind === "unauthorized") onUnauthorized();
      setError(
        describe(r, {
          conflict: "库里已有同名 skill",
          bad_request: "该目录不是可纳入的 skill",
        }),
      );
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-mute">
        扫描环境里已有的 skill，纳入后由元枢统一同步，环境里的原件不会被改动。
      </p>
      <div className="grid gap-3 min-[700px]:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs font-semibold">
          环境
          <select
            value={envId}
            onChange={(e) => {
              setEnvId(e.target.value);
              setWsId("");
              setFound(null);
            }}
            className={field}
          >
            {envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold">
          同时扫描的项目（可选）
          <select
            value={wsId}
            onChange={(e) => setWsId(e.target.value)}
            className={field}
          >
            <option value="">不扫描项目目录</option>
            {inEnv.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold">
          纳入后的范围
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as SkillScope)}
            className={field}
          >
            <option value="global">全局（由 agent 引用）</option>
            <option value="project">项目（分配给工作区）</option>
          </select>
        </label>
      </div>
      <div>
        <button
          type="button"
          disabled={busy || !envId}
          onClick={() => void scan()}
          className={actionBtn}
        >
          扫描
        </button>
      </div>
      {error && (
        <p role="alert" className="m-0 font-semibold text-acc">
          {error}
        </p>
      )}
      {found?.length === 0 && <p className="m-0 text-mute">没有发现 skill</p>}
      {found && found.length > 0 && (
        <ul className="m-0 list-none border-t border-ink p-0">
          {found.map((s) => (
            <li
              key={s.dir}
              className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-line2 py-2"
            >
              <span className="min-w-0">
                <span className="block font-semibold">{s.name}</span>
                <span className="block truncate text-xs text-mute">
                  {s.description}
                </span>
                <code className="block truncate font-mono text-xs text-mute">
                  {s.dir}
                </code>
              </span>
              {s.managed ? (
                <span className="text-xs text-mute">元枢同步产物</span>
              ) : s.inLibrary ? (
                <span className="text-xs text-ok">已在库中</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`导入 ${s.name}`}
                  onClick={() => void doImport(s)}
                  className="border border-ink px-3 py-1 text-xs font-semibold hover:bg-ink hover:text-bg disabled:opacity-50"
                >
                  导入
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
