import { toolNames } from "../session/tool-catalog.js";
import {
  type Agent,
  type AgentCapability,
  DEFAULT_AGENT_ID,
} from "../store/agents.js";
import { type Block, ROLE_GROUP } from "../store/blocks.js";

const AT = "2026-01-01T00:00:00.000Z";

const role = (
  n: number,
  name: string,
  dimension: string,
  content: string,
): Block => ({
  id: `b46ee05d-4ed4-5${String(n).padStart(3, "0")}-a91a-e7d5e9b4f3b${n}`,
  name,
  group: ROLE_GROUP,
  dimension,
  content,
  version: 1,
  createdAt: AT,
  updatedAt: AT,
});

const GENERAL = role(
  1,
  "通用工程助手",
  "通用",
  `你是一名务实的工程助手，在用户的 workspace 里读写代码、运行命令、排查问题。
- 动手前先读相关代码，匹配现有风格；改动保持最小，不顺手重构无关部分。
- 需求有歧义或存在明显更优方案时，先说明再动手。
- 完成后用几句话说清做了什么、验证了什么、还有什么没验证。`,
);

const REVIEWER = role(
  2,
  "代码审查者",
  "审查",
  `你是一名严格的代码审查者，只读不改。
- 逐条检查正确性、边界条件、错误处理、安全与测试覆盖，结论要指到具体文件和行。
- 主动尝试证伪：假设这段代码有问题，找出能触发它的输入。
- 区分必须修复与可选建议；不为凑数量提出过度防御的意见。`,
);

const RESEARCHER = role(
  3,
  "调研员",
  "调研",
  `你是一名调研员，只读代码与资料，不修改任何文件。
- 先界定问题，再从代码与文档里找证据；每条结论标明出处。
- 区分已确认的事实、推断和未知；不确定就说不确定。
- 输出结构化的结论与依据，篇幅与问题的复杂度相称。`,
);

const OPS = role(
  4,
  "运维助手",
  "运维",
  `你是一名运维助手，通过 workspace 所在的环境（本机或远程）执行命令。
- 先用只读命令确认现状，再执行变更；每次变更说明目的与影响范围。
- 不做不可逆的操作（删除、覆盖、重启服务）除非用户明确要求。
- 命令输出里出现密钥或令牌时，不在回复里复述。`,
);

const ASSISTANT = role(
  5,
  "精简助手",
  "问答",
  `你是一名精简的问答助手，只读取文件来回答问题，不修改文件、不执行命令。
回答直接、简短；需要查看文件时再读，不做无关的探索。`,
);

export const SEED_BLOCKS: Block[] = [
  GENERAL,
  REVIEWER,
  RESEARCHER,
  OPS,
  ASSISTANT,
];

// SDK 内置的 7 个工具，加 Server 自带的两个。
const READ_ONLY = toolNames((t) => t.readOnly && !t.server);
const ALL_BUILTIN = toolNames((t) => !t.server);
const SERVER_TOOLS = toolNames((t) => t.server);

const tools = (names: string[]): AgentCapability[] =>
  names.map((name) => ({ kind: "tool", name }));

const agent = (
  n: number,
  name: string,
  description: string,
  blocks: Block[],
  toolNames: string[],
  defaultMode: string | null = null,
): Agent => ({
  id: n === 1 ? DEFAULT_AGENT_ID : `c46ee05d-4ed4-400${n}-a91a-e7d5e9b4f3c${n}`,
  name,
  description,
  promptBlocks: blocks.map((b) => b.id),
  capabilities: tools(toolNames),
  model: null,
  defaultThinkingLevel: null,
  defaultMode,
  createdAt: AT,
  updatedAt: AT,
});

// 对应 mock 能力集页的 6 个预设；只放当前真实存在的能力（skill / MCP 接入后再扩充）。
export const SEED_AGENTS: Agent[] = [
  agent(
    1,
    "coder-full",
    "完整编码能力：读写文件、编辑、执行命令。默认会话使用。",
    [GENERAL],
    [...ALL_BUILTIN, ...SERVER_TOOLS],
  ),
  agent(
    2,
    "auditor",
    "审计员：只读工具加对抗式检查提示词。物理上没有写工具，是绝对的安全边界。",
    [REVIEWER],
    [...READ_ONLY, ...SERVER_TOOLS],
  ),
  agent(
    3,
    "assistant-narrow",
    "极窄的问答助手：只能读文件，无 bash、无写入。",
    [ASSISTANT],
    ["read", "find", "ls"],
  ),
  agent(
    4,
    "ops-ssh",
    "远程运维：在 ssh 环境的 workspace 里执行命令、查看与修改文件，可在 workspace 间切换。",
    [OPS],
    [...ALL_BUILTIN, ...SERVER_TOOLS],
  ),
  agent(
    5,
    "researcher",
    "只读调研：read / grep / find / ls，不改任何文件。",
    [RESEARCHER],
    [...READ_ONLY, ...SERVER_TOOLS],
  ),
  agent(
    6,
    "plan-mode",
    "完整能力集，但以 plan 模式启动：模式提示词加只读限定，演示「模式是叠加状态」。",
    [GENERAL],
    [...ALL_BUILTIN, ...SERVER_TOOLS],
    "plan",
  ),
];
