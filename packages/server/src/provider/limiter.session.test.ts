import { afterAll, afterEach, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { RequestLimiter } from "./limiter.js";

// 真实会话 + stub 模型：同一个供应商的上限为 1 时，两个会话同时发消息，模型请求被排成先后两个。
const stub = await startStub(() => "ok");
afterAll(() => stub.close());

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  stub.requests.length = 0;
  stub.mode.delayMs = 0;
});

async function twoRuns(limit: number) {
  const data = testData();
  const limiter = new RequestLimiter(() => limit);
  const t = testPool(stubSessionFactory(stub, {}, false, limiter), data);
  cleanups.push(
    () => t.pool.dispose(),
    () => data.close(true),
  );
  stub.mode.delayMs = 300;
  const open = async () => {
    const e = t.pool.get((await t.pool.create()).id);
    if (!e) throw new Error("no entry");
    const c = collector();
    e.subscribe(c);
    return { e, c };
  };
  const [a, b] = [await open(), await open()];
  const done = (c: ReturnType<typeof collector>) => () =>
    c.types().includes("run.ended");
  const t0 = Date.now();
  a.e.send("one");
  b.e.send("two");
  const at: number[] = [];
  await Promise.all(
    [a, b].map((x) =>
      waitFor(done(x.c), "run.ended", 10_000).then(() =>
        at.push(Date.now() - t0),
      ),
    ),
  );
  at.sort((x, y) => x - y);
  return (at[1] ?? 0) - (at[0] ?? 0);
}

test("上限为 1：第二个请求要等第一个结束才发出", async () => {
  expect(await twoRuns(1)).toBeGreaterThanOrEqual(250);
});

test("上限为 2：两个请求并行", async () => {
  expect(await twoRuns(2)).toBeLessThan(250);
});
