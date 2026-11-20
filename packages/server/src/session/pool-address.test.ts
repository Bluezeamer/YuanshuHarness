// 池给的地址簿与目录工具接线：switch_directory 只认 `<host>:<name>`，解析全走地址簿；
// 清单变化的通知用引用写法；<cwd> 段在主目录上、切换后不变。
// 真实会话池 + 真实会话工厂 + OpenAI 兼容 stub；ssh 主机只登记、不真连。
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  type StubReply,
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
  testPresets,
} from "../../test/support/stub.js";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { EnvHub } from "../env/hub.js";
import { EnvironmentStore } from "../store/environments.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { AttachmentDirectories } from "./attachments.js";
import type { SessionPool } from "./pool.js";

let plan: StubReply[] = [];
const stub = await startStub(() => plan.shift() ?? "好");
afterAll(() => stub.close());

let base = "";
let pool: SessionPool | undefined;
let data: TestData | undefined;

afterEach(() => {
  pool?.dispose();
  pool = undefined;
  data?.close();
  data = undefined;
  stub.requests.length = 0;
  plan = [];
});

interface Fixture {
  pool: SessionPool;
  local: { id: string; name: string; path: string };
  docs: { id: string; name: string; path: string };
  train: { id: string; name: string; path: string };
  attachments: AttachmentDirectories;
  data: TestData;
}

// 「主目录在本机 + 一台 ssh 主机 + 附件区」的最小世界。
function boot(): Fixture {
  base = makeTmpDir("yuanshu-pool-address-");
  const d = testData(path.join(base, "data"));
  const environments = new EnvironmentStore(d.db);
  const hub = new EnvHub(
    environments,
    new SecretStore(d.db, loadMasterKey(d.dir)),
  );
  const presets = testPresets(d);
  const dir = (name: string) => {
    const p = path.join(base as string, name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const local = d.directories.create("proj", dir("proj"));
  const docs = d.directories.create("docs", dir("docs"));
  const env = environments.create({
    name: "dev1",
    host: "10.0.0.9",
    port: 22,
    username: "dev",
    os: "posix",
    secretId: null,
  });
  if (!local || !docs || !env) throw new Error("夹具没建成");
  const train = d.directories.create(
    "train",
    "/data/train",
    new Date(),
    env.id,
  );
  if (!train) throw new Error("远程目录没建成");
  const attachments = new AttachmentDirectories(
    d.directories,
    d.dir,
    (sessionId) => p?.workspaceIdOf(sessionId) ?? sessionId,
  );
  let p: SessionPool | undefined;
  const t = testPool(stubSessionFactory(stub), d, {
    presetView: presets.view,
    envHub: hub,
    environments,
    attachments,
  });
  p = t.pool;
  pool = t.pool;
  data = d;
  return { pool: t.pool, local, docs, train, attachments, data: d };
}

const lastBody = () => {
  const last = stub.requests.at(-1);
  if (!last) throw new Error("桩没收到请求");
  return (last.body as { messages: unknown[] }).messages;
};

const toolResults = () =>
  (lastBody() as { role: string; content: unknown }[])
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));

async function turn(id: string): Promise<void> {
  const e = pool?.get(id);
  if (!e) throw new Error("会话不在池里");
  const c = collector();
  e.subscribe(c);
  e.send("go");
  // switch_directory 默认要审批：一律答「仅此次通过」
  let answered = 0;
  await waitFor(
    () => {
      const prompts = c.frames.filter((f) => f.type === "prompt.requested");
      for (; answered < prompts.length; answered++) {
        const f = prompts[answered] as unknown as {
          data: { promptId: string; options?: { id: string }[] };
        };
        e.answerPrompt(f.data.promptId, {
          optionId: f.data.options?.[0]?.id,
        });
      }
      return c.types().includes("run.ended");
    },
    "run.ended",
    30_000,
  );
}

test("addressBookOf：目录与环境每次现取；refOf、directory、主机名都是会话那一份", async () => {
  const w = boot();
  const s = await w.pool.create({
    directoryIds: [w.local.id, w.docs.id, w.train.id],
  });
  const book = w.pool.addressBookOf(s.id);
  expect(book.hosts().map((h) => h.label)).toEqual(["local", "dev1"]);
  expect(book.refOf(w.local as never)).toBe("local:proj");
  expect(book.refOf(w.train as never)).toBe("dev1:train");
  expect(book.directory("dev1:train").id).toBe(w.train.id);
  expect(book.directory("LOCAL:docs").id).toBe(w.docs.id);
  // 每次现造：两个实例互不共享状态，但看到的是同一份清单
  expect(w.pool.addressBookOf(s.id)).not.toBe(book);
});

test("switch_directory 只认 <host>:<name>：裸名字、未知主机、未知目录、附件区都被拒", async () => {
  const w = boot();
  const s = await w.pool.create({
    directoryIds: [w.local.id, w.docs.id, w.train.id],
  });
  await w.attachments.ensure(s.id);

  plan = [
    {
      tools: [
        { tool: "switch_directory", args: { directory: "docs" } },
        { tool: "switch_directory", args: { directory: w.docs.id } },
        { tool: "switch_directory", args: { directory: "x:proj" } },
        { tool: "switch_directory", args: { directory: "local:nope" } },
        { tool: "switch_directory", args: { directory: "attachment:x" } },
        { tool: "switch_directory", args: { directory: "attachment" } },
      ],
    },
    "好",
  ];
  await turn(s.id);
  const results = toolResults();
  expect(results).toHaveLength(6);
  // 裸名字与 id 都按「要写 <host>:<name>」拒，并列出这台会话的目录
  for (const r of results.slice(0, 2)) {
    expect(r).toContain("A directory is written <host>:<name>");
    expect(r).toContain("local:proj, local:docs, dev1:train");
  }
  expect(results[2]).toContain('Unknown host "x"');
  expect(results[3]).toContain('Directory "local:nope" not found.');
  // 附件区不是目录：地址簿统一拒
  expect(results[4]).toContain("The attachment host is not a directory.");
  expect(results[5]).toContain("A directory is written <host>:<name>");

  // 当前目录没变，也没有切换通知
  plan = ["还在原处"];
  await turn(s.id);
  expect(JSON.stringify(lastBody())).not.toContain("current directory is now");
});

test("switch_directory 成功：结果与尾部通知都写引用；<cwd> 仍是主目录，不随切换变", async () => {
  const w = boot();
  const s = await w.pool.create({
    directoryIds: [w.local.id, w.docs.id, w.train.id],
  });
  plan = [
    { tool: "switch_directory", args: { directory: "dev1:train" } },
    "好",
  ];
  await turn(s.id);
  expect(toolResults()[0]).toBe(
    `Switched to dev1:train (/data/train). Relative paths and bash run there from now on, on host dev1.`,
  );

  plan = ["好"];
  await turn(s.id);
  const body = JSON.stringify(lastBody());
  expect(body).toContain(
    "The current directory is now dev1:train (/data/train, host dev1). Relative paths and bash run there from now on; the host parameter can still name any host.",
  );
  // <cwd> 只写主目录：切换后也不变，免得反复触发状态通知
  expect(body).toContain(
    `<cwd>\\nThe session starts in its main directory local:proj (${w.local.path}). The current directory starts there; relative paths and bash use the current directory.\\n</cwd>`,
  );
  expect(pool?.info(s.id)?.directoryId).toBe(w.train.id);
});

test("清单变化的通知用引用写法：Added / Removed 都是 <host>:<name>", async () => {
  const w = boot();
  const s = await w.pool.create({ directoryIds: [w.local.id, w.docs.id] });
  plan = ["好"];
  await turn(s.id);
  const wsId = w.pool.workspaceIdOf(s.id) as string;
  const third = path.join(base, "third");
  mkdirSync(third, { recursive: true });
  const added = w.data.directories.create("third", third);
  if (!added) throw new Error("第三处没建成");

  await w.pool.setWorkspaceDirectories(wsId, [w.local.id, w.docs.id, added.id]);
  plan = ["好"];
  await turn(s.id);
  expect(JSON.stringify(lastBody())).toContain(
    `Added: local:third (${third}).`,
  );

  await w.pool.setWorkspaceDirectories(wsId, [w.local.id, added.id]);
  plan = ["好"];
  await turn(s.id);
  const body = JSON.stringify(lastBody());
  expect(body).toContain("Removed: local:docs.");
  expect(body).toContain("The current directory is still local:proj.");
});

test("bash 的 host：只收 <host>:<name>，在目标目录里跑；裸主机、未知目录、附件区与文件地址都被拒（原文来自地址簿）", async () => {
  const w = boot();
  const s = await w.pool.create({
    directoryIds: [w.local.id, w.docs.id, w.train.id],
  });
  await w.attachments.ensure(s.id);
  plan = [
    {
      tools: [
        { tool: "bash", args: { host: "local:docs", command: "pwd" } },
        { tool: "bash", args: { host: "dev1", command: "pwd" } },
        { tool: "bash", args: { host: "local:nope", command: "pwd" } },
        { tool: "bash", args: { host: "attachment:2026", command: "pwd" } },
        { tool: "bash", args: { host: "local:docs/x", command: "pwd" } },
        { tool: "bash", args: { host: "dev1:/x", command: "pwd" } },
        { tool: "bash", args: { command: "pwd" } },
      ],
    },
    "好",
  ];
  await turn(s.id);
  const results = toolResults();
  expect(results).toHaveLength(7);
  expect(results[0]).toContain(w.docs.path);
  // 裸主机：目录要写成 <host>:<name>
  expect(results[1]).toContain("A directory is written <host>:<name>");
  expect(results[2]).toContain('Directory "local:nope" not found.');
  // 附件区不是目录（它的目录行确实在清单里，报的是「不是目录」）
  expect(results[3]).toContain("The attachment host is not a directory.");
  // 写成文件地址（主机名后面直接跟路径）：目录名里带了斜杠，按「找不到这个目录」拒
  expect(results[4]).toContain('Directory "local:docs/x" not found.');
  expect(results[5]).toContain('Directory "dev1:/x" not found.');
  // 不给 host：仍在当前目录
  expect(results[6]).toContain(w.local.path);
  // 当前目录没变
  expect(pool?.info(s.id)?.directoryId).toBe(w.local.id);
});

test("所在的目录被移除：通知写回到主目录的引用", async () => {
  const w = boot();
  const s = await w.pool.create({ directoryIds: [w.local.id, w.docs.id] });
  plan = [
    { tool: "switch_directory", args: { directory: "local:docs" } },
    "好",
  ];
  await turn(s.id);
  const wsId = w.pool.workspaceIdOf(s.id) as string;
  await w.pool.setWorkspaceDirectories(wsId, [w.local.id]);
  plan = ["好"];
  await turn(s.id);
  expect(JSON.stringify(lastBody())).toContain(
    `The directory you were in has been removed; you are back in local:proj (${w.local.path}), and relative paths and bash run there from now on.`,
  );
});
