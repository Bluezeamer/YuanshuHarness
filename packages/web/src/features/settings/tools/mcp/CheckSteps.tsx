import type { StepResult } from "../../../../api/mcpLibrary";

type Steps = { start: StepResult; handshake: StepResult; list: StepResult };

const LABEL: Record<keyof Steps, string> = {
  start: "启动",
  handshake: "握手",
  list: "列工具",
};
const MARK: Record<StepResult["state"], string> = {
  ok: "✓",
  error: "✗",
  skipped: "—",
};

// 检测只做三件事：启动、握手、列工具。失败的那一步点名原因，不吞错，也不假装能探测能力。
export function CheckSteps({ steps }: { steps: Steps }) {
  return (
    <ol className="st-tl-steps t-aux" aria-label="检测三步">
      {(Object.keys(LABEL) as (keyof Steps)[]).map((k) => {
        const r = steps[k];
        return (
          <li key={k} data-state={r.state} data-step={k}>
            <span className="st-tl-step-m" aria-hidden="true">
              {MARK[r.state]}
            </span>
            <span className="st-tl-step-n">{LABEL[k]}</span>
            {r.state !== "skipped" && (
              <span className="st-tl-mono t-mono">{r.ms}ms</span>
            )}
            {r.error && <span className="st-tl-step-e t-mono">{r.error}</span>}
          </li>
        );
      })}
    </ol>
  );
}
