import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import { type StubReply, startStub } from "../../test/support/stub.js";
import {
  isChild,
  type Msg,
  spawnChild,
  subagentWorld,
  textOf,
  type World,
} from "../../test/support/subagents.js";
import { PAGE_READER_PRESET_ID } from "../prompt/builtin-agents.js";

const SECRET = "暗号-7f3a";

const lastOf = (body: Record<string, unknown>) =>
  ((body.messages ?? []) as Msg[]).at(-1);

// 子代理默认：先交付暗号，拿到工具结果后收尾。父默认：先派发，拿到结果后复述。
const PARENT: { reply: (body: Record<string, unknown>) => StubReply } = {
  reply: () => "",
};
const CHILD: {
  reply: (body: Record<string, unknown>, n: number) => StubReply;
} = { reply: () => "" };
let childCalls = 0;

const defaultChild = (body: Record<string, unknown>): StubReply =>
  lastOf(body)?.role === "tool"
    ? "child-done"
    : { tool: "deliver", args: { summary: SECRET } };
const defaultParent = (body: Record<string, unknown>): StubReply => {
  const last = lastOf(body);
  const out = textOf(last?.content);
  if (out.includes("[System notice]") || out.includes("[Background job"))
    return "收到通知";
  if (last?.role !== "tool")
    return { tool: "spawn_subagent", args: { task: "读文件并返回暗号" } };
  return `got:${out}`;
};

const stub = await startStub((_n, body) =>
  isChild(body) ? CHILD.reply(body, ++childCalls) : PARENT.reply(body),
);
afterAll(() => stub.close());

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0).reverse()) await w.close();
  stub.requests.length = 0;
  stub.mode.delayMs = 0;
  stub.mode.status = 200;
  PARENT.reply = defaultParent;
  CHILD.reply = defaultChild;
  childCalls = 0;
});
PARENT.reply = defaultParent;
CHILD.reply = defaultChild;

function setup(o: Parameters<typeof subagentWorld>[1] = {}) {
  const w = subagentWorld(stub, o);
  worlds.push(w);
  return w;
}

async function root(w: World) {
  const e = w.pool.get((await w.pool.create()).id);
  if (!e) throw new Error("no entry");
  const c = collector();
  e.subscribe(c);
  return { e, c };
}

const ended =
  (c: ReturnType<typeof collector>, n = 1) =>
  () =>
    c.types().filter((t) => t === "run.ended").length >= n;

const parentSaw = (text: string) =>
  parentRequests().some((r) => JSON.stringify(r.body).includes(text));
const parentRequests = () => stub.requests.filter((r) => !isChild(r.body));
const childRequests = () => stub.requests.filter((r) => isChild(r.body));

/** 第 n 次子代理请求里的第一条 user 消息（开场说明）。 */
const childBrief = (n = 0): string => {
  const body = childRequests()[n]?.body;
  const messages = (body?.messages ?? []) as Msg[];
  return textOf(messages.find((m) => m.role === "user")?.content);
};

describe("派发与交付", () => {
  test("阻塞派发：交付就是工具结果，子代理即任务，不产生回调", async () => {
    const w = setup();
    const { e, c } = await root(w);
    e.send("去问子代理");
    await waitFor(ended(c), "父运行结束");

    const [row] = w.subagents.list();
    expect(row?.parentId).toBe(e.id);
    expect(row?.depth).toBe(1);
    expect(row?.state).toBe("done");
    expect(row?.result).toBe(SECRET);

    const [job] = w.jobs.list(e.id);
    expect(job).toMatchObject({
      kind: "subagent",
      state: "done",
      ref: row?.childId,
    });
    expect(job?.told).toBe(true);

    const result = textOf(lastOf(parentRequests().at(-1)?.body ?? {})?.content);
    expect(result).toContain(`[Subagent ${job?.id} delivered]`);
    expect(result).toContain(SECRET);
    // 只有一次父运行：没有额外的回调把它再叫醒
    expect(ended(c)()).toBe(true);
    expect(c.types().filter((t) => t === "run.ended")).toHaveLength(1);
  });

  test("spec 里记下派发者的主目录：子会话的 primaryDirectoryOf 就是它（不是自己的第一个目录）", async () => {
    const w = setup();
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    const [row] = w.subagents.list();
    const parentPrimary = w.pool.primaryDirectoryOf(e.id);
    expect(row?.spec.primaryDirectoryId).toBe(parentPrimary.id);
    expect(w.pool.primaryDirectoryOf(row?.childId as string).id).toBe(
      parentPrimary.id,
    );
  });

  test("派发到非主目录：子代理的 local 仍是工作区主目录，不是它拿到的那个目录", async () => {
    const w = setup();
    const primary = w.data.directories.getDefault();
    if (!primary) throw new Error("no primary");
    mkdirSync(path.join(w.data.dir, "第二处"), { recursive: true });
    const second = w.data.directories.create(
      "第二处",
      path.join(w.data.dir, "第二处"),
    );
    if (!second) throw new Error("no second");
    const info = await w.pool.create({ directoryIds: [primary.id, second.id] });
    const e = w.pool.get(info.id);
    if (!e) throw new Error("no entry");
    const c = collector();
    e.subscribe(c);
    // 当前目录在第二个：派发时点名第二个（非主目录）——子代理只在它里面工作
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    PARENT.reply = () => "收尾";
    const { childId, done } = await spawnChild(w, e.id, {
      task: "T",
      directory: `local:${second.name}`,
    });
    await done.catch(() => {});
    const spec = w.subagents.get(childId)?.spec;
    expect(spec?.directoryIds).toEqual([second.id]);
    expect(spec?.primaryDirectoryId).toBe(primary.id);
    expect(w.pool.primaryDirectoryOf(childId).id).toBe(primary.id);
  });

  test("directory 写 <host>:<name>：子代理只在那个目录里，开场说明写明它不能切换、只到得了那台主机", async () => {
    const w = setup();
    const primary = w.data.directories.getDefault();
    if (!primary) throw new Error("no primary");
    mkdirSync(path.join(w.data.dir, "第二处"), { recursive: true });
    const second = w.data.directories.create(
      "第二处",
      path.join(w.data.dir, "第二处"),
    );
    if (!second) throw new Error("no second");
    const info = await w.pool.create({ directoryIds: [primary.id, second.id] });
    const e = w.pool.get(info.id);
    if (!e) throw new Error("no entry");
    const c = collector();
    e.subscribe(c);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    PARENT.reply = () => "收尾";
    const { childId, done } = await spawnChild(w, e.id, {
      task: "T",
      directory: "local:第二处",
    });
    await done.catch(() => {});
    expect(w.subagents.get(childId)?.spec.directoryIds).toEqual([second.id]);
    // 开场说明：目录的引用与路径，并说明不能切换、只到得了那个目录的主机与附件区
    // （父的第一次运行也派发过一次，取最后一次子代理的请求）
    expect(childBrief(childRequests().length - 1)).toContain(
      `- You work in the directory local:第二处 (${second.path}). Relative paths and commands start there. You cannot switch directories, and you can reach only that directory's host and the read-only attachment host; the host parameter of the file tools may be omitted.`,
    );
    // 子会话没有 switch_directory：只有一个目录，切不了
    expect(w.pool.enabledTools(childId)).toContain("list_directories");
    expect(w.pool.enabledTools(childId)).not.toContain("switch_directory");
  });

  test("预设能力点名 switch_directory：子代理照常起得来，只是少这个工具", async () => {
    const w = setup();
    const preset = w.presets.create({
      id: "p-agent-switchy",
      kind: "agent",
      name: "switchy",
      description: "",
      capabilities: [
        "tool:read",
        "tool:list_directories",
        "tool:switch_directory",
      ],
    });
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    PARENT.reply = () => "收尾";
    const { childId, done } = await spawnChild(w, e.id, {
      task: "T",
      agent: preset.id,
    });
    await done.catch(() => {});
    const tools = w.pool.enabledTools(childId);
    expect(tools).toContain("list_directories");
    expect(tools).not.toContain("switch_directory");
    // 真的起了：有开场说明，且没有因此失败
    expect(w.subagents.get(childId)?.state).not.toBe("failed");
    expect(childBrief(childRequests().length - 1)).toContain("Task:");
  });

  test("不写 directory：沿用调用方当前的目录，引用写法与父会话一致", async () => {
    const w = setup();
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    const current = w.pool.visibleDirectories(e.id)[0];
    const [row] = w.subagents.list();
    expect(row?.spec.directoryIds).toEqual([current?.id]);
    const book = w.pool.addressBookOf(e.id);
    expect(childBrief()).toContain(
      `You work in the directory ${book.refOf(current as never)} (${current?.path})`,
    );
  });

  test("directory 用旧写法（id、裸名字、不在范围内的目录）被拒，报错原文给模型", async () => {
    const w = setup();
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    PARENT.reply = () => "收尾";
    const primary = w.data.directories.getDefault();
    if (!primary) throw new Error("no primary");
    for (const [ref, why] of [
      [primary.id, "A directory is written <host>:<name>"],
      [primary.name, "A directory is written <host>:<name>"],
      ["local:nope", 'Directory "local:nope" not found.'],
      ["ghost:x", 'Unknown host "ghost".'],
    ] as const) {
      await expect(
        w.rt.spawn(
          e.id,
          { task: "T", directory: ref },
          {
            toolCallId: "c1",
            signal: undefined,
            branch: [],
          },
        ),
      ).rejects.toThrow(why);
    }
  });

  test("子代理的 <cwd> 写它自己工作的目录（不是父会话的主目录），并说明不能切换", async () => {
    const w = setup();
    const primary = w.data.directories.getDefault();
    if (!primary) throw new Error("no primary");
    mkdirSync(path.join(w.data.dir, "第二处"), { recursive: true });
    const second = w.data.directories.create(
      "第二处",
      path.join(w.data.dir, "第二处"),
    );
    if (!second) throw new Error("no second");
    const info = await w.pool.create({ directoryIds: [primary.id, second.id] });
    const e = w.pool.get(info.id);
    if (!e) throw new Error("no entry");
    const c = collector();
    e.subscribe(c);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    PARENT.reply = () => "收尾";
    const { done } = await spawnChild(w, e.id, {
      task: "T",
      directory: "local:第二处",
    });
    await done.catch(() => {});
    const system = JSON.stringify(
      ((childRequests().at(-1)?.body.messages ?? []) as Msg[]).filter(
        (m) => m.role === "system",
      ),
    );
    expect(system).toContain(
      `The session works in the directory local:第二处 (${second.path}). It cannot switch directories`,
    );
    expect(system).not.toContain("The session starts in its main directory");
  });

  test("附件区按工作区存放：子代理与父会话看到同一块附件区（同一行 directory）", async () => {
    const w = setup();
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    const parentAtt = await w.attachments.ensure(e.id);
    const childId = w.subagents.list()[0]?.childId as string;
    // 属主是工作区：子会话与父同属一个工作区
    expect(w.pool.workspaceIdOf(childId)).toBe(w.pool.workspaceIdOf(e.id));
    expect(w.pool.workspaceIdOf(childId)).not.toBeNull();
    expect(w.attachments.get(childId)?.id).toBe(parentAtt.id);
    // 池给两边的是同一行（子会话的目录子集里没有别的，附件区照旧追加在后面）
    const ids = (id: string) => w.pool.visibleDirectories(id).map((d) => d.id);
    expect(ids(childId)).toContain(parentAtt.id);
    expect(ids(e.id)).toContain(parentAtt.id);
  });

  test("子代理的开场说明是第一条 user 消息，写明交付方式", async () => {
    const w = setup();
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    const first = childRequests()[0]?.body.messages as Msg[];
    const brief = textOf(first.find((m) => m.role === "user")?.content);
    expect(brief).toContain("deliver");
    expect(brief).toContain("Task:");
    expect(brief).toContain("读文件并返回暗号");
    expect(brief).toContain("depth 1 of 3");
  });

  test("fork：沿用父此前的历史，spawn 那条 assistant 消息不进子代理的上下文", async () => {
    const w = setup();
    PARENT.reply = (body) => {
      const last = lastOf(body);
      if (last?.role === "tool") return "got";
      return {
        tool: "spawn_subagent",
        args: { task: "接着干", context: "fork" },
      };
    };
    const { e, c } = await root(w);
    e.send("前情提要-MARK-42");
    await waitFor(ended(c), "父运行结束");
    // 系统消息里会提到 spawn_subagent（内置说明），要看的是继承来的对话里没有那次调用
    const msgs = ((childRequests()[0]?.body.messages ?? []) as Msg[]).filter(
      (m) => m.role !== "system",
    );
    const all = JSON.stringify(msgs);
    expect(all).toContain("前情提要-MARK-42");
    expect(all).toContain("not a conversation to continue");
    expect(all).not.toContain("spawn_subagent");
    const [row] = w.subagents.list();
    expect(row?.state).toBe("done");
  });

  test("fresh 且 Agent 相同：开头系统消息与工具声明和父逐字节相同", async () => {
    const w = setup({ builtinTools: true });
    // 父先跑一步（冻结物写进会话），再派发
    let step = 0;
    PARENT.reply = () => {
      step++;
      if (step === 1) return { tool: "bash", args: { command: "echo hi" } };
      if (step === 2) return { tool: "spawn_subagent", args: { task: "T" } };
      return "got";
    };
    const { e, c } = await root(w);
    w.data.defaults.setPermissionTier("full");
    e.send("hello");
    await waitFor(ended(c), "父运行结束", 20_000);
    const p = parentRequests()[0]?.body;
    const ch = childRequests()[0]?.body;
    const first = (b: typeof p) => ((b?.messages ?? []) as Msg[])[0];
    expect(JSON.stringify(first(ch))).toBe(JSON.stringify(first(p)));
    expect(first(p)).toBeDefined();
    expect(JSON.stringify(ch?.tools)).toBe(JSON.stringify(p?.tools));
    // 声明沿用父的（含子代理本不该有的 ask_user），不能用的靠状态通知告知，deliver 经通知给出签名
    expect(JSON.stringify(ch?.tools)).toContain("ask_user");
    const childSeen = JSON.stringify(ch?.messages);
    expect(childSeen).toContain("Tools no longer available");
    expect(childSeen).toContain("New tools are available");
    expect(childSeen).toContain("deliver");
  });
});

describe("交付规则", () => {
  test("summary 超长被拒，缩短后重新交付；以最后一次为准", async () => {
    const w = setup();
    CHILD.reply = (body, n) => {
      const last = lastOf(body);
      if (n === 1)
        return { tool: "deliver", args: { summary: "x".repeat(2500) } };
      if (n === 2) return { tool: "deliver", args: { summary: "first" } };
      if (n === 3) return { tool: "deliver", args: { summary: "second" } };
      return last?.role === "tool" ? "done" : "done";
    };
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    // 第一次超长：工具结果是参数校验错误
    expect(textOf(lastOf(childRequests()[1]?.body ?? {})?.content)).toMatch(
      /2000|maxLength|too long|Validation/i,
    );
    expect(w.subagents.list()[0]?.result).toBe("second");
  });

  test("report 存成文件，父拿到路径与大小", async () => {
    const w = setup();
    CHILD.reply = (body) =>
      lastOf(body)?.role === "tool"
        ? "done"
        : {
            tool: "deliver",
            args: {
              summary: "short",
              report: "# 长报告\n" + "行\n".repeat(50),
            },
          };
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    const text = textOf(lastOf(parentRequests().at(-1)?.body ?? {})?.content);
    const childId = w.subagents.list()[0]?.childId as string;
    // 文字里是虚拟主机地址（host="collab" + 树内路径），落库的仍是 Server 的真实路径
    expect(text).toContain("Full report:");
    expect(text).toContain(`host="collab", path="/${childId}/report.md"`);
    expect(text).toMatch(/\(\d+ bytes\)/);
    expect(w.subagents.list()[0]?.report).toMatch(/report\.md$/);
  });

  test("名下还有在跑的后台任务：交付被拒并列出；提醒为 0 的常驻命令不算；停掉后可以交付", async () => {
    const w = setup();
    stub.mode.delayMs = 400;
    const { e } = await root(w);
    const { childId, done } = await spawnChild(w, e.id, { task: "T" });
    const slow = w.jobs.register(childId, {
      kind: "command",
      name: "bash",
      label: "slow",
    });
    expect(() => w.rt.deliver(childId, { summary: "too early" })).toThrow(
      /still have background jobs running: \w+ "slow"/,
    );
    // dev server 这类常驻命令（提醒为 0）不算在等回调
    w.jobs.setRemind(childId, slow.id, 0);
    expect(w.rt.deliver(childId, { summary: SECRET })).toContain(
      "Delivery recorded",
    );
    const r = await done;
    expect(r.text).toContain(SECRET);
  });

  test("停下却没交付：催 3 次，仍不交付就把最后一条回复当结果", async () => {
    const w = setup();
    CHILD.reply = () => "我只是说话没交付";
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    expect(childRequests()).toHaveLength(4);
    expect(textOf(lastOf(childRequests()[1]?.body ?? {})?.content)).toContain(
      "you must call deliver now",
    );
    const text = textOf(lastOf(parentRequests().at(-1)?.body ?? {})?.content);
    expect(text).toContain("without an explicit delivery");
    expect(text).toContain("我只是说话没交付");
    expect(w.subagents.list()[0]?.state).toBe("done");
  });
});

describe("限额与参数", () => {
  const call = { toolCallId: "c", signal: undefined, branch: [] };

  test("深度到上限：子代理不能再派发，写明别重试", async () => {
    const w = setup({ limits: { maxDepth: 1, perCaller: 10, perTree: 50 } });
    CHILD.reply = (_body, n) =>
      n === 1
        ? { tool: "spawn_subagent", args: { task: "再往下" } }
        : n === 2
          ? { tool: "deliver", args: { summary: "ok" } }
          : "done";
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    expect(textOf(lastOf(childRequests()[1]?.body ?? {})?.content)).toContain(
      "深度上限",
    );
    expect(w.subagents.list()).toHaveLength(1);
  });

  test("同时存活数超限：直接报错并写明别重试，不排队", async () => {
    const w = setup({ limits: { maxDepth: 3, perCaller: 1, perTree: 50 } });
    stub.mode.delayMs = 200;
    const { e } = await root(w);
    await spawnChild(w, e.id, { task: "A" });
    await expect(w.rt.spawn(e.id, { task: "B" }, call)).rejects.toThrow(
      /hard limit: do NOT retry/,
    );
    const w2 = setup({ limits: { maxDepth: 3, perCaller: 10, perTree: 1 } });
    const r2 = await root(w2);
    await spawnChild(w2, r2.e.id, { task: "A" });
    await expect(w2.rt.spawn(r2.e.id, { task: "B" }, call)).rejects.toThrow(
      /whole tree/,
    );
  });

  test("参数冲突：fork 不能指定 agent 或 model；模式与模型要存在", async () => {
    const w = setup();
    const { e } = await root(w);
    const spawn = (i: Parameters<typeof w.rt.spawn>[1]) =>
      w.rt.spawn(e.id, i, call);
    await expect(
      spawn({ task: "t", context: "fork", agent: "x" }),
    ).rejects.toThrow(/fork/);
    await expect(
      spawn({ task: "t", context: "fork", model: "p/m" }),
    ).rejects.toThrow(/fork/);
    await expect(spawn({ task: "t", mode: "nope" })).rejects.toThrow(
      /模式不存在/,
    );
    await expect(spawn({ task: "t", agent: "不存在" })).rejects.toThrow(
      /不存在/,
    );
    await expect(spawn({ task: " " })).rejects.toThrow(/不能为空/);
  });
});

describe("联系、后台与停止", () => {
  test("message_subagent 唤醒已交付的子代理：它回 work done，父收到「交付没变」的回调", async () => {
    const w = setup();
    PARENT.reply = (body) => {
      const last = lastOf(body);
      const out = textOf(last?.content);
      const m = /\[Subagent (\w+) delivered\]/.exec(out);
      if (m)
        return {
          tool: "message_subagent",
          args: { id: m[1], text: "follow-up-Q" },
        };
      if (out.includes("was woken up")) return "waiting";
      if (out.includes("[Subagent")) return "ok";
      return { tool: "spawn_subagent", args: { task: "T" } };
    };
    CHILD.reply = (body) => {
      const last = lastOf(body);
      if (textOf(last?.content).includes("follow-up-Q")) return "work done";
      return last?.role === "tool"
        ? "child-done"
        : { tool: "deliver", args: { summary: SECRET } };
    };
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(
      () => parentSaw("handled your message"),
      "父收到「交付没变」的回调",
      15_000,
    );
    await waitFor(ended(c), "父运行结束");
    const lastParent = JSON.stringify(parentRequests().at(-1)?.body);
    expect(lastParent).toContain("handled your message");
    expect(lastParent).toContain("earlier delivery is unchanged");
    const [row] = w.subagents.list();
    expect(row?.state).toBe("done");
    expect(row?.result).toBe(SECRET);
    expect(w.jobs.list(e.id)[0]?.state).toBe("done");
  });

  test("job_start 包着 spawn_subagent：任务 id 就是子代理 id，交付作为回调到达", async () => {
    const w = setup();
    PARENT.reply = (body) => {
      const last = lastOf(body);
      const out = textOf(last?.content);
      if (out.includes("[Subagent")) return "收到交付";
      if (last?.role === "tool") return "已派发";
      return {
        tool: "job_start",
        args: { name: "spawn_subagent", arguments: { task: "T" } },
      };
    };
    // 子代理慢一点，让 job_start 的观察期结束时它还在跑
    CHILD.reply = (body, n) => {
      stub.mode.delayMs = n === 1 ? 800 : 0;
      return lastOf(body)?.role === "tool"
        ? "child-done"
        : { tool: "deliver", args: { summary: SECRET } };
    };
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(() => parentSaw("[Subagent"), "交付回调送到父", 15_000);
    await waitFor(ended(c), "父运行结束");
    const started = /Started job (\w+)/.exec(
      JSON.stringify(parentRequests()[1]?.body),
    );
    const [job] = w.jobs.list(e.id);
    expect(started?.[1]).toBe(job?.id);
    expect(job).toMatchObject({ kind: "subagent", state: "done" });
    expect(JSON.stringify(parentRequests().at(-1)?.body)).toContain(
      `[Subagent ${job?.id} delivered]`,
    );
  });

  test("job_stop 停掉子代理：链式停止它名下的一切，阻塞的调用得到「被停止」", async () => {
    const w = setup();
    stub.mode.delayMs = 3000;
    const { e } = await root(w);
    const { childId, done } = await spawnChild(w, e.id, { task: "T" });
    const grand = await spawnChild(w, childId, { task: "孙" });
    const job = w.jobs.byRef(childId);
    const stopped = await w.jobs.stop(e.id, job?.id as string, "owner");
    expect(stopped).toContain(job?.id);
    expect(stopped).toContain(w.jobs.byRef(grand.childId)?.id);
    const r = await done;
    expect(r.isError).toBe(true);
    expect(r.text).toContain("was stopped");
    expect(w.subagents.get(childId)?.state).toBe("interrupted");
    expect(w.jobs.byRef(childId)?.state).toBe("stopped");
    // 孙代理随后一并停下
    await waitFor(
      () => w.subagents.get(grand.childId)?.state === "interrupted",
      "孙代理被链式停止",
    );
    expect(w.jobs.byRef(grand.childId)?.state).toBe("stopped");
    await waitFor(() => !w.pool.get(childId)?.busy, "子会话停下");
  });

  test("用户在子代理标签里点停止：等同停止这个任务，派发它的调用得到「被停止」", async () => {
    const w = setup();
    stub.mode.delayMs = 3000;
    const { e } = await root(w);
    const { childId, done } = await spawnChild(w, e.id, { task: "T" });
    await w.pool.get(childId)?.stop();
    const r = await done;
    expect(r.isError).toBe(true);
    expect(r.text).toContain("was stopped");
    expect(w.jobs.byRef(childId)?.state).toBe("stopped");
    expect(w.subagents.get(childId)?.state).toBe("interrupted");
  });

  test("用户停止根 agent，不停它派发的任务", async () => {
    const w = setup();
    stub.mode.delayMs = 600;
    const { e } = await root(w);
    const { childId } = await spawnChild(w, e.id, { task: "T" });
    await e.stop();
    expect(w.subagents.get(childId)?.state).toBe("running");
    expect(w.jobs.byRef(childId)?.state).toBe("running");
    await waitFor(
      () => w.subagents.get(childId)?.state === "done",
      "子代理照常交付",
      10_000,
    );
  });

  test("阻塞的 spawn 到提醒时间先返回，子代理继续跑，交付时回调", async () => {
    const w = setup();
    PARENT.reply = (body) => {
      const out = textOf(lastOf(body)?.content);
      return out.includes("[Subagent") ? "收到交付" : "ack";
    };
    CHILD.reply = (body, n) => {
      stub.mode.delayMs = n === 1 ? 11_000 : 0;
      return lastOf(body)?.role === "tool"
        ? "child-done"
        : { tool: "deliver", args: { summary: SECRET } };
    };
    const { e, c } = await root(w);
    const { childId, done } = await spawnChild(w, e.id, {
      task: "T",
      remindAfter: 10,
    });
    const r = await done;
    expect(r.text).toContain("still running");
    expect(r.text).toContain("NOT stopped");
    expect(w.jobs.byRef(childId)?.state).toBe("running");
    await waitFor(ended(c), "交付回调叫醒父", 15_000);
    expect(JSON.stringify(parentRequests().at(-1)?.body)).toContain(
      "delivered",
    );
    expect(w.jobs.byRef(childId)?.state).toBe("done");
  }, 40_000);
});

describe("交付经占位通道、配置继承", () => {
  test("deliver 不在声明里时经 call_tool 调用同样有效", async () => {
    const w = setup({ builtinTools: true });
    let step = 0;
    PARENT.reply = () => {
      step++;
      if (step === 1) return { tool: "bash", args: { command: "echo hi" } };
      if (step === 2) return { tool: "spawn_subagent", args: { task: "T" } };
      return "got";
    };
    CHILD.reply = (body) =>
      lastOf(body)?.role === "tool"
        ? "done"
        : {
            tool: "call_tool",
            args: { name: "deliver", arguments: { summary: SECRET } },
          };
    w.data.defaults.setPermissionTier("full");
    const { e, c } = await root(w);
    e.send("hello");
    await waitFor(ended(c), "父运行结束", 20_000);
    expect(w.subagents.list()[0]?.result).toBe(SECRET);
  });

  test("模型：fresh 缺省与调用方相同，可显式指定；fork 一律与调用方相同", async () => {
    const w = setup();
    stub.mode.delayMs = 300;
    const { e } = await root(w);
    const stored = (id: string) => w.pool.configs?.stored(id);
    const a = await spawnChild(w, e.id, { task: "A" });
    expect(stored(a.childId)?.model).toEqual(stored(e.id)?.model);
    const b = await spawnChild(w, e.id, { task: "B", model: "prov/mod" });
    expect(stored(b.childId)?.model).toEqual({
      mode: "explicit",
      provider: "prov",
      model: "mod",
      reasoning: "off",
    });
    // fork 要分叉点：随手给一条 assistant 消息
    const branch = [
      { id: "u1", parentId: null, type: "message", message: { role: "user" } },
      {
        id: "a1",
        parentId: "u1",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_f" }],
        },
      },
    ];
    await expect(
      w.rt.spawn(
        e.id,
        { task: "F", context: "fork" },
        { toolCallId: "call_f", signal: undefined, branch },
      ),
    ).rejects.toThrow(/分叉|没有会话文件|可复制/);
  });
});

describe("评审发现的回归", () => {
  // 消息内容是块数组：取出文本再按真实换行匹配
  const blockText = (c: unknown): string =>
    Array.isArray(c)
      ? c.map((b: { text?: string }) => b?.text ?? "").join("")
      : textOf(c);
  const taskOf = (body: Record<string, unknown>) => {
    const brief = ((body.messages ?? []) as Msg[]).find(
      (m) => m.role === "user" && blockText(m.content).includes("Task:"),
    );
    return /Task:\n(.+)/.exec(blockText(brief?.content))?.[1] ?? "";
  };
  // 子会话的第一条 user 消息（开场说明）。
  const briefOf = (body: Record<string, unknown>) =>
    blockText(
      ((body.messages ?? []) as Msg[]).find(
        (m) => m.role === "user" && blockText(m.content).includes("Task:"),
      )?.content,
    );
  const toolCount = (body: Record<string, unknown>) =>
    ((body.messages ?? []) as Msg[]).filter((m) => m.role === "tool").length;

  // 开场说明里写的是虚拟主机 collab 里的路径（`/<id>/`）：/… 开头，直接就能当 host="collab" 的 path。
  const ownPathOf = (body: Record<string, unknown>) =>
    /under (\S+)\/ \(write/.exec(briefOf(body))?.[1] ?? "";
  const approvals = (c: ReturnType<typeof collector>) =>
    c.frames.filter(
      (f) =>
        f.type === "prompt.requested" &&
        (f.data as { source?: string }).source === "approval",
    );

  test("子代理写自己的子目录放行，写树根被拒；父读报告放行（规则档，不弹窗）", async () => {
    const w = setup({ builtinTools: true });
    const { e, c } = await root(w);
    const results: string[] = [];
    // 子代理：写自己的目录 → 越界写树根 → 带报告交付
    CHILD.reply = (body) => {
      const n = toolCount(body);
      const own = ownPathOf(body);
      if (n === 0)
        return {
          tool: "write",
          args: {
            host: "collab",
            path: `${own}/notes.md`,
            content: "NOTES-OK",
          },
        };
      if (n === 1)
        return {
          tool: "write",
          args: { host: "collab", path: "/forbidden.md", content: "x" },
        };
      if (n === 2)
        return {
          tool: "deliver",
          args: { summary: "ok", report: "REPORT-BODY" },
        };
      return "done";
    };
    // 父：派发 → 按地址读报告 → 收尾
    PARENT.reply = (body) => {
      const last = lastOf(body);
      const out = textOf(last?.content);
      if (last?.role !== "tool")
        return { tool: "spawn_subagent", args: { task: "T" } };
      const m = /path="(\S+report\.md)"/.exec(out.replaceAll("\\n", " "));
      if (m) {
        results.push(m[1] as string);
        return { tool: "read", args: { host: "collab", path: m[1] as string } };
      }
      return "收尾";
    };
    e.send("go");
    await waitFor(ended(c), "父运行结束", 20_000);

    const childId = w.subagents.list()[0]?.childId as string;
    // 子代理的写：自己的目录成功，树根被拒（无人值守，没有人能批）
    expect(ownPathOf(childRequests()[0]?.body ?? {})).toBe(`/${childId}`);
    expect(
      readFileSync(`${w.collab.ownDir(e.id, childId)}/notes.md`, "utf8"),
    ).toBe("NOTES-OK");
    const childSaw = JSON.stringify(childRequests().at(-1)?.body);
    expect(childSaw).toContain("forbidden");
    expect(childSaw).toContain(
      "That path in the collab host is not yours to change.",
    );
    expect(existsSync(w.collab.boardPath(e.id))).toBe(false);
    expect(existsSync(`${w.collab.treeDir(e.id)}/forbidden.md`)).toBe(false);
    expect(w.subagents.list()[0]?.denied).toBe(1);

    // 父读报告：内容进了父的上下文，没有任何审批弹窗
    expect(results).toEqual([`/${childId}/report.md`]);
    expect(JSON.stringify(parentRequests().at(-1)?.body)).toContain(
      "REPORT-BODY",
    );
    expect(approvals(c)).toHaveLength(0);
  });

  test("子代理的 bash 带 host：指向自己的目录可以，指向不在可见清单里的目录被拒", async () => {
    const w = setup({ builtinTools: true });
    const primary = w.data.directories.getDefault();
    if (!primary) throw new Error("no primary");
    mkdirSync(path.join(w.data.dir, "第二处"), { recursive: true });
    const second = w.data.directories.create(
      "第二处",
      path.join(w.data.dir, "第二处"),
    );
    if (!second) throw new Error("no second");
    const info = await w.pool.create({ directoryIds: [primary.id, second.id] });
    const e = w.pool.get(info.id);
    if (!e) throw new Error("no entry");
    const c = collector();
    e.subscribe(c);
    // 子代理只拿到父当前的那个目录：它的引用写法就是它唯一能用的 host。
    const own = `local:${primary.name}`;
    CHILD.reply = (body) => {
      const n = toolCount(body);
      if (n === 0) return { tool: "bash", args: { host: own, command: "ls" } };
      if (n === 1)
        return {
          tool: "bash",
          args: { host: "local:第二处", command: "ls" },
        };
      // 交付一次就收尾（再调 deliver 会替换结果、停在工具结果上循环）
      return textOf(lastOf(body)?.content).includes("Delivery recorded")
        ? "done"
        : { tool: "deliver", args: { summary: "T-done" } };
    };
    PARENT.reply = (body) =>
      lastOf(body)?.role === "tool"
        ? "收尾"
        : { tool: "spawn_subagent", args: { task: "T" } };
    e.send("go");
    await waitFor(ended(c), "父运行结束", 20_000);
    const id = w.subagents.list()[0]?.childId as string;
    expect(w.subagents.list()[0]?.state).toBe("done");
    // 子代理的地址簿里只有它自己的那一个目录
    expect(
      w.pool.addressBookOf(id).refOf(w.pool.visibleDirectories(id)[0] as never),
    ).toBe(own);
    const results = childRequests().flatMap((r) =>
      ((r.body.messages ?? []) as Msg[])
        .filter((m) => m.role === "tool")
        .map((m) => textOf(m.content)),
    );
    // 自己的目录：只读命令在它的 cwd 内，直接执行（无人值守没有被拒）
    expect(results.some((t) => t.includes("jobs"))).toBe(true);
    expect(results.some((t) => t.includes("没有人工审批通道"))).toBe(false);
    // 别处：不在它的清单里，地址簿原文拒绝
    expect(results).toContain(
      `Directory "local:第二处" not found. Directories in this session: ${own}.`,
    );
  }, 20_000);

  test("删除根会话，整棵协作区一起清掉", async () => {
    const w = setup();
    const { e, c } = await root(w);
    PARENT.reply = (body) =>
      lastOf(body)?.role === "tool"
        ? "收尾"
        : { tool: "spawn_subagent", args: { task: "T" } };
    CHILD.reply = (body) =>
      lastOf(body)?.role === "tool"
        ? "done"
        : { tool: "deliver", args: { summary: "s", report: "R" } };
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    const report = w.subagents.list()[0]?.report ?? "";
    expect(existsSync(report)).toBe(true);
    expect(await w.pool.remove(e.id)).toBe("ok");
    expect(existsSync(report)).toBe(false);
    expect(existsSync(path.dirname(path.dirname(report)))).toBe(false);
  });

  test("job_start 包着的子代理：任务归属各归各的，子代理自己的 bash 输出不写进外层任务的日志", async () => {
    const w = setup({ builtinTools: true });
    w.data.defaults.setPermissionTier("full");
    PARENT.reply = (body) => {
      const out = textOf(lastOf(body)?.content);
      if (out.includes("[Subagent")) return "收到交付";
      if (lastOf(body)?.role === "tool") return "已派发";
      return {
        tool: "job_start",
        args: { name: "spawn_subagent", arguments: { task: "T" } },
      };
    };
    CHILD.reply = (body) => {
      stub.mode.delayMs = 400;
      const n = toolCount(body);
      if (taskOf(body) === "T") {
        if (n === 0)
          return { tool: "bash", args: { command: "echo leak-marker" } };
        if (n === 1) return { tool: "spawn_subagent", args: { task: "G" } };
        return n === 2
          ? { tool: "deliver", args: { summary: "T-done" } }
          : "done";
      }
      return n === 0
        ? { tool: "deliver", args: { summary: "G-done" } }
        : "done";
    };
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(() => parentSaw("[Subagent"), "交付回调送到父", 20_000);
    await waitFor(ended(c), "父运行结束");
    const rows = w.subagents.list();
    const t = rows.find((r) => r.parentId === e.id);
    const g = rows.find((r) => r.parentId === t?.childId);
    expect(t?.state).toBe("done");
    expect(g?.state).toBe("done");
    const rootJob = w.jobs.list(e.id)[0];
    expect(rootJob?.ref).toBe(t?.childId);
    expect(rootJob?.state).toBe("done");
    // 孙的任务属于子代理 T，不是根
    expect(w.jobs.byRef(g?.childId ?? "")?.sessionId).toBe(t?.childId);
    expect(w.jobs.list(e.id)).toHaveLength(1);
    // T 的 bash 照常返回给 T，输出不进根的那个任务的日志
    expect(JSON.stringify(childRequests().map((r) => r.body))).toContain(
      "leak-marker",
    );
    // 日志里有「→ bash echo leak-marker」这条动作记录是对的，但不该有命令自己的输出行
    expect(w.jobs.tail(rootJob?.id ?? "", 50).split("\n")).not.toContain(
      "leak-marker",
    );
  }, 30_000);

  test("发送在开始运行之前就失败（没有模型 / 缺密钥）：子代理记为失败，阻塞的调用立刻得到错误", async () => {
    const w = setup();
    const { e } = await root(w);
    w.hooks.failNext = "No model selected";
    const t0 = Date.now();
    const r = await w.rt.spawn(
      e.id,
      { task: "T" },
      { toolCallId: "c", signal: undefined, branch: [] },
    );
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No model selected");
    expect(w.subagents.list()[0]?.state).toBe("failed");
    expect(w.jobs.list(e.id)[0]?.state).toBe("failed");
  });

  test("已经交付了，只是收尾那一轮出错：交付仍然有效", async () => {
    const w = setup();
    CHILD.reply = (body) => {
      const first = lastOf(body)?.role !== "tool";
      stub.mode.status = first ? 200 : 500;
      return first ? { tool: "deliver", args: { summary: SECRET } } : "x";
    };
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(ended(c), "父运行结束");
    expect(w.subagents.list()[0]).toMatchObject({
      state: "done",
      result: SECRET,
    });
  });

  test("催交付的次数按「连续」算：中间有过工具调用就清零", async () => {
    const w = setup({ builtinTools: true });
    w.data.defaults.setPermissionTier("full");
    // 说话 ×3（被催 3 次的上限前一步）→ 调一次工具 → 又说话 ×3 → 才交付
    const seen = { n: 0 };
    CHILD.reply = (body) => {
      seen.n++;
      if (seen.n === 4) return { tool: "bash", args: { command: "true" } };
      if (seen.n === 8) return { tool: "deliver", args: { summary: SECRET } };
      return lastOf(body)?.role === "tool" ? "好了" : "想想";
    };
    const { e, c } = await root(w);
    e.send("go");
    await waitFor(ended(c), "父运行结束", 20_000);
    expect(w.subagents.list()[0]).toMatchObject({
      state: "done",
      result: SECRET,
    });
  }, 30_000);
});

describe("「子代理与模式」内置段", () => {
  const systemOf = (r?: { body: Record<string, unknown> }) =>
    JSON.stringify(
      ((r?.body.messages ?? []) as Msg[]).filter((m) => m.role === "system"),
    );

  test("有派发工具的会话在系统提示里带上这一段，列出可派发的 Agent；没有派发工具的不带", async () => {
    const w = setup();
    PARENT.reply = () => "ok";
    const full = await w.pool.create({ promptPresetId: w.coder.id });
    const readOnly = await w.pool.create({ promptPresetId: w.reviewer.id });
    for (const id of [full.id, readOnly.id]) {
      const e = w.pool.get(id);
      const c = collector();
      e?.subscribe(c);
      e?.send("hi");
      await waitFor(ended(c), "运行结束");
    }
    const [a, b] = parentRequests();
    expect(systemOf(a)).toContain("<delegation>");
    expect(systemOf(a)).toContain("coder-full");
    expect(systemOf(b)).not.toContain("<delegation>");
  });

  test("可派发的 Agent 清单变了：下一次运行前用状态通知告知，不改开头的冻结物", async () => {
    const w = setup();
    PARENT.reply = () => "ok";
    const { e, c } = await root(w);
    e.send("one");
    await waitFor(ended(c), "第一次运行结束");
    w.presets.create({
      kind: "agent",
      name: "researcher-xyz",
      description: "Digs through docs",
    });
    e.send("two");
    await waitFor(ended(c, 2), "第二次运行结束");
    const [first, second] = parentRequests();
    expect(systemOf(first)).not.toContain("researcher-xyz");
    // 前缀不变（冻结物），变化经状态通知到达
    expect(systemOf(second)).toBe(systemOf(first));
    const later = JSON.stringify(
      ((second?.body.messages ?? []) as Msg[]).filter(
        (m) => m.role !== "system",
      ),
    );
    expect(later).toContain("<delegation> changed");
    expect(later).toContain("researcher-xyz");
  });
});

describe("页面阅读：只读子代理的运行入口", () => {
  // 先交付，拿到工具结果后收尾（不收尾会一直重复交付）
  const DELIVER =
    (summary: string, report?: string) => (body: Record<string, unknown>) =>
      lastOf(body)?.role === "tool"
        ? "child-done"
        : {
            tool: "call_tool",
            args: {
              name: "deliver",
              arguments:
                report === undefined ? { summary } : { summary, report },
            },
          };
  /** 带辅助模型、带附件区的世界；调用方的附件区先建出来（真跑时页面文本就存在那里） */
  async function readerWorld(o: Parameters<typeof subagentWorld>[1] = {}) {
    const w = setup({
      builtinTools: true,
      auxModel: () => ({ provider: "stub", model: "stub-model" }),
      ...o,
    });
    const { e } = await root(w);
    await w.attachments.ensure(e.id);
    return { w, parentId: e.id };
  }

  test("交付了 report：返回报告文件的内容（不是摘要，也不是框架口吻）", async () => {
    const { w, parentId } = await readerWorld();
    CHILD.reply = DELIVER("done", '{"gist":"页面在讲什么"}');
    const text = await w.rt.readPage(parentId, {
      task: "READ-PAGE 任务",
      timeoutMs: 10_000,
      label: "页面阅读：T",
    });
    expect(text).toBe('{"gist":"页面在讲什么"}');
  });

  test("只有 summary：返回 summary", { timeout: 20_000 }, async () => {
    const { w, parentId } = await readerWorld();
    CHILD.reply = DELIVER("一句话结论");
    expect(
      await w.rt.readPage(parentId, {
        task: "READ-PAGE 任务",
        timeoutMs: 10_000,
        label: "页面阅读：T",
      }),
    ).toBe("一句话结论");
  });

  test("没有辅助模型：返回 null，且不建子会话", async () => {
    const w = setup({ auxModel: () => null });
    const { e } = await root(w);
    expect(
      await w.rt.readPage(e.id, {
        task: "READ-PAGE 任务",
        timeoutMs: 10_000,
        label: "页面阅读：T",
      }),
    ).toBeNull();
    expect(w.subagents.list()).toHaveLength(0);
  });

  test("超时：停掉这个子代理并返回 null", async () => {
    const { w, parentId } = await readerWorld();
    CHILD.reply = () => "还在想";
    stub.mode.delayMs = 500;
    const t0 = Date.now();
    expect(
      await w.rt.readPage(parentId, {
        task: "READ-PAGE 任务",
        timeoutMs: 200,
        label: "页面阅读：T",
      }),
    ).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
    // 子代理被停：不再是 running
    expect(w.subagents.list()[0]?.state).not.toBe("running");
  });

  test("调用方中止：同样停掉子代理并返回 null", async () => {
    const { w, parentId } = await readerWorld();
    CHILD.reply = () => "还在想";
    stub.mode.delayMs = 500;
    const stop = new AbortController();
    const pending = w.rt.readPage(parentId, {
      task: "READ-PAGE 任务",
      timeoutMs: 10_000,
      signal: stop.signal,
      label: "页面阅读：T",
    });
    setTimeout(() => stop.abort(), 150);
    expect(await pending).toBeNull();
    expect(w.subagents.list()[0]?.state).not.toBe("running");
  });

  test("子代理失败：返回 null", async () => {
    const { w, parentId } = await readerWorld();
    CHILD.reply = () => {
      stub.mode.status = 500;
      return "x";
    };
    expect(
      await w.rt.readPage(parentId, {
        task: "READ-PAGE 任务",
        timeoutMs: 10_000,
        label: "页面阅读：T",
      }),
    ).toBeNull();
    stub.mode.status = 200;
    expect(w.subagents.list()[0]?.state).toBe("failed");
  });

  test("没有交付：返回 null（最后一条回复不算报告）", async () => {
    const { w, parentId } = await readerWorld();
    CHILD.reply = () => "我只是说了几句话";
    expect(
      await w.rt.readPage(parentId, {
        task: "READ-PAGE 任务",
        timeoutMs: 20_000,
        label: "页面阅读：T",
      }),
    ).toBeNull();
    expect(w.subagents.list()[0]?.state).toBe("done");
  }, 30_000);

  test("深度已满：launch 拒绝，readPage 吞掉错误返回 null", async () => {
    const { w, parentId } = await readerWorld({
      limits: { maxDepth: 0, perCaller: 10, perTree: 50 },
    });
    expect(
      await w.rt.readPage(parentId, {
        task: "READ-PAGE 任务",
        timeoutMs: 10_000,
        label: "页面阅读：T",
      }),
    ).toBeNull();
    expect(w.subagents.list()).toHaveLength(0);
  });

  test("启动参数：内置预设、只给调用方的附件区、不占存活名额", async () => {
    // 存活名额打满：普通子代理派不动了，阅读子代理仍然能起
    const { w, parentId } = await readerWorld({
      limits: { maxDepth: 3, perCaller: 1, perTree: 50 },
    });
    stub.mode.delayMs = 400;
    CHILD.reply = (body) =>
      JSON.stringify(body).includes("READ-PAGE")
        ? DELIVER("一句话结论")(body)
        : "普通子代理在忙";
    const running = await spawnChild(w, parentId, { task: "普通任务" });
    await expect(
      w.rt.spawn(
        parentId,
        { task: "第二个" },
        { toolCallId: "c", signal: undefined, branch: [] },
      ),
    ).rejects.toThrow(/hard limit/);

    const text = await w.rt.readPage(parentId, {
      task: "READ-PAGE 任务",
      timeoutMs: 10_000,
      label: "页面阅读：T",
    });
    expect(text).toBe("一句话结论");

    const rows = w.subagents.list();
    const reader = rows.find((r) => r.childId !== running.childId);
    expect(reader).toMatchObject({
      parentId,
      counted: false,
      runId: null,
      spec: { agentPresetId: PAGE_READER_PRESET_ID },
    });
    // 起始目录：沿用调用方当前目录（页面正文用 attachment:/… 地址直接读，不再切进附件区）
    const current = w.pool.visibleDirectories(parentId)[0];
    expect(reader?.spec.directoryIds).toEqual([current?.id]);

    // 子代理标签上按 label 显示，任务名仍是普通子代理那一类
    const job = w.jobs.list(parentId).find((j) => j.ref === reader?.childId);
    expect(job).toMatchObject({ name: "spawn_subagent", label: "页面阅读：T" });
    // 子会话用辅助模型，能力只有内置预设里的 read 与 grep
    expect(w.pool.configs?.stored(reader?.childId as string)).toMatchObject({
      model: {
        mode: "explicit",
        provider: "stub",
        model: "stub-model",
        reasoning: "off",
      },
      capabilities: ["tool:read", "tool:grep"],
    });
  }, 30_000);
});
