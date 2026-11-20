// 在页面自己的 JS 环境里跑一段脚本（browser_exec 的下层）：只有这个文件与 page.ts 碰 Playwright 的脚本执行。
// 不用 new Function / 异步函数构造器：带 CSP 的页面会因缺 unsafe-eval 抛 EvalError；
// Playwright 经 CDP 求值的字符串表达式不受页面 CSP 约束。
import type { Locator, Page } from "playwright-core";
import { needRef, STALE } from "./ref.js";
import type { ExecOutcome } from "./types.js";

/** 脚本多久没返回就算超时（死循环，或一直在等什么）。 */
export const EXEC_TIMEOUT_MS = 30_000;

const noop = () => {};

// 页面里要用的形状（server 的 tsconfig 不含 dom 库，只写用到的成员）。
interface Ctor {
  new (...args: never[]): unknown;
}
interface SerializeEnv {
  Window?: Ctor;
  Node?: Ctor;
  Error?: Ctor;
  JSON: {
    stringify(value: unknown, replacer: unknown, space?: number): string;
  };
  String: (value: unknown) => string;
}
interface DomNodeShape {
  nodeType: number;
  tagName?: string;
  nodeName?: string;
  id?: string;
  className?: unknown;
}

/**
 * 页面里的序列化器：把手边的东西写成 JSON 文字。会被序列化进浏览器执行，只能引用 globalThis。
 * 为什么要自己写：Playwright 对求值结果的序列化有深度上限（约 60 层），深对象直接交回去会报
 * `object reference chain is too long`；成串回来再解析就没有这个限制。
 * 只替换这些：函数、bigint、symbol、Map、Set、Error、DOM 节点、window、环、NaN / Infinity。
 */
function serializeResult(value: unknown): string {
  const g = globalThis as unknown as SerializeEnv;
  if (value === undefined) return "undefined";

  /** DOM 节点：元素写标签、id 与 class，其余节点写 nodeType。 */
  const nodeText = (node: DomNodeShape): string => {
    if (node.nodeType !== 1) return `[Node ${node.nodeType}]`;
    const tag = (node.tagName ?? node.nodeName ?? "?").toLowerCase();
    const id = node.id === undefined || node.id === "" ? "" : `#${node.id}`;
    const cls =
      typeof node.className === "string" && node.className.trim() !== ""
        ? `.${node.className.trim().split(/\s+/).join(".")}`
        : "";
    return `[Element <${tag}${id}${cls}>]`;
  };

  // 当前路径上的对象：JSON.stringify 的 `this` 是值的容器，也就是它的父层。
  const path: unknown[] = [];
  const replacer = function (
    this: unknown,
    _key: string,
    raw: unknown,
  ): unknown {
    const at = path.indexOf(this);
    if (at === -1) path.push(this);
    else path.length = at + 1;
    if (typeof raw === "function") {
      const name = (raw as { name?: string }).name ?? "";
      return name === "" ? "[Function]" : `[Function ${name}]`;
    }
    if (typeof raw === "bigint") return `${g.String(raw)}n`;
    if (typeof raw === "symbol") return g.String(raw);
    if (typeof raw === "number") {
      if (Number.isNaN(raw)) return "NaN";
      if (!Number.isFinite(raw)) return raw > 0 ? "Infinity" : "-Infinity";
      return raw;
    }
    if (typeof raw !== "object" || raw === null) return raw;
    // 环：这个对象已经出现在当前路径上。
    if (path.includes(raw)) return "[Circular]";
    if (g.Window !== undefined && raw instanceof g.Window) return "[Window]";
    if (g.Node !== undefined && raw instanceof g.Node)
      return nodeText(raw as DomNodeShape);
    if (raw instanceof Map) return { "[Map]": [...raw.entries()] };
    if (raw instanceof Set) return { "[Set]": [...raw.values()] };
    if (g.Error !== undefined && raw instanceof g.Error) {
      const e = raw as { name?: string; message?: string; stack?: string };
      return {
        name: e.name ?? "",
        message: e.message ?? "",
        stack: e.stack ?? "",
      };
    }
    return raw;
  };

  try {
    return g.JSON.stringify(value, replacer, 2);
  } catch (e) {
    const message = e instanceof Error ? e.message : g.String(e);
    return `[unserializable: ${message}]`;
  }
}

/** 页面里把抛出来的东西写成一句能直接显示的话：name: message 加栈的前几行。 */
function formatThrown(thrown: unknown): string {
  const g = globalThis as unknown as SerializeEnv;
  if (g.Error !== undefined && thrown instanceof g.Error) {
    const e = thrown as { name?: string; message?: string; stack?: string };
    const head = `${e.name ?? "Error"}: ${e.message ?? ""}`;
    const lines = (e.stack ?? "").split("\n").filter((l) => l.trim() !== "");
    // 栈的第一行与 head 重复：去掉。
    const rest = lines[0] === head ? lines.slice(1) : lines;
    return [head, ...rest.slice(0, 6)].join("\n");
  }
  return g.String(thrown);
}

/**
 * 交给页面求值的表达式：外层一个 async 函数里放序列化器，用户脚本自己再套一层，
 * 它的局部变量不会和外层撞名。给 ref 时外层收元素参数，用户那层转交下去。
 */
function expressionFor(script: string, withEl: boolean): string {
  const params = withEl ? "el" : "";
  return [
    withEl ? "async (el) => {" : "async () => {",
    `const __ser = ${serializeResult.toString()};`,
    `const __fmt = ${formatThrown.toString()};`,
    "try {",
    `  const __r = await (async (${params}) => {`,
    // 各行用换行连接：脚本以行注释结尾时不会吞掉后面的收尾括号。
    script,
    `  })(${params});`,
    "  return { v: __ser(__r) };",
    "} catch (e) {",
    "  return { t: __fmt(e) };",
    "}",
    "}",
  ].join("\n");
}

interface RawOutcome {
  v?: string;
  t?: string;
}

/**
 * 把表达式字符串扮成一个函数的 toString：Playwright 先 String(pageFunction) 再按
 * 「是的，是函数」去调它（把元素参数交进来），这是唯一能把表达式交给 CDP 求值又能拿到 el 的办法。
 */
function asFunction(expression: string): () => void {
  const fn = () => undefined;
  Object.defineProperty(fn, "toString", { value: () => expression });
  return fn;
}

/** 到点就抛超时；原来的 promise 还在跑，只能不管它（调用方已经挂上 catch）。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `脚本 ${Math.round(timeoutMs / 1000)} 秒内没有返回（死循环，或一直在等什么？）。页面里的脚本可能还在跑，必要时关掉页面重开`,
        ),
      );
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 在页面里跑脚本：ref 给了就往那个元素上求值（函数体里多一个 el），没给就在页面全局环境里跑。
 * timeoutMs 只给测试用（死循环那条用例要小超时）。
 */
export async function runScript(
  page: Page,
  script: string,
  ref: string | null,
  timeoutMs: number = EXEC_TIMEOUT_MS,
): Promise<ExecOutcome> {
  let target: Page | Locator = page;
  if (ref !== null) {
    needRef(ref);
    const locator = page.locator(`aria-ref=${ref}`);
    if ((await locator.count()) === 0) throw new Error(STALE);
    target = locator;
  }
  // 表达式字符串扮成函数交给 Playwright：它按字符串求值（不受页面 CSP 约束），按函数去调用
  // （给 ref 时把元素作为参数交进来），并把返回值当值交回来。
  const expression = asFunction(expressionFor(script, ref !== null));
  const call = (target === page
    ? page.evaluate(expression)
    : (target as Locator).evaluate(
        expression,
      )) as unknown as Promise<RawOutcome>;
  // 超时之后原来的 promise 还在：它的拒绝要有人接手，否则是 unhandled rejection。
  call.catch(noop);
  const raw = await withTimeout(call, timeoutMs);
  if (raw.t !== undefined) return { kind: "threw", message: raw.t };
  return { kind: "value", json: raw.v ?? "undefined" };
}
