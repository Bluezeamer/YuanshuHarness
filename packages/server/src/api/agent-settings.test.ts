import "../../test/contract/isolate.js";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { AgentSettingsFile } from "../session/agent-settings.js";
import { agentSettingsApi } from "./agent-settings.js";

let app: FastifyInstance | undefined;
let file = "";
let previousAgentDir: string | undefined;

const PI_SETTINGS = {
  compaction: { enabled: false, reserveTokens: 8000, keepRecentTokens: 9000 },
  retry: { enabled: false, maxRetries: 5 },
};

beforeEach(async () => {
  const ysHome = makeTmpDir("b24-api-ys-");
  file = join(ysHome, "settings.json");
  // 「不看我们文件时 pi 自己会用的值」：临时 agentDir 当 pi 的配置目录
  const agentDir = makeTmpDir("b24-api-pi-");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(PI_SETTINGS));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(ysHome, { recursive: true });
  app = Fastify({ logger: false });
  await app.register(agentSettingsApi, {
    file: new AgentSettingsFile(file),
  });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

const server = (): FastifyInstance => {
  if (!app) throw new Error("应用没建起来");
  return app;
};

const get = () =>
  server().inject({ method: "GET", url: "/api/v1/agent-settings" });
// 一律按 JSON 发：非对象的 body 也要走解析，才轮到路由自己的校验
const put = (payload: unknown) =>
  server().inject({
    method: "PUT",
    url: "/api/v1/agent-settings",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });

const DEFAULTS = {
  compaction: { enabled: false, reserveTokens: 8000, keepRecentTokens: 9000 },
  retry: { enabled: false, maxRetries: 5 },
};
const RANGES = {
  reserveTokens: { min: 4096, max: 65536 },
  keepRecentTokens: { min: 4000, max: 200000 },
  maxRetries: { min: 0, max: 10 },
};

test("GET：文件不存在时 values 全空，defaults 来自 pi 自己的设置", async () => {
  const res = await get();
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    file,
    values: { compaction: {}, retry: {} },
    problems: [],
    defaults: DEFAULTS,
    ranges: RANGES,
  });
});

test("GET：defaults 每次现读 pi 的配置", async () => {
  await get();
  const agentDir = process.env.PI_CODING_AGENT_DIR as string;
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { reserveTokens: 12000 } }),
  );
  expect((await get()).json().defaults).toEqual({
    compaction: {
      enabled: true,
      reserveTokens: 12000,
      keepRecentTokens: 20000,
    },
    retry: { enabled: true, maxRetries: 3 },
  });
});

test("PUT：合并写入并返回与 GET 同形的对象", async () => {
  const res = await put({
    compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    file,
    values: {
      compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
      retry: {},
    },
    problems: [],
    defaults: DEFAULTS,
    ranges: RANGES,
  });
  expect((await get()).json().values).toEqual({
    compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
    retry: {},
  });
});

test("PUT：null 删掉这一项，回到跟随 pi", async () => {
  await put({ retry: { enabled: true, maxRetries: 2 } });
  const res = await put({ retry: { maxRetries: null } });
  expect(res.json().values).toEqual({
    compaction: {},
    retry: { enabled: true },
  });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    retry: { enabled: true },
  });
});

test("PUT：body 不是对象或含不认识的键时 400，文件不动", async () => {
  for (const body of [
    [1],
    "x",
    null,
    { other: 1 },
    { compaction: { nope: 1 } },
  ]) {
    const res = await put(body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "bad_request" });
  }
  const unknown = await put({ compaction: { nope: 1 } });
  expect(unknown.json().message).toBe("未知的设置项：compaction.nope");
  const notObject = await put({ retry: 1 });
  expect(notObject.json().message).toBe("retry 必须是对象");
  expect(readdirSync(file.slice(0, file.lastIndexOf("/")))).toEqual([]);
});

test("PUT：类型与范围不合规时 400 带中文原因", async () => {
  const cases: [unknown, string][] = [
    [
      { compaction: { reserveTokens: 4095 } },
      "compaction.reserveTokens 必须是 4096–65536 的整数",
    ],
    [
      { compaction: { keepRecentTokens: 200001 } },
      "compaction.keepRecentTokens 必须是 4000–200000 的整数",
    ],
    [{ retry: { maxRetries: 11 } }, "retry.maxRetries 必须是 0–10 的整数"],
    [{ retry: { enabled: "yes" } }, "retry.enabled 必须是 true 或 false"],
  ];
  for (const [body, message] of cases) {
    const res = await put(body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "bad_request", message });
  }
});

test("PUT：原文件是坏 JSON 时 400，文件字节不变", async () => {
  writeFileSync(file, "{oops");
  const res = await put({ retry: { maxRetries: 1 } });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({
    error: "bad_request",
    message: "settings.json 现在不是合法 JSON，先改好再从界面保存",
  });
  expect(readFileSync(file, "utf8")).toBe("{oops");
});

test("GET：坏账的单项写进 problems", async () => {
  writeFileSync(
    file,
    JSON.stringify({ compaction: { enabled: "x" }, retry: { maxRetries: 3 } }),
  );
  const body = (await get()).json();
  expect(body.values).toEqual({ compaction: {}, retry: { maxRetries: 3 } });
  expect(body.problems).toEqual([
    "settings.json 里的 compaction.enabled 无效（必须是 true 或 false），已忽略",
  ]);
});
