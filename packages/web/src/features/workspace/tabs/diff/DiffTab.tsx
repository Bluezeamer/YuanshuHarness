// 单轮单文件的改动查看：左侧树/头部显示轮次与路径，正文是带行号的逐行 diff。
import { useEffect, useState } from "react";
import { gitFileDiff } from "../../../../api/git";
import { loadToken } from "../../../../api/http";
import { readTeamDiff } from "../../../../api/team";
import { readTurnDiff } from "../../../../api/turnChanges";
import { Empty, InlineNotice } from "../../../../ui";
import { diffLines } from "../preview/diffLines";
import { baseName } from "../preview/kind";
import { parseDiff } from "./parseDiff";

type State =
  | { kind: "loading" }
  | { kind: "ready"; rows: ReturnType<typeof parseDiff> }
  | { kind: "gone" }
  | { kind: "binary" }
  | { kind: "error" }
  | { kind: "no-session" };

export function DiffTab({
  sessionId,
  env,
  turn,
  team = false,
  path,
}: {
  sessionId: string | null;
  env: string;
  /** null = 工作区 vs HEAD（git 面板打开），有值 = 某一轮的改动 */
  turn: number | null;
  /** 团队建队以来的改动（属于 sessionId 那个会话的团队），此时 turn 不用 */
  team?: boolean;
  path: string;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    // 轮末 diff 与团队 diff 要知道属于哪个会话；工作区 vs HEAD 不需要会话
    if (sessionId === null && (team || turn !== null)) {
      setState({ kind: "no-session" });
      return;
    }
    let alive = true;
    setState({ kind: "loading" });
    void (async () => {
      if (team) {
        if (sessionId === null) return setState({ kind: "no-session" });
        const r = await readTeamDiff(loadToken(), sessionId, path);
        if (!alive) return;
        if (r.ok) return setState({ kind: "ready", rows: parseDiff(r.data) });
        // 410：这个文件已经没有改动（改回去了）
        return setState(
          r.kind === "not_found" ? { kind: "gone" } : { kind: "error" },
        );
      }
      if (turn === null) {
        // 目录：HEAD 版本 vs 磁盘现状（未跟踪文件没有 HEAD 版本，按新增处理）
        const r = await gitFileDiff(loadToken(), env, path, path);
        if (!alive) return;
        if (!r.ok) return setState({ kind: "error" });
        if (r.data.binary) return setState({ kind: "binary" });
        return setState({
          kind: "ready",
          rows: diffLines(r.data.original ?? "", r.data.current),
        });
      }
      if (sessionId === null) return setState({ kind: "no-session" });
      const r = await readTurnDiff(loadToken(), sessionId, turn, path);
      if (!alive) return;
      if (r.ok) return setState({ kind: "ready", rows: parseDiff(r.data) });
      // 410：轮次副本已被清掉，只剩清单
      setState(r.kind === "not_found" ? { kind: "gone" } : { kind: "error" });
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, env, turn, team, path]);

  return (
    <div className="ws-df">
      <div className="ws-df-head t-aux">
        <span className="ws-df-turn">
          {team ? "团队改动" : turn === null ? "目录改动" : `第 ${turn} 轮`}
        </span>
        <span className="ws-df-name t-mono" title={path}>
          {baseName(path)}
        </span>
        <span className="ws-df-path t-mono" title={path}>
          {path}
        </span>
      </div>
      {state.kind === "no-session" && (
        <Empty compact title="找不到这一轮所属的会话" />
      )}
      {state.kind === "loading" && (
        <p className="ws-df-note t-aux" role="status">
          正在读取改动…
        </p>
      )}
      {state.kind === "binary" && (
        <p className="ws-df-note t-aux">这是二进制文件，无法按行对比。</p>
      )}
      {state.kind === "gone" && (
        <p className="ws-df-note t-aux">
          {team
            ? "这个文件相对建队时已经没有改动。"
            : "这次改动的内容已不可用（只保留了文件清单）。"}
        </p>
      )}
      {state.kind === "error" && (
        <InlineNotice tone="danger" className="ws-df-note-bad">
          读取改动失败，请重试。
        </InlineNotice>
      )}
      {state.kind === "ready" && (
        <div className="ws-df-body t-mono">
          {state.rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff 行按顺序排列
            <div key={i} className="ws-df-row" data-kind={r.kind}>
              <span className="ws-df-n">{r.a ?? ""}</span>
              <span className="ws-df-n">{r.b ?? ""}</span>
              <span className="ws-df-t">{r.text || " "}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
