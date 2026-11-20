import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, type Frame, waitFor } from "../../test/support/frames.js";
import { type StubReply, startStub } from "../../test/support/stub.js";
import {
  isChild,
  type Msg,
  subagentWorld,
  textOf,
  type World,
} from "../../test/support/subagents.js";

const plain = (c: unknown): string =>
  Array.isArray(c)
    ? c.map((p) => (p as { text?: string }).text ?? "").join("")
    : textOf(c);
const lastOf = (body: Record<string, unknown>) =>
  ((body.messages ?? []) as Msg[]).at(-1);

// 子代理交付「done:任务第一行」；调用方按步骤决定调哪个工具。
const taskOf = (body: Record<string, unknown>): string => {
  const first = ((body.messages ?? []) as Msg[]).find((m) => m.role === "user");
  return plain(first?.content).split("\nTask:\n")[1] ?? "";
};
const CHILD: {
  reply: (task: string, body: Record<string, unknown>) => StubReply;
} = {
  reply: (task, body) =>
    lastOf(body)?.role === "tool"
      ? "finished"
      : { tool: "deliver", args: { summary: `done:${task.split("\n")[0]}` } },
};
const LEAD: { reply: (body: Record<string, unknown>) => StubReply } = {
  reply: () => "ack",
};

const stub = await startStub((_n, body) =>
  isChild(body) ? CHILD.reply(taskOf(body), body) : LEAD.reply(body),
);
afterAll(() => stub.close());

const worlds: World[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0).reverse()) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  stub.requests.length = 0;
  stub.mode.delayMs = 0;
  LEAD.reply = () => "ack";
});

function workflowFile(
  dir: string,
  name: string,
  script: string,
  params = `{}`,
): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.js`);
  writeFileSync(
    file,
    `/* @workflow\n{ "description": "${name} 测试流程", "params": ${params}, "phases": ["go"] }\n*/\n${script}`,
  );
  return file;
}

function setup() {
  const globalDir = mkdtempSync(join(tmpdir(), "yuanshu-wf-named-"));
  dirs.push(globalDir);
  const w = subagentWorld(stub, { workflows: { globalDir } });
  worlds.push(w);
  return { w, globalDir };
}

async function lead(w: World) {
  const e = w.pool.get((await w.pool.create()).id);
  if (!e) throw new Error("no entry");
  return e;
}

const results = (): string[] =>
  stub.requests
    .filter((r) => !isChild(r.body))
    .flatMap((r) => (r.body.messages ?? []) as Msg[])
    .filter((m) => m.role === "tool")
    .map((m) => plain(m.content));

const prompts = (c: ReturnType<typeof collector>) =>
  c.frames.filter((f: Frame) => f.type === "prompt.requested");

describe("命名流程", () => {
  test("workflow_run { name } 跑通并返回结果；通过档同样能跑（不掉参数）", async () => {
    const { w, globalDir } = setup();
    workflowFile(
      globalDir,
      "review",
      `return await agent("work " + args.scope);`,
      `{ "scope": { "type": "string", "default": "week" } }`,
    );
    for (const tier of ["full", "rules"] as const) {
      w.data.defaults.setPermissionTier(tier);
      const e = await lead(w);
      const c = collector();
      e.subscribe(c);
      LEAD.reply = (body) => {
        if (lastOf(body)?.role === "tool") return "ack";
        return { tool: "workflow_run", args: { name: "review" } };
      };
      e.send("go");
      if (tier === "rules") {
        await waitFor(() => prompts(c).length > 0, "审批弹窗", 8000);
        e.answerPrompt(prompts(c)[0]?.data.promptId, { optionId: "allow" });
        // 弹窗正文点名命名流程与层
        expect(prompts(c)[0]?.data.body).toContain(
          "命名流程：review（global）",
        );
        expect(prompts(c)[0]?.data.detail?.summary).toBe(
          '\nreturn await agent("work " + args.scope);\n\n--- args ---\n{"scope":"week"}',
        );
      }
      await waitFor(
        () => results().some((t) => t.includes("Workflow finished (agents: 1")),
        "运行结束",
        20_000,
      );
      await waitFor(() => c.types().includes("run.ended"), "run.ended", 8000);
      expect(results().some((t) => t.includes("done:work week"))).toBe(true);
    }
  });

  test("批准的就是运行的：弹窗等待期间改写文件，运行的仍是批准时的文本", async () => {
    const { w, globalDir } = setup();
    const file = workflowFile(
      globalDir,
      "review",
      `return await agent("OLD");`,
    );
    w.data.defaults.setPermissionTier("rules");
    const e = await lead(w);
    const c = collector();
    e.subscribe(c);
    LEAD.reply = (body) => {
      if (lastOf(body)?.role === "tool") return "ack";
      return { tool: "workflow_run", args: { name: "review" } };
    };
    e.send("go");
    await waitFor(() => prompts(c).length > 0, "审批弹窗", 8000);
    expect(prompts(c)[0]?.data.detail?.summary).toContain('agent("OLD")');
    // 弹窗还开着就换掉文件内容
    writeFileSync(
      file,
      `/* @workflow\n{ "description": "改过了" }\n*/\nreturn await agent("NEW");`,
    );
    e.answerPrompt(prompts(c)[0]?.data.promptId, { optionId: "allow" });
    await waitFor(
      () => results().some((t) => t.includes("Workflow finished")),
      "运行结束",
      20_000,
    );
    const tasks = stub.requests
      .filter((r) => isChild(r.body))
      .map((r) => taskOf(r.body));
    expect(tasks).toEqual(["OLD", "OLD"]);
    expect(tasks).not.toContain("NEW");
  });

  test("job_start 包着 name：批准的同样就是运行的（弹窗等待期间改写文件）", async () => {
    const { w, globalDir } = setup();
    const file = workflowFile(
      globalDir,
      "review",
      `return await agent("OLD");`,
    );
    w.data.defaults.setPermissionTier("rules");
    const e = await lead(w);
    const c = collector();
    e.subscribe(c);
    LEAD.reply = (body) => {
      if (lastOf(body)?.role === "tool") return "ack";
      return {
        tool: "job_start",
        args: { name: "workflow_run", arguments: { name: "review" } },
      };
    };
    e.send("go");
    await waitFor(() => prompts(c).length > 0, "审批弹窗", 8000);
    expect(prompts(c)[0]?.data.detail?.summary).toContain('agent("OLD")');
    writeFileSync(
      file,
      `/* @workflow\n{ "description": "改过了" }\n*/\nreturn await agent("NEW");`,
    );
    e.answerPrompt(prompts(c)[0]?.data.promptId, { optionId: "allow" });
    await waitFor(
      () => stub.requests.some((r) => isChild(r.body)),
      "子代理启动",
      20_000,
    );
    const tasks = stub.requests
      .filter((r) => isChild(r.body))
      .map((r) => taskOf(r.body));
    expect(tasks).toContain("OLD");
    expect(tasks).not.toContain("NEW");
  });

  test("workflow_list：列出名称、层、描述、参数与阶段；无效文件带原因；不弹审批", async () => {
    const { w, globalDir } = setup();
    workflowFile(
      globalDir,
      "review",
      "return 1;",
      `{ "scope": { "type": "string", "default": "week", "description": "范围" }, "limit": { "type": "integer", "required": true } }`,
    );
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "broken.js"), "return 1;");
    w.data.defaults.setPermissionTier("rules");
    const e = await lead(w);
    const c = collector();
    e.subscribe(c);
    LEAD.reply = (body) => {
      if (lastOf(body)?.role === "tool") return "ack";
      return { tool: "workflow_list", args: {} };
    };
    e.send("go");
    await waitFor(
      () =>
        results().some(
          (t) => t.includes("workflow_list out") || t.includes("review |"),
        ),
      "列表回来",
      15_000,
    );
    await waitFor(() => c.types().includes("run.ended"), "run.ended", 8000);
    const out = results().find((t) => t.includes("review |")) ?? "";
    expect(out).toContain("review | global | review 测试流程");
    expect(out).toContain('scope (string; optional; default "week"; 范围)');
    expect(out).toContain("limit (integer; required)");
    expect(out).toContain("phases: go");
    expect(out).toContain("broken | global | NOT RUNNABLE:");
    // 只读：不弹审批
    expect(prompts(c)).toHaveLength(0);
  });

  test("不存在的名称：报错并列出可用名称，不启动任何 agent", async () => {
    const { w, globalDir } = setup();
    workflowFile(globalDir, "review", "return 1;");
    w.data.defaults.setPermissionTier("rules");
    const e = await lead(w);
    const c = collector();
    e.subscribe(c);
    LEAD.reply = (body) => {
      if (lastOf(body)?.role === "tool") return "ack";
      return { tool: "workflow_run", args: { name: "nope" } };
    };
    e.send("go");
    await waitFor(
      () => results().some((t) => t.includes("no named workflow")),
      "错误回到模型",
      15_000,
    );
    expect(results().some((t) => t.includes("Available: review"))).toBe(true);
    // 解析失败不弹窗
    expect(prompts(c)).toHaveLength(0);
    expect(w.subagents.children(e.id)).toHaveLength(0);
  });
});
