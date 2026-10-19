// 创建与删除 workspace 的竞争（预占）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  startStub,
  stubSessionFactory,
  testData,
  testPool,
} from "../../test/support/stub.js";

const stub = await startStub(() => "hi");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

describe("创建期间删除 workspace：预占防冲突", () => {
  test("工厂延迟期间删除 workspace 被判占用，工厂完成后会话正常", async () => {
    const t = testPool(async (opts) => {
      await new Promise((r) => setTimeout(r, 100)); // 延迟工厂
      return stubSessionFactory(stub)(opts);
    }, testData());
    cleanups.push(
      () => t.data.close(true),
      () => t.pool.dispose(),
    );
    const dir = mkdtempSync(path.join(tmpdir(), "ws-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const w2 = t.data.workspaces.create("w2", dir);
    expect(w2).toBeTruthy();
    const createTask = t.pool.create({ workspaceId: w2?.id });
    // 等一小会让工厂开始
    await new Promise((r) => setTimeout(r, 50));
    expect(t.pool.workspaceInUse(w2?.id as string)).toBe(true);
    const info = await createTask;
    expect(info.workspaceId).toBe(w2?.id);
  });

  test("工厂完成前删除 workspace，工厂抛错，workspace 被删", async () => {
    const t = testPool(async (opts) => {
      await new Promise((r) => setTimeout(r, 100));
      return stubSessionFactory(stub)(opts);
    }, testData());
    cleanups.push(
      () => t.data.close(true),
      () => t.pool.dispose(),
    );
    const dir = mkdtempSync(path.join(tmpdir(), "ws-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const w2 = t.data.workspaces.create("w2", dir);
    expect(w2).toBeTruthy();
    const createTask = t.pool.create({ workspaceId: w2?.id });
    await new Promise((r) => setTimeout(r, 50));
    // 强制删除 workspace（实际删除的前提是池检查过 inUse）
    t.data.workspaces.remove(w2?.id as string);
    await expect(createTask).rejects.toThrow("workspace 已被删除");
  });
});
