import type { WorkspaceCapabilities } from "../../../../api/workspaceCapabilities";
import { Checkbox } from "../../../../ui";
import type { CapabilityPick, CapabilityRow } from "../api";

type Kind = keyof WorkspaceCapabilities;

const SECTIONS: { kind: Kind; title: string }[] = [
  { kind: "skill", title: "技能" },
  { kind: "mcp", title: "MCP 服务" },
];

/**
 * 这个工作区额外启用哪些技能与 MCP：已设为全局的每个会话都带上，显示成已勾选、不可改；
 * 其余在这里勾给这个工作区。
 */
export function CapabilitiesEditor({
  pick,
  value,
  onChange,
}: {
  pick: CapabilityPick;
  value: WorkspaceCapabilities;
  onChange: (next: WorkspaceCapabilities) => void;
}) {
  const rows: Record<Kind, CapabilityRow[]> = {
    skill: pick.skills,
    mcp: pick.mcp,
  };
  if (pick.skills.length === 0 && pick.mcp.length === 0)
    return (
      <p className="t-aux">
        还没有技能或 MCP 服务。先在「设置 · 工具与能力」里安装，再回来启用。
      </p>
    );

  const toggle = (kind: Kind, name: string, on: boolean) => {
    const set = new Set(value[kind]);
    if (on) set.add(name);
    else set.delete(name);
    onChange({ ...value, [kind]: [...set].sort() });
  };

  return (
    <div className="dlg-caps">
      <div className="dlg-caps-list">
        {SECTIONS.filter((s) => rows[s.kind].length > 0).map((s) => (
          <div key={s.kind} className="dlg-caps-sec">
            <div className="dlg-caps-h t-group">
              <span>{s.title}</span>
              <span className="t-mono">{rows[s.kind].length}</span>
            </div>
            {rows[s.kind].map((r) => (
              <Checkbox
                key={r.name}
                className="dlg-caps-row"
                checked={r.global || value[s.kind].includes(r.name)}
                disabled={r.global}
                onChange={(on) => toggle(s.kind, r.name, on)}
              >
                <span className="dlg-caps-name t-entry">{r.name}</span>
                <span className="dlg-caps-desc t-aux">{r.desc}</span>
                <span className="t-aux">
                  {r.global ? "全局" : r.enabled ? "" : "已禁用"}
                </span>
              </Checkbox>
            ))}
          </div>
        ))}
      </div>
      <p className="t-aux">
        设为全局的在每个会话里都生效，不用勾；其余只在勾了的工作区里生效。在「设置
        · 工具与能力」里改全局开关。
      </p>
    </div>
  );
}
