import "./isolate.js";
import { afterAll, expect, test } from "vitest";
import { at, makeEnv, openSession, startStub, writeModels } from "./harness.js";

// R6：单槽位界面（confirm/select/input）被 SDK 原样委托给 Server 提供的 uiContext。
// 先答先赢、超时默认值属于 Server 层的实现，留给 ROADMAP 第 3 条；这里只验证 Server 有这个接管点。
const stub = await startStub();
afterAll(() => stub.close());

type Opts = { signal?: AbortSignal; timeout?: number } | undefined;
type Call = { kind: string; title: string; opts: Opts };
type Answers = {
  confirm?: boolean;
  select?: string;
  input?: string;
  hang?: boolean;
};
type DialogCtx = {
  ui: {
    confirm(t: string, m: string, o?: Opts): Promise<boolean>;
    select(t: string, o: string[], opts?: Opts): Promise<string | undefined>;
    input(t: string, p?: string, o?: Opts): Promise<string | undefined>;
  };
};

// 其余界面方法都是终端渲染相关，Server 不需要，一律空实现。
function makeUi(answers: Answers) {
  const calls: Call[] = [];
  const noop = () => undefined;
  const reply = <T>(c: Call, v: T): Promise<T> => {
    calls.push(c);
    return answers.hang ? new Promise<T>(() => undefined) : Promise.resolve(v);
  };
  const ui = new Proxy(
    {
      confirm: (title: string, _m: string, opts: Opts) =>
        reply({ kind: "confirm", title, opts }, answers.confirm ?? false),
      select: (title: string, _o: string[], opts: Opts) =>
        reply({ kind: "select", title, opts }, answers.select),
      input: (title: string, _p: string | undefined, opts: Opts) =>
        reply({ kind: "input", title, opts }, answers.input),
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? noop },
  );
  return { ui: ui as never, calls };
}

async function askVia(ui: never, command: (ctx: DialogCtx) => Promise<void>) {
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
  return session;
}

test("R6 confirm 到达 Server 的 uiContext，timeout/signal 原样透传，答案回到扩展", async () => {
  const { ui, calls } = makeUi({ confirm: true });
  const ac = new AbortController();
  let answer: boolean | undefined;
  const session = await askVia(ui, async (ctx) => {
    answer = await ctx.ui.confirm("Run rm?", "details", {
      timeout: 1234,
      signal: ac.signal,
    });
  });
  await session.prompt("/ask");
  session.dispose();
  expect(at(calls, 0).title).toBe("Run rm?");
  expect(at(calls, 0).opts?.timeout).toBe(1234);
  expect(at(calls, 0).opts?.signal).toBeInstanceOf(AbortSignal);
  expect(answer).toBe(true);
});

test("R6 select 与 input 同样被接管，答案回到扩展", async () => {
  const { ui, calls } = makeUi({ select: "B", input: "typed" });
  const got: Array<string | undefined> = [];
  const session = await askVia(ui, async (ctx) => {
    got.push(await ctx.ui.select("Pick", ["A", "B"], { timeout: 50 }));
    got.push(await ctx.ui.input("Name?", "placeholder"));
  });
  await session.prompt("/ask");
  session.dispose();
  expect(calls.map((c) => c.kind)).toEqual(["select", "input"]);
  expect(at(calls, 0).opts?.timeout).toBe(50);
  expect(got).toEqual(["B", "typed"]);
});

test("R6 SDK 不自行强制 timeout：uiContext 不返回时扩展会一直等（超时必须由 Server 实现）", async () => {
  const { ui } = makeUi({ hang: true });
  let finished = false;
  const session = await askVia(ui, async (ctx) => {
    await ctx.ui.confirm("Nobody?", "m", { timeout: 30 });
    finished = true;
  });
  const pending = session.prompt("/ask").then(() => "done");
  const raced = await Promise.race([
    pending,
    new Promise<string>((r) => setTimeout(() => r("still-waiting"), 400)),
  ]);
  expect(raced).toBe("still-waiting");
  expect(finished).toBe(false);
});
