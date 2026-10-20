import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { AuditLog } from "../store/audit.js";

const CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [];
const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as Array<{ role: string }>;
  return CALLS[msgs.filter((m) => m.role === "tool").length] ?? "done";
});
afterAll(() => stub.close());

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  CALLS.length = 0;
  stub.requests.length = 0;
});

async function setup() {
  const outside = mkdtempSync(path.join(tmpdir(), "yuanshu-out-"));
  const data = testData();
  const audit = new AuditLog(data.db);
  const t = testPool(stubSessionFactory(stub, {}, true), data, { audit });
  cleanups.push(
    () => rmSync(outside, { recursive: true, force: true }),
    () => data.close(true),
    () => t.pool.dispose(),
  );
  const info = await t.pool.create();
  const entry = t.pool.get(info.id);
  if (!entry) throw new Error("no entry");
  const c = collector();
  entry.subscribe(c);
  return { entry, c, outside, audit, id: info.id };
}

const run = async (x: Awaited<ReturnType<typeof setup>>, optionId: string) => {
  x.entry.send("go");
  await waitFor(
    () => x.c.frames.some((f) => f.type === "prompt.requested"),
    "prompt.requested",
  );
  const p = x.c.frames.find((f) => f.type === "prompt.requested");
  x.entry.answerPrompt(p?.data.promptId, { optionId });
  await waitFor(() => x.c.types().includes("run.ended"), "run.ended", 8000);
};

test("批准后：工具开始/结束与权限决定落审计，不含写入内容", async () => {
  const x = await setup();
  const f = path.join(x.outside, "a.txt");
  CALLS.push({
    tool: "write",
    args: { path: f, content: "TOP-SECRET-BODY" },
  });
  await run(x, "allow");
  const { entries } = x.audit.list({ session: x.id });
  const byKind = (k: string) => entries.filter((e) => e.kind === k);
  expect(byKind("permission")).toMatchObject([
    {
      actor: "user",
      summary: `allow write: ${f}`,
      detail: { tool: "write", decision: "allow", by: "user" },
    },
  ]);
  expect(byKind("tool").map((e) => e.summary)).toEqual([
    "write 完成",
    `write ${f}`,
  ]);
  expect(byKind("tool")[0]?.detail).toMatchObject({ isError: false });
  expect(byKind("tool")[0]?.detail).toHaveProperty("durationMs");
  expect(byKind("tool").every((e) => e.actor === "agent")).toBe(true);
  expect(entries.every((e) => e.environmentId === "local")).toBe(true);
  expect(JSON.stringify(entries)).not.toContain("TOP-SECRET-BODY");
});

test("拒绝：权限决定记为 deny", async () => {
  const x = await setup();
  CALLS.push({
    tool: "write",
    args: { path: path.join(x.outside, "a.txt"), content: "x" },
  });
  await run(x, "deny");
  const perm = x.audit.list({ kind: "permission" }).entries;
  expect(perm).toHaveLength(1);
  expect(perm[0]).toMatchObject({
    actor: "user",
    detail: { decision: "deny", by: "user" },
  });
});
