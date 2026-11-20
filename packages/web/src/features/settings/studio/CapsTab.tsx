import { useState } from "react";
import { InlineNotice, Loading, Segmented } from "../../../ui";
import { CapPicker } from "./CapPicker";
import { useCapCatalog } from "./useCapCatalog";
import type { Draft } from "./usePresetDraft";

type Op = "limit" | "add" | "remove";

const OP_HINT: Record<Op, string> = {
  limit:
    "进入这个模式时，只留下清单里的能力；其余暂时关掉。不限定 = 不动现有的。",
  add: "进入这个模式时，即使会话里没开，也把清单里的能力打开。",
  remove: "进入这个模式时，把清单里的能力关掉；本来就没开的无事。",
};

// 能力页。Agent：基线「不限制 / 指定清单」，会话可以在它上面增减。
// 模式：对会话现有能力的三种操作，顺序固定为 限定为 → 增加 → 减少。
export function CapsTab({
  mode,
  draft,
  edit,
}: {
  mode: boolean;
  draft: Draft;
  edit: (patch: Partial<Draft>) => void;
}) {
  const groups = useCapCatalog();
  const [op, setOp] = useState<Op>("limit");
  if (!groups) return <Loading>正在读取能力清单…</Loading>;
  const total = groups.reduce((a, g) => a + g.items.length, 0);

  const list =
    op === "limit"
      ? draft.capabilities
      : op === "add"
        ? draft.capsAdd
        : draft.capsRemove;
  const setList = (next: string[] | null) =>
    edit(
      op === "limit"
        ? { capabilities: next }
        : op === "add"
          ? { capsAdd: next ?? [] }
          : { capsRemove: next ?? [] },
    );
  const unlimited = list === null;

  return (
    <div className="sd-caps">
      {mode && (
        <Segmented
          aria-label="对能力的操作"
          options={[
            {
              value: "limit",
              label: `限定为${draft.capabilities ? ` · ${draft.capabilities.length}` : ""}`,
            },
            {
              value: "add",
              label: `增加${draft.capsAdd.length ? ` · ${draft.capsAdd.length}` : ""}`,
            },
            {
              value: "remove",
              label: `减少${draft.capsRemove.length ? ` · ${draft.capsRemove.length}` : ""}`,
            },
          ]}
          value={op}
          onChange={(v) => setOp(v as Op)}
        />
      )}
      <div className="sd-caps-bar">
        {(!mode || op === "limit") && (
          <Segmented
            aria-label="能力范围"
            options={[
              { value: "all", label: mode ? "不限定" : "不限制" },
              { value: "pick", label: "指定清单" },
            ]}
            value={unlimited ? "all" : "pick"}
            onChange={(v) => setList(v === "all" ? null : [])}
          />
        )}
        <span className="t-aux">
          {mode
            ? OP_HINT[op]
            : unlimited
              ? "全部内置工具（默认关闭的「开发调试」除外）+ 目录已分发的技能与 MCP"
              : `已选 ${list?.length ?? 0} / ${total}`}
        </span>
      </div>
      {!mode && (
        <InlineNotice>
          这是 Agent
          的基线：会话在它上面可以增减，改动单独记在会话里，随时能恢复成这份基线。框架工具（call_tool、ask_user、todo_write
          等）始终可用，不在这里；插件注册的工具由插件开关决定。
        </InlineNotice>
      )}
      <CapPicker
        groups={groups}
        value={list ?? []}
        onChange={setList}
        disabled={unlimited}
      />
    </div>
  );
}
