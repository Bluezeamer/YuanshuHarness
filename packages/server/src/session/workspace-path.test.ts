// 登记路径被换成指向别处的符号链接后，创建与恢复会话都必须失败（评审 R2 第 6 项）
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  testData,
  testPool,
} from "../../test/support/stub.js";

const stub = await startStub(() => "hi");
afterAll(() => stub.close());
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

// 登记一个 workspace，返回换链接的动作
function setupWs(t: ReturnType<typeof testPool>) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ws-swap-")));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, "w");
  const other = path.join(base, "other");
  mkdirSync(dir);
  mkdirSync(other);
  const ws = t.data.workspaces.create("w", dir);
  if (!ws) throw new Error("create failed");
  const swap = () => {
    rmSync(dir, { recursive: true });
    symlinkSync(other, dir);
  };
  return { ws, swap, other };
}

describe("登记路径 realpath 与登记值不一致", () => {
  test("创建会话：失败并说明路径已变化", async () => {
    const t = testPool(stubSessionFactory(stub), testData());
    cleanups.push(
      () => t.data.close(true),
      () => t.pool.dispose(),
    );
    const { ws, swap, other } = setupWs(t);
    swap();
    const err = await t.pool.create({ workspaceId: ws.id }).catch((e) => e);
    expect(err.message).toContain("路径已变化");
    expect(err.message).toContain(other);
  });

  test("恢复会话：失败，且不调用工厂", async () => {
    const t = testPool(stubSessionFactory(stub), testData());
    const { ws, swap } = setupWs(t);
    const info = await t.pool.create({ workspaceId: ws.id });
    const e = t.pool.get(info.id);
    const c = collector();
    e?.subscribe(c);
    e?.send("hi");
    await waitFor(() => c.types().includes("run.ended"), "run.ended");
    t.pool.dispose();
    t.data.close(false); // 保留数据目录，换一个池重新打开
    swap();
    let called = 0;
    const t2 = testPool(async (o) => {
      called++;
      return stubSessionFactory(stub)(o);
    }, testData(t.data.dir));
    cleanups.push(
      () => t2.data.close(true),
      () => t2.pool.dispose(),
    );
    const err = await t2.pool.acquire(info.id).catch((e) => e);
    expect(err.code).toBe("load_failed");
    expect(err.message).toContain("路径已变化");
    expect(called).toBe(0);
  });
});
