import { Button, Checkbox } from "../../../../ui";
import {
  allCapabilityIds,
  type CapItem,
  type Catalog,
  capabilityLibrary,
  capItemOf,
  presetDefaults,
} from "../model/catalog";
import { capsChanged, capsLabel } from "../model/labels";

const KIND_LABEL = {
  tool: "工具",
  unit: "能力单元",
  skill: "技能",
  mcp: "MCP",
} as const;
const KIND_ORDER = ["tool", "unit", "skill", "mcp"] as const;

// 能力：不限制（全部工具 + 目录已分发的技能 / MCP），或在 Agent 基线上逐项勾选。
export function CapsEditor({
  cat,
  agentId,
  value,
  onChange,
}: {
  cat: Catalog;
  agentId: string;
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const items = capabilityLibrary(cat);
  const on = new Set(value ?? []);
  const toggle = (id: string) => {
    const cur = new Set(value ?? []);
    if (!cur.delete(id)) cur.add(id);
    onChange([...cur]);
  };
  const changed = capsChanged(cat, agentId, value);

  return (
    <div className="dlg-stack">
      <div className="dlg-bar">
        <span className="t-mono">{capsLabel(value)}</span>
        <span className="dlg-spacer" />
        {changed && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(presetDefaults(cat, agentId).capabilities)}
          >
            恢复 Agent 基线
          </Button>
        )}
        {value === null ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(allCapabilityIds(cat))}
          >
            改为逐项勾选
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            不限制
          </Button>
        )}
      </div>
      {value === null ? (
        <p className="t-aux">
          能力不限制：全部内置工具 + 目录已分发的技能 /
          MCP；默认关闭的「开发调试」不在其中，要用请改为逐项勾选。
        </p>
      ) : (
        KIND_ORDER.map((kind) => {
          const group = items.filter((i) => i.kind === kind);
          if (group.length === 0) return null;
          return (
            <section key={kind} className="dlg-capgroup">
              <div className="dlg-capgroup-h">
                <span className="t-group">{KIND_LABEL[kind]}</span>
                <span className="t-mono">
                  {group.filter((i) => on.has(i.id)).length}/{group.length}
                </span>
              </div>
              <div className="dlg-capgrid">
                {group.map((i: CapItem) => (
                  <Checkbox
                    key={i.id}
                    checked={on.has(i.id)}
                    onChange={() => toggle(i.id)}
                    title={i.desc}
                  >
                    {i.name}
                  </Checkbox>
                ))}
              </div>
            </section>
          );
        })
      )}
      {value?.length === 0 && (
        <p className="t-aux">
          没有勾选任何能力：模型将没有内置工具可用（ask_user、todo_write
          仍常驻）。
        </p>
      )}
      {(value ?? []).some((id) => !capItemOf(cat, id).known) && (
        <p className="t-aux">
          有引用指向已不存在的技能 / MCP，运行时会被跳过。
        </p>
      )}
    </div>
  );
}
