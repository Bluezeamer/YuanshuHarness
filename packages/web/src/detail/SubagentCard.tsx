import { Link } from "../router";

export interface SpawnInfo {
  childId: string;
  agent: string;
  workspaces: string[];
  tier: string;
}

// spawn_subagent 的结果是单行 JSON（server 的 subagent/tools.ts）；解析不了就当普通工具结果。
export function parseSpawn(result: string | undefined): SpawnInfo | null {
  if (!result) return null;
  try {
    const v = JSON.parse(result) as Partial<SpawnInfo>;
    if (typeof v.childId !== "string" || v.childId === "") return null;
    return {
      childId: v.childId,
      agent: typeof v.agent === "string" ? v.agent : "",
      workspaces: Array.isArray(v.workspaces) ? v.workspaces.map(String) : [],
      tier: typeof v.tier === "string" ? v.tier : "",
    };
  } catch {
    return null;
  }
}

// 参数里的 task 文本；参数不是合法 JSON 时为空。
export function spawnTask(args: string | undefined): string {
  if (!args) return "";
  try {
    const v = JSON.parse(args) as { task?: unknown };
    return typeof v.task === "string" ? v.task : "";
  } catch {
    return "";
  }
}

export function SubagentCard({
  info,
  task,
}: {
  info: SpawnInfo;
  task: string;
}) {
  return (
    <div className="space-y-1.5 rounded-[var(--radius)] border border-line bg-accent-soft px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold text-accent-deep">已派发子代理</span>
        <Link
          to={`/sessions/${encodeURIComponent(info.childId)}`}
          className="font-semibold text-accent-deep hover:underline"
        >
          查看子会话 →
        </Link>
      </div>
      {task && <p className="m-0 line-clamp-3 text-ink">{task}</p>}
      <dl className="m-0 flex flex-wrap gap-x-4 gap-y-0.5 text-mute">
        {info.agent && (
          <div className="flex gap-1">
            <dt>agent</dt>
            <dd className="m-0 font-mono text-ink">{info.agent}</dd>
          </div>
        )}
        {info.workspaces.length > 0 && (
          <div className="flex gap-1">
            <dt>环境</dt>
            <dd className="m-0 font-mono text-ink">
              {info.workspaces.join("、")}
            </dd>
          </div>
        )}
        {info.tier && (
          <div className="flex gap-1">
            <dt>档位上限</dt>
            <dd className="m-0 font-mono text-ink">{info.tier}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
