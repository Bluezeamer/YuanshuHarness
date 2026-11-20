import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { LocalEnv } from "../env/local.js";
import { routedToolsExtension } from "../env/tools.js";
import type { ExecEnv } from "../env/types.js";
import { type Db, openDatabase } from "../store/db.js";
import { JobStore } from "../store/jobs.js";
import { JobManager } from "./manager.js";
import { jobExtension } from "./tools.js";

interface Tool {
  name: string;
  parameters: { properties: Record<string, unknown> };
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: object,
  ) => Promise<{ content: { type: string; text?: string }[] }>;
}

let dir: string;
let db: Db;
let sent: string[];
let jobs: JobManager;
let bash: Tool;
let other: string;
// 另一台主机：id 与 kind 与本机不同，执行仍落在本机（只用来证明命令走的是目标环境）。
const there = new Proxy(new LocalEnv(), {
  get: (t, k) =>
    k === "id" ? "e1" : k === "kind" ? "ssh" : Reflect.get(t, k, t),
}) as unknown as ExecEnv;

const ctx = {
  sessionManager: {
    getSessionId: () => "t",
    getSessionFile: () => undefined,
  },
};
const run = async (params: unknown, signal?: AbortSignal) =>
  (await bash.execute("c", params, signal, undefined, ctx)).content
    .map((c) => c.text ?? "")
    .join("");
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (cond: () => boolean, ms = 5000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await sleep(20);
  expect(cond()).toBe(true);
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-jobbash-"));
  // bash 的 host 只收 `<host>:<name>`：这里的替身把 dev1:train 换成另一个目录与环境。
  other = makeTmpDir("yuanshu-jobbash-other-");
  db = openDatabase(dir);
  sent = [];
  jobs = new JobManager({
    store: new JobStore(db),
    dir: path.join(dir, "jobs"),
    notify: (_to, text) => {
      sent.push(text);
      return true;
    },
    remindMs: () => 600_000,
  });
  const tools = new Map<string, Tool>();
  await routedToolsExtension(
    async (ref) =>
      ref === "dev1:train"
        ? { env: there, cwd: other }
        : { env: new LocalEnv(), cwd: dir },
    undefined,
    { jobs, owner: "s1" },
  )({ registerTool: (t: Tool) => tools.set(t.name, t) } as never);
  bash = tools.get("bash") as Tool;
});
afterEach(() => {
  jobs.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("bash 与后台任务", () => {
  test("声明里没有 timeout，换成 remind_after（另有 host）", () => {
    expect(Object.keys(bash.parameters.properties).sort()).toEqual([
      "command",
      "host",
      "remind_after",
    ]);
  });

  test("没到提醒时间就结束：照常阻塞返回，不产生任务", async () => {
    expect(await run({ command: "echo hi", remind_after: 5 })).toBe("hi\n");
    expect(jobs.list("s1")).toEqual([]);
  });

  test("到了提醒时间还在跑：这次调用返回，命令不死，结束后回调", async () => {
    const out = await run({
      command: "echo first; sleep 1.2; echo second",
      remind_after: 0.4,
    });
    expect(out).toContain("still running");
    expect(out).toContain("NOT stopped");
    expect(out).toContain("first");
    const [row] = jobs.list("s1");
    expect(row?.state).toBe("running");
    await until(() => sent.length === 1);
    expect(sent[0]).toContain("finished with exit code 0");
    expect(sent[0]).toContain("second");
    expect(jobs.list("s1")[0]?.state).toBe("done");
  });

  test("转后台的任务沿用这次调用的提醒间隔（夹到 10 秒下限），开始时间是命令最初开始的时刻", async () => {
    await run({ command: "sleep 30", remind_after: 0.4 });
    const [row] = jobs.list("s1");
    expect(row?.remindMs).toBe(10_000);
    expect(
      Date.now() - Date.parse(row?.startedAt as string),
    ).toBeGreaterThanOrEqual(400);
  });

  test("转后台之后外层调用被中止，命令不受影响", async () => {
    const ac = new AbortController();
    await run({ command: "sleep 1; echo alive", remind_after: 0.3 }, ac.signal);
    ac.abort();
    await until(() => sent.length === 1);
    expect(sent[0]).toContain("alive");
  });

  test("转后台的命令可以被停止，进程树一起结束", async () => {
    await run({ command: "sleep 30", remind_after: 0.3 });
    const [row] = jobs.list("s1");
    await jobs.stop("s1", row?.id as string, "owner");
    expect(jobs.list("s1")[0]?.state).toBe("stopped");
    expect(sent).toEqual([]);
  });

  test("remind_after 为 0：一直阻塞到结束", async () => {
    expect(
      await run({ command: "sleep 0.6; echo done", remind_after: 0 }),
    ).toBe("done\n");
    expect(jobs.list("s1")).toEqual([]);
  });

  test("带 host 的命令转后台之后仍在目标目录里跑", async () => {
    const out = await run({
      host: "dev1:train",
      command: "echo start; sleep 1; echo done > late.txt",
      remind_after: 0.3,
    });
    expect(out).toContain("still running");
    await until(() => sent.length === 1);
    expect(readFileSync(path.join(other, "late.txt"), "utf8")).toBe("done\n");
  });

  test("job_start 里的 bash 带 host：内层调用在目标环境与目录里运行", async () => {
    // job_start 用同一个 ctx.executeTool 驱动内层工具：这里把它接到上面那组工具上。
    let jobTools: Map<string, Tool> | undefined;
    const tools = new Map<string, Tool>();
    await routedToolsExtension(
      async (ref) =>
        ref === "dev1:train"
          ? { env: there, cwd: other }
          : { env: new LocalEnv(), cwd: dir },
      undefined,
      { jobs, owner: "s1" },
    )({
      registerTool: (t: Tool) => tools.set(t.name, t),
    } as never);
    jobTools = tools;
    await jobExtension(jobs, "s1", () => [...(jobTools?.keys() ?? [])])({
      registerTool: (t: Tool) =>
        tools.set((t as unknown as { name: string }).name, t),
    } as never);
    const start = tools.get("job_start") as Tool;
    // 与 SDK 的 ctx.executeTool 同形：result 带 content 与 structuredContent
    const inner = async (name: string, args: Record<string, unknown>) => {
      const tool = jobTools?.get(name);
      if (!tool) throw new Error(`no inner tool ${name}`);
      const r = await tool.execute("i", args, undefined, undefined, ctx);
      return {
        result: { ...r, structuredContent: { exit_code: 0 } },
        isError: false,
      };
    };
    const r = await start.execute(
      "j",
      {
        name: "bash",
        arguments: {
          host: "dev1:train",
          command: "pwd; echo job > from-job.txt",
        },
      },
      undefined,
      undefined,
      {
        ...ctx,
        tools: [...tools.values()].map((t) => ({
          name: (t as unknown as { name: string }).name,
          parameters: (t as unknown as { parameters: unknown }).parameters,
        })),
        executeTool: inner,
      },
    );
    const text = r.content.map((c) => c.text ?? "").join("");
    expect(text).toContain("finished");
    expect(readFileSync(path.join(other, "from-job.txt"), "utf8")).toBe(
      "job\n",
    );
  });

  test("转后台的任务记下完整命令", async () => {
    const command = "echo first\nsleep 1.2\necho second";
    await run({ command, remind_after: 0.4 });
    const [row] = jobs.list("s1");
    expect(row?.input).toBe(command);
    await until(() => sent.length === 1);
  });

  test("job_start 的 bash 记下命令原文，其他工具记下参数 JSON", async () => {
    const tools = new Map<string, Tool>();
    await routedToolsExtension(
      async () => ({ env: new LocalEnv(), cwd: dir }),
      undefined,
      { jobs, owner: "s1" },
    )({ registerTool: (t: Tool) => tools.set(t.name, t) } as never);
    // 一个不碰 fs 的替身工具：只用来证明非 bash 工具存的是参数 JSON
    const fake: Tool = {
      name: "fake_tool",
      parameters: {
        type: "object",
        properties: { avoid: { type: "string" } },
      } as never,
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    tools.set(fake.name, fake);
    await jobExtension(jobs, "s1", () => [...tools.keys()])({
      registerTool: (t: Tool) =>
        tools.set((t as unknown as { name: string }).name, t),
    } as never);
    const start = tools.get("job_start") as Tool;
    const inner = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no inner tool ${name}`);
      const r = await tool.execute("i", args, undefined, undefined, ctx);
      return {
        result: { ...r, structuredContent: { exit_code: 0 } },
        isError: false,
      };
    };
    const call = async (name: string, args: Record<string, unknown>) =>
      start.execute("j", { name, arguments: args }, undefined, undefined, {
        ...ctx,
        tools: [...tools.values()].map((t) => ({
          name: (t as unknown as { name: string }).name,
          parameters: (t as unknown as { parameters: unknown }).parameters,
        })),
        executeTool: inner,
      });
    // bash 的观察期内就结束：直接返回结果，仍要记下命令
    await call("bash", { command: "echo hi", remind_after: 5 });
    expect(jobs.list("s1")[0]?.input).toBe("echo hi");
    // 非 bash 工具：存参数 JSON
    await call("fake_tool", { avoid: "x" });
    const rows = jobs.list("s1");
    const other = rows.find((r) => r.name === "fake_tool");
    expect(JSON.parse(other?.input ?? "{}")).toEqual({ avoid: "x" });
  });

  test("非零退出码仍是失败结果，不受转后台影响", async () => {
    const out = await run({
      command: "echo bad; exit 3",
      remind_after: 5,
    }).catch((e: Error) => e.message);
    expect(String(out)).toContain("code 3");
  });
});
