// 轮末改动清单：落库后必须推 turn.changes，否则前端在 run.ended 时拉的清单还是空的。
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, type Frame, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  type TestData,
  testPool,
} from "../../test/support/stub.js";
import type { TurnChangeStore } from "../changes/store.js";
import type { ChangeTracker, TurnChangeSet } from "../changes/tracker.js";
import type { SessionPool } from "./pool.js";

const stub = await startStub(() => "done");
afterAll(() => stub.close());

let pool: SessionPool;
let data: TestData | undefined;
afterEach(() => {
  pool?.dispose();
  data?.close();
  data = undefined;
});

// 假 tracker：finish 直接给出结果，不碰真实文件与 git。
function fakeTracker(set: TurnChangeSet): ChangeTracker {
  return {
    begin: async () => {},
    noteWrite: async () => {},
    finish: async () => set,
  } as unknown as ChangeTracker;
}

// 假 store：记录 save 的调用（不落库），nextTurn 固定为 1；marks 用来和帧比较先后。
function fakeStore(
  saves: Array<{ turn: number; files: number }>,
  marks: string[],
) {
  return {
    nextTurn: () => 1,
    save: (_id: string, turn: number, set: TurnChangeSet) => {
      marks.push("save");
      saves.push({ turn, files: set.files.length });
    },
    list: () => [],
    clear: () => {},
  } as unknown as TurnChangeStore;
}

// 建池并开一个挂在默认 directory 上的会话：directory 由 testData() 的 ensureDefault 建成本机环境，
// 这样 changeCtx 才不为 null（否则 finishChanges 直接 return，测试会假通过）。
async function open(set: TurnChangeSet, marks: string[] = []) {
  const saves: Array<{ turn: number; files: number }> = [];
  const t = testPool(stubSessionFactory(stub), undefined, {
    tracker: fakeTracker(set),
    changes: fakeStore(saves, marks),
  });
  pool = t.pool;
  data = t.data;
  const info = await pool.create();
  expect(info.directoryId).toBeTruthy();
  const entry = pool.get(info.id);
  if (!entry) throw new Error("会话不存在");
  return { entry, saves };
}

const changeSet = (files: TurnChangeSet["files"]): TurnChangeSet => ({
  mode: "files",
  total: files.length,
  files,
});

describe("轮末改动帧", () => {
  test("一轮结束后推 turn.changes，且帧在清单落库之后", async () => {
    const marks: string[] = [];
    const { entry, saves } = await open(
      changeSet([{ path: "a.txt", status: "modified", added: 1, removed: 0 }]),
      marks,
    );
    // "save" 由假 store 记，帧到达时记 "frame"：据此比较先后。
    const c = collector((f: Frame) => {
      if (f.type === "turn.changes") marks.push("frame");
    });
    entry.subscribe(c);
    entry.send("go");
    await waitFor(() => marks.includes("frame"), "turn.changes 帧");

    const frame = c.frames.find((f) => f.type === "turn.changes");
    expect(frame?.data.turn).toBe(1);
    expect(frame?.data.total).toBe(1);
    const anchor = frame?.data.anchorTs;
    expect(anchor === null || typeof anchor === "string").toBe(true);
    expect(saves).toHaveLength(1);
    expect(marks).toEqual(["save", "frame"]);
  });

  test("本轮没有文件改动：不推 turn.changes，清单仍尝试落库", async () => {
    const marks: string[] = [];
    const { entry, saves } = await open(changeSet([]), marks);
    const c = collector(() => {});
    entry.subscribe(c);
    entry.send("go");
    await waitFor(() => c.types().includes("run.ended"), "run.ended");
    // 收尾在 run.ended 之后异步执行，等它走完再判断「没有推帧」。
    await waitFor(() => saves.length === 1, "save 调用");
    await new Promise((r) => setTimeout(r, 100));

    expect(saves).toHaveLength(1);
    // 只有落库、没有帧
    expect(marks).toEqual(["save"]);
    expect(c.types()).not.toContain("turn.changes");
  });
});
