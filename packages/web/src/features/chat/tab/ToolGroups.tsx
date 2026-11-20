import { useState } from "react";
import { Dot, ListRow } from "../../../ui";
import { CodeBlock } from "../../markdown/CodeBlock";
import { Delta, FlowGroup } from "./FlowGroup";
import { groupMeta, groupTools, previewOf, type ToolGroup } from "./toolGroups";
import { langOf, resultOf, rowMeta, type ToolRow, viewOf } from "./toolRows";

function Output({ row }: { row: ToolRow }) {
  const result = resultOf(row);
  if (!result) return null;
  if (result.kind === "code" || result.kind === "diff")
    return (
      <CodeBlock
        code={result.text}
        lang={langOf(row.name, viewOf(row.name, row.args).primary)}
      />
    );
  return (
    <pre className="ch-out t-code" data-kind={result.kind}>
      {result.text}
    </pre>
  );
}

// 组里的一行：状态点、工具名、参数摘要、行数 / 耗时。有输出的行点一下看输出，失败的行默认就露出红字输出。
function ToolLine({ row }: { row: ToolRow }) {
  const [picked, setPicked] = useState<boolean | null>(null);
  const hasOut = resultOf(row) !== null;
  const open = hasOut && (picked ?? row.status === "error");
  const meta = rowMeta(row);
  return (
    <div className="ch-row">
      <ListRow
        size="compact"
        lead={
          <Dot
            size="sm"
            tone={row.status === "error" ? "danger" : "live"}
            motion={row.status === "running" ? "pulse" : undefined}
          />
        }
        label={
          <span className="ch-line">
            <span className="t-plain">{row.name}</span>
            <span className="ch-arg t-code">
              {viewOf(row.name, row.args).primary}
            </span>
          </span>
        }
        trail={
          meta.delta || meta.text ? (
            <span className="ch-trail">
              {meta.delta && <Delta {...meta.delta} />}
              {meta.text && <span className="t-mono">{meta.text}</span>}
            </span>
          ) : undefined
        }
        {...(hasOut ? { expanded: open } : {})}
        onClick={hasOut ? () => setPicked(!open) : undefined}
      />
      {open && <Output row={row} />}
      {row.children && row.children.length > 0 && (
        <div className="ch-kids">
          {row.children.map((c) => (
            <ToolLine key={c.id} row={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupCard({ group }: { group: ToolGroup }) {
  const meta = groupMeta(group);
  return (
    <FlowGroup
      auto={group.failed}
      label={group.label}
      hint={previewOf(group)}
      trail={
        <>
          {group.failed && <Dot size="sm" tone="danger" />}
          {group.running && <Dot size="sm" tone="live" motion="pulse" />}
          {meta && <span className="t-mono">{meta}</span>}
        </>
      }
    >
      {group.rows.map((r) => (
        <ToolLine key={r.id} row={r} />
      ))}
    </FlowGroup>
  );
}

// 一串连续的工具调用：相邻同类折成一组，每组一行摘要。
export function ToolRuns({ rows }: { rows: readonly ToolRow[] }) {
  return (
    <>
      {groupTools(rows).map((g) => (
        <GroupCard key={g.id} group={g} />
      ))}
    </>
  );
}
