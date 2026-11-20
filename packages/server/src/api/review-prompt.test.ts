import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, test } from "vitest";
import { type TestData, testData } from "../../test/support/stub.js";
import {
  DEFAULT_CRITERIA,
  POLICY_MAX,
  PROTOCOL_HEAD,
  PROTOCOL_TAIL,
} from "../permission/review-policy.js";
import { DefaultsStore } from "../store/defaults.js";
import { reviewPromptApi } from "./review-prompt.js";

interface View {
  head: string;
  tail: string;
  criteria: string;
  defaultCriteria: string;
  custom: boolean;
  max: number;
}

let data: TestData | undefined;
let app: FastifyInstance | undefined;

async function boot() {
  data = testData();
  app = Fastify({ logger: false });
  await app.register(reviewPromptApi, { defaults: new DefaultsStore(data.db) });
  await app.ready();
}

afterEach(async () => {
  await app?.close();
  data?.close();
  data = undefined;
  app = undefined;
});

const server = (): FastifyInstance => {
  if (!app) throw new Error("未启动测试服务");
  return app;
};

const get = async (): Promise<View> => {
  const res = await server().inject({
    method: "GET",
    url: "/api/v1/review-prompt",
  });
  expect(res.statusCode).toBe(200);
  return res.json() as View;
};

// 用字符串 payload：null / 数组 / 原始值都能原样送进服务端。
const put = async (body: unknown) =>
  server().inject({
    method: "PUT",
    url: "/api/v1/review-prompt",
    payload: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const BASE = {
  head: PROTOCOL_HEAD,
  tail: PROTOCOL_TAIL,
  criteria: DEFAULT_CRITERIA,
  defaultCriteria: DEFAULT_CRITERIA,
  custom: false,
  max: POLICY_MAX,
};

test("GET：没人设置过时给默认准则，头尾原样带出", async () => {
  await boot();
  expect(await get()).toEqual(BASE);
});

test("PUT 自定义后 GET 是新文本；返回的也是完整对象", async () => {
  await boot();
  const res = await put({ criteria: "只许改 docs" });
  expect(res.statusCode).toBe(200);
  const body = res.json() as View;
  expect(body).toEqual({ ...BASE, criteria: "只许改 docs", custom: true });
  expect(await get()).toEqual(body);
});

test("PUT 带首尾空白被 trim", async () => {
  await boot();
  await put({ criteria: "  只许改 docs\n " });
  expect((await get()).criteria).toBe("只许改 docs");
});

test("PUT null 与只有空白的字符串都恢复默认", async () => {
  await boot();
  await put({ criteria: "只许改 docs" });
  expect((await put({ criteria: null })).statusCode).toBe(200);
  expect(await get()).toEqual(BASE);
  await put({ criteria: "只许改 docs" });
  expect((await put({ criteria: "   " })).statusCode).toBe(200);
  expect(await get()).toEqual(BASE);
});

test("提交的文本与默认准则相同（含首尾空白）：按恢复默认处理，不把默认钉成自定义", async () => {
  await boot();
  await put({ criteria: "只许改 docs" });
  expect((await put({ criteria: ` ${DEFAULT_CRITERIA}\n` })).statusCode).toBe(
    200,
  );
  expect(await get()).toEqual(BASE);
});

test("非法入参 400 invalid_review_criteria 且不落库", async () => {
  await boot();
  await put({ criteria: "只许改 docs" });
  for (const body of [
    { criteria: "x".repeat(POLICY_MAX + 1) },
    { criteria: 1 },
    { criteria: {} },
    { criteria: ["x"] },
    {},
    null,
  ]) {
    const res = await put(body);
    expect(res.statusCode, JSON.stringify(body)).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_review_criteria" });
  }
  expect((await get()).criteria).toBe("只许改 docs");
});
