// 回放步骤的落库：插一步挤一步、会话概况、工作区隔离、会话删除。
import { expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { BrowserStepStore, type StepRow } from "./browser-steps.js";
import { type Db, openDatabase } from "./db.js";

const setup = () => {
  const db: Db = openDatabase(makeTmpDir("yuanshu-steps-"));
  return { db, store: new BrowserStepStore(db) };
};

const row = (
  at: string,
  over: Partial<Omit<StepRow, "id">> = {},
): Omit<StepRow, "id"> => ({
  workspaceKey: "w1",
  sessionId: "s1",
  pageId: "p1",
  ts: at,
  tool: "browser_click",
  summary: "点击 e1",
  url: "https://x.test/",
  title: "",
  ...over,
});

test("插入后能列出，字段都能读回", () => {
  const { store } = setup();
  const { id, dropped } = store.insert(
    row("2026-01-01T00:00:01.000Z", { title: "登录页" }),
    300,
  );
  expect(dropped).toEqual([]);
  expect(store.list("w1", "s1")).toEqual([
    {
      id,
      workspaceKey: "w1",
      sessionId: "s1",
      pageId: "p1",
      ts: "2026-01-01T00:00:01.000Z",
      tool: "browser_click",
      summary: "点击 e1",
      url: "https://x.test/",
      title: "登录页",
    },
  ]);
  expect(store.get("w1", "s1", id)?.tool).toBe("browser_click");
  expect(store.get("w1", "s1", id + 1)).toBeUndefined();
});

test("超过 keep 时挤掉最旧的，恰好 keep 步不挤", () => {
  const { store } = setup();
  const ids = [1, 2, 3].map(
    (n) => store.insert(row(`2026-01-01T00:00:0${n}.000Z`), 3).id,
  );
  expect(ids).toHaveLength(3);
  const fourth = store.insert(row("2026-01-01T00:00:04.000Z"), 3);
  expect(fourth.dropped).toEqual([ids[0]]);
  expect(store.list("w1", "s1").map((s) => s.id)).toEqual([
    ids[1],
    ids[2],
    fourth.id,
  ]);

  const fifth = store.insert(row("2026-01-01T00:00:05.000Z"), 3);
  expect(fifth.dropped).toEqual([ids[1]]);
  expect(store.list("w1", "s1").map((s) => s.id)).toEqual([
    ids[2],
    fourth.id,
    fifth.id,
  ]);
});

test("挤掉只发生在同一会话内：两个会话互不影响", () => {
  const { store } = setup();
  const a = store.insert(row("2026-01-01T00:00:01.000Z"), 1).id;
  const b = store.insert(
    row("2026-01-01T00:00:02.000Z", { sessionId: "s2" }),
    1,
  ).id;
  const a2 = store.insert(row("2026-01-01T00:00:03.000Z"), 1);
  expect(a2.dropped).toEqual([a]);
  expect(store.list("w1", "s1").map((s) => s.id)).toEqual([a2.id]);
  expect(store.list("w1", "s2").map((s) => s.id)).toEqual([b]);
});

test("listSessions：计数、时间段、最近有动作的在前", () => {
  const { store } = setup();
  store.insert(row("2026-01-01T00:00:01.000Z"), 300);
  store.insert(row("2026-01-01T00:00:03.000Z"), 300);
  store.insert(row("2026-01-01T00:00:05.000Z", { sessionId: "s2" }), 300);
  store.insert(row("2026-01-01T00:00:02.000Z", { sessionId: "s3" }), 300);
  expect(store.listSessions("w1")).toEqual([
    {
      sessionId: "s2",
      steps: 1,
      firstTs: "2026-01-01T00:00:05.000Z",
      lastTs: "2026-01-01T00:00:05.000Z",
    },
    {
      sessionId: "s1",
      steps: 2,
      firstTs: "2026-01-01T00:00:01.000Z",
      lastTs: "2026-01-01T00:00:03.000Z",
    },
    {
      sessionId: "s3",
      steps: 1,
      firstTs: "2026-01-01T00:00:02.000Z",
      lastTs: "2026-01-01T00:00:02.000Z",
    },
  ]);
  expect(store.listSessions("w2")).toEqual([]);
});

test("工作区隔离：别的工作区读不到行，会话概况里也没有", () => {
  const { store } = setup();
  const { id } = store.insert(row("2026-01-01T00:00:01.000Z"), 300);
  expect(store.list("w2", "s1")).toEqual([]);
  expect(store.get("w2", "s1", id)).toBeUndefined();
  expect(store.listSessions("w2")).toEqual([]);
  expect(store.list("w1", "s1")).toHaveLength(1);
});

test("removeSession：只删该会话、返回正确的 id", () => {
  const { store } = setup();
  const a = store.insert(row("2026-01-01T00:00:01.000Z"), 300).id;
  const b = store.insert(row("2026-01-01T00:00:02.000Z"), 300).id;
  const other = store.insert(
    row("2026-01-01T00:00:03.000Z", { sessionId: "s2" }),
    300,
  ).id;
  expect(store.removeSession("s1")).toEqual([a, b]);
  expect(store.list("w1", "s1")).toEqual([]);
  expect(store.list("w1", "s2").map((s) => s.id)).toEqual([other]);
  expect(store.removeSession("s1")).toEqual([]);
});
