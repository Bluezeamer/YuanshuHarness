import "./isolate.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  at,
  countIn,
  makeEnv,
  openSession,
  startStub,
  writeModels,
} from "./harness.js";
import { fakeHome } from "./isolate.js";

// R5：AGENTS.md 的接管。
const stub = await startStub();
afterAll(() => stub.close());

const AGENTS = "AGENTS-MARKER-7f3a";
const PROJECT_TEXT = `# Project\n${AGENTS}\n`;

function setup() {
  stub.requests.length = 0;
  const env = makeEnv();
  writeModels(env, stub.url);
  writeFileSync(join(env.cwd, "AGENTS.md"), PROJECT_TEXT);
  return env;
}

const lastBody = () =>
  at(stub.requests, -1).body as { messages: Array<{ content?: unknown }> };

test("R5 基线：SDK 默认会读取 cwd 下的 AGENTS.md，且在请求里只出现一次", async () => {
  const env = setup();
  const { session } = await openSession(env);
  await session.prompt("hi");
  expect(countIn(lastBody(), AGENTS)).toBe(1);
  session.dispose();
});

test("R5 接管：关闭 SDK 自读，由 Server 自己注入同一内容，只出现一次", async () => {
  const env = setup();
  const { session } = await openSession(env, {
    loader: { noContextFiles: true, appendSystemPrompt: [PROJECT_TEXT] },
  });
  await session.prompt("hi");
  expect(countIn(lastBody(), AGENTS)).toBe(1);
  session.dispose();
});

test("R5 对照：不关闭 SDK 自读又自己注入，必须出现两次以上（说明接管确实需要关闭自读）", async () => {
  const env = setup();
  const { session } = await openSession(env, {
    loader: { appendSystemPrompt: [PROJECT_TEXT] },
  });
  await session.prompt("hi");
  const text = JSON.stringify(lastBody().messages);
  expect(text.split(AGENTS).length - 1).toBeGreaterThanOrEqual(2);
  session.dispose();
});

test("R5 不读取 ~/.pi：假 HOME 里的 AGENTS.md 与设置不得进入请求", async () => {
  const env = setup();
  mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".pi", "agent", "AGENTS.md"),
    "HOME-AGENTS-SHOULD-NOT-LEAK",
  );
  // 显式给定 agentDir（Server 的做法）：不得读到假 HOME 里的文件
  const { session } = await openSession(env);
  await session.prompt("hi");
  expect(JSON.stringify(lastBody().messages)).not.toContain(
    "HOME-AGENTS-SHOULD-NOT-LEAK",
  );
  session.dispose();
});
