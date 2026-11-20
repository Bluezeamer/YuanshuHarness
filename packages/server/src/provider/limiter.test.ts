import { describe, expect, test } from "vitest";
import { RequestLimiter } from "./limiter.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

// 一个能手动结束的假流：wrap 只用到 result()
function fakeStream() {
  let finish!: () => void;
  let fail!: () => void;
  const done = new Promise<unknown>((ok, bad) => {
    finish = () => ok({});
    fail = () => bad(new Error("boom"));
  });
  return { result: () => done, finish, fail } as never;
}

describe("RequestLimiter", () => {
  test("不超过上限直接放行；满了排队，释放一个放行下一个，先来后到", async () => {
    const lim = new RequestLimiter(() => 2);
    const a = await lim.acquire("p");
    const b = await lim.acquire("p");
    const order: string[] = [];
    const c = lim.acquire("p").then((r) => (order.push("c"), r));
    const d = lim.acquire("p").then((r) => (order.push("d"), r));
    await tick();
    expect(order).toEqual([]);
    a();
    await tick();
    expect(order).toEqual(["c"]);
    b();
    await tick();
    expect(order).toEqual(["c", "d"]);
    (await c)();
    (await d)();
  });

  test("不同供应商互不占用名额", async () => {
    const lim = new RequestLimiter(() => 1);
    await lim.acquire("p1");
    const q = await Promise.race([
      lim.acquire("p2").then(() => "ok"),
      tick().then(() => "blocked"),
    ]);
    expect(q).toBe("ok");
  });

  test("释放函数只有第一次有效，重复调用不会放出多余的名额", async () => {
    const lim = new RequestLimiter(() => 1);
    const a = await lim.acquire("p");
    const waiting = lim.acquire("p");
    const other = lim.acquire("p");
    a();
    a();
    const first = await waiting;
    const raced = await Promise.race([
      other.then(() => "got"),
      tick().then(() => "waiting"),
    ]);
    expect(raced).toBe("waiting");
    first();
    await other;
  });

  test("排队时被中止：放弃排队，不占名额，后面的照常放行", async () => {
    const lim = new RequestLimiter(() => 1);
    const a = await lim.acquire("p");
    const ac = new AbortController();
    const aborted = lim.acquire("p", ac.signal);
    const next = lim.acquire("p");
    ac.abort();
    await expect(aborted).rejects.toThrow("aborted");
    a();
    (await next)();
    await expect(lim.acquire("p", AbortSignal.abort())).rejects.toThrow(
      "aborted",
    );
  });

  test("上限现取：调高之后，下一个到来的请求把队里能放的都放掉，放不下的继续等", async () => {
    let limit = 1;
    const lim = new RequestLimiter(() => limit);
    await lim.acquire("p"); // 一直占着一个名额
    const order: string[] = [];
    const b = lim.acquire("p").then(() => order.push("b"));
    const c = lim.acquire("p").then(() => order.push("c"));
    await tick();
    expect(order).toEqual([]);
    limit = 3; // 还剩两个空位：b、c 放行，d 仍排着
    lim.acquire("p").then(() => order.push("d"));
    await Promise.all([b, c]);
    await tick();
    expect(order).toEqual(["b", "c"]);
  });

  describe("wrap", () => {
    const model = { provider: "p" } as never;

    test("流结束（正常或出错）时释放；开始前排队", async () => {
      const lim = new RequestLimiter(() => 1);
      const streams = [fakeStream(), fakeStream()];
      let n = 0;
      const wrapped = lim.wrap((async () => streams[n++]) as never);
      const s1 = await wrapped(model, {} as never);
      const second = wrapped(model, {} as never);
      await tick();
      expect(n).toBe(1); // 第二个还没开始请求
      (s1 as unknown as { finish: () => void }).finish();
      await second;
      expect(n).toBe(2);
      (streams[1] as unknown as { fail: () => void }).fail();
      const third = await lim.acquire("p");
      third();
    });

    test("建流时抛错也释放名额", async () => {
      const lim = new RequestLimiter(() => 1);
      const wrapped = lim.wrap((async () => {
        throw new Error("no key");
      }) as never);
      await expect(wrapped(model, {} as never)).rejects.toThrow("no key");
      (await lim.acquire("p"))();
    });
  });
});
