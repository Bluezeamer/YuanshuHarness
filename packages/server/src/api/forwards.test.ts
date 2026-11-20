// 服务转发接口：列表、开启、关闭。转发服务用假的，Fastify 是真的。
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ForwardService, ForwardView } from "../forward/service.js";
import { HttpError } from "../lib/http-error.js";
import { forwardsApi } from "./forwards.js";

let app: FastifyInstance;
let base = "";
let calls: Array<{ fn: string; args: unknown[] }> = [];
let views: ForwardView[] = [];
let openError: Error | null = null;
let closeResult = true;

const view = (over: Partial<ForwardView> = {}): ForwardView => ({
  id: "f1",
  envId: "e1",
  port: 3000,
  localPort: 7500,
  listening: true,
  ...over,
});

// 目标解析用真的 resolveTarget；这里只给它「e1 / e2 / server(=local) 是环境、默认环境是 e1」
const targetOptions = {
  findEnv: (name: string) =>
    name === "server"
      ? "local"
      : name === "local"
        ? "e1"
        : ["e1", "e2"].includes(name)
          ? name
          : null,
  defaultEnvId: "e1",
};

beforeEach(async () => {
  calls = [];
  views = [];
  openError = null;
  closeResult = true;
  const forwards: Pick<ForwardService, "list" | "open" | "close"> = {
    list(workspaceKey) {
      calls.push({ fn: "list", args: [workspaceKey] });
      return views;
    },
    async open(workspaceKey, envId, port) {
      calls.push({ fn: "open", args: [workspaceKey, envId, port] });
      if (openError) throw openError;
      return view({ envId, port });
    },
    async close(workspaceKey, id) {
      calls.push({ fn: "close", args: [workspaceKey, id] });
      return closeResult;
    },
  };
  app = Fastify({ logger: false });
  await app.register(forwardsApi, {
    forwards,
    targetOptions: () => targetOptions,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}/api/v1`;
});

afterEach(async () => {
  await app.close();
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("列表：按工作区返回转发", async () => {
  views = [view(), view({ id: "f2", port: 3001, localPort: 7501 })];
  const r = await call("GET", "/workspaces/w1/forwards");
  expect(r.status).toBe(200);
  // target 是地址栏写法：本机环境 local 在这里叫 server
  expect(await r.json()).toEqual({
    forwards: [
      { ...views[0], target: "e1:3000" },
      { ...views[1], target: "e1:3001" },
    ],
  });
  expect(calls).toEqual([{ fn: "list", args: ["w1"] }]);

  views = [];
  expect(await (await call("GET", "/workspaces/w2/forwards")).json()).toEqual({
    forwards: [],
  });
});

test("开启：目标写成 host:端口，200 返回转发视图", async () => {
  const r = await call("POST", "/workspaces/w1/forwards", {
    target: "e2:3000",
  });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({
    ...view({ envId: "e2" }),
    target: "e2:3000",
  });
  expect(calls).toEqual([{ fn: "open", args: ["w1", "e2", 3000] }]);
});

test("开启：只写端口与 local:端口 都落在工作区主目录所在的环境；首尾空白忽略", async () => {
  for (const target of ["3000", " 3000 ", "local:3000"]) {
    calls = [];
    const r = await call("POST", "/workspaces/w1/forwards", { target });
    expect(r.status, target).toBe(200);
    expect(calls, target).toEqual([{ fn: "open", args: ["w1", "e1", 3000] }]);
  }
});

test("开启：目标里带路径只取端口（路径无意义）", async () => {
  const r = await call("POST", "/workspaces/w1/forwards", {
    target: "e1:3000/api?x=1",
  });
  expect(r.status).toBe(200);
  expect(calls).toEqual([{ fn: "open", args: ["w1", "e1", 3000] }]);
});

test.each([
  ["缺目标", {}],
  ["目标是数字", { target: 3000 }],
  ["目标是空串", { target: "" }],
  ["目标全是空白", { target: "   " }],
])("开启的参数不合法（%s）：400 bad_request", async (_n, body) => {
  const r = await call("POST", "/workspaces/w1/forwards", body);
  expect(r.status).toBe(400);
  expect(await r.json()).toMatchObject({ error: "bad_request" });
  expect(calls).toEqual([]);
});

test.each([
  ["端口为 0", "e1:0"],
  ["端口越界", "e1:70000"],
  ["未知主机", "nope:3000"],
  ["不是端口", "abc"],
  ["文件路径", "/etc/passwd"],
  ["主机加文件路径", "e1:/etc/passwd"],
])(
  "开启的目标不对（%s）：400 bad_target，说明原因，不调用转发",
  async (_n, target) => {
    const r = await call("POST", "/workspaces/w1/forwards", { target });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_target");
    expect(body.message.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  },
);

test("开启：server 指本机环境（local），返回的 target 仍写成 server:端口", async () => {
  const r = await call("POST", "/workspaces/w1/forwards", {
    target: "server:3000",
  });
  expect(calls).toEqual([{ fn: "open", args: ["w1", "local", 3000] }]);
  expect(await r.json()).toMatchObject({
    envId: "local",
    target: "server:3000",
  });
});

test("开启：业务错误按状态与中文说明返回", async () => {
  openError = new HttpError(
    "forbidden_target",
    "这个工作区够不到这个环境或端口",
    403,
  );
  const r = await call("POST", "/workspaces/w1/forwards", {
    target: "e2:3000",
  });
  expect(r.status).toBe(403);
  expect(await r.json()).toEqual({
    error: "forbidden_target",
    message: "这个工作区够不到这个环境或端口",
  });
});

test("关闭：204；不存在 404", async () => {
  const ok = await call("DELETE", "/workspaces/w1/forwards/f1");
  expect(ok.status).toBe(204);
  expect(calls).toEqual([{ fn: "close", args: ["w1", "f1"] }]);

  closeResult = false;
  const missing = await call("DELETE", "/workspaces/w1/forwards/nope");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "not_found" });
});
