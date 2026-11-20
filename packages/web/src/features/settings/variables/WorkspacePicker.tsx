import { useState } from "react";
import { Checkbox, SearchBox } from "../../../ui";
import type { WorkspaceBrief } from "./store";

// 勾选「哪些工作区启用这个变量」：变量详情与添加弹窗共用。
export function WorkspacePicker({
  workspaces,
  on,
  onToggle,
}: {
  workspaces: readonly WorkspaceBrief[];
  on: ReadonlySet<string>;
  onToggle: (id: string, next: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = workspaces.filter(
    (w) =>
      !needle ||
      w.name.toLowerCase().includes(needle) ||
      w.path.toLowerCase().includes(needle),
  );
  if (workspaces.length === 0)
    return <p className="t-aux">还没有工作区；先在左侧新建一个。</p>;
  return (
    <div className="vr-wsp">
      {workspaces.length > 5 && (
        <SearchBox
          aria-label="筛选工作区"
          placeholder="筛选工作区"
          value={q}
          onChange={setQ}
        />
      )}
      <fieldset className="vr-wsp-list" aria-label="工作区">
        {shown.map((w) => (
          <Checkbox
            key={w.id}
            className="vr-wsp-row"
            checked={on.has(w.id)}
            onChange={(next) => onToggle(w.id, next)}
          >
            <span className="t-entry">{w.name}</span>
            {w.archived && <span className="t-aux">已归档</span>}
            <span className="vr-wsp-path t-mono">{w.path}</span>
          </Checkbox>
        ))}
        {shown.length === 0 && (
          <p className="vr-wsp-none t-aux">没有匹配的工作区</p>
        )}
      </fieldset>
    </div>
  );
}
