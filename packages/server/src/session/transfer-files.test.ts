import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type Frame, waitFor } from "../../test/support/frames.js";
import { type StubReply, startStub } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";
import { createSessionFactory } from "./factory.js";

// transfer_files 端到端：真实服务 + 真实会话工厂 + 假模型端点。
// 同一台本机上的两个目录登记成两个 directory（A、B），模型在参数里直接写两端的 directory。
let script: StubReply[] = [];
const stub = await startStub((n) => script[n - 1] ?? "done");

let root = "";
let server: YuanshuServer;
let http = "";
const a = { id: "", name: "ws-a", dir: "" };
const b = { id: "", name: "ws-b", dir: "" };
let out = "";

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
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-xfer-")));
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  mkdirSync(path.join(root, "start"));
  for (const d of ["a", "b", "out"]) mkdirSync(path.join(root, d));
  a.dir = path.join(root, "a");
  b.dir = path.join(root, "b");
  out = path.join(root, "out");
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
  const model = await call("POST", "/api/v1/models", {
    name: "stub",
    api: "openai-completions",
    baseUrl: stub.url,
    modelId: "stub-model",
    reasoning: false,
    apiKey: "stub-key",
  });
  await call("PATCH", `/api/v1/models/${model.id}`, { isDefault: true });
  // 默认 rules 档：cwd 内放行、cwd 外审批
  a.id = (
    await call("POST", "/api/v1/directories", { name: a.name, path: a.dir })
  ).id;
  b.id = (
    await call("POST", "/api/v1/directories", { name: b.name, path: b.dir })
  ).id;
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await stub.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个用例从干净的目录开始
  for (const d of [a.dir, b.dir, out]) {
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d);
  }
});

const transfer = (args: Record<string, unknown>): StubReply => ({
  tool: "transfer_files",
  args,
});
// 两端都是 path + 可选的 host：相对路径相对会话当前目录，绝对路径配 host="local"
// （两个目录都在本机主目录所在主机上）。
const side = (p: string) =>
  p.startsWith("/") ? { host: "local", path: p } : { path: p };
const between = (x: { from: string; to: string; overwrite?: boolean }) => ({
  from: side(x.from).path,
  ...(side(x.from).host ? { from_host: "local" } : {}),
  to: side(x.to).path,
  ...(side(x.to).host ? { to_host: "local" } : {}),
  ...(x.overwrite === true ? { overwrite: true } : {}),
});

// 开一个会话（起始在 directory A）、发一条消息；按 answers 依次回答审批弹窗，答完没有的一律拒绝。
async function run(replies: StubReply[], answers: string[] = []) {
  script = replies;
  stub.requests.length = 0; // 脚本按本轮请求序号取
  // 两端都要挂在会话上：传输只能在本会话的 directory 之间进行
  const session = await call("POST", "/api/v1/sessions", {
    directoryIds: [a.id, b.id],
  });
  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
  );
  try {
    expect((await client.command("send_message", { text: "go" })).ok).toBe(
      true,
    );
    let answered = 0;
    await waitFor(
      () => {
        const ps = client.frames.filter((f) => f.type === "prompt.requested");
        for (; answered < ps.length; answered++)
          void client.command("answer_prompt", {
            promptId: (ps[answered] as Frame).data.promptId,
            optionId: answers[answered] ?? "deny",
          });
        return client.frames.some((f) => f.type === "run.ended");
      },
      "run.ended",
      30_000,
    );
    const prompts = client.frames
      .filter((f) => f.type === "prompt.requested")
      .map((f) => f.data);
    // 最后一次发给模型的请求里带着所有工具结果
    const messages = (stub.requests.at(-1)?.body.messages ?? []) as {
      role: string;
      content: unknown;
    }[];
    const results = messages
      .filter((m) => m.role === "tool")
      .map((m) => JSON.stringify(m.content));
    const { entries } = await call(
      "GET",
      `/api/v1/audit?session=${session.id}&limit=200`,
    );
    return { id: session.id as string, prompts, results, audit: entries };
  } finally {
    client.close();
  }
}

type AuditEntry = {
  kind: string;
  actor: string;
  sessionId: string;
  summary: string;
  detail: Record<string, unknown>;
};
const transferAudit = (audit: AuditEntry[]) =>
  audit.filter((e) => e.kind === "transfer");

test("工具对默认 agent 可用", async () => {
  await run([]);
  const names = (
    (stub.requests[0]?.body.tools ?? []) as { function: { name: string } }[]
  ).map((t) => t.function.name);
  expect(names).toContain("transfer_files");
});

test("传单个文件：两端都在各自 cwd 内，不弹审批，结果带文件数与字节数，并记审计（agent、会话 id）", async () => {
  writeFileSync(path.join(a.dir, "a.txt"), "hello");
  const r = await run([transfer(between({ from: "a.txt", to: "copied.txt" }))]);
  // 目标相对当前目录（A），所以复制到 A 里
  expect(readFileSync(path.join(a.dir, "copied.txt"), "utf8")).toBe("hello");
  expect(r.prompts).toEqual([]);
  expect(r.results[0]).toContain(
    "Transferred 1 file(s), 5 bytes, skipped 0 symlink(s)",
  );
  expect(r.results[0]).toContain(`local:${path.join(a.dir, "a.txt")}`);
  expect(transferAudit(r.audit)).toMatchObject([
    {
      actor: "agent",
      sessionId: r.id,
      summary: `transfer ok: local:${path.join(a.dir, "a.txt")} -> local:${path.join(a.dir, "copied.txt")}`,
      detail: { op: "transfer", result: "ok", files: 1, bytes: 5 },
    },
  ]);
});

test("传目录：整棵树过去，符号链接不跟随只计数", async () => {
  mkdirSync(path.join(a.dir, "d/sub"), { recursive: true });
  writeFileSync(path.join(a.dir, "d/x.txt"), "xx");
  writeFileSync(path.join(a.dir, "d/sub/y.txt"), "yyy");
  symlinkSync(out, path.join(a.dir, "d/link"));
  const r = await run([transfer(between({ from: "d", to: "copy" }))]);
  expect(readFileSync(path.join(a.dir, "copy/x.txt"), "utf8")).toBe("xx");
  expect(readFileSync(path.join(a.dir, "copy/sub/y.txt"), "utf8")).toBe("yyy");
  expect(existsSync(path.join(a.dir, "copy/link"))).toBe(false);
  expect(r.prompts).toEqual([]);
  expect(r.results[0]).toContain(
    "Transferred 2 file(s), 5 bytes, skipped 1 symlink(s)",
  );
});

test("两端都写相对路径：都相对当前目录（同一目录内复制）", async () => {
  writeFileSync(path.join(a.dir, "a.txt"), "same");
  const r = await run([transfer({ from: "a.txt", to: "a2.txt" })]);
  expect(readFileSync(path.join(a.dir, "a2.txt"), "utf8")).toBe("same");
  expect(r.prompts).toEqual([]);
});

test("跨目录：host + 绝对路径直接寻址，不必切换目录", async () => {
  writeFileSync(path.join(a.dir, "a.txt"), "cross");
  const r = await run([
    transfer(between({ from: "a.txt", to: path.join(b.dir, "cross.txt") })),
  ]);
  expect(readFileSync(path.join(b.dir, "cross.txt"), "utf8")).toBe("cross");
  expect(r.prompts).toEqual([]);
});

test("路径里带主机名：拒绝并把主机放进 host 的写法告诉模型", async () => {
  writeFileSync(path.join(a.dir, "a.txt"), "x");
  const r = await run([
    transfer({ from: "a.txt", to: `local:${path.join(b.dir, "n.txt")}` }),
  ]);
  expect(r.results[0]).toContain("starts with a host name");
  expect(r.results[0]).toContain("Put the host in the host parameter");
  expect(existsSync(path.join(b.dir, "n.txt"))).toBe(false);
});

test("不带 overwrite：目标已存在被拒，原文件不动、错误原样给模型，审计记 conflict", async () => {
  writeFileSync(path.join(a.dir, "a.txt"), "new");
  writeFileSync(path.join(b.dir, "b.txt"), "old");
  const r = await run([
    transfer(between({ from: "a.txt", to: path.join(b.dir, "b.txt") })),
  ]);
  expect(readFileSync(path.join(b.dir, "b.txt"), "utf8")).toBe("old");
  expect(r.results[0]).toContain(
    `目标已存在 1 个文件：${path.join(b.dir, "b.txt")}`,
  );
  expect(transferAudit(r.audit)).toMatchObject([
    {
      summary: expect.stringContaining("transfer conflict:"),
      detail: { result: "error", outcome: "conflict" },
    },
  ]);
});

test("overwrite=true：覆盖成功", async () => {
  writeFileSync(path.join(a.dir, "a.txt"), "new");
  writeFileSync(path.join(b.dir, "b.txt"), "old");
  const r = await run([
    transfer(
      between({
        from: "a.txt",
        to: path.join(b.dir, "b.txt"),
        overwrite: true,
      }),
    ),
  ]);
  expect(readFileSync(path.join(b.dir, "b.txt"), "utf8")).toBe("new");
  expect(r.results[0]).toContain("Transferred 1 file(s)");
});

test("源不存在：报错给模型，审计记 src_missing", async () => {
  const r = await run([
    transfer(between({ from: "nope.txt", to: path.join(b.dir, "x.txt") })),
  ]);
  expect(r.results[0]).toContain(`源不存在：${path.join(a.dir, "nope.txt")}`);
  expect(existsSync(path.join(b.dir, "x.txt"))).toBe(false);
  expect(transferAudit(r.audit)).toMatchObject([
    { detail: { outcome: "src_missing" } },
  ]);
});

test("未知主机：报错并列出本会话的主机，不算一次传输", async () => {
  const bad = await run([
    transfer({ from: "a.txt", to_host: "ghost", to: "/x" }),
  ]);
  expect(bad.results[0]).toContain("Unknown host");
  expect(bad.results[0]).toContain("Hosts in this session: local");
  expect(transferAudit(bad.audit)).toEqual([]);
});

test("规则档：目标在目标 directory 的 cwd 之外 → 弹一个审批，批准后写入；在内不弹", async () => {
  writeFileSync(path.join(a.dir, "a.txt"), "hello");
  const target = path.join(out, "o.txt");
  const r = await run(
    [transfer(between({ from: "a.txt", to: target }))],
    ["allow"],
  );
  expect(r.prompts).toHaveLength(1);
  expect(r.prompts[0]).toMatchObject({
    source: "approval",
    title: "允许执行 transfer_files？",
  });
  // 摘要写清「从 A 的某路径 到 B 的某路径」，且只有目标端需要审批
  expect(r.prompts[0]?.body).toContain(
    `from local:${path.join(a.dir, "a.txt")} to local:${target}`,
  );
  expect(r.prompts[0]?.body).toContain("Destination needs approval");
  expect(r.prompts[0]?.body).not.toContain("Source needs approval");
  expect(readFileSync(target, "utf8")).toBe("hello");
  expect(
    r.audit.filter((e: AuditEntry) => e.kind === "permission"),
  ).toMatchObject([
    { summary: expect.stringContaining("allow transfer_files:") },
  ]);

  // 同样的内容放进目标 directory 的 cwd 内：不弹
  const inside = await run([
    transfer(between({ from: "a.txt", to: path.join(b.dir, "in.txt") })),
  ]);
  expect(inside.prompts).toEqual([]);
  expect(readFileSync(path.join(b.dir, "in.txt"), "utf8")).toBe("hello");
});

test("规则档：拒绝审批则不写入；源端在源 directory 的 cwd 之外同样弹审批（各端用各自的 cwd）", async () => {
  // 源在 OUT（不属于任何登记目录，按当前目录 A 归属 → cwd 外），目标在 A 的 cwd 内
  writeFileSync(path.join(out, "in-out.txt"), "from-out");
  const r = await run(
    [transfer(between({ from: path.join(out, "in-out.txt"), to: "x.txt" }))],
    ["deny"],
  );
  expect(r.prompts).toHaveLength(1);
  expect(r.prompts[0]?.body).toContain("Source needs approval");
  expect(r.prompts[0]?.body).not.toContain("Destination needs approval");
  expect(existsSync(path.join(a.dir, "x.txt"))).toBe(false);
  expect(r.results[0]).toContain("用户拒绝了该操作");
});

test("两端都在 cwd 外：仍只弹一个审批；记住后记到归属目录（不属于任何登记目录 → 当前目录），再传不再弹", async () => {
  writeFileSync(path.join(out, "src.txt"), "data");
  const dstDir = path.join(out, "dst");
  mkdirSync(dstDir);
  const args = between({
    from: path.join(out, "src.txt"),
    to: path.join(dstDir, "t.txt"),
  });
  const first = await run([transfer(args)], ["remember"]);
  expect(first.prompts).toHaveLength(1);
  expect(first.prompts[0]?.body).toContain("Source needs approval");
  expect(first.prompts[0]?.body).toContain("Destination needs approval");
  expect(readFileSync(path.join(dstDir, "t.txt"), "utf8")).toBe("data");

  const rules = async (id: string) =>
    (await call("GET", `/api/v1/directories/${id}/rules`)).rules ?? [];
  const ruleList = async (id: string) =>
    (await rules(id)).map((r: { access: string; value: string }) => [
      r.access,
      r.value,
    ]);
  // 两端都不在任何登记目录内，都按当前目录 A 归属：读、写两条规则都记在 A（顺序不定）
  expect((await ruleList(a.id)).sort()).toEqual(
    [
      ["read", out],
      ["write", dstDir],
    ].sort(),
  );
  expect(await ruleList(b.id)).toEqual([]);

  const second = await run([transfer({ ...args, overwrite: true })]);
  expect(second.prompts).toEqual([]);
  expect(second.results[0]).toContain("Transferred 1 file(s)");
});

test("档位是会话的、读全局默认：完全允许时写到 cwd 外不弹，改回规则档下一次调用就要审批", async () => {
  writeFileSync(path.join(a.dir, "a.txt"), "hello");
  writeFileSync(path.join(out, "o.txt"), "from-out");
  const setTier = (permissionTier: string) =>
    call("PUT", "/api/v1/defaults", { permissionTier });
  try {
    await setTier("full");
    const w = await run([
      transfer(between({ from: "a.txt", to: path.join(out, "w.txt") })),
    ]);
    expect(w.prompts).toEqual([]);
    expect(readFileSync(path.join(out, "w.txt"), "utf8")).toBe("hello");

    await setTier("rules");
    const r = await run(
      [transfer(between({ from: "a.txt", to: path.join(out, "r.txt") }))],
      ["deny"],
    );
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]?.body).toContain("Destination needs approval");
    expect(r.prompts[0]?.body).not.toContain("Source needs approval");
    expect(existsSync(path.join(out, "r.txt"))).toBe(false);
  } finally {
    await setTier("rules");
  }
});
