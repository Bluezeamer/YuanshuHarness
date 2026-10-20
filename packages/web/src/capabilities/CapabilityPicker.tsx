import { useState } from "react";
import { actionBtn, field } from "../settings/shared";
import type { AgentCapability, ToolInfo } from "./agentsApi";

const same = (a: AgentCapability, b: AgentCapability) =>
  a.kind === b.kind && a.name === b.name;

// 能力勾选：内置工具来自目录；skill / MCP 只是名字引用，库由别处管理，这里不校验是否存在。
export function CapabilityPicker({
  tools,
  value,
  onChange,
}: {
  tools: ToolInfo[];
  value: AgentCapability[];
  onChange(next: AgentCapability[]): void;
}) {
  const [kind, setKind] = useState<"skill" | "mcp">("skill");
  const [name, setName] = useState("");
  const refs = value.filter((c) => c.kind !== "tool");
  const on = (t: ToolInfo) =>
    value.some((c) => c.kind === "tool" && c.name === t.name);

  const toggle = (t: ToolInfo) =>
    onChange(
      on(t)
        ? value.filter((c) => !(c.kind === "tool" && c.name === t.name))
        : [...value, { kind: "tool", name: t.name }],
    );

  const add = () => {
    const n = name.trim();
    if (!n) return;
    const cap: AgentCapability = { kind, name: n };
    if (!value.some((c) => same(c, cap))) onChange([...value, cap]);
    setName("");
  };

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 p-0 text-xs font-semibold">内置工具</legend>
        {tools.map((t) => (
          <label
            key={t.name}
            className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-baseline gap-x-3 border border-line px-2 py-1"
          >
            <input
              type="checkbox"
              checked={on(t)}
              onChange={() => toggle(t)}
              aria-label={t.name}
            />
            <span>
              <span className="font-mono font-semibold">{t.name}</span>
              <span className="text-xs text-mute"> {t.description}</span>
            </span>
            <span className="text-xs text-mute">
              {t.readOnly ? "只读" : "可写 / 执行"}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 p-0 text-xs font-semibold">
          Skill / MCP 引用
        </legend>
        {refs.map((c) => (
          <div
            key={`${c.kind}:${c.name}`}
            className="flex items-center justify-between gap-2 border border-line px-2 py-1"
          >
            <span className="min-w-0 truncate">
              <span className="text-xs text-mute">{c.kind} · </span>
              <span className="font-mono font-semibold">{c.name}</span>
            </span>
            <button
              type="button"
              aria-label={`移除引用 ${c.name}`}
              onClick={() => onChange(value.filter((x) => !same(x, c)))}
              className="border border-line px-2 py-0.5 text-xs font-semibold hover:bg-ink hover:text-bg"
            >
              移除
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <select
            aria-label="引用类型"
            value={kind}
            onChange={(e) => setKind(e.target.value as "skill" | "mcp")}
            className={field}
          >
            <option value="skill">skill</option>
            <option value="mcp">mcp</option>
          </select>
          <input
            aria-label="引用名称"
            value={name}
            placeholder="名称"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              add();
            }}
            className={`${field} min-w-0 flex-1`}
          />
          <button
            type="button"
            disabled={!name.trim()}
            onClick={add}
            className={actionBtn}
          >
            添加
          </button>
        </div>
      </fieldset>
    </div>
  );
}
