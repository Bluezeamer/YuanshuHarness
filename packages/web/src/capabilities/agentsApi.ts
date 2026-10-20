import { call, enc } from "../api";

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  promptBlocks: string[];
  capabilities: AgentCapability[];
  model: string | null;
  defaultThinkingLevel: string | null;
  defaultMode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCapability {
  kind: "tool" | "skill" | "mcp";
  name: string;
}

export interface AgentInput {
  name: string;
  description?: string;
  promptBlocks?: string[];
  capabilities?: AgentCapability[];
  model?: string | null;
  defaultThinkingLevel?: string | null;
  defaultMode?: string | null;
}

export interface ToolInfo {
  name: string;
  description: string;
  readOnly: boolean;
  server: boolean;
}

export interface BlockInfo {
  id: string;
  name: string;
  group: string;
  dimension: string | null;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BlockInput {
  name: string;
  group: string;
  dimension?: string | null;
  content: string;
}

export interface PreviewPart {
  kind: "block" | "global-file" | "project-file" | "mode";
  group: string;
  id?: string;
  name: string;
  chars: number;
}

export interface PreviewResult {
  text: string;
  parts: PreviewPart[];
  chars: number;
}

export type Mode = "build" | "plan";

export const listAgents = (token: string | null) =>
  call(
    "GET",
    "/api/v1/agents",
    token,
    undefined,
    (b: { agents: AgentInfo[] }) => {
      if (!Array.isArray(b.agents)) throw new Error("shape");
      return b.agents;
    },
  );

export const getAgent = (token: string | null, id: string) =>
  call(
    "GET",
    `/api/v1/agents/${enc(id)}`,
    token,
    undefined,
    (b: AgentInfo) => b,
  );

export const createAgent = (token: string | null, input: AgentInput) =>
  call("POST", "/api/v1/agents", token, input, (b: AgentInfo) => b);

export const patchAgent = (
  token: string | null,
  id: string,
  input: Partial<AgentInput>,
) =>
  call("PATCH", `/api/v1/agents/${enc(id)}`, token, input, (b: AgentInfo) => b);

export const deleteAgent = (token: string | null, id: string) =>
  call("DELETE", `/api/v1/agents/${enc(id)}`, token, undefined, () => {});

export const listTools = (token: string | null) =>
  call("GET", "/api/v1/tools", token, undefined, (b: { tools: ToolInfo[] }) => {
    if (!Array.isArray(b.tools)) throw new Error("shape");
    return b.tools;
  });

export const listBlocks = (token: string | null) =>
  call(
    "GET",
    "/api/v1/prompt/blocks",
    token,
    undefined,
    (b: { blocks: BlockInfo[] }) => {
      if (!Array.isArray(b.blocks)) throw new Error("shape");
      return b.blocks;
    },
  );

export const createBlock = (token: string | null, input: BlockInput) =>
  call("POST", "/api/v1/prompt/blocks", token, input, (b: BlockInfo) => b);

export const patchBlock = (
  token: string | null,
  id: string,
  input: Partial<BlockInput>,
) =>
  call(
    "PATCH",
    `/api/v1/prompt/blocks/${enc(id)}`,
    token,
    input,
    (b: BlockInfo) => b,
  );

export const deleteBlock = (token: string | null, id: string) =>
  call(
    "DELETE",
    `/api/v1/prompt/blocks/${enc(id)}`,
    token,
    undefined,
    () => {},
  );

export const previewPrompt = (
  token: string | null,
  body:
    | { agentId: string; workspaceId?: string }
    | { promptBlocks: string[]; mode?: Mode; workspaceId?: string },
) =>
  call("POST", "/api/v1/prompt/preview", token, body, (b: PreviewResult) => b);
