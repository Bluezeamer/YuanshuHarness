// 动态工作流的脚本引擎（workflow.md §2–§4）：在 quickjs-wasi 沙箱里跑一段 JS，只暴露
// agent / parallel / pipeline / phase / log / args。脚本是纯编排：没有文件、网络、定时器、require、
// 动态 import，用了时钟与随机（Date.now / Math.random / 无参 new Date()）直接报错；权限全在它调用的 agent 上。
// 这个文件不认识子代理：agent() 由宿主（runtime.ts）实现。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Intrinsics, type JSValueHandle, QuickJS } from "quickjs-wasi";

/** 用错钩子（参数错、未知选项、超上限）：整个脚本失败，不是让这一项变成 null。 */
export class UsageError extends Error {}

export const SANDBOX_DEFAULTS = {
  /** 沙箱内存上限 */
  memoryBytes: 64 * 1024 * 1024,
  /**
   * 脚本每一段连续同步计算的时间上限；等 agent 的时候脚本是空闲的，不计。沙箱跑在主线程上，
   * 一段死循环会卡住整个服务到这个时间，而纯编排用不到几秒，所以取小。
   */
  segmentMs: 2000,
  /** parallel / pipeline 一次调用的条目上限，超了报错，不静默截断 */
  maxItemsPerCall: 4096,
} as const;

export interface SandboxHost {
  /** 子代理的最终文本 / 校验后的对象；失败为 null；用错抛 UsageError */
  agent(prompt: string, opts: Record<string, unknown>): Promise<unknown>;
  phase(title: string): void;
  log(message: string): void;
}

export type SandboxResult =
  | { ok: true; value: unknown }
  // script：脚本自己出错（抛错、超时、超内存、返回值不是纯 JSON）；usage：用错钩子；
  // runtime：引擎或宿主故障；stopped：被外部停止
  | {
      ok: false;
      kind: "script" | "usage" | "runtime" | "stopped";
      error: string;
    };

// 只编译一次；tsconfig 的 lib 里没有 WebAssembly 的类型，这里按最窄的形状取
type WasmModule = Parameters<typeof QuickJS.create>[0] extends infer O
  ? O extends { wasm: infer W }
    ? W
    : never
  : never;
let wasm: Promise<WasmModule> | undefined;
const compiled = () =>
  (wasm ??= (
    globalThis as unknown as {
      WebAssembly: { compile(b: Uint8Array): Promise<WasmModule> };
    }
  ).WebAssembly.compile(
    readFileSync(
      createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm"),
    ),
  ));

// 进入沙箱后立刻执行的一段：把宿主函数包成脚本看到的钩子，禁掉不确定的函数，最后把裸宿主函数从全局删掉。
const prelude = (maxItems: number) => `
(() => {
  const G = globalThis;
  const hostAgent = G.__agent, hostUsage = G.__usage, hostPhase = G.__phase, hostLog = G.__log;
  const MAX = ${maxItems};
  const usage = (m) => { hostUsage(String(m)); throw new Error(String(m)); };
  const text = (v) => {
    if (typeof v === "string") return v;
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
  };

  G.agent = (prompt, opts) => {
    if (typeof prompt !== "string" || prompt.trim() === "")
      usage("agent(prompt, opts): prompt must be a non-empty string");
    let o = "{}";
    if (opts !== undefined) {
      if (typeof opts !== "object" || opts === null || Array.isArray(opts))
        usage("agent(prompt, opts): opts must be an object");
      try { o = JSON.stringify(opts); } catch { usage("agent(prompt, opts): opts must be plain JSON"); }
    }
    return hostAgent(prompt, o);
  };
  G.phase = (title) => {
    if (typeof title !== "string" || title.trim() === "") usage("phase(title): title must be a non-empty string");
    hostPhase(title);
  };
  G.log = (message) => { hostLog(text(message)); };
  G.console = { log: G.log, info: G.log, warn: G.log, error: G.log };

  const checkItems = (what, items) => {
    if (!Array.isArray(items)) usage(what + " takes an array");
    if (items.length > MAX) usage(what + " got " + items.length + " items; the limit is " + MAX + " per call. Split the work into batches.");
  };
  G.parallel = async (thunks) => {
    checkItems("parallel()", thunks);
    for (const t of thunks)
      if (typeof t !== "function") usage("parallel() takes an array of functions, e.g. parallel(items.map((x) => () => agent(...)))");
    return Promise.all(thunks.map((t) => Promise.resolve().then(t).then((v) => (v === undefined ? null : v), () => null)));
  };
  G.pipeline = async (items, ...stages) => {
    checkItems("pipeline()", items);
    if (stages.length === 0) usage("pipeline(items, stage1, stage2, ...) needs at least one stage");
    for (const s of stages) if (typeof s !== "function") usage("pipeline() stages must be functions (prev, item, index) => ...");
    return Promise.all(items.map(async (item, i) => {
      let v = item;
      try { for (const s of stages) v = await s(v, item, i); } catch { return null; }
      return v === undefined ? null : v;
    }));
  };

  // 不确定的函数：报错，不是返回一个假值（将来按重放恢复的前提）
  const banned = (what) => () => usage(what + " is not allowed in workflow scripts: it would make runs non-repeatable");
  Math.random = banned("Math.random");
  const RealDate = Date;
  const NoClockDate = function (...a) {
    if (!new.target) return banned("Date()")();
    if (a.length === 0) return banned("new Date() without arguments")();
    return new RealDate(...a);
  };
  NoClockDate.prototype = RealDate.prototype;
  // 否则 new Date(0).constructor 就是真的 Date，.now() 又能读时钟
  Object.defineProperty(RealDate.prototype, "constructor", { value: NoClockDate, writable: true, configurable: true });
  NoClockDate.now = banned("Date.now");
  NoClockDate.parse = RealDate.parse;
  NoClockDate.UTC = RealDate.UTC;
  G.Date = NoClockDate;

  // 返回值必须是纯 JSON：拒绝函数、symbol、undefined 嵌套、NaN / Infinity、环
  G.__toJson = (v) => {
    const seen = new Set();
    const walk = (x, path) => {
      if (x === null || typeof x === "boolean" || typeof x === "string") return;
      if (typeof x === "number") { if (!Number.isFinite(x)) throw new Error("the return value has a non-finite number at " + path); return; }
      if (typeof x !== "object") throw new Error("the return value has a " + typeof x + " at " + path);
      if (seen.has(x)) throw new Error("the return value has a cycle at " + path);
      seen.add(x);
      if (Array.isArray(x)) x.forEach((e, i) => walk(e, path + "[" + i + "]"));
      else for (const k of Object.keys(x)) walk(x[k], path + "." + k);
      seen.delete(x);
    };
    walk(v === undefined ? null : v, "$");
    return JSON.stringify(v === undefined ? null : v);
  };

  delete G.__agent; delete G.__usage; delete G.__phase; delete G.__log;
})();
`;

const messageOf = (vm: QuickJS, h: JSValueHandle): string => {
  try {
    const m = vm.dump(h.getProp("message"));
    return typeof m === "string" && m !== "" ? m : String(vm.dump(h));
  } catch {
    return "unknown error";
  }
};

/** 跑一段脚本：脚本是一个 async 函数体，可以直接 await，用 return 给出结果（纯 JSON）。 */
export async function runScript(
  script: string,
  args: unknown,
  host: SandboxHost,
  o: {
    signal?: AbortSignal;
    memoryBytes?: number;
    segmentMs?: number;
    maxItemsPerCall?: number;
  } = {},
): Promise<SandboxResult> {
  const segmentMs = o.segmentMs ?? SANDBOX_DEFAULTS.segmentMs;
  const maxItems = o.maxItemsPerCall ?? SANDBOX_DEFAULTS.maxItemsPerCall;
  let segStart = Date.now();
  let timedOut = false;
  let closed = false;
  // 第一个致命问题（用错钩子 / 宿主故障）：记下来，之后不管脚本怎么 catch 都让整次运行失败
  let fatal: { kind: "usage" | "runtime"; error: string } | null = null;
  let wake: () => void = () => {};
  const woken = new Promise<void>((r) => {
    wake = r;
  });
  const fail = (kind: "usage" | "runtime", error: string) => {
    fatal ??= { kind, error };
    wake();
  };
  const aborted = () => o.signal?.aborted === true;
  const timeoutText = `Script computed for more than ${segmentMs} ms without waiting for an agent (an endless loop?).`;
  o.signal?.addEventListener("abort", () => wake(), { once: true });

  const vm = await QuickJS.create({
    wasm: await compiled(),
    memoryLimit: o.memoryBytes ?? SANDBOX_DEFAULTS.memoryBytes,
    // 去掉 performance（又一个时钟）
    intrinsics: Intrinsics.ALL & ~Intrinsics.PERFORMANCE,
    interruptHandler: () => {
      if (aborted()) return true;
      if (Date.now() - segStart > segmentMs) {
        timedOut = true;
        return true;
      }
      return false;
    },
  });

  const pump = () => {
    if (closed) return;
    segStart = Date.now();
    try {
      vm.executePendingJobs();
    } catch (e) {
      // 超时 / 中止时引擎会把中断抛到这里而不是让脚本的 promise 失败：叫醒主流程，由它按原因收尾
      if (!aborted() && !timedOut)
        fail("runtime", `engine error: ${String(e)}`);
      else wake();
    }
  };

  try {
    const global = vm.global;
    global.setProp(
      "__usage",
      vm.newFunction("__usage", (m) => {
        fail("usage", String(vm.dump(m)));
        return vm.getUndefined();
      }),
    );
    global.setProp(
      "__phase",
      vm.newFunction("__phase", (t) => {
        host.phase(String(vm.dump(t)));
        return vm.getUndefined();
      }),
    );
    global.setProp(
      "__log",
      vm.newFunction("__log", (m) => {
        host.log(String(vm.dump(m)));
        return vm.getUndefined();
      }),
    );
    global.setProp(
      "__agent",
      vm.newFunction("__agent", (p, opts) => {
        const prompt = String(vm.dump(p));
        const d = vm.newPromise();
        const settle = (f: () => void) => {
          if (closed) return;
          try {
            f();
          } catch (e) {
            // 把结果递给沙箱失败（比如内存已满）：这是引擎故障，不能变成未处理的 rejection
            fail("runtime", `engine error: ${String(e)}`);
          } finally {
            pump();
          }
        };
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(String(vm.dump(opts))) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        host.agent(prompt, parsed).then(
          (v) =>
            settle(() => {
              const h = vm.hostToHandle(v ?? null);
              d.resolve(h);
              h.dispose?.();
            }),
          (e: unknown) =>
            settle(() => {
              const msg = e instanceof Error ? e.message : String(e);
              if (e instanceof UsageError) fail("usage", msg);
              else if (!aborted()) fail("runtime", `agent host error: ${msg}`);
              const err = vm.newError(msg);
              d.reject(err);
              err.dispose?.();
            }),
        );
        return d.handle;
      }),
    );
    vm.evalCode(prelude(maxItems)).dispose?.();
    const a = vm.hostToHandle(args ?? null);
    global.setProp("args", a);
    a.dispose?.();

    segStart = Date.now();
    let main: JSValueHandle;
    try {
      main = vm.evalCode(`(async () => {\n${script}\n})()`, "workflow.js");
    } catch (e) {
      if (aborted())
        return { ok: false, kind: "stopped", error: "The run was stopped." };
      if (fatal)
        return {
          ok: false,
          ...(fatal as { kind: "usage" | "runtime"; error: string }),
        };
      if (timedOut) return { ok: false, kind: "script", error: timeoutText };
      const why = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        kind: "script",
        error: `Script error: ${why.split("\n")[0]}`,
      };
    }
    const settled = vm.resolvePromise(main);
    pump();

    const first = await Promise.race([settled, woken.then(() => null)]);
    if (aborted())
      return { ok: false, kind: "stopped", error: "The run was stopped." };
    if (fatal)
      return {
        ok: false,
        ...(fatal as { kind: "usage" | "runtime"; error: string }),
      };
    if (timedOut) return { ok: false, kind: "script", error: timeoutText };
    if (first === null)
      return {
        ok: false,
        kind: "runtime",
        error: "engine stopped unexpectedly",
      };
    if ("error" in first) {
      const msg = messageOf(vm, first.error);
      return {
        ok: false,
        kind: "script",
        error: /out of memory|memory limit/i.test(msg)
          ? "Script exceeded the sandbox memory limit."
          : `Script error: ${msg}`,
      };
    }
    try {
      segStart = Date.now();
      const toJson = global.getProp("__toJson");
      const json = vm.callFunction(toJson, vm.getUndefined(), first.value);
      return { ok: true, value: JSON.parse(String(vm.dump(json))) as unknown };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        kind: "script",
        error: `Script error: ${why.split("\n")[0]}`,
      };
    }
  } finally {
    closed = true;
    vm.dispose();
  }
}
