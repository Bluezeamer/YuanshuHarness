import type { ModelInfo } from "../api";
import { field } from "../settings/shared";
import type {
  AgentCapability,
  AgentInfo,
  BlockInfo,
  Mode,
  ToolInfo,
} from "./agentsApi";
import { BlockPicker } from "./BlockPicker";
import { CapabilityPicker } from "./CapabilityPicker";
import { Field } from "./Field";
import { PromptPreview } from "./PromptPreview";

export interface AgentDraft {
  name: string;
  description: string;
  // 空串表示用 Server 默认模型 / 默认推理档位。
  model: string;
  thinking: string;
  mode: Mode;
  promptBlocks: string[];
  capabilities: AgentCapability[];
}

export const EMPTY_DRAFT: AgentDraft = {
  name: "",
  description: "",
  model: "",
  thinking: "",
  mode: "build",
  promptBlocks: [],
  capabilities: [],
};

export const toDraft = (a: AgentInfo): AgentDraft => ({
  name: a.name,
  description: a.description,
  model: a.model ?? "",
  thinking: a.defaultThinkingLevel ?? "",
  mode: a.defaultMode === "plan" ? "plan" : "build",
  promptBlocks: a.promptBlocks,
  capabilities: a.capabilities,
});

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "build", label: "build", hint: "完整工具集，可写文件、执行命令" },
  {
    id: "plan",
    label: "plan",
    hint: "只读：写入与执行类调用会在执行层被拒绝",
  },
];

export function AgentForm({
  draft,
  onChange,
  models,
  blocks,
  tools,
  onUnauthorized,
}: {
  draft: AgentDraft;
  onChange(next: AgentDraft): void;
  models: ModelInfo[];
  blocks: BlockInfo[];
  tools: ToolInfo[];
  onUnauthorized(): void;
}) {
  const set = <K extends keyof AgentDraft>(k: K, v: AgentDraft[K]) =>
    onChange({ ...draft, [k]: v });

  return (
    <div className="flex flex-col gap-4">
      <Field label="名称" id="ag-name">
        <input
          id="ag-name"
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          className={field}
        />
      </Field>
      <Field label="描述" id="ag-desc">
        <input
          id="ag-desc"
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          className={field}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
        <Field label="模型" id="ag-model">
          <select
            id="ag-model"
            value={draft.model}
            onChange={(e) => set("model", e.target.value)}
            className={field}
          >
            <option value="">Server 默认模型</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="推理档位" id="ag-think">
          <select
            id="ag-think"
            value={draft.thinking}
            onChange={(e) => set("thinking", e.target.value)}
            className={field}
          >
            <option value="">默认</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-xs font-semibold">
          初始模式（会话创建时生效）
        </legend>
        {MODES.map((m) => (
          <label
            key={m.id}
            className={`grid cursor-pointer grid-cols-[auto_1fr] gap-x-3 border px-3 py-2 ${draft.mode === m.id ? "border-ink" : "border-line"}`}
          >
            <input
              type="radio"
              name="ag-mode"
              value={m.id}
              checked={draft.mode === m.id}
              onChange={() => set("mode", m.id)}
              className="mt-1"
            />
            <span className="font-semibold">{m.label}</span>
            <span className="col-start-2 text-xs text-mute">{m.hint}</span>
          </label>
        ))}
      </fieldset>
      <section aria-label="提示词块" className="flex flex-col gap-2">
        <h3 className="m-0 text-xs font-semibold">提示词块</h3>
        <BlockPicker
          blocks={blocks}
          value={draft.promptBlocks}
          onChange={(v) => set("promptBlocks", v)}
        />
      </section>
      <section aria-label="能力" className="flex flex-col gap-2">
        <h3 className="m-0 text-xs font-semibold">能力</h3>
        <CapabilityPicker
          tools={tools}
          value={draft.capabilities}
          onChange={(v) => set("capabilities", v)}
        />
      </section>
      <section aria-label="拼接预览" className="flex flex-col gap-2">
        <h3 className="m-0 text-xs font-semibold">拼接预览</h3>
        <PromptPreview
          promptBlocks={draft.promptBlocks}
          mode={draft.mode}
          onUnauthorized={onUnauthorized}
        />
      </section>
    </div>
  );
}
