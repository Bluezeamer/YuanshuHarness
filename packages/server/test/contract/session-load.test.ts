import "./isolate.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, expect, test } from "vitest";
import {
  at,
  countIn,
  makeEnv,
  openSession,
  startStub,
  writeModels,
} from "./harness.js";

// R4：用公开接口从既有 JSONL 重建会话。
const stub = await startStub();
afterAll(() => stub.close());

async function writeSession() {
  const env = makeEnv();
  writeModels(env, stub.url);
  const sessionDir = join(env.root, "sessions");
  const manager = SessionManager.create(env.cwd, sessionDir);
  const { session } = await openSession(env, { sessionManager: manager });
  await session.prompt("first-question-MARKER");
  await session.prompt("second-question");
  const file = session.sessionManager.getSessionFile();
  const messages = structuredClone(session.messages);
  session.dispose();
  return { env, sessionDir, file: file as string, messages };
}

test("R4 重建后 messages 与原会话一致，并能继续对话（历史随请求发出）", async () => {
  const { env, sessionDir, file, messages } = await writeSession();
  expect(file).toBeTruthy();

  const reopened = SessionManager.open(file, sessionDir);
  const { session } = await openSession(env, { sessionManager: reopened });
  expect(session.messages).toEqual(messages);

  stub.requests.length = 0;
  await session.prompt("third-question");
  const body = at(stub.requests, 0).body as {
    messages: Array<{ content?: unknown }>;
  };
  expect(countIn(body, "first-question-MARKER")).toBe(1);
  session.dispose();
});

test("R4 变异：JSONL 缺一行时，重建结果必须与原会话不同", async () => {
  const { env, sessionDir, file, messages } = await writeSession();
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  writeFileSync(file, `${lines.slice(0, -2).join("\n")}\n`);
  const { session } = await openSession(env, {
    sessionManager: SessionManager.open(file, sessionDir),
  });
  expect(session.messages).not.toEqual(messages);
  session.dispose();
});
