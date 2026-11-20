import { expect, test } from "vitest";
import { runScript, type SandboxHost, UsageError } from "./sandbox.js";

// 宿主的假 agent：延迟后返回；记录调用与并发峰值。prompt 含「坏」返回 null，含「用错」抛 UsageError。
function fakeHost(ms = 20) {
  const seen = {
    calls: [] as string[],
    live: 0,
    peak: 0,
    phases: [] as string[],
    logs: [] as string[],
  };
  const host: SandboxHost = {
    agent: (prompt, opts) =>
      new Promise((resolve, reject) => {
        seen.calls.push(prompt);
        if (prompt.includes("用错"))
          return reject(new UsageError("bad option"));
        seen.live++;
        seen.peak = Math.max(seen.peak, seen.live);
        setTimeout(() => {
          seen.live--;
          resolve(
            prompt.includes("坏")
              ? null
              : opts.schema
                ? { got: prompt }
                : `ok:${prompt}`,
          );
        }, ms);
      }),
    phase: (t) => seen.phases.push(t),
    log: (m) => seen.logs.push(m),
  };
  return { host, seen };
}

const run = (
  script: string,
  args: unknown = {},
  o: Parameters<typeof runScript>[3] = {},
  ms = 20,
) => {
  const h = fakeHost(ms);
  return runScript(script, args, h.host, o).then((r) => ({ r, ...h }));
};

test("串行：agent 的返回值可以接着用，args 原样透传，return 给出结果", async () => {
  const { r } = await run(
    `const a = await agent("A:" + args.x); const b = await agent("B:" + a); return { a, b };`,
    { x: 1 },
  );
  expect(r).toEqual({ ok: true, value: { a: "ok:A:1", b: "ok:B:ok:A:1" } });
});

test("parallel：同时在飞、有序、失败项为 null；pipeline 每个条目独立穿过各阶段", async () => {
  const p = await run(
    `return await parallel(["a","坏","c","d","e"].map((f) => () => agent(f)));`,
  );
  expect(p.r).toEqual({
    ok: true,
    value: ["ok:a", null, "ok:c", "ok:d", "ok:e"],
  });
  expect(p.seen.peak).toBe(5);

  const q = await run(
    `return await pipeline(["x","坏","z"], (item) => agent("1:" + item), (prev, item, i) => agent("2:" + prev + ":" + i));`,
  );
  // 第二项的第一阶段得到 null，传给第二阶段的 prev 就是 null，脚本自己处理
  expect(q.r).toEqual({
    ok: true,
    value: ["ok:2:ok:1:x:0", "ok:2:null:1", "ok:2:ok:1:z:2"],
  });
  // 阶段里抛错：该条目为 null，其余照常
  const t = await run(
    `return await pipeline([1,2,3], (n) => { if (n === 2) throw new Error("no"); return n * 10; }, (n) => n + 1);`,
  );
  expect(t.r).toEqual({ ok: true, value: [11, null, 31] });
});

test("phase 与 log 到宿主；console.log 也当 log", async () => {
  const { seen } = await run(
    `phase("scan"); log("a"); log({ n: 1 }); console.log("c"); return 1;`,
  );
  expect(seen.phases).toEqual(["scan"]);
  expect(seen.logs).toEqual(["a", '{"n":1}', "c"]);
});

test("用错钩子整个脚本失败，即使脚本把错误 catch 掉；agent 失败只是 null", async () => {
  for (const [script, why] of [
    [`return await agent(42);`, /prompt must be a non-empty string/],
    [`return await agent("x", [1]);`, /opts must be an object/],
    [
      `try { await parallel("nope"); } catch {} return "swallowed";`,
      /takes an array/,
    ],
    [
      `try { await parallel([1]); } catch {} return "swallowed";`,
      /array of functions/,
    ],
    [`await pipeline([1]); return 1;`, /at least one stage/],
    [
      `try { Math.random(); } catch {} return 1;`,
      /Math\.random is not allowed/,
    ],
    [`try { Date.now(); } catch {} return 1;`, /Date\.now is not allowed/],
    [
      `try { new Date(); } catch {} return 1;`,
      /new Date\(\) without arguments/,
    ],
    [`try { await agent("用错"); } catch {} return 1;`, /bad option/],
  ] as const) {
    const { r } = await run(script);
    expect(r, script).toMatchObject({ ok: false, kind: "usage" });
    expect((r as { error: string }).error, script).toMatch(why);
  }
  expect((await run(`return await agent("坏");`)).r).toEqual({
    ok: true,
    value: null,
  });
  // 有参数的 new Date 是确定的，照常可用
  expect((await run(`return new Date(0).toISOString();`)).r).toEqual({
    ok: true,
    value: "1970-01-01T00:00:00.000Z",
  });
});

test("条目数超上限直接报错，不静默截断", async () => {
  const { r } = await run(
    `return await parallel(args.items.map(() => () => agent("a")));`,
    { items: [1, 2, 3] },
    { maxItemsPerCall: 2 },
  );
  expect(r).toMatchObject({ ok: false, kind: "usage" });
  expect((r as { error: string }).error).toContain(
    "got 3 items; the limit is 2 per call",
  );
});

test("沙箱里没有 require / process / fetch / 定时器 / performance，动态 import 失败", async () => {
  const t = await run(
    `return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof performance].join(",");`,
  );
  expect(t.r).toEqual({
    ok: true,
    value: "undefined,undefined,undefined,undefined,undefined",
  });
  const imp = await run(`return await import("fs");`);
  expect(imp.r).toMatchObject({ ok: false, kind: "script" });
});

test("超时按每一段同步计算算：等 agent 很久不超时，死循环超时", async () => {
  // 总共等 300ms，远超 100ms 的段上限，但每一段同步计算都很短
  const slow = await run(
    `for (let i = 0; i < 3; i++) await agent("a" + i); return "done";`,
    {},
    { segmentMs: 100 },
    100,
  );
  expect(slow.r).toEqual({ ok: true, value: "done" });
  const loop = await run(`while (true) {}`, {}, { segmentMs: 200 });
  expect(loop.r).toMatchObject({ ok: false, kind: "script" });
  expect((loop.r as { error: string }).error).toMatch(
    /without waiting for an agent/,
  );
});

test("吃内存被拦下，不影响宿主", async () => {
  const { r } = await run(
    `const a = []; while (true) { a.push(new Array(100000).fill(1)); }`,
    {},
    { memoryBytes: 8 * 1024 * 1024, segmentMs: 5000 },
  );
  expect(r).toMatchObject({ ok: false, kind: "script" });
});

test("返回值必须是纯 JSON：函数、环、非有限数被拒；undefined 当 null", async () => {
  expect((await run(`return () => 1;`)).r).toMatchObject({
    ok: false,
    kind: "script",
  });
  expect((await run(`const a = {}; a.a = a; return a;`)).r).toMatchObject({
    ok: false,
    kind: "script",
  });
  expect((await run(`return { n: NaN };`)).r).toMatchObject({
    ok: false,
    kind: "script",
  });
  expect((await run(`return { f() {} };`)).r).toMatchObject({
    ok: false,
    kind: "script",
  });
  expect((await run(`return;`)).r).toEqual({ ok: true, value: null });
});

test("脚本抛错与语法错误：script 类失败，带原因", async () => {
  const a = await run(`throw new Error("boom");`);
  expect(a.r).toEqual({
    ok: false,
    kind: "script",
    error: "Script error: boom",
  });
  const b = await run(`return (;`);
  expect(b.r).toMatchObject({ ok: false, kind: "script" });
  expect((b.r as { error: string }).error).toMatch(/^Script error:/);
});

test("外部停止：立刻结束，之后宿主再回调也不出错", async () => {
  const ac = new AbortController();
  const h = fakeHost(300);
  const p = runScript(
    `return await parallel(args.map((n) => () => agent("a" + n)));`,
    [1, 2, 3],
    h.host,
    { signal: ac.signal },
  );
  setTimeout(() => ac.abort(), 50);
  expect(await p).toMatchObject({ ok: false, kind: "stopped" });
  // 宿主那边的 agent 在 300ms 后才 resolve：沙箱已关闭，不能崩
  await new Promise((r) => setTimeout(r, 400));
});

test("等过 agent 之后才死循环：同样超时失败，不会一直挂着", async () => {
  const { r } = await run(
    `await agent("a"); while (true) {}`,
    {},
    { segmentMs: 200 },
  );
  expect(r).toMatchObject({ ok: false, kind: "script" });
  expect((r as { error: string }).error).toMatch(
    /without waiting for an agent/,
  );
}, 8000);

test("不能通过 constructor 绕过时钟禁令", async () => {
  for (const script of [
    `return new Date(0).constructor.now();`,
    `return String(new (new Date(0).constructor)());`,
    `return Object.getPrototypeOf(new Date(0)).constructor.now();`,
  ]) {
    const { r } = await run(script);
    expect(r, script).toMatchObject({ ok: false, kind: "usage" });
  }
});
