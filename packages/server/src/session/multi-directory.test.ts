import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Frame, waitFor } from "../../test/support/frames.js";
import { type StubReply, startStub } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";
import { DB_FILE } from "../store/db.js";
import { createSessionFactory } from "./factory.js";

// 一个会话挂多个 directory：清单与角色、提示词里的说明、一次输出里跨 directory 的工具调用序列、
// 权限校验跟着「调用那一刻」的 directory、清单增删与通知、子代理范围、删除保护。
// 真实服务 + 真实会话工厂 + 假模型端点；这里的几个 directory 都在本机上，用来验证同一台主机的多个目录。
let plan: StubReply[] = [];
const stub = await startStub(() => plan.shift() ?? "好的");

let root = "";
let server: YuanshuServer;
let http = "";
const ws: Record<"a" | "b" | "c", { id: string; dir: string }> = {
  a: { id: "", dir: "" },
  b: { id: "", dir: "" },
  c: { id: "", dir: "" },
};

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${http}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const ok = async (method: string, url: string, body?: unknown) => {
  const r = await call(method, url, body);
  if (r.status >= 300)
    throw new Error(
      `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`,
    );
  return r.body;
};

async function boot() {
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
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "yuanshu-multiws-")));
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  mkdirSync(path.join(root, "start"));
  for (const [k, name] of [
    ["a", "alpha"],
    ["b", "beta"],
    ["c", "gamma"],
  ] as const) {
    const dir = path.join(root, name);
    mkdirSync(dir);
    // 同名文件在不同 directory 里内容不同：读相对路径就能分辨落在哪个 cwd
    writeFileSync(path.join(dir, "notes.txt"), `NOTES-${name.toUpperCase()}\n`);
    ws[k].dir = dir;
  }
  await boot();
  const p = await ok("POST", "/api/v1/providers", {
    name: "多目录 stub",
    slug: "multi-stub",
    api: "openai-completions",
    baseUrl: stub.url,
    apiKey: "k",
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        levels: [],
        input: ["text"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  await ok("PUT", "/api/v1/default-model", { provider: p.id, model: "m" });
  for (const [k, name] of [
    ["a", "主仓"],
    ["b", "附录"],
    ["c", "第三处"],
  ] as const)
    ws[k].id = (
      await ok("POST", "/api/v1/directories", { path: ws[k].dir, name })
    ).id;
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

const newSession = (ids: string[]) =>
  ok("POST", "/api/v1/sessions", { directoryIds: ids }) as Promise<{
    id: string;
  }>;

const systemOf = (body: Record<string, unknown>) =>
  JSON.stringify((body.messages as unknown[])[0]);
// 本次请求里按顺序出现的工具结果文本
const toolResults = (body: Record<string, unknown>) =>
  (body.messages as { role: string; content: unknown }[])
    .filter((m) => m.role === "tool")
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );

interface Turn {
  frames: Frame[];
  // 本轮里模型收到的所有请求体
  requests: Record<string, unknown>[];
  // 弹出过审批的工具名，按出现顺序
  approvals: string[];
}

// 发一条消息并等这一轮结束；遇到审批弹窗按 decide 作答
async function turn(
  sessionId: string,
  decide: (tool: string) => "allow" | "deny" = () => "allow",
): Promise<Turn> {
  const from = stub.requests.length;
  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${sessionId}/stream`,
  );
  const approvals: Turn["approvals"] = [];
  let answered = 0;
  try {
    expect((await client.command("send_message", { text: "go" })).ok).toBe(
      true,
    );
    await waitFor(
      () => {
        for (const f of client.frames.slice(answered)) {
          answered++;
          if (f.type === "prompt.requested" && f.data.source === "approval") {
            const tool = String(
              (f.data.detail as { tool?: unknown } | undefined)?.tool,
            );
            approvals.push(tool);
            const opts = f.data.options as { id: string }[];
            const pick = opts.find((o) => o.id === decide(tool)) ?? opts[0];
            void client.command("answer_prompt", {
              promptId: f.data.promptId,
              optionId: pick?.id,
            });
          }
        }
        return client.frames.some((f) => f.type === "run.ended");
      },
      "run.ended",
      30_000,
    );
    return {
      frames: client.frames,
      requests: stub.requests.slice(from).map((r) => r.body),
      approvals,
    };
  } finally {
    client.close();
  }
}

const directoriesOf = async (id: string) =>
  (await ok("GET", `/api/v1/sessions/${id}/directories`)).directories as {
    id: string;
    name: string;
    role: string;
    current: boolean;
  }[];

test("清单：第 1 个是 local，其余是 remote；当前是 local；重启后顺序与角色不变", async () => {
  const s = await newSession([ws.a.id, ws.b.id]);
  expect(await directoriesOf(s.id)).toEqual([
    expect.objectContaining({ id: ws.a.id, role: "local", current: true }),
    expect.objectContaining({ id: ws.b.id, role: "remote", current: false }),
  ]);
  await turn(s.id);
  await server.stop();
  await boot();
  const after = await directoriesOf(s.id);
  expect(after.map((w) => [w.id, w.role])).toEqual([
    [ws.a.id, "local"],
    [ws.b.id, "remote"],
  ]);
  // 重启后会话不在内存里，只能靠库里的清单拦住删除：remote 虽然不是当前所在的，也在用
  const del = await call("DELETE", `/api/v1/directories/${ws.b.id}`);
  expect(del.status).toBe(409);
});

test("创建时的清单要合法：directoryId 与第 1 个冲突、重复、不存在都被拒", async () => {
  const bad = async (body: unknown) =>
    (await call("POST", "/api/v1/sessions", body)).status;
  expect(await bad({ directoryId: ws.b.id, directoryIds: [ws.a.id] })).toBe(
    400,
  );
  expect(await bad({ directoryIds: [ws.a.id, ws.a.id] })).toBe(400);
  expect(await bad({ directoryIds: [ws.a.id, "nope"] })).toBe(400);
  expect(await bad({ directoryIds: [] })).toBe(400);
});

test.skip("提示词：多个 directory 时带「目录」一节，同一台主机的目录归在一起；单个时没有", async () => {
  const multi = await newSession([ws.a.id, ws.b.id]);
  plan = ["好的"];
  const t = await turn(multi.id);
  const sys = systemOf(t.requests[0] as Record<string, unknown>);
  // 接管后目录说明归到 environment 槽（cwd 段内），不再带 "## 目录" 标题
  expect(sys).toContain("主仓（local）");
  expect(sys).toContain("附录（remote）");
  // 图片引用约定：多 directory、单 directory 都要注入（归到 identity 槽即 preamble）
  expect(sys).toContain("file:<主机>:<绝对路径>");
  // 两个目录都在本机：「主机」只出现一次，两个目录挂在它下面
  expect(sys.match(/Host "local"/g)).toHaveLength(1);

  const single = await newSession([ws.a.id]);
  plan = ["好的"];
  const t2 = await turn(single.id);
  const singleSys = systemOf(t2.requests[0] as Record<string, unknown>);
  // 单 directory：没有目录清单说明，但渲染约定照旧
  expect(singleSys).not.toContain("This session has 2 directories");
  expect(singleSys).toContain("file:<主机>:<绝对路径>");
});

test("一次输出里依次：切换、读、切换、读——每次都落在调用那一刻的 directory", async () => {
  const s = await newSession([ws.a.id, ws.b.id]);
  plan = [
    {
      tools: [
        { tool: "switch_directory", args: { directory: "local:附录" } },
        { tool: "read", args: { path: "notes.txt" } },
        { tool: "switch_directory", args: { directory: "local:主仓" } },
        { tool: "read", args: { path: "notes.txt" } },
      ],
    },
    "读完了",
  ];
  const t = await turn(s.id);
  const results = toolResults(t.requests[1] as Record<string, unknown>);
  expect(results).toHaveLength(4);
  expect(results[0]).toContain("附录");
  expect(results[1]).toContain("NOTES-BETA");
  expect(results[2]).toContain("主仓");
  expect(results[3]).toContain("NOTES-ALPHA");
  // 序列跑完停在最后切到的 directory
  expect((await directoriesOf(s.id)).find((w) => w.current)?.id).toBe(ws.a.id);
});

test("权限按目标地址归属的目录判：跨目录读不再需要切换，登记目录之外的路径仍要审批", async () => {
  const s = await newSession([ws.a.id, ws.b.id]);
  const target = path.join(ws.a.dir, "notes.txt");
  // 路径里带主机名：拒绝并把主机放进 host 的写法告诉模型，不弹审批
  plan = [
    { tools: [{ tool: "read", args: { path: `local:${target}` } }] },
    "好",
  ];
  const bare = await turn(s.id);
  expect(bare.approvals).toEqual([]);
  expect(
    toolResults(bare.requests[1] as Record<string, unknown>).at(-1) ?? "",
  ).toContain("starts with a host name");
  expect(
    toolResults(bare.requests[1] as Record<string, unknown>).at(-1) ?? "",
  ).toContain('host="local"');

  // host 分开写、落在已登记目录（alpha）内：即使当前目录是 beta，也直接放行
  plan = [
    {
      tools: [
        { tool: "switch_directory", args: { directory: "local:附录" } },
        { tool: "read", args: { host: "local", path: target } },
      ],
    },
    "好",
  ];
  const across = await turn(s.id, (tool) =>
    tool === "switch_directory" ? "allow" : "deny",
  );
  expect(across.approvals).toEqual(["switch_directory"]);
  expect(
    toolResults(across.requests[1] as Record<string, unknown>).at(-1) ?? "",
  ).toContain("NOTES-ALPHA");
});

test("登记目录之外的路径：按归属目录（这里退回当前目录）判为目录外，要审批", async () => {
  const s = await newSession([ws.a.id, ws.b.id]);
  const outside = path.join(root, "实在没有登记过的目录", "x.txt");
  plan = [
    {
      tools: [
        { tool: "switch_directory", args: { directory: "local:附录" } },
        { tool: "read", args: { host: "local", path: outside } },
      ],
    },
    "好",
  ];
  const r = await turn(s.id, (tool) =>
    tool === "switch_directory" ? "allow" : "deny",
  );
  expect(r.approvals).toEqual(["switch_directory", "read"]);
  expect(
    toolResults(r.requests[1] as Record<string, unknown>).at(-1) ?? "",
  ).not.toContain("NOTES-ALPHA");
});

// 会话的 directory 清单属于它所在的工作区：改清单走工作区路由（第 1 个是主目录，不可改）。
test("改清单：新增 remote 后下一轮开头收到通知；移除所在的 directory 退回 local 并通知", async () => {
  // 用独立的工作区与目录，改清单会连带清理没人引用的目录，不碰共用 fixture。
  const fresh = (name: string) => {
    const d = path.join(root, name);
    mkdirSync(d);
    return d;
  };
  const home = fresh("改清单-主");
  const apart = fresh("改清单-附");
  const third = fresh("改清单-三");
  // 目录名在同一主机上唯一（另一个工作区已经占了「附录」），这里换个名字。
  const space = await ok("POST", "/api/v1/workspaces", {
    directories: [{ path: home }, { path: apart, name: "改清单-附" }],
  });
  const s = (await ok("POST", "/api/v1/sessions", {
    workspaceId: space.id,
  })) as { id: string };
  plan = [
    {
      tools: [
        { tool: "switch_directory", args: { directory: "local:改清单-附" } },
      ],
    },
    "好",
  ];
  await turn(s.id);
  const put = (dirs: string[]) =>
    call("PUT", `/api/v1/workspaces/${space.id}/directories`, {
      directories: dirs.map((dir) => ({ path: dir })),
    });

  // 新增第三处
  expect((await put([home, apart, third])).status).toBe(200);
  plan = ["好"];
  const added = await turn(s.id);
  const addedText = JSON.stringify(
    (added.requests[0] as { messages: unknown[] }).messages,
  );
  expect(addedText).toContain("The directories of this session have changed");
  expect(addedText).toContain("改清单-三");

  // 移除所在的「改清单-附」：退回 local
  expect((await put([home, third])).status).toBe(200);
  expect((await directoriesOf(s.id)).find((w) => w.current)?.name).toBe(
    "改清单-主",
  );
  plan = ["好"];
  const removed = await turn(s.id);
  const removedText = JSON.stringify(
    (removed.requests[0] as { messages: unknown[] }).messages,
  );
  expect(removedText).toContain("The directory you were in has been removed");
});

test("清单里的 directory 不能被删，即使它不是当前所在的", async () => {
  // 清单属于工作区：独立建一个挂着两个目录的工作区，删掉那个没被用作当前目录的。
  const home = path.join(root, "删保护-主");
  const apart = path.join(root, "删保护-附");
  for (const d of [home, apart]) mkdirSync(d);
  await ok("POST", "/api/v1/workspaces", {
    directories: [{ path: home }, { path: apart }],
  });
  const apartId = (await ok("GET", "/api/v1/directories")).directories.find(
    (d: { path: string; id: string }) => d.path === apart,
  ).id as string;
  const r = await call("DELETE", `/api/v1/directories/${apartId}`);
  expect(r.status).toBe(409);
  expect(r.body.error).toBe("directory_in_use");
});

test("子代理只能拿到父会话清单里的 directory", async () => {
  const s = await newSession([ws.a.id, ws.b.id]);
  // 另建一个从未被这个工作区引用的目录：前面的用例会往工作区里加目录，不能拿 ws.c 当「不在范围内」
  const dir = path.join(root, "delta");
  mkdirSync(dir);
  await ok("POST", "/api/v1/directories", { path: dir, name: "范围外" });
  plan = [
    {
      tools: [
        {
          tool: "spawn_subagent",
          args: { task: "看一眼", directory: "local:范围外" },
        },
      ],
    },
    "好",
  ];
  const t = await turn(s.id);
  const res = toolResults(t.requests[1] as Record<string, unknown>).join("\n");
  // 子代理的目录解析走父会话的地址簿：报错里列的是父自己的目录清单
  expect(res).toContain('Directory "local:范围外" not found.');
  expect(res).toContain("local:主仓");
});

test("没有工作区的旧行：读作只有当前这一个，同时是 local", async () => {
  const s = await newSession([ws.a.id, ws.b.id]);
  await turn(s.id);
  await server.stop();
  // 旧库里的行没有被绑定过工作区：直接把 workspace_id 清空模拟
  const db = new Database(path.join(root, "data", DB_FILE));
  db.prepare("UPDATE sessions SET workspace_id = NULL WHERE id = ?").run(s.id);
  db.close();
  await boot();
  expect(await directoriesOf(s.id)).toEqual([
    expect.objectContaining({ id: ws.a.id, role: "local", current: true }),
  ]);
});

test("默认值：目录起点与图片压缩缺省值可改、非法被拒；~ 展开为家目录", async () => {
  expect(await ok("GET", "/api/v1/defaults")).toEqual({
    directoryStart: "~",
    imageCompression: {
      enabled: true,
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 4.5 * 1024 * 1024,
      jpegQuality: 80,
    },
    permissionTier: "rules",
    reviewModel: null,
    auxModel: null,
    jobRemindSeconds: 600,
    goalMaxRounds: 50,
    subagentLimits: { maxDepth: 3, perCaller: 10, perTree: 50 },
    canvasMedia: {
      thumbMaxSide: 2000,
      thumbQuality: 85,
      gifMaxMB: 8,
      sourceMaxMB: 20,
      assetGitMaxMB: 5,
      uploadMaxMB: 500,
    },
    browserMirror: "",
  });
  expect(
    (await ok("PUT", "/api/v1/defaults", { directoryStart: " /srv " }))
      .directoryStart,
  ).toBe("/srv");
  expect((await ok("GET", "/api/v1/defaults")).directoryStart).toBe("/srv");
  for (const v of ["", "  ", 5, "a\0b", "x".repeat(4097)])
    expect(
      (await call("PUT", "/api/v1/defaults", { directoryStart: v })).status,
    ).toBe(400);
  const badCompression = [
    { enabled: "yes" },
    {
      enabled: true,
      maxWidth: 1,
      maxHeight: 2000,
      maxBytes: 4718592,
      jpegQuality: 80,
    },
    { enabled: true, maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592 },
  ];
  for (const imageCompression of badCompression)
    expect(
      (await call("PUT", "/api/v1/defaults", { imageCompression })).status,
    ).toBe(400);
  // 图片压缩独立保存，改起点不影响它
  const compression = {
    enabled: false,
    maxWidth: 800,
    maxHeight: 600,
    maxBytes: 1024 * 1024,
    jpegQuality: 70,
  };
  expect(
    (await ok("PUT", "/api/v1/defaults", { imageCompression: compression }))
      .imageCompression,
  ).toEqual(compression);
  expect((await ok("GET", "/api/v1/defaults")).imageCompression).toEqual(
    compression,
  );
  await ok("PUT", "/api/v1/defaults", {
    directoryStart: "~",
    imageCompression: {
      enabled: true,
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 4.5 * 1024 * 1024,
      jpegQuality: 80,
    },
  });

  const home = realpathSync(os.homedir());
  expect((await ok("GET", "/api/v1/fs/dirs?path=~")).path).toBe(home);
  const files = await ok("GET", "/api/v1/environments/local/files/list?path=~");
  expect(files.path).toBe(home);
});
