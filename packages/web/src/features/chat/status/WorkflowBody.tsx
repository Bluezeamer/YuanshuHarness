import type { WorkflowPhase, WorkflowRun } from "../../../api/flows";
import { Dot } from "../../../ui";
import { Tick } from "./Blocks";
import { phaseCounts, phaseLive, runEndText } from "./workflow";

// 阶段前的标记：有东西在跑是脉动的点，全失败是红点，其余算完成
function PhaseMark({ p }: { p: WorkflowPhase }) {
  if (!phaseLive(p) && p.failed > 0 && p.done === 0)
    return <Dot size="sm" tone="danger" />;
  return <Tick done={!phaseLive(p)} current={phaseLive(p)} />;
}

// 工作流：每次运行一段，每个阶段一行「名字 / 计数」。几十上百个 agent 逐个列在这里没有意义。
export function WorkflowBody({
  runs,
  now,
}: {
  runs: readonly WorkflowRun[];
  now: number;
}) {
  return (
    <>
      {runs.map((r) => (
        <div className="ch-run" key={r.id} data-run={r.id} data-state={r.state}>
          <div className="ch-run-h">
            <span className="t-plain ch-run-name">{r.label}</span>
            <span className="t-aux ch-dim">{runEndText(r, now)}</span>
          </div>
          <ul className="ch-phases">
            {r.phases.map((p) => {
              const parts = phaseCounts(p);
              return (
                <li key={p.name ?? ""} data-phase={p.name ?? ""}>
                  <span className="ch-plan-mark">
                    <PhaseMark p={p} />
                  </span>
                  <span className="ch-phase-t">
                    <span className={phaseLive(p) ? "t-entry" : "t-plain"}>
                      {p.name ?? "未分阶段"}
                    </span>
                    <span className="t-aux ch-dim">
                      {parts.join(" · ")}
                      {p.failed > 0 && (
                        <>
                          {parts.length > 0 && " · "}
                          <span className="ch-del">失败 {p.failed}</span>
                        </>
                      )}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="t-aux ch-dim">
            <span className="ch-nowrap">已启动 {r.started} 个 agent ·</span>{" "}
            <span className="ch-nowrap">单次运行上限 {r.limit}</span>
          </p>
        </div>
      ))}
    </>
  );
}
