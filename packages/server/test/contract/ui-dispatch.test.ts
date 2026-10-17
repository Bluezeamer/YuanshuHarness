import "./isolate.js";
import { afterAll, expect, test } from "vitest";
import { at, makeEnv, openSession, startStub, writeModels } from "./harness.js";

// R6：单槽位界面（confirm/select/input）能被 Server 接管并分发。
const stub = await startStub();
afterAll(() => stub.close());

type Opts = { signal?: AbortSignal; timeout?: number } | undefined;
type Call = { kind: string; title: string; opts: Opts };

// 其余界面方法都是终端渲染相关，Server 不需要，一律空实现。
function makeUi(handlers: {
  confirm?: (c: Call) => Promise<boolean>;
  select?: (c: Call) => Promise<string | undefined>;
  input?: (c: Call) => Promise<string | undefined>;
}) {
  const calls: Call[] = [];
  const noop = () => undefined;
  const ui = new Proxy(
    {
      confirm: (title: string, _m: string, opts: Opts) => {
        const c = { kind: "confirm", title, opts };
        calls.push(c);
        return (handlers.confirm ?? (async () => false))(c);
      },
      select: (title: string, _o: string[], opts: Opts) => {
        const c = { kind: "select", title, opts };
        calls.push(c);
        return (handlers.select ?? (async () => undefined))(c);
      },
      input: (title: string, _p: string | undefined, opts: Opts) => {
        const c = { kind: "input", title, opts };
        calls.push(c);
        return (handlers.input ?? (async () => undefined))(c);
      },
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? noop },
  );
  return { ui: ui as never, calls };
}

// 先答先赢：同一次提问分发给多个接收方，第一个有结果的赢，其余通过 signal 被取消。
function fanOut<T>(
  receivers: Array<(signal: AbortSignal) => Promise<T>>,
  opts: Opts,
  fallback: T,
): Promise<T> {
  const ac = new AbortController();
  opts?.signal?.addEventListener("abort", () => ac.abort());
  return new Promise<T>((resolve) => {
    let done = false;
    const finish = (v: T) => {
      if (done) return;
      done = true;
      ac.abort();
      resolve(v);
    };
    for (const r of receivers) r(ac.signal).then(finish, () => undefined);
    if (opts?.timeout) setTimeout(() => finish(fallback), opts.timeout);
  });
}

async function askVia(
  ui: never,
  command: (ctx: {
    ui: { confirm(t: string, m: string, o?: Opts): Promise<boolean> };
  }) => Promise<void>,
) {
  const env = makeEnv();
  writeModels(env, stub.url);
  const { session } = await openSession(env, {
    noTools: false,
    loader: {
      extensionFactories: [
        (pi) => {
          pi.registerCommand("ask", {
            handler: async (_a, ctx) => command(ctx as never),
          });
        },
      ],
    },
  });
  await session.bindExtensions({ uiContext: ui });
  await session.prompt("/ask");
  session.dispose();
}

test("R6 扩展里的 confirm 到达 Server 提供的 uiContext，选项（timeout/signal）原样透传，答案回到扩展", async () => {
  const { ui, calls } = makeUi({ confirm: async () => true });
  let answer: boolean | undefined;
  await askVia(ui, async (ctx) => {
    answer = await ctx.ui.confirm("Run rm?", "details", { timeout: 1234 });
  });
  expect(calls).toHaveLength(1);
  expect(at(calls, 0).title).toBe("Run rm?");
  expect(at(calls, 0).opts?.timeout).toBe(1234);
  expect(answer).toBe(true);
});

test("R6 分发：两个接收方抢答，先答先赢，另一方被取消", async () => {
  let slowSawAbort = false;
  const { ui } = makeUi({
    confirm: (c) =>
      fanOut<boolean>(
        [
          async () => true,
          (signal) =>
            new Promise<boolean>((resolve) => {
              signal.addEventListener("abort", () => {
                slowSawAbort = true;
                resolve(false);
              });
            }),
        ],
        c.opts,
        false,
      ),
  });
  let answer: boolean | undefined;
  await askVia(ui, async (ctx) => {
    answer = await ctx.ui.confirm("Which?", "m");
  });
  expect(answer).toBe(true);
  expect(slowSawAbort).toBe(true);
});

test("R6 超时：无人回答时按超时返回默认值", async () => {
  const { ui } = makeUi({
    confirm: (c) =>
      fanOut<boolean>(
        [() => new Promise<boolean>(() => undefined)],
        c.opts,
        false,
      ),
  });
  let answer: boolean | undefined;
  await askVia(ui, async (ctx) => {
    answer = await ctx.ui.confirm("Nobody?", "m", { timeout: 30 });
  });
  expect(answer).toBe(false);
});
