import "./isolate.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, expect, test } from "vitest";
import { at, makeEnv, openSession, startStub, writeModels } from "./harness.js";

// R7：模型配置路径可指定；API key 可由 Server 运行时提供，而不是文件里的明文。
const stub = await startStub();
afterAll(() => stub.close());

const auth = () => at(stub.requests, -1).headers.authorization;

function allFileText(dir: string): string {
  let out = "";
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out += readFileSync(join(e.parentPath, e.name), "utf8");
  }
  return out;
}

test("R7 运行时提供 key：models.json 不含 apiKey，请求用的是运行时提供的值，磁盘上不落明文", async () => {
  stub.requests.length = 0;
  const env = makeEnv();
  writeModels(env, stub.url, {}, null);
  expect(readFileSync(join(env.agentDir, "models.json"), "utf8")).not.toContain(
    "apiKey",
  );
  const { session, modelRuntime } = await openSession(env);
  await modelRuntime.setRuntimeApiKey("stub", "runtime-secret-123");
  await session.prompt("hi");
  expect(auth()).toBe("Bearer runtime-secret-123");
  expect(allFileText(env.root)).not.toContain("runtime-secret-123");
  session.dispose();
});

test("R7 环境变量引用：apiKey 写成 $NAME，请求用的是环境变量的值，文件里只有引用", async () => {
  stub.requests.length = 0;
  process.env.YUANSHU_CONTRACT_KEY = "env-secret-456";
  const env = makeEnv();
  writeModels(env, stub.url, {}, "$YUANSHU_CONTRACT_KEY");
  const { session } = await openSession(env);
  await session.prompt("hi");
  expect(auth()).toBe("Bearer env-secret-456");
  expect(allFileText(env.root)).not.toContain("env-secret-456");
  session.dispose();
});

test("R7 命令引用：apiKey 写成 !command（可对接密码库命令行），请求时执行并取其输出", async () => {
  stub.requests.length = 0;
  const env = makeEnv();
  writeModels(env, stub.url, {}, "!printf cmd-%s secret-789");
  const { session } = await openSession(env);
  await session.prompt("hi");
  expect(auth()).toBe("Bearer cmd-secret-789");
  expect(allFileText(env.root)).not.toContain("cmd-secret-789");
  session.dispose();
});

test("R7 配置路径：只读取显式指定的 models.json，不落到默认目录", async () => {
  const env = makeEnv();
  writeModels(env, stub.url);
  const rt = await ModelRuntime.create({
    authPath: join(env.agentDir, "auth.json"),
    modelsPath: join(env.agentDir, "models.json"),
  });
  expect(rt.getModel("stub", "stub-model")).toBeDefined();
  const other = makeEnv();
  const rt2 = await ModelRuntime.create({
    authPath: join(other.agentDir, "auth.json"),
    modelsPath: join(other.agentDir, "models.json"),
  });
  expect(rt2.getModel("stub", "stub-model")).toBeUndefined();
});
