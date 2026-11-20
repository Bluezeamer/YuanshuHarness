// 画面流中枢的每条规则：推流、观看计数、操作窗口、输入门禁、导航与清理。
// 全部用替身：不装浏览器、不起 HTTP。
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type { ConsoleEntry } from "../engine/types.js";
import {
  cleanupTmpDirs,
  type FakePage,
  type Harness,
  makeRegistry,
} from "../pages/testkit.js";
import type { PageView } from "../pages/types.js";
import { StreamHub, type StreamHubDeps, type Viewer } from "./hub.js";
import { FRAME_OPTS, type StreamEvent } from "./protocol.js";

afterAll(cleanupTmpDirs);

class Recorder implements Viewer {
  readonly events: StreamEvent[] = [];
  readonly frames: Buffer[] = [];

  event(e: StreamEvent): void {
    this.events.push(e);
  }

  frame(jpeg: Buffer): void {
    this.frames.push(jpeg);
  }

  states(): Array<Extract<StreamEvent, { type: "state" }>> {
    return this.events.filter(
      (e): e is Extract<StreamEvent, { type: "state" }> => e.type === "state",
    );
  }

  /** 最后一次收到的 state。 */
  last(): Extract<StreamEvent, { type: "state" }> | undefined {
    return this.states().at(-1);
  }

  errors(): string[] {
    return this.events.flatMap((e) => (e.type === "error" ? [e.message] : []));
  }

  consoles(): ConsoleEntry[] {
    return this.events.flatMap((e) => (e.type === "console" ? [e.entry] : []));
  }

  /** 收到的「页面自己写了剪贴板」事件里的文字。 */
  clipboards(): string[] {
    return this.events.flatMap((e) => (e.type === "clipboard" ? [e.text] : []));
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

interface Setup {
  h: Harness;
  hub: StreamHub;
  /** 传给注册表的「用户操作了页面」的页面 id。 */
  notes: string[];
  watches: { taken: number; released: number };
  subs: { taken: number; released: number };
  /** 让它之后返回 null，模拟页面已从注册表消失。 */
  hide(pageId: string): void;
  open(opts?: {
    controller?: "agent" | "user";
    url?: string;
  }): Promise<PageView>;
}

function setup(
  overrides: Partial<StreamHubDeps> = {},
  deps: Partial<Parameters<typeof makeRegistry>[0]> = {},
): Setup {
  const h = makeRegistry(deps);
  const notes: string[] = [];
  const watches = { taken: 0, released: 0 };
  const subs = { taken: 0, released: 0 };
  const hidden = new Set<string>();
  const hub = new StreamHub({
    registry: {
      get: (id) => (hidden.has(id) ? null : h.registry.get(id)),
      peek: (id) => h.registry.peek(id),
      subscribe: (cb) => {
        subs.taken += 1;
        const off = h.registry.subscribe(cb);
        return () => {
          subs.released += 1;
          off();
        };
      },
      watch: (id) => {
        watches.taken += 1;
        const off = h.registry.watch(id);
        return () => {
          watches.released += 1;
          off();
        };
      },
      noteActivity: (id) => {
        notes.push(id);
        h.registry.noteActivity(id);
      },
    },
    resolveGoto: (_workspaceKey, raw) => ({ ok: true, url: `https://${raw}/` }),
    ...overrides,
  });
  return {
    h,
    hub,
    notes,
    watches,
    subs,
    hide: (id) => hidden.add(id),
    async open(opts = {}) {
      const controller = opts.controller ?? "user";
      const r = await h.registry.open({
        workspaceKey: "w1",
        actor: controller === "user" ? null : "s1",
        url: opts.url ?? "https://a.test/",
      });
      return r.page;
    },
  };
}

const handleOf = (h: Harness, id: string) => h.registry.peek(id) as FakePage;

const frame = (n: number) => Buffer.from(`jpeg-${n}`);

describe("连接与状态", () => {
  test("页面不存在时 attach 返回 null", () => {
    const s = setup();
    expect(s.hub.attach("nope", new Recorder())).toBeNull();
  });

  test("第一个连接立刻收到 state 且是操作窗口，第二个不是", async () => {
    const s = setup();
    const page = await s.open();
    const a = new Recorder();
    const b = new Recorder();
    s.hub.attach(page.id, a);
    s.hub.attach(page.id, b);

    expect(a.last()).toMatchObject({ page: { id: page.id }, operator: true });
    expect(b.last()).toMatchObject({ page: { id: page.id }, operator: false });
    expect(a.events[0]?.type).toBe("state");
  });
});

describe("推流", () => {
  test("第一个连接开推，参数是 FRAME_OPTS；第二个不重复开", async () => {
    const s = setup();
    const page = await s.open();
    const a = s.hub.attach(page.id, new Recorder());
    const handle = handleOf(s.h, page.id);
    expect(handle.screencastOpts).toEqual(FRAME_OPTS);
    expect(handle.calls.filter((c) => c === "startScreencast")).toHaveLength(1);

    s.hub.attach(page.id, new Recorder());
    expect(handle.calls.filter((c) => c === "startScreencast")).toHaveLength(1);
    a?.detach();
  });

  test("最后一个连接离开才停推流", async () => {
    const s = setup();
    const page = await s.open();
    const handle = handleOf(s.h, page.id);
    const a = s.hub.attach(page.id, new Recorder());
    const b = s.hub.attach(page.id, new Recorder());

    a?.detach();
    expect(handle.calls).not.toContain("stopScreencast");
    b?.detach();
    expect(handle.calls).toContain("stopScreencast");
    expect(handle.screencastOpts).toBeNull();
  });

  test("一帧分发给所有连接，新连接立刻补上最后一帧", async () => {
    const s = setup();
    const page = await s.open();
    const a = new Recorder();
    s.hub.attach(page.id, a);
    await handleOf(s.h, page.id).pushFrame(frame(1));
    expect(a.frames).toEqual([frame(1)]);

    // 推流只在画面变化时出帧：新窗口要靠补发才不会一直空白。
    const b = new Recorder();
    s.hub.attach(page.id, b);
    expect(b.frames).toEqual([frame(1)]);

    await handleOf(s.h, page.id).pushFrame(frame(2));
    expect(a.frames).toEqual([frame(1), frame(2)]);
    expect(b.frames).toEqual([frame(1), frame(2)]);
  });

  test("旧推流迟到的一帧不分发、也不缓存", async () => {
    const s = setup();
    const page = await s.open();
    const old = handleOf(s.h, page.id);
    // 真引擎里 stopScreencast 是异步的，停之前已在途的帧还会回调：把回调留下来模拟。
    let late: (jpeg: Buffer) => void | Promise<void> = () => {};
    const start = old.startScreencast.bind(old);
    old.startScreencast = async (opts, onFrame) => {
      late = onFrame;
      return start(opts, onFrame);
    };
    const a = new Recorder();
    s.hub.attach(page.id, a);

    s.h.registry.onEngineCrash();
    await s.h.registry.activate(page.id);
    await late(frame(9));

    expect(a.frames).toEqual([]);
    const b = new Recorder();
    s.hub.attach(page.id, b);
    expect(b.frames).toEqual([]);
  });

  test("推流启动失败：每个观看的窗口都收到一条说明（只取原因首行）", async () => {
    const s = setup();
    const page = await s.open();
    handleOf(s.h, page.id).startScreencast = async () => {
      throw new Error("Target closed\n    at somewhere");
    };
    const a = new Recorder();
    const b = new Recorder();
    s.hub.attach(page.id, a);
    s.hub.attach(page.id, b);
    await Promise.resolve();
    await Promise.resolve();

    expect(a.errors()).toEqual(["画面流没能启动：Target closed"]);
    expect(b.errors()).toEqual(["画面流没能启动：Target closed"]);
  });

  test("启动期间句柄已被换掉：旧推流的失败不吵用户", async () => {
    const s = setup();
    const page = await s.open();
    const old = handleOf(s.h, page.id);
    let fail: (e: Error) => void = () => {};
    old.startScreencast = () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      });
    const a = new Recorder();
    s.hub.attach(page.id, a);

    s.h.registry.onEngineCrash();
    await s.h.registry.activate(page.id);
    fail(new Error("Target closed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(a.errors()).toEqual([]);
  });

  test("换句柄（崩溃后唤醒）：停旧的、开新的、旧帧作废", async () => {
    const s = setup();
    const page = await s.open();
    const a = new Recorder();
    s.hub.attach(page.id, a);
    const old = handleOf(s.h, page.id);
    await old.pushFrame(frame(1));

    s.h.registry.onEngineCrash();
    expect(old.calls).toContain("stopScreencast");

    await s.h.registry.activate(page.id);
    const fresh = handleOf(s.h, page.id);
    expect(fresh).not.toBe(old);
    expect(fresh.screencastOpts).toEqual(FRAME_OPTS);
    expect(a.last()?.page.state).toBe("active");

    // 旧画面不能补给后来加入的窗口。
    const b = new Recorder();
    s.hub.attach(page.id, b);
    expect(b.frames).toEqual([]);

    await fresh.pushFrame(frame(2));
    expect(b.frames).toEqual([frame(2)]);
    expect(a.frames.at(-1)).toEqual(frame(2));
  });
});

describe("休眠页", () => {
  test("只发 state、不推画面、不开推流", async () => {
    const s = setup({}, { limits: { perWorkspace: 1 } });
    const a = await s.open({ controller: "agent", url: "https://a.test/" });
    await s.open({ controller: "agent", url: "https://b.test/" });
    expect(s.h.registry.get(a.id)?.state).toBe("sleeping");

    const rec = new Recorder();
    s.hub.attach(a.id, rec);
    expect(rec.last()?.page.state).toBe("sleeping");
    expect(rec.states()).toHaveLength(1);
    expect(rec.frames).toEqual([]);
    expect(s.h.ctx("w1").pages.some((p) => p.screencastOpts !== null)).toBe(
      false,
    );
  });

  test("唤醒后自动开始推画面", async () => {
    const s = setup({}, { limits: { perWorkspace: 1 } });
    const a = await s.open({ controller: "agent", url: "https://a.test/" });
    await s.open({ controller: "agent", url: "https://b.test/" });
    const rec = new Recorder();
    s.hub.attach(a.id, rec);
    expect(rec.frames).toEqual([]);

    await s.h.registry.activate(a.id);
    const handle = handleOf(s.h, a.id);
    expect(handle.screencastOpts).toEqual(FRAME_OPTS);
    await handle.pushFrame(frame(1));
    expect(rec.frames).toEqual([frame(1)]);
  });
});

describe("观看计数", () => {
  test("attach 加一、detach 归零，重复 detach 不多减", async () => {
    const s = setup();
    const page = await s.open();
    const att = s.hub.attach(page.id, new Recorder());
    expect(s.h.registry.get(page.id)?.viewers).toBe(1);
    att?.detach();
    expect(s.h.registry.get(page.id)?.viewers).toBe(0);
    expect(() => att?.detach()).not.toThrow();
    expect(s.h.registry.get(page.id)?.viewers).toBe(0);
  });

  test("页面被关时观看计数也释放掉", async () => {
    const s = setup();
    const page = await s.open();
    const att = s.hub.attach(page.id, new Recorder());
    expect(s.watches).toEqual({ taken: 1, released: 0 });
    await s.h.registry.close(page.id, "user");
    expect(s.watches).toEqual({ taken: 1, released: 1 });
    // 连接层之后还会调一次 detach，不能重复释放。
    att?.detach();
    expect(s.watches).toEqual({ taken: 1, released: 1 });
  });
});

describe("控制台", () => {
  const entry = (text: string): ConsoleEntry => ({
    id: 1,
    ts: 1,
    firstTs: 1,
    count: 1,
    kind: "console",
    level: "log",
    text,
  });

  test("新条目分发给所有连接", async () => {
    const s = setup();
    const page = await s.open();
    const a = new Recorder();
    const b = new Recorder();
    s.hub.attach(page.id, a);
    s.hub.attach(page.id, b);

    handleOf(s.h, page.id).emitConsole(entry("hi"));
    expect(a.consoles().map((e) => e.text)).toEqual(["hi"]);
    expect(b.consoles().map((e) => e.text)).toEqual(["hi"]);
  });

  test("换句柄后订阅跟着换，旧句柄的条目不再分发", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    s.hub.attach(page.id, rec);
    const old = handleOf(s.h, page.id);

    s.h.registry.onEngineCrash();
    await s.h.registry.activate(page.id);
    const fresh = handleOf(s.h, page.id);

    old.emitConsole(entry("old"));
    fresh.emitConsole(entry("new"));
    expect(rec.consoles().map((e) => e.text)).toEqual(["new"]);
  });
});

describe("页面被关", () => {
  test("所有连接收到 closed，条目清干净，之后再 attach 返回 null", async () => {
    const s = setup();
    const page = await s.open();
    const a = new Recorder();
    const b = new Recorder();
    s.hub.attach(page.id, a);
    s.hub.attach(page.id, b);

    await s.h.registry.close(page.id, "user");
    expect(a.types()).toContain("closed");
    expect(b.types()).toContain("closed");
    expect(s.hub.attach(page.id, new Recorder())).toBeNull();
    expect(s.watches.released).toBe(2);
  });
});

describe("操作窗口", () => {
  test("最早的窗口是操作窗口；它离开后下一个接任", async () => {
    const s = setup();
    const page = await s.open();
    const a = new Recorder();
    const b = new Recorder();
    const attA = s.hub.attach(page.id, a);
    const attB = s.hub.attach(page.id, b);
    expect(a.last()?.operator).toBe(true);
    expect(b.last()?.operator).toBe(false);

    attA?.detach();
    expect(b.last()?.operator).toBe(true);
    expect(b.states().map((s) => s.operator)).toEqual([false, true]);

    // 接任的窗口现在能操作。
    await attB?.handle({ type: "nav", action: "reload" });
    expect(b.errors()).toEqual([]);
    expect(handleOf(s.h, page.id).calls).toContain("reload");
  });

  test("take 抢占，原来的收到 operator:false", async () => {
    const s = setup();
    const page = await s.open();
    const a = new Recorder();
    const b = new Recorder();
    s.hub.attach(page.id, a);
    const attB = s.hub.attach(page.id, b);
    await attB?.handle({ type: "take" });

    expect(a.last()?.operator).toBe(false);
    expect(b.last()?.operator).toBe(true);
    // 已经拿着窗口的再 take 不重复播状态
    await attB?.handle({ type: "take" });
    expect(b.states()).toHaveLength(2);
  });

  test("身份没变的窗口不重复收 state", async () => {
    const s = setup();
    const page = await s.open();
    s.hub.attach(page.id, new Recorder());
    const b = new Recorder();
    s.hub.attach(page.id, b);
    const attC = s.hub.attach(page.id, new Recorder());
    const before = b.states().length;

    // c 抢占：a 变成非操作窗口，b 一直不是，不该再收到内容相同的 state。
    await attC?.handle({ type: "take" });
    expect(b.states()).toHaveLength(before);
  });

  test("非操作窗口的 input / nav 被拒并回 error", async () => {
    const s = setup();
    const page = await s.open();
    s.hub.attach(page.id, new Recorder());
    const b = new Recorder();
    const attB = s.hub.attach(page.id, b);

    await attB?.handle({ type: "input", event: { type: "text", text: "hi" } });
    await attB?.handle({ type: "nav", action: "reload" });
    expect(b.errors()).toEqual([
      "另一个窗口正在操作这个页面；点「接管操作」后再试",
      "另一个窗口正在操作这个页面；点「接管操作」后再试",
    ]);
    expect(handleOf(s.h, page.id).calls).not.toContain("input text");
    expect(handleOf(s.h, page.id).calls).not.toContain("reload");
  });
});

describe("输入门禁", () => {
  const text = { type: "input", event: { type: "text", text: "hi" } };

  test("页面由 agent 操作时拒绝", async () => {
    const s = setup();
    const page = await s.open({ controller: "agent" });
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    await att?.handle(text);
    expect(rec.errors()).toEqual([
      "页面当前由 agent 操作；点「手动操作」后才能输入",
    ]);
    expect(handleOf(s.h, page.id).inputs).toEqual([]);
  });

  test("页面休眠时拒绝", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    s.h.registry.onEngineCrash();
    await att?.handle(text);
    expect(rec.errors().at(-1)).toBe("页面已休眠，请先唤醒");
  });

  test("顺序：由 agent 操作优先于非操作窗口，休眠优先于由 agent 操作", async () => {
    const s = setup();
    const page = await s.open({ controller: "agent" });
    s.hub.attach(page.id, new Recorder());
    const b = new Recorder();
    const attB = s.hub.attach(page.id, b);
    await attB?.handle(text);
    expect(b.errors().at(-1)).toBe(
      "页面当前由 agent 操作；点「手动操作」后才能输入",
    );

    s.h.registry.onEngineCrash();
    await attB?.handle(text);
    expect(b.errors().at(-1)).toBe("页面已休眠，请先唤醒");
  });

  test("页面已关闭时拒绝；take 同样回「页面已关闭」", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    // 注册表里已经没有这一页（页面条目还没被 removed 清掉的那种窗口期）。
    s.hide(page.id);
    await att?.handle(text);
    await att?.handle({ type: "take" });
    expect(rec.errors()).toEqual(["页面已关闭", "页面已关闭"]);
  });

  test("通过后真的输入、只拷认识的字段、并刷新最近使用", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    const before = s.h.registry.get(page.id)?.lastUsedAt;
    s.h.clock.now += 60_000;

    await att?.handle({
      type: "input",
      event: { type: "mouse", action: "down", x: 12, y: 34, evil: 1 },
    });
    await att?.handle({ type: "input", event: { type: "text", text: "你好" } });
    const inputs = handleOf(s.h, page.id).inputs;
    expect(inputs).toEqual([
      { type: "mouse", action: "down", x: 12, y: 34 },
      { type: "text", text: "你好" },
    ]);
    expect(rec.errors()).toEqual([]);
    expect(s.notes).toEqual([page.id, page.id]);
    expect(s.h.registry.get(page.id)?.lastUsedAt).not.toBe(before);
  });
});

describe("复制页面里选中的文字", () => {
  test("只回给发起的窗口，且不算「用过页面」", async () => {
    const s = setup();
    const page = await s.open();
    const a = new Recorder();
    const att = s.hub.attach(page.id, a);
    const b = new Recorder();
    s.hub.attach(page.id, b);
    handleOf(s.h, page.id).selected = "划选的字";

    await att?.handle({ type: "copy" });
    expect(a.events.at(-1)).toEqual({ type: "copied", text: "划选的字" });
    expect(b.events.some((e) => e.type === "copied")).toBe(false);
    expect(s.notes).toEqual([]);
  });

  test("过输入门禁：非操作窗口、agent 操作、休眠都拒绝，也不去碰页面", async () => {
    const s = setup();
    const page = await s.open();
    s.hub.attach(page.id, new Recorder());
    const b = new Recorder();
    const attB = s.hub.attach(page.id, b);
    await attB?.handle({ type: "copy" });
    expect(b.errors()).toEqual([
      "另一个窗口正在操作这个页面；点「接管操作」后再试",
    ]);

    const agentPage = await s.open({ controller: "agent" });
    const c = new Recorder();
    const attC = s.hub.attach(agentPage.id, c);
    await attC?.handle({ type: "copy" });
    expect(c.errors()).toEqual([
      "页面当前由 agent 操作；点「手动操作」后才能输入",
    ]);
    expect(handleOf(s.h, page.id).calls).not.toContain("selection");
    expect(handleOf(s.h, agentPage.id).calls).not.toContain("selection");
  });

  test("底层抛错变 error 事件，不抛出去", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    handleOf(s.h, page.id).selection = async () => {
      throw new Error("Target closed\n  at x");
    };
    await att?.handle({ type: "copy" });
    expect(rec.errors()).toEqual(["Target closed"]);
  });
});

describe("消息顺序", () => {
  test("同一连接的消息一条条处理：前一条没做完，后一条不开始", async () => {
    const s = setup();
    const page = await s.open();
    const att = s.hub.attach(page.id, new Recorder());
    const handle = handleOf(s.h, page.id);
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    handle.input = async (ev) => {
      order.push(`start ${ev.type}`);
      if (ev.type === "mouse") await gate;
      order.push(`end ${ev.type}`);
    };
    const first = att?.handle({
      type: "input",
      event: { type: "mouse", action: "down", x: 1, y: 2 },
    });
    const second = att?.handle({
      type: "input",
      event: { type: "key", action: "down", key: "h" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start mouse"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["start mouse", "end mouse", "start key", "end key"]);
  });

  describe("移动与滚轮合并", () => {
    const move = (x: number, y = 0) => ({
      type: "input",
      event: { type: "mouse", action: "move", x, y },
    });
    const down = (x: number, y = 0) => ({
      type: "input",
      event: { type: "mouse", action: "down", x, y },
    });

    const tick = () => new Promise((r) => setTimeout(r, 0));

    /** 让第一条输入卡住，模拟浏览器忙着；返回放行函数与实际执行过的输入。 */
    async function blocked() {
      const s = setup();
      const page = await s.open();
      const att = s.hub.attach(page.id, new Recorder());
      const done: string[] = [];
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let first = true;
      handleOf(s.h, page.id).input = async (ev) => {
        if (first) {
          first = false;
          await gate;
        }
        if (ev.type === "mouse") done.push(`${ev.action}@${ev.x}`);
      };
      return { att, done, release };
    }

    test("排队中的移动只留最后一个位置，点击照常在后面", async () => {
      const { att, done, release } = await blocked();
      const all = [att?.handle(move(1))]; // 开始处理并卡住
      await tick();
      all.push(
        att?.handle(move(2)),
        att?.handle(move(3)),
        att?.handle(move(4)),
        att?.handle(down(4)),
      );
      release();
      await Promise.all(all);
      expect(done).toEqual(["move@1", "move@4", "down@4"]);
    });

    test("点击后面来的移动不能越过点击去改写前面排着的移动", async () => {
      const { att, done, release } = await blocked();
      const all = [att?.handle(move(1))];
      await tick();
      all.push(
        att?.handle(move(2)),
        att?.handle(down(2)),
        att?.handle(move(3)),
        att?.handle(move(4)),
      );
      release();
      await Promise.all(all);
      expect(done).toEqual(["move@1", "move@2", "down@2", "move@4"]);
    });

    const wheel = (x: number, deltaY: number) => ({
      type: "input",
      event: { type: "wheel", x, y: 0, deltaX: 0, deltaY },
    });

    test("滚轮与移动不互相合并：移动 2 在滚轮之前、移动 3 在滚轮之后，各自保留", async () => {
      const { att, done, release } = await blocked();
      const all = [att?.handle(move(1))];
      await tick();
      all.push(
        att?.handle(move(2)),
        att?.handle(wheel(2, 5)),
        att?.handle(move(3)),
      );
      release();
      await Promise.all(all);
      // 滚轮不进 done（只记鼠标）
      expect(done).toEqual(["move@1", "move@2", "move@3"]);
    });

    test("排队中的滚轮并成一条：位移相加、位置取最后的，不丢距离", async () => {
      const s = setup();
      const page = await s.open();
      const att = s.hub.attach(page.id, new Recorder());
      const seen: string[] = [];
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let first = true;
      handleOf(s.h, page.id).input = async (ev) => {
        if (first) {
          first = false;
          await gate;
        }
        if (ev.type === "wheel") seen.push(`wheel@${ev.x}:${ev.deltaY}`);
      };
      const all = [att?.handle(wheel(1, 10))]; // 开始处理并卡住
      await tick();
      all.push(
        att?.handle(wheel(2, 20)),
        att?.handle(wheel(3, 30)),
        att?.handle(wheel(4, 40)),
      );
      release();
      await Promise.all(all);
      expect(seen).toEqual(["wheel@1:10", "wheel@4:90"]);
    });

    test("滚轮被点击隔开就不合并", async () => {
      const s = setup();
      const page = await s.open();
      const att = s.hub.attach(page.id, new Recorder());
      const seen: string[] = [];
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let first = true;
      handleOf(s.h, page.id).input = async (ev) => {
        if (first) {
          first = false;
          await gate;
        }
        seen.push(ev.type === "wheel" ? `wheel:${ev.deltaY}` : ev.type);
      };
      const all = [att?.handle(wheel(1, 10))];
      await tick();
      all.push(
        att?.handle(wheel(1, 20)),
        att?.handle(down(1)),
        att?.handle(wheel(1, 30)),
      );
      release();
      await Promise.all(all);
      expect(seen).toEqual(["wheel:10", "wheel:20", "mouse", "wheel:30"]);
    });

    test("后来的移动并进排队中的那条：它的 promise 等到那条处理完才完成", async () => {
      const { att, done, release } = await blocked();
      const first = att?.handle(move(1));
      await tick();
      const queued = att?.handle(move(2));
      const merged = att?.handle(move(3)); // 并进 move(2) 那条
      let finished = false;
      void merged?.then(() => {
        finished = true;
      });
      await tick();
      expect(finished).toBe(false);
      release();
      await Promise.all([first, queued, merged]);
      expect(finished).toBe(true);
      expect(done).toEqual(["move@1", "move@3"]);
    });

    test("形状不对的 move 仍回 error，不吞掉", async () => {
      const s = setup();
      const page = await s.open();
      const rec = new Recorder();
      const att = s.hub.attach(page.id, rec);
      await att?.handle(move(Number.NaN));
      await att?.handle({
        type: "input",
        event: { type: "mouse", action: "move", x: "a", y: 0 },
      });
      expect(rec.errors()).toHaveLength(2);
    });
  });
});

describe("导航", () => {
  test("back / forward / reload 分发给句柄", async () => {
    const s = setup();
    const page = await s.open();
    const att = s.hub.attach(page.id, new Recorder());
    for (const action of ["back", "forward", "reload"] as const)
      await att?.handle({ type: "nav", action });
    expect(handleOf(s.h, page.id).calls).toEqual(
      expect.arrayContaining(["back", "forward", "reload"]),
    );
  });

  test("goto 走 resolveGoto（带上页面所属的工作区），成功后导航到解析出来的地址", async () => {
    const workspaces: string[] = [];
    const s = setup({
      resolveGoto: (workspaceKey, raw) => {
        workspaces.push(workspaceKey);
        return { ok: true, url: `https://${raw}/` };
      },
    });
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    await att?.handle({ type: "nav", action: "goto", target: " b.test " });
    expect(handleOf(s.h, page.id).calls).toContain("goto https://b.test/");
    expect(workspaces).toEqual(["w1"]);
    expect(rec.errors()).toEqual([]);
    expect(s.notes).toEqual([page.id]);
  });

  test("resolveGoto 失败：原样回错误，不导航", async () => {
    const s = setup({
      resolveGoto: () => ({ ok: false, error: "看不懂这个地址" }),
    });
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    await att?.handle({ type: "nav", action: "goto", target: "???" });
    expect(rec.errors()).toEqual(["看不懂这个地址"]);
    expect(s.notes).toEqual([]);
    expect(
      handleOf(s.h, page.id).calls.filter((c) => c.startsWith("goto")),
    ).toHaveLength(1); // 只有打开页面那一次
  });

  test("goto 被代理拒绝：blocked_address 翻成中文回给发起的人", async () => {
    const s = setup();
    const page = await s.open();
    const a = new Recorder();
    const b = new Recorder();
    const attA = s.hub.attach(page.id, a);
    s.hub.attach(page.id, b);
    handleOf(s.h, page.id).gotoResult = {
      status: 403,
      deny: "blocked_address",
    };
    await attA?.handle({ type: "nav", action: "goto", target: "10.0.0.1" });
    expect(a.errors()).toEqual([
      "该地址落在内网、回环、链路本地或保留网段，浏览器代理不允许访问",
    ]);
    expect(b.errors()).toEqual([]);
    // 被拒的导航不算用页面。
    expect(s.notes).toEqual([]);
  });

  test("deny 都翻成中文：认证失败、已知码用统一文案、未知码带上原码", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    handleOf(s.h, page.id).gotoResult = { status: 407, deny: "auth" };
    await att?.handle({ type: "nav", action: "goto", target: "x.test" });
    handleOf(s.h, page.id).gotoResult = { status: 500, deny: "upstream" };
    await att?.handle({ type: "nav", action: "goto", target: "x.test" });
    expect(rec.errors()).toEqual([
      "浏览器代理认证失败（上下文令牌失效）",
      "浏览器代理拒绝了这次访问：upstream",
    ]);
  });

  test("底层抛错变 error 事件，取第一行，不抛出去", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    handleOf(s.h, page.id).gotoResult = { status: 500, deny: null };
    await att?.handle({ type: "nav", action: "goto", target: "x.test" });
    expect(rec.errors()).toEqual([]);

    handleOf(s.h, page.id).gotoError = new Error("页面已关闭\n    at 别的地方");
    await expect(
      att?.handle({ type: "nav", action: "goto", target: "x.test" }),
    ).resolves.toBeUndefined();
    expect(rec.errors()).toEqual(["页面已关闭"]);
  });
});

describe("非法消息", () => {
  test("形状不对回 error，连接保持，不碰句柄", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    const handle = handleOf(s.h, page.id);
    const before = [...handle.calls];

    for (const raw of [
      "text",
      null,
      { type: "view", width: 100 },
      {
        type: "input",
        event: { type: "mouse", action: "move", x: 9999, y: 0 },
      },
      { type: "nav", action: "goto", target: "  " },
    ])
      await att?.handle(raw);
    expect(rec.errors()).toHaveLength(5);
    expect(handle.calls).toEqual(before);

    // 连接没被打断：下一条合法消息照常生效。
    await att?.handle({ type: "input", event: { type: "text", text: "ok" } });
    expect(handle.inputs).toEqual([{ type: "text", text: "ok" }]);
  });
});

describe("dispose", () => {
  test("停推流、摘订阅，之后注册表事件不再触发任何东西", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    s.hub.attach(page.id, rec);
    const handle = handleOf(s.h, page.id);
    expect(s.subs).toEqual({ taken: 1, released: 0 });
    s.hub.dispose();
    expect(handle.calls).toContain("stopScreencast");
    expect(s.watches.released).toBe(1);
    // 注册表订阅只建一份，退出时摘掉，免得中枢已经没了还被回调。
    expect(s.subs).toEqual({ taken: 1, released: 1 });

    const seen = rec.events.length;
    handle.emitConsole({
      id: 1,
      ts: 1,
      firstTs: 1,
      count: 1,
      kind: "console",
      level: "log",
      text: "after",
    });
    await s.h.registry.activate(page.id);
    expect(rec.events).toHaveLength(seen);
    // 关页面也不会再给这个连接发 closed。
    await s.h.registry.close(page.id, "user");
    expect(rec.types()).not.toContain("closed");
  });
});

describe("页面自己写的剪贴板", () => {
  // 监视是一串 setTimeout，真等每轮 2.5 秒；用假计时器，注册表的写库去抖也跟着被冻住。
  const click = {
    type: "input",
    event: { type: "mouse", action: "up", x: 10, y: 20 },
  };
  const keyUp = {
    type: "input",
    event: { type: "key", action: "up", key: "c" },
  };

  /** 替下页面的 copied()：由测试决定页面里现在记着什么，顺带数查了几次。 */
  function stubCopied(handle: FakePage) {
    const state = {
      value: null as { text: string; ts: number } | null,
      error: null as Error | null,
      reads: 0,
    };
    handle.copied = async () => {
      state.reads += 1;
      if (state.error) throw state.error;
      return state.value;
    };
    return state;
  }

  /** 推进假计时器，并把期间排上的异步活儿（copied() 的 Promise、续排）跑完。 */
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("点击之后页面写了剪贴板：只推给操作窗口", async () => {
    const s = setup();
    const page = await s.open();
    const a = new Recorder();
    const b = new Recorder();
    const attA = s.hub.attach(page.id, a);
    s.hub.attach(page.id, b);
    const copied = stubCopied(handleOf(s.h, page.id));

    await attA?.handle(click);
    copied.value = { text: "分享的链接", ts: Date.now() };
    await tick(300);
    expect(a.clipboards()).toEqual(["分享的链接"]);
    expect(b.clipboards()).toEqual([]);
    s.hub.dispose();
  });

  test("复制发生在输入的派发期间（点击处理函数里写剪贴板）：输入返回时已过了几毫秒，也要推", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    const handle = handleOf(s.h, page.id);
    const copied = stubCopied(handle);
    // 页面在派发 mouse up 的过程中写了剪贴板，随后派发才返回（时间已经往前走了）
    handle.input = async () => {
      copied.value = { text: "派发期间写的", ts: Date.now() };
      vi.setSystemTime(Date.now() + 5);
    };

    await att?.handle(click);
    await tick(300);
    expect(rec.clipboards()).toEqual(["派发期间写的"]);
    s.hub.dispose();
  });

  test("按键抬起同样触发（如在分享按钮上按 Enter）", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    const copied = stubCopied(handleOf(s.h, page.id));

    await att?.handle(keyUp);
    copied.value = { text: "选区", ts: Date.now() };
    await tick(300);
    expect(rec.clipboards()).toEqual(["选区"]);
    s.hub.dispose();
  });

  test("鼠标移动 / 滚轮 / 按下 / 文字插入不触发监视", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    const copied = stubCopied(handleOf(s.h, page.id));

    for (const event of [
      { type: "mouse", action: "move", x: 1, y: 2 },
      { type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: 3 },
      { type: "mouse", action: "down", x: 1, y: 2 },
      { type: "text", text: "文字" },
    ] as const)
      await att?.handle({ type: "input", event });
    copied.value = { text: "新的", ts: Date.now() };

    await tick(3000);
    expect(copied.reads).toBe(0);
    expect(rec.clipboards()).toEqual([]);
    s.hub.dispose();
  });

  test("输入之前就存在的旧复制不推", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    const copied = stubCopied(handleOf(s.h, page.id));
    copied.value = { text: "早就复制的", ts: Date.now() - 60_000 };

    await att?.handle(click);
    await tick(3000);
    expect(copied.reads).toBeGreaterThan(0);
    expect(rec.clipboards()).toEqual([]);
    s.hub.dispose();
  });

  test("同一次复制只推一次；新的复制再推一次", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    const copied = stubCopied(handleOf(s.h, page.id));

    await att?.handle(click);
    copied.value = { text: "第一次", ts: Date.now() };
    await tick(600);
    expect(rec.clipboards()).toEqual(["第一次"]);

    // 监视期内还会查好几轮，同一个 ts 不再推。
    await tick(600);
    expect(rec.clipboards()).toEqual(["第一次"]);

    copied.value = { text: "第二次", ts: Date.now() + 1 };
    await tick(600);
    expect(rec.clipboards()).toEqual(["第一次", "第二次"]);
    s.hub.dispose();
  });

  test("点击 1.5 秒之后才写（异步复制）仍然推；超过监视时长之后写的不推", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    const copied = stubCopied(handleOf(s.h, page.id));

    await att?.handle(click);
    await tick(1500);
    copied.value = { text: "1.5 秒后才写", ts: Date.now() };
    await tick(300);
    expect(rec.clipboards()).toEqual(["1.5 秒后才写"]);

    // 监视在点击后 2.5 秒结束：之后再写的不推。
    await tick(1200);
    copied.value = { text: "监视结束后才写", ts: Date.now() };
    await tick(1000);
    expect(rec.clipboards()).toEqual(["1.5 秒后才写"]);
    s.hub.dispose();
  });

  test("连续两次输入：监视延长而不是起两个，复制只推一次", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    const copied = stubCopied(handleOf(s.h, page.id));

    await att?.handle(click);
    await tick(1500);
    const timers = vi.getTimerCount();
    await att?.handle(click); // 第二次输入把窗口从 2.5 秒延到此刻 + 2.5 秒
    expect(vi.getTimerCount()).toBe(timers); // 延长，不叠第二个监视
    copied.value = { text: "延长期内", ts: Date.now() };
    await tick(600);
    expect(rec.clipboards()).toEqual(["延长期内"]);

    // 第一次输入那 2.5 秒早就过了，还能推说明窗口确实被延长了。
    await tick(1500);
    expect(rec.clipboards()).toEqual(["延长期内"]);
    copied.value = { text: "更晚的复制", ts: Date.now() };
    await tick(600);
    expect(rec.clipboards()).toEqual(["延长期内", "更晚的复制"]);
    s.hub.dispose();
  });

  test("copy 请求回答之后，同一次复制不再以 clipboard 事件重复推", async () => {
    const s = setup();
    const page = await s.open();
    const rec = new Recorder();
    const att = s.hub.attach(page.id, rec);
    const copied = stubCopied(handleOf(s.h, page.id));
    handleOf(s.h, page.id).selected = "选中的字";

    await att?.handle(keyUp);
    copied.value = { text: "选中的字", ts: Date.now() };
    await att?.handle({ type: "copy" });
    expect(rec.events.filter((e) => e.type === "copied")).toHaveLength(1);

    await tick(3000);
    expect(rec.clipboards()).toEqual([]);
    s.hub.dispose();
  });

  test("页面被关闭后没有残留计时器", async () => {
    const s = setup();
    const page = await s.open();
    const att = s.hub.attach(page.id, new Recorder());
    await att?.handle(click);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await s.h.registry.close(page.id, "user");
    expect(vi.getTimerCount()).toBe(0);
    s.hub.dispose();
  });

  test("全部窗口离开后不再查剪贴板，计时器也收干净", async () => {
    const s = setup();
    const page = await s.open();
    const att = s.hub.attach(page.id, new Recorder());
    const copied = stubCopied(handleOf(s.h, page.id));
    await att?.handle(click);
    await tick(300);
    expect(copied.reads).toBeGreaterThan(0);

    att?.detach(); // 最后一个窗口离开：条目被 drop，监视的计时器一并清掉
    const reads = copied.reads;
    await tick(3000);
    expect(copied.reads).toBe(reads);
    // 注册表自己的写库去抖（500ms）跑完就什么都不剩了。
    expect(vi.getTimerCount()).toBe(0);
    s.hub.dispose();
  });

  test("copied() 抛错不产生未处理的拒绝，监视结束后正常收尾", async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      const s = setup();
      const page = await s.open();
      const rec = new Recorder();
      const att = s.hub.attach(page.id, rec);
      const copied = stubCopied(handleOf(s.h, page.id));
      copied.error = new Error("Target closed");

      await att?.handle(click);
      await tick(3000);
      await Promise.resolve();
      expect(copied.reads).toBeGreaterThan(0);
      expect(rejections).toEqual([]);
      expect(rec.errors()).toEqual([]);
      expect(rec.clipboards()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      s.hub.dispose();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
