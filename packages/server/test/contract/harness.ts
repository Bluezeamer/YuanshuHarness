import "./isolate.js";

export {
  type Env,
  makeEnv,
  openSession,
  type RecordedRequest,
  type Stub,
  startStub,
  tmpDir,
  writeModels,
} from "../support/stub.js";

export const textOf = (m: { content?: unknown }): string =>
  typeof m.content === "string" ? m.content : JSON.stringify(m);

// 统计标记在整个请求（所有消息）里出现的总次数，而不是包含标记的消息条数。
export const countIn = (
  body: { messages: Array<{ content?: unknown }> },
  needle: string,
): number => body.messages.map(textOf).join("\n").split(needle).length - 1;

export const toolNames = (body: {
  tools?: Array<{ function?: { name: string } }>;
}): string[] => (body.tools ?? []).map((t) => t.function?.name ?? "");

const emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as never;
export const makeTool = (name: string) => ({
  name,
  label: name,
  description: `tool ${name}`,
  parameters: emptySchema,
  execute: async () => ({
    content: [{ type: "text" as const, text: "ok" }],
    details: {},
  }),
});

export function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i < 0 ? arr.length + i : i];
  if (v === undefined)
    throw new Error(`index ${i} out of range (length ${arr.length})`);
  return v;
}
