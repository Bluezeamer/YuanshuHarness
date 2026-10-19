import "./isolate.js";
// 验证 SDK tool_call 阻断行为：阻断时工具不执行，模型收到 isError=true 的结果，会话继续。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { SessionPool } from "../../src/session/pool.js";
import { openDatabase } from "../../src/store/db.js";
import { RuleStore } from "../../src/store/rules.js";
import { SessionStore } from "../../src/store/sessions.js";
import { WorkspaceStore } from "../../src/store/workspaces.js";
import { collector, waitFor } from "../support/frames.js";
import { startStub, stubSessionFactory } from "../support/stub.js";

// 模型调用 bash、read、write，拦截根据阻断表决定。
const CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: "bash", args: { command: "echo allow" } },
  { tool: "read", args: { path: "allow.txt" } },
  { tool: "write", args: { path: "blocked.txt", content: "x" } },
  {
    tool: "edit",
    args: { path: "e.txt", edits: [{ oldText: "a", newText: "b" }] },
  },
];
// SDK 1.3.0 默认只启用 bash/read/write/edit（grep/find/ls 需显式开启，其 schema 的可选 `path` 字段已核对）。
// 各内置工具的目标路径字段（权限拦截依赖它们）。
const PATH_FIELD = ["command", "path", "path", "path"];
// 按已有工具结果条数依次发起下一个调用，用完后收尾。
const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as Array<{ role: string }>;
  return CALLS[msgs.filter((m) => m.role === "tool").length] ?? "done";
});
afterAll(() => stub.close());

let base: string;
const blocks = new Map<string, boolean>();
const seen: string[] = [];
const inputs: Array<Record<string, unknown>> = [];
// 扩展工厂：tool_call 时按表决定 block，记录调用序列。
const blockingExt: ExtensionFactory = (pi) => {
  pi.on("tool_call", (e) => {
    seen.push(e.toolName);
    inputs.push({ ...e.input });
    if (blocks.get(e.toolName))
      return { block: true, reason: `工具 ${e.toolName} 被拒绝` };
  });
};

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-block-"));
  blocks.clear();
  seen.length = 0;
  inputs.length = 0;
  stub.requests.length = 0;
  await mkdir(path.join(base, "web"));
  await writeFile(path.join(base, "web", "index.html"), "<title>x</title>");
  await writeFile(path.join(base, "allow.txt"), "允许读的内容");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("SDK tool_call 阻断契约", () => {
  test("阻断时工具不执行且模型收到 isError=true 的结果，运行继续", async () => {
    const dir = path.join(base, "data");
    await mkdir(dir);
    const db = openDatabase(dir);
    const store = new SessionStore(db);
    const workspaces = new WorkspaceStore(db);
    workspaces.ensureDefault(base);
    const inner = stubSessionFactory(stub, {}, true);
    const pool = new SessionPool({
      factory: (o) => inner({ ...o, extensions: [blockingExt] }),
      store,
      workspaces,
      rules: new RuleStore(db),
      sessionDir: path.join(dir, "sessions"),
    });
    const id = (await pool.create()).id;
    const entry = pool.get(id);
    if (!entry) throw new Error("no entry");
    // bash 放行、read 放行、write 阻断。
    blocks.set("bash", false);
    blocks.set("read", false);
    blocks.set("write", true);
    blocks.set("edit", false);
    const c = collector();
    entry.subscribe(c);
    entry.send("开始");
    await waitFor(() => c.types().includes("run.ended"), "run.ended", 8000);
    expect(seen).toEqual(CALLS.map((c) => c.tool));
    // 每个内置工具的输入字段名与契约一致。
    for (const [i, f] of PATH_FIELD.entries())
      expect(inputs[i], CALLS[i]?.tool).toHaveProperty(f);
    // write 阻断后模型下一次请求应当能看到前两个工具结果加一个 error 结果。
    const lastBody = stub.requests[3]?.body as {
      messages: Array<{
        role: string;
        content?: string | Array<{ type: string; text?: string }>;
      }>;
    };
    const tools = lastBody.messages.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(3);
    const write = tools[2];
    const text = Array.isArray(write?.content)
      ? write.content.find((c) => c.type === "text")?.text
      : write?.content;
    expect(text).toContain("被拒绝");
    pool.dispose();
    db.close();
  });
});
