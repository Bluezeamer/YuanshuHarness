import Fastify from "fastify";
import { afterAll, afterEach, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { type StubReply, startStub } from "../../test/support/stub.js";
import {
  isChild,
  type Msg,
  memberOf,
  subagentWorld,
  type World,
} from "../../test/support/subagents.js";
import { appendEntry, parseEntries, readBoard } from "../team/board.js";
import { type TeamView, teamApi } from "./team.js";

// 成员先 write 一个文件，再交付
const stub = await startStub((_n, body): StubReply => {
  if (!memberOf(body)) return isChild(body) ? "other" : "ack";
  const results = ((body.messages ?? []) as Msg[]).filter(
    (m) => m.role === "tool",
  ).length;
  if (results === 0)
    return { tool: "write", args: { path: "a.txt", content: "hello\n" } };
  if (results === 1)
    return { tool: "deliver", args: { summary: "wrote a.txt" } };
  return "done";
});
afterAll(() => stub.close());

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0).reverse()) await w.close();
  stub.requests.length = 0;
});

const call = { toolCallId: "c", signal: undefined, branch: [] };

async function setup() {
  const w = subagentWorld(stub, { builtinTools: true, tracker: true });
  worlds.push(w);
  const app = Fastify();
  app.register(teamApi, {
    teams: w.teams,
    collab: w.collab,
    runtime: w.teamRt,
  });
  await app.ready();
  const e = w.pool.get((await w.pool.create()).id);
  if (!e) throw new Error("no entry");
  const get = async (url: string) => {
    const res = await app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.json() };
  };
  return { w, e, get, close: () => app.close() };
}

test("没有团队：404", async () => {
  const { e, get, close } = await setup();
  expect((await get(`/api/v1/sessions/${e.id}/team`)).status).toBe(404);
  expect(
    (await get(`/api/v1/sessions/${e.id}/team/diff?path=a.txt`)).status,
  ).toBe(404);
  await close();
});

test("团队：公告板条数与最近 3 条，改动清单；单个文件的 diff", async () => {
  const { w, e, get, close } = await setup();
  await w.teamRt.create(
    e.id,
    { members: [{ name: "alpha", task: "write A" }] },
    call,
  );
  await waitFor(
    () => w.subagents.children(e.id).every((r) => r.state !== "running"),
    "成员交付",
  );
  // 建队与成员交付都会往板子上记；再加三条
  const file = w.collab.boardPath(e.id);
  const before = parseEntries(readBoard(file)).length;
  expect(before).toBeGreaterThan(0);
  for (const n of [10, 11, 12])
    appendEntry(file, n, "lead", "all", `note ${n}`);

  const t = (await get(`/api/v1/sessions/${e.id}/team`)).body as TeamView;
  expect(t.board.file).toBe(file);
  expect(t.board.count).toBe(before + 3);
  expect(t.board.recent.map((x) => x.no)).toEqual([10, 11, 12]);
  expect(t.board.recent[2]).toMatchObject({
    from: "lead",
    to: "all",
    text: "note 12",
  });
  expect(t.changes?.files).toEqual([
    { path: "a.txt", status: "added", added: 1, removed: 0 },
  ]);
  expect(t.changes?.total).toBe(1);

  const d = await get(`/api/v1/sessions/${e.id}/team/diff?path=a.txt`);
  expect(d.status).toBe(200);
  expect(d.body.path).toBe("a.txt");
  expect(d.body.diff).toContain("+hello");
  await w.teamRt.disband(e.id);
  await close();
});

test("diff：缺少 path 或路径跑出团队目录 400；没有改动的文件 410", async () => {
  const { w, e, get, close } = await setup();
  await w.teamRt.create(
    e.id,
    { members: [{ name: "alpha", task: "write A" }] },
    call,
  );
  await waitFor(
    () => w.subagents.children(e.id).every((r) => r.state !== "running"),
    "成员交付",
  );
  expect((await get(`/api/v1/sessions/${e.id}/team/diff`)).status).toBe(400);
  expect(
    (await get(`/api/v1/sessions/${e.id}/team/diff?path=../x`)).status,
  ).toBe(400);
  expect(
    (await get(`/api/v1/sessions/${e.id}/team/diff?path=nothing.txt`)).status,
  ).toBe(410);
  await w.teamRt.disband(e.id);
  await close();
});
