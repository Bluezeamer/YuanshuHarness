import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Db, openDatabase } from "./db.js";
import { type Goal, SessionStateStore } from "./session-state.js";
import { SessionStore } from "./sessions.js";

let dir: string;
let db: Db;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yuanshu-state-"));
  db = openDatabase(dir);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("没有记录时返回空状态；保存后原样读回，覆盖写入，删除后回到空", () => {
  const store = new SessionStateStore(db);
  expect(store.get("s")).toEqual({ goal: null, todo: [], compact: null });
  const goal: Goal = {
    id: "01a14000-0000-7000-8000-000000000001",
    revision: 2,
    text: "g",
    by: "user",
    state: "paused",
    reason: { code: "user-paused" },
    maxRounds: 50,
    rounds: 3,
    since: "t",
    updatedAt: "u",
  };
  store.save("s", {
    goal,
    todo: [{ content: "a", status: "in_progress" }],
    compact: { summary: "sum", at: "t", savedPct: 40 },
  });
  expect(store.get("s")).toEqual({
    goal,
    todo: [{ content: "a", status: "in_progress" }],
    compact: { summary: "sum", at: "t", savedPct: 40 },
  });
  store.save("s", { goal: null, todo: [], compact: null });
  expect(store.get("s")).toEqual({ goal: null, todo: [], compact: null });
  store.remove("s");
  expect(db.prepare("SELECT COUNT(*) AS n FROM session_state").get()).toEqual({
    n: 0,
  });
});

test("启动对账清掉没有索引行的孤儿状态，保留有会话文件的", () => {
  const KEPT = "01a14000-0000-7000-8000-00000000000a";
  const sdir = path.join(dir, "sessions");
  mkdirSync(sdir);
  writeFileSync(
    path.join(sdir, `2026-01-02T03-04-05-000Z_${KEPT}.jsonl`),
    `${JSON.stringify({ type: "session", version: 3, id: KEPT, timestamp: "2026-01-02T03:04:05.000Z", cwd: "/w" })}\n`,
  );
  const store = new SessionStateStore(db);
  const empty = { goal: null, todo: [], compact: null };
  store.save(KEPT, empty);
  store.save("orphan", empty);
  new SessionStore(db).reconcile(sdir, () => {});
  const ids = db.prepare("SELECT session_id FROM session_state").all();
  expect(ids).toEqual([{ session_id: KEPT }]);
});
