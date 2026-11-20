import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { startStub } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";
import { DB_FILE } from "../store/db.js";
import { createSessionFactory } from "./factory.js";

// 引用记录的「命令」列：模型写的是占位符，库里存的也只能是占位符。
// 模型这条命令里除了自己引用的变量，还夹带了另外几个变量的真值（长的、刚过登记下限的短的）；
// 真值被窗口边界切开的那条超长命令也要不漏。
// 真实服务 + 真实会话工厂 + stub 模型（让它调 bash）；停服后再直接读 SQLite 文件核对落库内容。
const API_VAL = "API-VALUE-aaaa1111bbbb";
const LEAK_VAL = "LEAK-VALUE-cccc2222dddd";
const PW_VAL = "pw42"; // 登记下限，短于输出遮罩下限 8

const CMD_SHORT = `echo A={{@api.token}} L=${LEAK_VAL} P=${PW_VAL}`;
// 窗口起点落在 LEAK_VAL 中间：先截断再遮罩的话会漏出它的后半截
const CMD_LONG = `echo ${"a".repeat(10)}${LEAK_VAL}${"b".repeat(472)} {{@api.token}}`;

const COMMANDS = [CMD_SHORT, CMD_LONG];
const stub = await startStub((n) => {
  // 请求 1、3 各发起一次 bash；请求 2、4 是工具返回后的收尾
  const i = Math.floor(n / 2);
  return n % 2 === 1
    ? { tool: "bash", args: { command: COMMANDS[i] } }
    : `done-${n}`;
});

let root = "";
let server: YuanshuServer;
let http = "";
// 变量默认对会话不可见，要先在会话所属工作区启用。
let variableIds: string[] = [];

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${http}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
};

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-refcmd-")));
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  mkdirSync(path.join(root, "start"));
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(root, "data"),
      allowCidrs: [],
    },
    {
      webRoot: path.join(root, "web"),
      startDir: path.join(root, "start"),
      makeSessionFactory: createSessionFactory,
      logStream: { write() {} },
    },
  );
  const addr = await server.start();
  http = `http://${addr.host}:${addr.port}`;
  const p = await call("POST", "/api/v1/providers", {
    name: "stub",
    slug: "stub",
    api: "openai-completions",
    baseUrl: stub.url,
    apiKey: "k",
    models: [
      {
        id: "stub-model",
        name: "stub-model",
        reasoning: false,
        levels: [],
        input: ["text"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  await call("PUT", "/api/v1/default-model", {
    provider: p.id,
    model: "stub-model",
  });
  // 完全允许档：只关心引用记录，不想被审批卡住
  await call("PUT", "/api/v1/defaults", { permissionTier: "full" });
  const ids = [] as string[];
  for (const [name, value] of [
    ["api.token", API_VAL],
    ["leak.token", LEAK_VAL],
    ["sudo.pw", PW_VAL],
  ] as const)
    ids.push(
      (
        await call("POST", "/api/v1/variables", {
          name,
          desc: `${name} 的说明`,
          value,
        })
      ).id as string,
    );
  variableIds = ids;
}, 30_000);

afterAll(async () => {
  await server?.stop().catch(() => {});
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

const refs = async () =>
  (await call("GET", "/api/v1/references")).references as Array<{
    name: string;
    result: string;
    command?: string;
  }>;

test("模型的命令里夹带别的变量的真值：引用记录与落库内容都只有占位符", async () => {
  const session = await call("POST", "/api/v1/sessions", {});
  await call("PUT", `/api/v1/workspaces/${session.workspaceId}/variables`, {
    variables: variableIds,
  });
  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
  );
  try {
    for (const [i, text] of ["go", "go again"].entries()) {
      expect((await client.command("send_message", { text })).ok).toBe(true);
      await waitFor(
        () => client.frames.filter((f) => f.type === "run.ended").length > i,
        "run.ended",
        30_000,
      );
    }
  } finally {
    client.close();
  }

  const list = (await refs()).filter((r) => r.name === "api.token");
  expect(list).toHaveLength(2);
  const [long, short] = list; // 新的在前
  // 第一条：整条命令都在 500 字符以内，真值被遮成占位符，自己引用的占位符原样保留
  expect(short?.command).toBe(
    "echo A={{@api.token}} L={{@leak.token}} P={{@sudo.pw}}",
  );
  // 第二条：超长，截到 500 以内，仍含自己的占位符，被窗口切开的真值不留残片
  expect(long?.command?.length).toBeLessThanOrEqual(500);
  expect(long?.command).toContain("{{@api.token}}");
  for (let n = 6; n <= LEAK_VAL.length; n++) {
    expect(long?.command).not.toContain(LEAK_VAL.slice(0, n));
    expect(long?.command).not.toContain(LEAK_VAL.slice(-n));
  }

  // 接口响应里没有任何真值
  const body = JSON.stringify(await refs());
  for (const v of [API_VAL, LEAK_VAL, PW_VAL]) expect(body).not.toContain(v);

  // 停服后直接读 SQLite 文件：variable_refs 的每一列都没有真值
  await server.stop();
  const raw = new Database(path.join(root, "data", DB_FILE), {
    readonly: true,
  });
  try {
    const rows = JSON.stringify(
      raw.prepare("SELECT * FROM variable_refs").all(),
    );
    for (const v of [API_VAL, LEAK_VAL, PW_VAL]) expect(rows).not.toContain(v);
    expect(rows).toContain("{{@api.token}}");
  } finally {
    raw.close();
  }
}, 60_000);
