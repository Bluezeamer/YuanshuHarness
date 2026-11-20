import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { type StubReply, startStub } from "../../test/support/stub.js";
import {
  isChild,
  type Msg,
  memberOf,
  subagentWorld,
  textOf,
  type World,
} from "../../test/support/subagents.js";
import { appendEntry, parseEntries, readBoard } from "./board.js";
import { TeamError } from "./runtime.js";

type Body = Record<string, unknown>;
const lastOf = (body: Body) => ((body.messages ?? []) as Msg[]).at(-1);
// 分段内容取纯文本（textOf 会 JSON 序列化，换行与引号被转义）
const plain = (c: unknown): string =>
  Array.isArray(c)
    ? c.map((p) => (p as { text?: string }).text ?? "").join("")
    : textOf(c);
// 整个请求体里找一段文字：把 JSON 里转义的换行与引号还原再比
const flat = (body: Body): string =>
  JSON.stringify(body).replaceAll('\\"', '"').replaceAll("\\n", "\n");

// 成员默认：被唤醒（公告或私信）就回 work done，否则交付「名字-done」，拿到工具结果后收尾。
const defaultMember = (name: string, body: Body): StubReply => {
  const last = lastOf(body);
  const t = plain(last?.content);
  if (last?.role === "tool") return `${name} finished`;
  if (t.includes("[Team announcement") || t.includes("[Private message"))
    return "work done";
  return { tool: "deliver", args: { summary: `${name}-done` } };
};
const MEMBER: { reply: (name: string, body: Body) => StubReply } = {
  reply: defaultMember,
};
const LEAD: { reply: (body: Body) => StubReply } = { reply: () => "ack" };

const stub = await startStub((_n, body) => {
  const name = memberOf(body);
  if (name) return MEMBER.reply(name, body);
  return isChild(body) ? "other" : LEAD.reply(body);
});
afterAll(() => stub.close());

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0).reverse()) await w.close();
  stub.requests.length = 0;
  stub.mode.delayMs = 0;
  MEMBER.reply = defaultMember;
  LEAD.reply = () => "ack";
});

function setup(o: Parameters<typeof subagentWorld>[1] = {}) {
  const w = subagentWorld(stub, o);
  worlds.push(w);
  return w;
}
const call = { toolCallId: "c", signal: undefined, branch: [] };
const members = [
  { name: "alpha", task: "write A" },
  { name: "beta", task: "write B" },
];

async function lead(w: World) {
  const e = w.pool.get((await w.pool.create()).id);
  if (!e) throw new Error("no entry");
  return e;
}
const childOf = (w: World, leadId: string, name: string) =>
  w.teams.memberByName(leadId, name)?.childId as string;
const states = (w: World, leadId: string) =>
  w.subagents.children(leadId).map((r) => r.state);
const settled = (w: World, leadId: string, n: number) => () =>
  states(w, leadId).length === n &&
  states(w, leadId).every((s) => s !== "running");

const leadRequests = () => stub.requests.filter((r) => !memberOf(r.body));
const memberRequests = (name: string) =>
  stub.requests.filter((r) => memberOf(r.body) === name);
const leadSaw = (text: string) =>
  leadRequests().some((r) => flat(r.body).includes(text));
const memberSaw = (name: string, text: string) =>
  memberRequests(name).some((r) => flat(r.body).includes(text));

describe("建队与交付", () => {
  test("模型建队：首批公告、成员开场逐字相同、交付记进板子并分别回调 lead；job_list 只有一行", async () => {
    const w = setup();
    // 成员的交付回调会随时插进来，所以按「已经做过什么」而不是「上一条是什么」来决定下一步
    let listed = false;
    let stopped = false;
    LEAD.reply = (body) => {
      if (!JSON.stringify(body.messages).includes("Team created with"))
        return { tool: "team_create", args: { note: "shared goal", members } };
      if (!listed) {
        listed = true;
        return { tool: "job_list", args: {} };
      }
      if (!stopped) {
        stopped = true;
        return {
          tool: "job_stop",
          args: { id: w.jobs.list(e.id)[0]?.id ?? "x" },
        };
      }
      return "ack";
    };
    const e = await lead(w);
    e.send("go");
    await waitFor(settled(w, e.id, 2), "成员交付");
    await waitFor(
      () =>
        leadSaw("[Team member alpha delivered]") &&
        leadSaw("[Team member beta delivered]"),
      "lead 收到两份交付",
    );

    // 花名册与任务：成员登记成 team_member，名字当标签
    expect(w.teams.members(e.id).map((m) => m.name)).toEqual(["alpha", "beta"]);
    expect(w.jobs.list(e.id).map((j) => [j.name, j.label])).toEqual([
      ["team_member", "alpha"],
      ["team_member", "beta"],
    ]);

    // 公告板：首批公告（note + 每人一条任务）与自动记下的交付
    const board = readBoard(w.collab.boardPath(e.id));
    expect(board).toMatch(/## #1 · \d\d:\d\d · lead → all\nshared goal/);
    expect(board).toContain("Task for alpha (agent: coder-full):\nwrite A");
    expect(board).toContain("Task for beta (agent: coder-full):\nwrite B");
    expect(board).toMatch(/· alpha → all\nDelivered: alpha-done/);
    expect(board).toMatch(/· beta → all\nDelivered: beta-done/);

    // 开场消息：除最后「你是谁」之外逐字相同，且包含完整的初始公告板
    const brief = (name: string) => {
      const m = ((memberRequests(name)[0]?.body.messages ?? []) as Msg[]).find(
        (x) => x.role === "user",
      );
      return plain(m?.content);
    };
    const [sharedA = "x"] = brief("alpha").split('\nYou are "');
    const [sharedB = "y"] = brief("beta").split('\nYou are "');
    expect(sharedA).toBe(sharedB);
    expect(sharedA).toContain("Task for beta");
    expect(sharedA).toContain("Do NOT commit");
    // 协作区是虚拟主机：开场消息里只有 collab:/board.md，没有真实路径
    expect(sharedA).toContain('Team board: host="collab", path="/board.md"');
    expect(brief("alpha")).toContain('You are "alpha".');
    // 自己的子目录：host="collab" + 自己的 id
    expect(brief("alpha")).toContain(`path="/${childOf(w, e.id, "alpha")}/"`);

    // post 随队伍出现：lead 与成员都有
    expect(w.pool.enabledTools(e.id)).toContain("post");
    expect(w.pool.enabledTools(childOf(w, e.id, "alpha"))).toContain("post");

    // job_list 里团队只占一行；对成员用 job_stop 被转向 team_stop（job_stop 的结果出现，说明 job_list 已经做过了）
    await waitFor(
      () => leadSaw("Stop it with team_stop"),
      "job_stop 被转向 team_stop",
    );
    const toolTexts = leadRequests()
      .flatMap((r) => (r.body.messages ?? []) as Msg[])
      .filter((m) => m.role === "tool")
      .map((m) => plain(m.content));
    expect(toolTexts.some((t) => /^team: 2 members, \d running/.test(t))).toBe(
      true,
    );
    expect(toolTexts.some((t) => t.includes("team_member"))).toBe(false);
  });

  test("交付回调称「团队成员 名字」，联系方式是 post", async () => {
    const w = setup();
    const e = await lead(w);
    await w.teamRt.create(e.id, { members }, call);
    await waitFor(settled(w, e.id, 2), "成员交付");
    await waitFor(() => leadSaw("[Team member alpha delivered]"), "回调");
    const text = leadRequests()
      .flatMap((r) => (r.body.messages ?? []) as Msg[])
      .map((m) => plain(m.content))
      .join("\n");
    expect(text).toContain('post { "to": "alpha"');
    expect(text).not.toContain('message_subagent { "id"');
  });
});

describe("公告与私信", () => {
  async function ready() {
    const w = setup();
    const e = await lead(w);
    await w.teamRt.create(e.id, { members }, call);
    await waitFor(settled(w, e.id, 2), "成员交付");
    await waitFor(
      () =>
        leadSaw("[Team member alpha delivered]") &&
        leadSaw("[Team member beta delivered]"),
      "回调",
    );
    return { w, e };
  }

  test("公告：进板子，推给其他成员，已交付的被唤醒回 work done；不回调 lead", async () => {
    const { w, e } = await ready();
    const before = leadRequests().length;
    const r = await w.teamRt.post(e.id, { text: "API changed to v2" });
    expect(r.text).toMatch(
      /Announcement #\d+ is on the board\. Notified: alpha, beta/,
    );
    expect(readBoard(w.collab.boardPath(e.id))).toMatch(
      /· lead → all\nAPI changed to v2/,
    );
    await waitFor(
      () =>
        memberSaw("alpha", "[Team announcement") &&
        memberSaw("beta", "[Team announcement") &&
        settled(w, e.id, 2)(),
      "两个成员处理完公告",
    );
    // 已交付的成员被唤醒时带着 work done 的约定
    expect(memberSaw("alpha", 'reply with exactly "work done"')).toBe(true);
    // 交付没变：lead 一条回调都没收到
    await new Promise((res) => setTimeout(res, 200));
    expect(leadSaw("handled your message")).toBe(false);
    expect(leadRequests().length).toBe(before);
  });

  test("成员发公告：不推给自己，也不推给 lead", async () => {
    const { w, e } = await ready();
    const alpha = childOf(w, e.id, "alpha");
    const r = await w.teamRt.post(alpha, { text: "found a bug in parser" });
    expect(r.text).toContain("Notified: beta.");
    expect(readBoard(w.collab.boardPath(e.id))).toMatch(
      /· alpha → all\nfound a bug in parser/,
    );
    await waitFor(
      () => memberSaw("beta", "found a bug in parser"),
      "beta 收到",
    );
    expect(memberSaw("alpha", "found a bug in parser")).toBe(false);
    expect(leadSaw("found a bug in parser")).toBe(false);
  });

  test("lead 私信成员：不进板子；成员回 work done，lead 收到「交付没变」", async () => {
    const { w, e } = await ready();
    const r = await w.teamRt.post(e.id, { to: "alpha", text: "re-check A" });
    expect(r.text).toContain("it was idle and has been woken");
    expect(readBoard(w.collab.boardPath(e.id))).not.toContain("re-check A");
    await waitFor(
      () => leadSaw("[Team member alpha handled your message"),
      "lead 收到交付没变",
    );
  });

  test("成员私信 lead 会推给 lead；成员之间的私信不让 lead 收到「交付没变」", async () => {
    const { w, e } = await ready();
    const alpha = childOf(w, e.id, "alpha");
    await w.teamRt.post(alpha, { to: "lead", text: "design question" });
    await waitFor(
      () =>
        leadSaw("[Private message from team member alpha]\ndesign question"),
      "lead 收到私信",
    );
    const before = leadRequests().length;
    await w.teamRt.post(alpha, { to: "beta", text: "ping" });
    await waitFor(
      () => memberSaw("beta", "[Private message from team member alpha]"),
      "beta 收到",
    );
    await waitFor(settled(w, e.id, 2), "beta 处理完");
    await new Promise((res) => setTimeout(res, 200));
    expect(leadSaw("handled your message")).toBe(false);
    expect(leadRequests().length).toBe(before);
  });

  test("两条消息同时发给同一个已交付的成员：一条唤醒它，另一条跟着当前步骤送进去，都不丢", async () => {
    const { w, e } = await ready();
    const [a, b] = await Promise.all([
      w.teamRt.post(e.id, { to: "alpha", text: "first-Q" }),
      w.teamRt.post(childOf(w, e.id, "beta"), {
        to: "alpha",
        text: "second-Q",
      }),
    ]);
    expect([a.text, b.text].sort()).toEqual([
      "Message sent to alpha.",
      "Message sent to alpha; it was idle and has been woken.",
    ]);
    await waitFor(
      () => memberSaw("alpha", "first-Q") && memberSaw("alpha", "second-Q"),
      "alpha 两条都收到",
    );
  });

  test("成员名查找不分大小写", async () => {
    const { w, e } = await ready();
    const r = await w.teamRt.post(e.id, { to: "ALPHA", text: "hi" });
    expect(r.text).toContain("Message sent to alpha");
  });

  test("写给不存在的人、自己、或不在团队里：报错写明可用的名字", async () => {
    const { w, e } = await ready();
    const alpha = childOf(w, e.id, "alpha");
    await expect(
      w.teamRt.post(e.id, { to: "nobody", text: "x" }),
    ).rejects.toThrow(/no team member named "nobody"\. Members: alpha, beta/);
    await expect(
      w.teamRt.post(alpha, { to: "alpha", text: "x" }),
    ).rejects.toThrow(/yourself/);
    await expect(
      w.teamRt.post(e.id, { to: "lead", text: "x" }),
    ).rejects.toThrow(/You are the lead/);
    await expect(
      w.teamRt.post(e.id, { text: "x".repeat(4001) }),
    ).rejects.toThrow(/limit is 4000/);
    const other = await lead(w);
    await expect(w.teamRt.post(other.id, { text: "x" })).rejects.toThrow(
      /not part of a team/,
    );
  });
});

describe("停止、解散与成员管理", () => {
  test("停止单个成员：留在花名册，被私信唤醒；公告不唤醒停止的成员；解散后花名册清空、板子还在", async () => {
    const w = setup();
    stub.mode.delayMs = 400;
    const e = await lead(w);
    await w.teamRt.create(e.id, { members }, call);
    const stopped = await w.teamRt.stop(e.id, "beta");
    expect(stopped.text).toContain("Stopped beta");
    expect(w.subagents.get(childOf(w, e.id, "beta"))?.state).toBe(
      "interrupted",
    );
    // 自己发起的停止不回调自己
    expect(w.teams.members(e.id)).toHaveLength(2);
    const ann = await w.teamRt.post(e.id, { text: "heads up" });
    expect(ann.text).toContain("Not notified: beta (stopped)");
    const dm = await w.teamRt.post(e.id, { to: "beta", text: "continue" });
    expect(dm.text).toContain("woken");
    expect(w.subagents.get(childOf(w, e.id, "beta"))?.state).toBe("running");

    const gone = await w.teamRt.disband(e.id);
    expect(gone.text).toContain("Team disbanded");
    expect(w.teams.get(e.id)).toBeUndefined();
    expect(w.teams.members(e.id)).toEqual([]);
    expect(existsSync(w.collab.boardPath(e.id))).toBe(true);
    expect(states(w, e.id).every((s) => s === "interrupted")).toBe(true);
    await expect(w.teamRt.status(e.id)).rejects.toThrow(/no team/);
  });

  test("team_update：只能减没在运行的；加人时已有成员收到公告；名字不能重", async () => {
    const w = setup();
    stub.mode.delayMs = 300;
    const e = await lead(w);
    await w.teamRt.create(e.id, { members }, call);
    await expect(
      w.teamRt.update(e.id, { remove: ["alpha"] }, call),
    ).rejects.toThrow(/is running/);
    await expect(
      w.teamRt.update(e.id, { add: [{ name: "Alpha", task: "t" }] }, call),
    ).rejects.toThrow(/already used/);
    await w.teamRt.stop(e.id, "alpha");
    const r = await w.teamRt.update(
      e.id,
      { add: [{ name: "gamma", task: "write C" }], remove: ["alpha"] },
      call,
    );
    expect(r.text).toContain("Added: gamma. Removed: alpha.");
    expect(w.teams.members(e.id).map((m) => m.name)).toEqual(["beta", "gamma"]);
    const board = readBoard(w.collab.boardPath(e.id));
    expect(board).toMatch(
      /New member joined:\ngamma \(agent: coder-full\)\nwrite C/,
    );
    await waitFor(
      () => memberSaw("beta", "New member joined"),
      "beta 得知有人加入",
    );
    // 新成员的开场说明里已含自己的任务
    await waitFor(() => memberRequests("gamma").length > 0, "gamma 启动");
    expect(JSON.stringify(memberRequests("gamma")[0]?.body.messages)).toContain(
      "write C",
    );
    await w.teamRt.disband(e.id);
  });

  test("team_update 加人：先启动新成员再通知旧的，被唤醒的旧成员占着名额也不挤掉新成员", async () => {
    // 上限 2、两个旧成员都已交付：若先唤醒旧的（让它们保持运行），新成员就放不下
    const w = setup({ limits: { maxDepth: 3, perCaller: 2, perTree: 50 } });
    const e = await lead(w);
    await w.teamRt.create(e.id, { members }, call);
    await waitFor(settled(w, e.id, 2), "成员交付");
    stub.mode.delayMs = 400;
    const r = await w.teamRt.update(
      e.id,
      { add: [{ name: "gamma", task: "write C" }] },
      call,
    );
    expect(r.text).toBe("Added: gamma.");
    expect(w.teams.members(e.id).map((m) => m.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    stub.mode.delayMs = 0;
    await w.teamRt.disband(e.id);
  });

  test("并行的两次 team_create：只有一次成功，另一次报错，不动已有的板子", async () => {
    const w = setup();
    const e = await lead(w);
    const results = await Promise.allSettled([
      w.teamRt.create(e.id, { members: [members[0] as never] }, call),
      w.teamRt.create(e.id, { members: [members[1] as never] }, call),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const lost = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    expect(String(lost?.reason)).toMatch(/already have a team/);
    expect(existsSync(w.collab.boardPath(e.id).replace(/\.md$/, ".1.md"))).toBe(
      false,
    );
    expect(w.teams.members(e.id)).toHaveLength(1);
    await w.teamRt.disband(e.id);
  });

  test("成员带报告交付：板子里记的是虚拟主机 collab 里的地址，不是 Server 的真实路径", async () => {
    const w = setup();
    MEMBER.reply = (name, body) =>
      lastOf(body)?.role === "tool"
        ? `${name} finished`
        : { tool: "deliver", args: { summary: `${name}-done`, report: "R" } };
    const e = await lead(w);
    await w.teamRt.create(e.id, { members }, call);
    await waitFor(settled(w, e.id, 2), "成员交付");
    const board = readBoard(w.collab.boardPath(e.id));
    const alpha = w.teams.members(e.id).find((m) => m.name === "alpha");
    expect(board).toContain(
      `Report: host="collab", path="/${alpha?.childId}/report.md"`,
    );
    expect(board).not.toContain(w.collab.treeDir(e.id));
  });

  test("team_status：每人状态与板子摘要；摘要不可用时附最近的原文", async () => {
    const w = setup({ summarize: async () => "- decided: use v2" });
    const e = await lead(w);
    await w.teamRt.create(e.id, { members }, call);
    await waitFor(settled(w, e.id, 2), "成员交付");
    const r = await w.teamRt.status(e.id);
    expect(r.text).toContain(
      "- alpha (agent: coder-full): delivered: alpha-done",
    );
    expect(r.text).toContain("- decided: use v2");

    const w2 = setup({
      summarize: async () => {
        throw new Error("no aux model");
      },
    });
    const e2 = await lead(w2);
    await w2.teamRt.create(e2.id, { members }, call);
    await waitFor(settled(w2, e2.id, 2), "成员交付");
    const r2 = await w2.teamRt.status(e2.id);
    expect(r2.text).toContain("Summary unavailable");
    expect(r2.text).toContain("Task for alpha");
  });
});

describe("限制", () => {
  test("参数错误整批拒绝，不留花名册", async () => {
    const w = setup();
    const e = await lead(w);
    const create = (m: unknown[]) =>
      w.teamRt.create(e.id, { members: m as never }, call);
    await expect(create([])).rejects.toThrow(/at least one member/);
    await expect(create([{ name: "1bad", task: "t" }])).rejects.toThrow(
      /not valid/,
    );
    await expect(create([{ name: "lead", task: "t" }])).rejects.toThrow(
      /reserved/,
    );
    await expect(
      create([
        { name: "a", task: "t" },
        { name: "A", task: "t" },
      ]),
    ).rejects.toThrow(/already used/);
    await expect(create([{ name: "a", task: " " }])).rejects.toThrow(/empty/);
    await expect(
      create([{ name: "a", task: "t", context: "fork", agent: "x" }]),
    ).rejects.toThrow(/do not set agent/);
    await expect(
      create([{ name: "a", task: "t", agent: "不存在" }]),
    ).rejects.toThrow(/不存在/);
    expect(w.teams.get(e.id)).toBeUndefined();
    expect(w.subagents.children(e.id)).toEqual([]);
  });

  test("整批放不下存活上限：直接拒绝，一个都不启动", async () => {
    const w = setup({ limits: { maxDepth: 3, perCaller: 2, perTree: 50 } });
    const e = await lead(w);
    await expect(
      w.teamRt.create(
        e.id,
        { members: [...members, { name: "gamma", task: "C" }] },
        call,
      ),
    ).rejects.toThrow(/Starting 3 more would exceed it/);
    expect(w.subagents.children(e.id)).toEqual([]);
    expect(w.teams.get(e.id)).toBeUndefined();
  });

  test("一个会话一个队；成员（子代理）不能建队", async () => {
    const w = setup();
    stub.mode.delayMs = 300;
    const e = await lead(w);
    await w.teamRt.create(e.id, { members }, call);
    await expect(w.teamRt.create(e.id, { members }, call)).rejects.toThrow(
      /already have a team/,
    );
    await expect(
      w.teamRt.create(childOf(w, e.id, "alpha"), { members }, call),
    ).rejects.toThrow(TeamError);
    await w.teamRt.disband(e.id);
  });

  test("新队接手有旧板子的会话：旧板子改名保留", async () => {
    const w = setup();
    const e = await lead(w);
    await w.teamRt.create(e.id, { members: [members[0] as never] }, call);
    await waitFor(settled(w, e.id, 1), "交付");
    await w.teamRt.disband(e.id);
    await w.teamRt.create(
      e.id,
      { members: [{ name: "gamma", task: "C" }] },
      call,
    );
    const board = readBoard(w.collab.boardPath(e.id));
    expect(board).toContain("Task for gamma");
    expect(board).not.toContain("Task for alpha");
    expect(existsSync(w.collab.boardPath(e.id).replace(/\.md$/, ".1.md"))).toBe(
      true,
    );
    await w.teamRt.disband(e.id);
  });

  test("删除 lead 会话：花名册与协作区一起清掉", async () => {
    const w = setup();
    const e = await lead(w);
    await w.teamRt.create(e.id, { members }, call);
    await waitFor(settled(w, e.id, 2), "成员交付");
    await waitFor(() => w.jobs.list(e.id).every((j) => j.told), "回调都已送达");
    await new Promise((res) => setTimeout(res, 300));
    expect(await w.pool.remove(e.id)).toBe("ok");
    expect(w.teams.get(e.id)).toBeUndefined();
    expect(w.teams.members(e.id)).toEqual([]);
    expect(existsSync(w.collab.boardPath(e.id))).toBe(false);
  });
});

describe("team_diff", () => {
  // 成员先 write 一个文件，再交付
  const writer = (_name: string, body: Body): StubReply => {
    const results = ((body.messages ?? []) as Msg[]).filter(
      (m) => m.role === "tool",
    ).length;
    if (results === 0)
      return { tool: "write", args: { path: "a.txt", content: "hello\n" } };
    if (results === 1)
      return { tool: "deliver", args: { summary: "wrote a.txt" } };
    return "done";
  };
  const hasGit = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  test("非 git 目录：看得到 write 的改动、看不到不经工具的写入；带路径看 diff；路径要在目录里", async () => {
    const w = setup({ builtinTools: true, tracker: true });
    MEMBER.reply = writer;
    const e = await lead(w);
    await w.teamRt.create(e.id, { members: [members[0] as never] }, call);
    await waitFor(settled(w, e.id, 1), "交付");
    writeFileSync(path.join(w.data.dir, "outside-tool.txt"), "x\n");

    const list = await w.teamRt.diff(e.id);
    expect(list.text).toContain("A a.txt (+1 -0)");
    expect(list.text).not.toContain("outside-tool.txt");
    expect(list.text).toContain("not a git repository");
    expect((await w.teamRt.diff(e.id, "a.txt")).text).toContain("+hello");
    expect(
      (await w.teamRt.diff(e.id, path.join(w.data.dir, "a.txt"))).text,
    ).toContain("+hello");
    await expect(w.teamRt.diff(e.id, "../x")).rejects.toThrow(/inside/);
    await w.teamRt.disband(e.id);
  });

  test.skipIf(!hasGit)(
    "git 目录：以建队时的目录树为基线，不经工具的改动也看得到",
    async () => {
      const dir = realpathSync(
        mkdtempSync(path.join(tmpdir(), "yuanshu-team-git-")),
      );
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(path.join(dir, "keep.txt"), "one\n");
      const w = setup({ builtinTools: true, tracker: true });
      MEMBER.reply = writer;
      const repo = w.data.directories.create("repo", dir);
      const e = w.pool.get(
        (await w.pool.create({ directoryId: repo?.id as string })).id,
      );
      if (!e) throw new Error("no entry");
      await w.teamRt.create(e.id, { members: [members[0] as never] }, call);
      await waitFor(settled(w, e.id, 1), "交付");
      writeFileSync(path.join(dir, "keep.txt"), "one\ntwo\n");

      const list = await w.teamRt.diff(e.id);
      expect(list.text).toContain("includes changes made by shell commands");
      expect(list.text).toContain("A a.txt (+1 -0)");
      expect(list.text).toContain("M keep.txt (+1 -0)");
      expect((await w.teamRt.diff(e.id, "keep.txt")).text).toContain("+two");
      await w.teamRt.disband(e.id);
    },
  );
});

describe("公告板条目", () => {
  test("按框架写的格式拆成条目：编号、时间、署名、收件人、正文；正文可以多行", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "board-")), "b.md");
    const at = new Date(2026, 10, 8, 14, 3);
    appendEntry(file, 1, "alpha", "all", "started A\nsecond line", at);
    appendEntry(file, 2, "lead", "beta", "  go on  ", at);
    expect(parseEntries(readBoard(file))).toEqual([
      {
        no: 1,
        time: "14:03",
        from: "alpha",
        to: "all",
        text: "started A\nsecond line",
      },
      { no: 2, time: "14:03", from: "lead", to: "beta", text: "go on" },
    ]);
  });

  test("空板子没有条目；正文是空的也算一条；不是这个格式的块丢掉", () => {
    expect(parseEntries("")).toEqual([]);
    expect(parseEntries("## #3 · 09:00 · a → all")).toEqual([
      { no: 3, time: "09:00", from: "a", to: "all", text: "" },
    ]);
    expect(
      parseEntries("随手写的一行\n\n## #4 · 09:01 · a → all\nx\n"),
    ).toEqual([{ no: 4, time: "09:01", from: "a", to: "all", text: "x" }]);
  });

  test("正文里出现像标题的字也不会错拆（只认行首的 ## #编号 · ）", () => {
    const board =
      "## #1 · 10:00 · a → all\nsee ## #9 · not a header\n\n## #2 · 10:01 · b → all\nok\n";
    const got = parseEntries(board);
    expect(got.map((e) => e.no)).toEqual([1, 2]);
    expect(got[0]?.text).toBe("see ## #9 · not a header");
  });
});
