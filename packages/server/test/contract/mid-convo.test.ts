import "./isolate.js";
import { afterAll, describe, expect, test } from "vitest";
import {
  at,
  countIn,
  makeEnv,
  makeTool,
  openSession,
  startStub,
  textOf,
  toolNames,
  writeModels,
} from "./harness.js";

// R3：supportsMidConvoSystemMessages / supportsMidConvoToolAdditions 的实际行为（openai-completions）。
// 注意：SDK 1.3.0 里 openai-completions 用 ...ToolAdditions，anthropic-messages 才用 ...ToolChanges。
const stub = await startStub();
afterAll(() => stub.close());

const MARK = "MARK-appended-section";

type Body = {
  messages: Array<{ role: string; content?: unknown; tools?: unknown }>;
  tools?: Array<{ function?: { name: string } }>;
};

async function run(
  compat: Record<string, boolean>,
  change: "append" | "tools",
) {
  stub.requests.length = 0;
  const env = makeEnv();
  writeModels(env, stub.url, { compat });
  let mark: string | undefined;
  const { session } = await openSession(env, {
    noTools: false,
    loader: {
      appendSystemPromptOverride: (base) => (mark ? [...base, mark] : base),
      extensionFactories: [
        (pi) => {
          pi.registerTool(makeTool("t1") as never);
          pi.registerTool(makeTool("t2") as never);
        },
      ],
    },
  });
  await session.bindExtensions({});
  session.setActiveToolsByName(["t1"]);
  await session.prompt("one");
  if (change === "append") {
    mark = MARK;
    await session.reload();
  } else {
    session.setActiveToolsByName(["t1", "t2"]);
  }
  await session.prompt("two");
  session.dispose();
  return at(stub.requests, 1).body as Body;
}

describe("R3 supportsMidConvoSystemMessages", () => {
  test("关闭：追加内容改写开头的系统提示词（前缀被破坏），没有中途 system 消息", async () => {
    const body = await run({ supportsMidConvoSystemMessages: false }, "append");
    expect(textOf(at(body.messages, 0))).toContain(MARK);
    expect(body.messages.slice(1).some((m) => m.role === "system")).toBe(false);
  });

  test("开启：开头不变，追加内容以中途 system 消息出现在最新用户消息之前", async () => {
    const body = await run({ supportsMidConvoSystemMessages: true }, "append");
    expect(textOf(at(body.messages, 0))).not.toContain(MARK);
    const idx = body.messages.findIndex((m) => textOf(m).includes(MARK));
    expect(at(body.messages, idx).role).toBe("system");
    expect(idx).toBe(body.messages.length - 2);
    expect(at(body.messages, -1).role).toBe("user");
    expect(countIn(body, MARK)).toBe(1);
  });
});

describe("R3 supportsMidConvoToolAdditions", () => {
  test("关闭：工具集变化体现在顶层 tools 字段", async () => {
    const body = await run({ supportsMidConvoToolAdditions: false }, "tools");
    expect(toolNames(body)).toEqual(["t1", "t2"]);
  });

  test("开启：顶层 tools 不变，新增工具走带 tools 字段的非标准中途 system 消息", async () => {
    const body = await run(
      {
        supportsMidConvoToolAdditions: true,
        supportsMidConvoSystemMessages: true,
      },
      "tools",
    );
    expect(toolNames(body)).toEqual(["t1"]);
    const carrier = body.messages.find(
      (m) => m.role === "system" && "tools" in m,
    );
    expect(carrier).toBeDefined();
    expect(JSON.stringify(carrier?.tools)).toContain("t2");
  });
});

describe("R3 before_agent_start 返回 systemPrompt", () => {
  test("即使开启 supportsMidConvoSystemMessages，也是整体替换开头的系统提示词，不走中途消息", async () => {
    stub.requests.length = 0;
    const env = makeEnv();
    writeModels(env, stub.url, {
      compat: { supportsMidConvoSystemMessages: true },
    });
    let mark: string | undefined;
    const { session } = await openSession(env, {
      loader: {
        extensionFactories: [
          (pi) => {
            pi.on("before_agent_start", (e) =>
              mark ? { systemPrompt: `${e.systemPrompt}\n${mark}` } : undefined,
            );
          },
        ],
      },
    });
    await session.prompt("one");
    mark = MARK;
    await session.prompt("two");
    session.dispose();
    const body = at(stub.requests, 1).body as Body;
    expect(textOf(at(body.messages, 0))).toContain(MARK);
    expect(body.messages.slice(1).some((m) => m.role === "system")).toBe(false);
  });
});
