// page 层的纯函数与 wrapPage 的接线：用假 Playwright Page 断言发出去的动作序列与决策。
// 真浏览器里的行为在 engine.live.test.ts。
import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, test } from "vitest";
import { explain, pageSize, wrapPage } from "./page.js";
import { isRef } from "./ref.js";
import type { RequestJars } from "./request.js";

describe("isRef", () => {
  test("接受 e12 与 iframe 里的 f1e2", () => {
    expect(isRef("e1")).toBe(true);
    expect(isRef("e123")).toBe(true);
    expect(isRef("f1e2")).toBe(true);
    expect(isRef("f12e34")).toBe(true);
  });

  test("拒绝其它形状", () => {
    for (const bad of ["", "e", "1", "e1e2", "f1", "abe1", "e1 ", "E1", "e-1"])
      expect(isRef(bad)).toBe(false);
  });
});

describe("explain", () => {
  test("代理拒绝 HTTPS 时浏览器只报隧道失败：翻成人话", () => {
    expect(
      explain(
        new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://x/"),
      ),
    ).toContain("代理没能连上目标");
  });

  test("常见网络错误与未知错误", () => {
    expect(explain(new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe(
      "无法解析域名",
    );
    expect(explain(new Error("boom\n  at stack"))).toBe("boom");
  });
});

type Box = { x: number; y: number; width: number; height: number };

/** 假 Playwright Page：只转发 wrapPage 会用到的那几个成员，动作记在 sent 里。 */
function fakePage(
  opts: {
    boxes?: Record<string, Box | null>;
    size?: { width: number; height: number };
    history?: { currentIndex: number; entries: { url: string }[] };
    snapshot?: string;
    /** 让 scrollIntoViewIfNeeded 抛 Playwright 风格的多行超时错误 */
    scrollFails?: boolean;
    /** 各 frame 里读到的 __ysClip（下标与 frames() 对齐） */
    clips?: unknown[];
    /** scroll 前后取到的页面位置（x / y，其余字段固定）；不传就都是 0,0 */
    positions?: { x: number; y: number }[];
    /** 各编号读到的图片地址；值是 Error 表示这次读取失败 */
    srcs?: Record<string, string | Error>;
    /** 各编号的下拉框选项（readSelect 的结果）；没给的编号不是下拉框 */
    selects?: Record<
      string,
      {
        multiple: boolean;
        options: { value: string; label: string; disabled: boolean }[];
      }
    >;
  } = {},
) {
  const boxes = opts.boxes ?? {};
  const sent: string[] = [];
  // 同名事件可以有多个监听（真 Page 就是这样：控制台 / 网络 / 鼠标各注册各的）。
  const listeners = new Map<string, ((arg: unknown) => void)[]>();
  const emitTo = (name: string, arg: unknown) => {
    for (const fn of listeners.get(name) ?? []) fn(arg);
  };
  const frame = (id: string, clip: unknown, fail = false) => ({
    id,
    // 页面里的取值函数：selection 取选区（假页面里是空的），readCopied 取 __ysClip。
    evaluate: async (fn: { name?: string }) => {
      if (fail) throw new Error("Frame was detached");
      return fn.name === "readClip" ? clip : "";
    },
  });
  const mainFrame = frame(
    "main",
    opts.clips?.[0] ?? null,
    opts.clips?.[0] === "fail",
  );
  const childFrame = frame(
    "child",
    opts.clips?.[1] ?? null,
    opts.clips?.[1] === "fail",
  );
  let shotOptions: Record<string, unknown> | null = null;
  // scroll 取页面位置的表达式（字符串）：按调用次数依次给「动作前 / 动作后」两个值。
  const positions = opts.positions ?? [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  let scrolled = 0;
  const scrollPos = () => ({
    ...(positions[scrolled++] ?? { x: 0, y: 0 }),
    width: 1280,
    height: 800,
    viewWidth: 1280,
    viewHeight: 800,
  });
  const history = opts.history ?? {
    currentIndex: 0,
    entries: [{ url: "http://a/" }],
  };
  let detached = 0;
  let sessions = 0;

  const locator = (selector: string) => {
    const ref = selector.replace(/^aria-ref=/, "");
    return {
      count: async () => (ref in boxes ? 1 : 0),
      scrollIntoViewIfNeeded: async () => {
        sent.push(`scrollIntoView ${ref}`);
        if (opts.scrollFails)
          throw new Error(
            "locator.scrollIntoViewIfNeeded: Timeout 5000ms exceeded.\nCall log:\n  - waiting",
          );
      },
      boundingBox: async () => boxes[ref] ?? null,
      click: async (o?: { clickCount?: number; button?: string }) => {
        sent.push(
          `locator.click ${ref} ${o?.clickCount ?? 1} ${o?.button ?? "left"}`,
        );
      },
      fill: async (text: string) => {
        sent.push(`fill ${ref} ${text}`);
      },
      evaluate: async (fn: { name?: string }) => {
        sent.push(`locator.evaluate ${ref} ${fn.name ?? ""}`.trim());
        if (fn.name === "readSelect") {
          return opts.selects?.[ref] ?? null;
        }
        const src = opts.srcs?.[ref];
        if (src instanceof Error) throw src;
        return src ?? "";
      },
      selectOption: async (values: string[]) => {
        sent.push(`selectOption ${ref} ${values.join(",")}`);
        return values;
      },
    };
  };

  const page = {
    url: () => "https://a.test/",
    title: async () => "标题",
    on: (name: string, fn: (arg: unknown) => void) => {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
    },
    mainFrame: () => mainFrame,
    frames: () => [mainFrame, childFrame],
    locator,
    ariaSnapshot: async () => opts.snapshot ?? "- button e1",
    waitForLoadState: async () => {},
    waitForTimeout: async (ms: number) => {
      sent.push(`wait ${ms}`);
    },
    // 页面里的取值函数（pageSize / collectImages 之类）在测试里直接给结果；
    // 内容观察器的三个页面函数按名字认出来，记进 sent。
    evaluate: async (fn: unknown) => {
      if (typeof fn === "string") return scrollPos();
      const name = (fn as { name?: string }).name ?? "";
      if (/^(start|read|stop)Additions$/.test(name)) {
        sent.push(`page.evaluate ${name}`);
        // 读到的是一次早就发生过的新增：滚动后的等待立刻返回，不真等满 800ms
        // （没有信号的路径由 content-wait.test.ts 用假时钟覆盖）。
        return name === "readAdditions"
          ? { count: 1, lastAt: Date.now() - 1000 }
          : undefined;
      }
      return opts.size ?? { width: 1280, height: 800 };
    },
    screenshot: async (o: Record<string, unknown>) => {
      shotOptions = o;
      return Buffer.from("jpeg");
    },
    mouse: {
      move: async (x: number, y: number, o?: { steps?: number }) => {
        sent.push(`mouse.move ${x},${y}${o?.steps ? ` steps=${o.steps}` : ""}`);
      },
      down: async () => {
        sent.push("mouse.down");
      },
      up: async () => {
        sent.push("mouse.up");
      },
      wheel: async (dx: number, dy: number) => {
        sent.push(`mouse.wheel ${dx},${dy}`);
      },
      click: async (
        x: number,
        y: number,
        o?: { clickCount?: number; button?: string },
      ) => {
        sent.push(
          `mouse.click ${x},${y} ${o?.clickCount ?? 1} ${o?.button ?? "left"}`,
        );
      },
    },
    keyboard: {
      press: async (key: string) => {
        sent.push(`keyboard.press ${key}`);
      },
      type: async (text: string) => {
        sent.push(`keyboard.type ${text}`);
      },
      insertText: async (text: string) => {
        sent.push(`keyboard.insertText ${text}`);
      },
    },
    goBack: async () => {
      history.currentIndex -= 1;
      sent.push("goBack");
      return null;
    },
    goForward: async () => {
      history.currentIndex += 1;
      sent.push("goForward");
      return null;
    },
    reload: async () => {
      sent.push("reload");
      return null;
    },
    close: async () => {
      emitTo("close", {});
    },
  };

  const cdp = {
    send: async (name: string) => {
      sent.push(name);
      return history;
    },
    detach: async () => {
      detached += 1;
    },
  };
  const ctx = {
    newCDPSession: async () => {
      sessions += 1;
      return cdp;
    },
  } as unknown as BrowserContext;

  /** 主框架发起一次整页导航请求；sub 是子框架的（不该清鼠标位置）。 */
  const navigate = (sub = false) => {
    const req = {
      isNavigationRequest: () => true,
      url: () => "https://a.test/child",
      method: () => "GET",
      resourceType: () => "document",
      frame: () => (sub ? childFrame : mainFrame),
    };
    emitTo("request", req);
  };

  return {
    // wrapPage 只把 request / identityCookies 接到 jars 上，这里不需要真实现。
    handle: wrapPage(page as unknown as Page, ctx, {} as RequestJars, null),
    frames: { main: mainFrame, child: childFrame },
    sent,
    sessions: () => sessions,
    shotOptions: () => shotOptions,
    detached: () => detached,
    navigate,
    /** 让假 Page 派发一个事件（与 page.on 注册的监听对齐）。 */
    emit: emitTo,
    close: () => emitTo("close", {}),
  };
}

const MID = { x: 100, y: 400 }; // 元素中心：box 90,380,20,40

describe("mouse 位置", () => {
  test("初始是 null，move 之后有值", async () => {
    const f = fakePage();
    expect(f.handle.mouse()).toBeNull();
    await f.handle.move({ x: 10, y: 20 });
    expect(f.handle.mouse()).toEqual({ x: 10, y: 20 });
  });

  test("主框架整页导航后清空；子框架的导航不清", async () => {
    const f = fakePage();
    await f.handle.move({ x: 10, y: 20 });
    f.navigate(true);
    expect(f.handle.mouse()).toEqual({ x: 10, y: 20 });
    f.navigate();
    expect(f.handle.mouse()).toBeNull();
  });

  test("input 的 mouse / wheel 也更新位置；位置没变不再移动", async () => {
    const f = fakePage();
    await f.handle.input({ type: "mouse", action: "down", x: 5, y: 6 });
    expect(f.handle.mouse()).toEqual({ x: 5, y: 6 });
    await f.handle.input({ type: "mouse", action: "up", x: 5, y: 6 });
    await f.handle.input({
      type: "wheel",
      x: 7,
      y: 8,
      deltaX: 0,
      deltaY: 30,
    });
    expect(f.handle.mouse()).toEqual({ x: 7, y: 8 });
    expect(f.sent).toEqual([
      "mouse.move 5,6", // 之前是 null：一律移动
      "mouse.down",
      "mouse.up", // 位置没变：不再移动
      "mouse.move 7,8",
      "mouse.wheel 0,30",
    ]);
  });
});

describe("move", () => {
  test("ref：先滚到可见处再移到元素中心", async () => {
    const f = fakePage({
      boxes: { e1: { x: 90, y: 380, width: 20, height: 40 } },
    });
    await f.handle.move({ ref: "e1" });
    expect(f.sent).toEqual([
      "scrollIntoView e1",
      `mouse.move ${MID.x},${MID.y} steps=5`,
    ]);
    expect(f.handle.mouse()).toEqual(MID);
  });

  test("元素隐藏（没有包围盒）报错", async () => {
    const f = fakePage({ boxes: { e1: null } });
    const err = (await f.handle.move({ ref: "e1" }).catch((e) => e)) as Error;
    expect(err.message).toBe("该元素不可见，没有位置");
  });

  test("定位时 Playwright 超时：报一行中文，不把英文调用日志交给模型", async () => {
    const f = fakePage({
      boxes: { e1: { x: 1, y: 1, width: 2, height: 2 } },
      scrollFails: true,
    });
    const err = (await f.handle.move({ ref: "e1" }).catch((e) => e)) as Error;
    expect(err.message).toBe(
      "定位失败：locator.scrollIntoViewIfNeeded: Timeout 5000ms exceeded.",
    );
  });

  test("编号已失效：先报失效，不去算位置", async () => {
    const f = fakePage();
    const err = (await f.handle.move({ ref: "e9" }).catch((e) => e)) as Error;
    expect(err.message).toContain("编号已失效");
    expect(f.sent).toEqual([]);
  });
});

describe("scroll", () => {
  // 内容观察器在动作前后各一次 evaluate：start 在最前，stop 在最后。
  const START = "page.evaluate startAdditions";
  const READ = "page.evaluate readAdditions";
  const STOP = "page.evaluate stopAdditions";

  test("to：滚到元素进入视口，不动鼠标", async () => {
    const f = fakePage({
      boxes: { e1: { x: 0, y: 0, width: 10, height: 10 } },
    });
    await f.handle.scroll({ to: "e1" });
    expect(f.sent).toEqual([
      START,
      "scrollIntoView e1",
      "wait 300",
      READ,
      STOP,
    ]);
    expect(f.handle.mouse()).toBeNull();
  });

  test("direction 缺省一屏、在视口中心滚", async () => {
    const f = fakePage();
    await f.handle.scroll({ direction: "down" });
    expect(f.sent).toEqual([
      START,
      "mouse.move 640,400",
      "mouse.wheel 0,800",
      "wait 300",
      READ,
      STOP,
    ]);
    expect(f.handle.mouse()).toEqual({ x: 640, y: 400 });

    await f.handle.scroll({ direction: "up", amount: 100 });
    expect(f.sent.slice(-6)).toEqual([
      START,
      "mouse.move 640,400",
      "mouse.wheel 0,-100",
      "wait 300",
      READ,
      STOP,
    ]);
  });

  test("横向按视口宽度；at 用坐标 / ref 指定滚的位置", async () => {
    const f = fakePage();
    await f.handle.scroll({ direction: "right" });
    expect(f.sent).toContain("mouse.wheel 1280,0");
    await f.handle.scroll({ direction: "left", at: { x: 3, y: 4 } });
    expect(f.sent.slice(-6)).toEqual([
      START,
      "mouse.move 3,4",
      "mouse.wheel -1280,0",
      "wait 300",
      READ,
      STOP,
    ]);
    // ref 位置现查
    const g = fakePage({
      boxes: { e1: { x: 90, y: 80, width: 20, height: 40 } },
    });
    await g.handle.scroll({ direction: "down", at: { ref: "e1" } });
    expect(g.sent.slice(0, 3)).toEqual([
      START,
      "scrollIntoView e1",
      "mouse.move 100,100",
    ]);
  });

  test("滚动抛错也一定停观察器", async () => {
    const f = fakePage({
      boxes: { e1: { x: 0, y: 0, width: 10, height: 10 } },
      scrollFails: true,
    });
    const err = (await f.handle
      .scroll({ to: "e1" })
      .catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      "滚动失败：locator.scrollIntoViewIfNeeded: Timeout 5000ms exceeded.",
    );
    expect(f.sent).toEqual([START, "scrollIntoView e1", STOP]);
  });

  test("返回动作前后的页面位置：before 在动作前取，after 等快照稳定后才取", async () => {
    const f = fakePage({
      positions: [
        { x: 0, y: 0 },
        { x: 0, y: 700 },
      ],
    });
    expect(await f.handle.scroll({ direction: "down", amount: 700 })).toEqual({
      before: {
        x: 0,
        y: 0,
        width: 1280,
        height: 800,
        viewWidth: 1280,
        viewHeight: 800,
      },
      after: {
        x: 0,
        y: 700,
        width: 1280,
        height: 800,
        viewWidth: 1280,
        viewHeight: 800,
      },
    });
  });
});

describe("screenshotRect", () => {
  test("PNG，clip 原样交出去（非 fullPage 的 clip 已是视口坐标）", async () => {
    const f = fakePage();
    const png = await f.handle.screenshotRect({
      x: 5,
      y: 6,
      width: 20,
      height: 30,
    });
    expect(png).toBeInstanceOf(Buffer);
    expect(f.shotOptions()).toEqual({
      type: "png",
      clip: { x: 5, y: 6, width: 20, height: 30 },
    });
  });
});

describe("drag", () => {
  const boxes = {
    e1: { x: 0, y: 0, width: 100, height: 100 }, // 中心 50,50
    e2: { x: 400, y: 0, width: 100, height: 100 }, // 中心 450,50
  };

  test("真实鼠标事件序列：按下 → 中点（+2）→ 终点 → 抬起", async () => {
    const f = fakePage({ boxes });
    await f.handle.drag({ ref: "e1" }, { ref: "e2" });
    expect(f.sent).toEqual([
      "scrollIntoView e1",
      "scrollIntoView e2",
      "scrollIntoView e1", // 解析终点之后起点重新取一次
      "mouse.move 50,50",
      "mouse.down",
      "mouse.move 250,52 steps=6",
      "mouse.move 450,50 steps=12",
      "mouse.up",
    ]);
    expect(f.handle.mouse()).toEqual({ x: 450, y: 50 });
  });

  test("起点或终点不在视口内直接报错，不按下", async () => {
    const f = fakePage({ boxes });
    const err = (await f.handle
      .drag({ ref: "e1" }, { x: 500, y: 2000 }) // 视口高 800
      .catch((e) => e)) as Error;
    expect(err.message).toBe("拖动的起点或终点不在视口内，先滚动到位");
    expect(f.sent).not.toContain("mouse.down");
  });
});

describe("click", () => {
  test("带次数与按键；点完鼠标位置是元素中心", async () => {
    const f = fakePage({
      boxes: { e1: { x: 90, y: 380, width: 20, height: 40 } },
    });
    await f.handle.click("e1", { count: 2 });
    expect(f.sent).toEqual(["scrollIntoView e1", "locator.click e1 2 left"]);
    expect(f.handle.mouse()).toEqual(MID);
    await f.handle.click("e1", { button: "right" });
    expect(f.sent.at(-1)).toBe("locator.click e1 1 right");
  });

  test("编号失效时 click 仍先报失效", async () => {
    const f = fakePage();
    const err = (await f.handle.click("e9").catch((e) => e)) as Error;
    expect(err.message).toContain("编号已失效");
  });

  test("clickAt 坐标 / 当前鼠标位置；没有位置时报错", async () => {
    const f = fakePage();
    const err = (await f.handle.clickAt(null).catch((e) => e)) as Error;
    expect(err.message).toContain("还没有鼠标位置");
    await f.handle.move({ x: 10, y: 20 });
    await f.handle.clickAt(null, { count: 3 });
    expect(f.sent.at(-1)).toBe("mouse.click 10,20 3 left");
    await f.handle.clickAt({ x: 30, y: 40 }, { button: "right" });
    expect(f.sent.at(-1)).toBe("mouse.click 30,40 1 right");
    expect(f.handle.mouse()).toEqual({ x: 30, y: 40 });
  });
});

describe("type", () => {
  const boxes = { e1: { x: 0, y: 0, width: 100, height: 20 } };

  test("带 ref 整段：走 fill，不逐键；submit 再回车", async () => {
    const f = fakePage({ boxes });
    await f.handle.type("e1", "新内容", { submit: true, perKey: false });
    expect(f.sent).toEqual([
      "locator.evaluate e1 readSelect",
      "fill e1 新内容",
      "keyboard.press Enter",
    ]);
  });

  test("带 ref 逐键：先点进去聚焦、全选，再逐键（仍是替换）", async () => {
    const f = fakePage({ boxes });
    await f.handle.type("e1", "ab", { submit: false, perKey: true });
    expect(f.sent).toEqual([
      "locator.evaluate e1 readSelect",
      "locator.click e1 1 left",
      "keyboard.press ControlOrMeta+a",
      "keyboard.type ab",
    ]);
  });

  test("带 ref 逐键、空串：按 Delete 清空选区", async () => {
    const f = fakePage({ boxes });
    await f.handle.type("e1", "", { submit: false, perKey: true });
    expect(f.sent.at(-1)).toBe("keyboard.press Delete");
  });

  test("不带 ref：整段 insertText / 逐键 type，都不碰 locator", async () => {
    const f = fakePage();
    await f.handle.type(null, "你好", { submit: false, perKey: false });
    await f.handle.type(null, "ab", { submit: true, perKey: true });
    expect(f.sent).toEqual([
      "keyboard.insertText 你好",
      "keyboard.type ab",
      "keyboard.press Enter",
    ]);
  });

  test("非下拉框返回 null", async () => {
    const f = fakePage({ boxes });
    expect(
      await f.handle.type("e1", "x", { submit: false, perKey: false }),
    ).toBeNull();
  });

  const SELECT = (multiple = false) => ({
    multiple,
    options: [
      { value: "", label: "请选择", disabled: false },
      { value: "bj", label: "北京", disabled: false },
      { value: "sh", label: "上海", disabled: true },
    ],
  });

  test("下拉框走 selectOption 而不是 fill，返回选中的选项文字", async () => {
    const f = fakePage({ boxes, selects: { e1: SELECT() } });
    expect(
      await f.handle.type("e1", "北京", { submit: false, perKey: false }),
    ).toEqual({ selected: ["北京"] });
    expect(f.sent).toEqual([
      "locator.evaluate e1 readSelect",
      "selectOption e1 bj",
    ]);
  });

  test("按 value 匹配（label 优先）；空串匹配 label / value 为空的选项", async () => {
    const f = fakePage({ boxes, selects: { e1: SELECT() } });
    await f.handle.type("e1", "bj", { submit: false, perKey: false });
    expect(f.sent.at(-1)).toBe("selectOption e1 bj");
    await f.handle.type("e1", "", { submit: false, perKey: false });
    expect(f.sent.at(-1)).toBe("selectOption e1 ");
  });

  test("没匹配上：不调 selectOption，错误里列出可选项（空 label 写「（空）」）", async () => {
    const f = fakePage({
      boxes,
      selects: {
        e1: {
          multiple: false,
          options: [
            { value: "", label: "", disabled: false },
            { value: "bj", label: "北京", disabled: false },
          ],
        },
      },
    });
    const err = (await f.handle
      .type("e1", "广州", { submit: false, perKey: false })
      .catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      "下拉框 e1 里没有匹配「广州」的选项。可选：（空）、北京",
    );
    expect(f.sent.some((s) => s.startsWith("selectOption"))).toBe(false);
  });

  test("可选项超过 30 个：只列前 30 个并写总数", async () => {
    const options = Array.from({ length: 32 }, (_, i) => ({
      value: `v${i}`,
      label: `项${i}`,
      disabled: false,
    }));
    const f = fakePage({
      boxes,
      selects: { e1: { multiple: false, options } },
    });
    const err = (await f.handle
      .type("e1", "x", { submit: false, perKey: false })
      .catch((e: Error) => e)) as Error;
    expect(err.message).toContain("项29…等共 32 个");
    expect(err.message).not.toContain("项30");
  });

  test("disabled 的选项不选，报错", async () => {
    const f = fakePage({ boxes, selects: { e1: SELECT() } });
    const err = (await f.handle
      .type("e1", "上海", { submit: false, perKey: false })
      .catch((e: Error) => e)) as Error;
    expect(err.message).toBe("选项「上海」被禁用，选不了");
    expect(f.sent.some((s) => s.startsWith("selectOption"))).toBe(false);
  });

  test("多选：按换行拆成多项一次选上；有一项没匹配就整体不选并报那一项", async () => {
    const f = fakePage({
      boxes,
      selects: {
        e1: {
          multiple: true,
          options: [
            { value: "a", label: "A", disabled: false },
            { value: "b", label: "B", disabled: false },
          ],
        },
      },
    });
    expect(
      await f.handle.type("e1", "A\nB", { submit: false, perKey: false }),
    ).toEqual({ selected: ["A", "B"] });
    expect(f.sent.at(-1)).toBe("selectOption e1 a,b");

    const g = fakePage({
      boxes,
      selects: {
        e1: {
          multiple: true,
          options: [{ value: "a", label: "A", disabled: false }],
        },
      },
    });
    const err = (await g.handle
      .type("e1", "A\nC", { submit: false, perKey: false })
      .catch((e: Error) => e)) as Error;
    expect(err.message).toContain("没有匹配「C」");
    expect(g.sent.some((s) => s.startsWith("selectOption"))).toBe(false);
  });

  test("下拉框忽略 perKey，submit 照常回车", async () => {
    const f = fakePage({ boxes, selects: { e1: SELECT() } });
    await f.handle.type("e1", "北京", { submit: true, perKey: true });
    expect(f.sent).toEqual([
      "locator.evaluate e1 readSelect",
      "selectOption e1 bj",
      "keyboard.press Enter",
    ]);
  });
});

describe("screenshotFull", () => {
  test("文档比视口高：返回真实高度与宽度，clip 到真实高度", async () => {
    const f = fakePage({ size: { width: 1280, height: 3000 } });
    const shot = await f.handle.screenshotFull();
    expect(shot).toMatchObject({ width: 1280, height: 3000, fullHeight: 3000 });
    expect(shot.bytes.toString()).toBe("jpeg");
    expect(f.shotOptions()).toEqual({
      type: "jpeg",
      quality: 70,
      fullPage: true,
      clip: { x: 0, y: 0, width: 1280, height: 3000 },
    });
  });

  test("超过 30000：只截前 30000，fullHeight 仍是真实高度", async () => {
    const f = fakePage({ size: { width: 1280, height: 90_000 } });
    const shot = await f.handle.screenshotFull();
    expect(shot.height).toBe(30_000);
    expect(shot.fullHeight).toBe(90_000);
    expect(f.shotOptions()?.clip).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 30_000,
    });
  });
});

describe("back / forward", () => {
  test("没有上一页 / 下一页：不动作、返回 false", async () => {
    const f = fakePage();
    expect(await f.handle.back()).toBe(false);
    expect(await f.handle.forward()).toBe(false);
    expect(f.sent).toEqual([
      "Page.getNavigationHistory",
      "Page.getNavigationHistory",
    ]);
  });

  test("上一条是 about:blank（goto 之前的初始条目）也算没有上一页", async () => {
    const f = fakePage({
      history: {
        currentIndex: 1,
        entries: [{ url: "about:blank" }, { url: "http://a/" }],
      },
    });
    expect(await f.handle.back()).toBe(false);
    expect(f.sent).toEqual(["Page.getNavigationHistory"]);
  });

  test("有历史就导航并返回 true；CDP 会话只建一次", async () => {
    const f = fakePage({
      history: {
        currentIndex: 1,
        entries: [
          { url: "http://a/" },
          { url: "http://b/" },
          { url: "http://c/" },
        ],
      },
    });
    expect(await f.handle.back()).toBe(true);
    expect(await f.handle.forward()).toBe(true);
    expect(f.sent).toEqual([
      "Page.getNavigationHistory",
      "goBack",
      "Page.getNavigationHistory", // 第二次用缓存下来的会话
      "goForward",
    ]);
    expect(f.sessions()).toBe(1);
    // 页面关掉时 detach
    f.close();
    expect(f.detached()).toBe(1);
  });
});

describe("snapshot", () => {
  test("没有 img 节点时原样返回（不截断），一次额外的往返都没有", async () => {
    const long = `- button "${"x".repeat(50_000)}"`;
    const f = fakePage({ snapshot: long });
    expect(await f.handle.snapshot()).toBe(long);
    expect(f.sent.filter((x) => x.startsWith("locator.evaluate"))).toEqual([]);
  });

  test("img 节点带上此刻的地址：普通地址原样，data: 写成 mime 与长度", async () => {
    const raw = `- main [ref=e1]:\n  - img "甲" [ref=e2]\n  - img "乙" [ref=e3]`;
    const data = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAE";
    const f = fakePage({ snapshot: raw, srcs: { e2: data, e3: "/b.png" } });
    expect(await f.handle.snapshot()).toBe(
      [
        `- main [ref=e1]:`,
        `  - img "甲" [ref=e2]:`,
        `    - /src: data:image/gif (${data.length} chars)`,
        `  - img "乙" [ref=e3]:`,
        `    - /src: /b.png`,
      ].join("\n"),
    );
  });

  test("单个编号读不到（元素刚被换掉）当作没有地址，不让整个快照失败", async () => {
    const raw = `- img "甲" [ref=e2]\n- img "乙" [ref=e3]`;
    const f = fakePage({
      snapshot: raw,
      srcs: { e2: new Error("Element is not attached"), e3: "/b.png" },
    });
    expect(await f.handle.snapshot()).toBe(
      `- img "甲" [ref=e2]\n- img "乙" [ref=e3]:\n  - /src: /b.png`,
    );
  });
});

describe("console", () => {
  const msg = (text: string, type = "log") => ({
    type: () => type,
    text: () => text,
    location: () => ({ url: "https://a.test/p", lineNumber: 4 }),
  });

  test("相同四元组的消息合成一组，订阅者在计数增加时收到更新后的组", () => {
    const f = fakePage();
    const seen: { id: number; count: number }[] = [];
    f.handle.onConsole((e) => seen.push({ id: e.id, count: e.count }));
    for (let i = 0; i < 3; i++) f.emit("console", msg("poll failed"));
    f.emit("console", msg("poll failed", "warning"));
    const list = f.handle.console();
    expect(list.map((e) => e.count)).toEqual([3, 1]);
    expect(list.map((e) => e.level)).toEqual(["log", "warn"]);
    expect(list[0]?.url).toBe("https://a.test/p:5");
    expect(seen.at(-1)).toEqual({ id: 2, count: 1 });
    expect(seen.at(-2)).toEqual({ id: 1, count: 3 });
    expect(f.handle.consoleEvicted()).toBe(0);
  });

  test("超出容量时 consoleEvicted 报被挤掉的出现次数", () => {
    const f = fakePage();
    for (let i = 0; i < 502; i++) f.emit("console", msg(`m${i}`));
    f.emit("console", msg("m500"));
    expect(f.handle.console()).toHaveLength(500);
    // m0、m1 各出现 1 次被挤掉；m500 再出现是已有的组
    expect(f.handle.consoleEvicted()).toBe(2);
  });

  test("未捕获异常带首帧位置；没有栈就不写 url", () => {
    const f = fakePage();
    const err = new Error("页面里的异常");
    err.stack =
      "Error: 页面里的异常\n    at boom (https://a.test/p?token=abc:9:7)";
    f.emit("pageerror", err);
    f.emit("pageerror", { message: "没有栈" });
    const list = f.handle.console();
    expect(list[0]).toMatchObject({
      kind: "error",
      text: "页面里的异常",
      url: "https://a.test/p?token=***:9",
    });
    expect(list[1]).toMatchObject({ kind: "error", text: "没有栈" });
    expect(list[1]?.url).toBeUndefined();
  });

  test("失败请求的地址打码", () => {
    const f = fakePage();
    f.emit("requestfailed", {
      isNavigationRequest: () => false,
      failure: () => ({ errorText: "net::ERR_FAILED" }),
      url: () => "https://a.test/api?token=abc",
    });
    expect(f.handle.console()[0]).toMatchObject({
      kind: "request-failed",
      text: "net::ERR_FAILED",
      url: "https://a.test/api?token=***",
      count: 1,
    });
  });

  test("copied：取各 frame 里最新的那次复制；都没复制过是 null", async () => {
    const empty = fakePage();
    expect(await empty.handle.copied()).toBeNull();
    const f = fakePage({
      clips: [
        { text: "主文档", ts: 10 },
        { text: "框里的", ts: 30 },
      ],
    });
    expect(await f.handle.copied()).toEqual({ text: "框里的", ts: 30 });
  });
});

describe("pageSize", () => {
  test("宽取 scrollWidth、高取 documentElement 与 body 的大", () => {
    const g = globalThis as unknown as { document?: unknown };
    const had = "document" in g;
    const saved = g.document;
    g.document = {
      documentElement: { scrollWidth: 1280, scrollHeight: 900 },
      body: { scrollWidth: 1400, scrollHeight: 1200 },
    };
    try {
      expect(pageSize()).toEqual({ width: 1400, height: 1200 });
    } finally {
      if (had) g.document = saved;
      else delete g.document;
    }
  });
});

describe("network", () => {
  /**
   * 假 Request：给 watchNetwork 用；sizes / allHeaders 都可控。
   * 没有状态也没有失败的就是 pending：response / allHeaders / sizes 与真实的一样一直挂着。
   */
  const request = (
    url = "https://a.test/api",
    opts: {
      type?: string;
      method?: string;
      frame?: unknown;
      status?: number;
      headers?: Record<string, string>;
      body?: string;
      sizes?: { responseBodySize: number; requestBodySize: number };
      failure?: string;
      frameThrows?: boolean;
      responseBody?: Buffer;
      responseBodyThrows?: string;
    } = {},
  ) => {
    const sent: string[] = [];
    const pending = opts.status === undefined && !opts.failure;
    const never = new Promise<never>(() => {});
    const req = {
      url: () => url,
      method: () => opts.method ?? "GET",
      isNavigationRequest: () => false,
      resourceType: () => opts.type ?? "xhr",
      frame: () => {
        if (opts.frameThrows)
          throw new Error("Service Worker 的请求没有 frame");
        return opts.frame;
      },
      failure: () => (opts.failure ? { errorText: opts.failure } : null),
      allHeaders: () =>
        pending ? never : Promise.resolve(opts.headers ?? { accept: "*/*" }),
      headers: () => opts.headers ?? {},
      postDataBuffer: () =>
        opts.body === undefined ? null : Buffer.from(opts.body),
      sizes: () =>
        pending
          ? never
          : Promise.resolve(
              opts.sizes ?? { responseBodySize: 0, requestBodySize: 0 },
            ),
      response: () =>
        pending
          ? never
          : Promise.resolve(
              opts.status === undefined
                ? null
                : {
                    status: () => opts.status,
                    headers: () => ({
                      "content-type": "Application/JSON; charset=utf-8",
                    }),
                    allHeaders: async () => ({
                      "content-type": "Application/JSON; charset=utf-8",
                    }),
                    body: async () => {
                      if (opts.responseBodyThrows)
                        throw new Error(opts.responseBodyThrows);
                      return opts.responseBody ?? Buffer.from("{}");
                    },
                  },
            ),
      sent,
    };
    return req;
  };

  test("开始入缓冲，响应 / 结束回填状态、mime、大小与耗时", async () => {
    const f = fakePage();
    const req = request("https://a.test/api?token=abc", {
      frame: f.frames.main,
      status: 200,
      sizes: { responseBodySize: 4198, requestBodySize: 0 },
    });
    f.emit("request", req);
    f.emit("response", {
      request: () => req,
      status: () => 200,
      headers: () => ({ "content-type": "Application/JSON; charset=utf-8" }),
    });
    f.emit("requestfinished", req);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.handle.network()).toEqual([
      {
        id: 1,
        ts: expect.any(Number),
        method: "GET",
        url: "https://a.test/api?token=abc",
        type: "xhr",
        frame: "main",
        status: 200,
        mime: "application/json",
        size: 4198,
        ms: expect.any(Number),
        failure: null,
      },
    ]);
    expect(f.handle.networkEvicted()).toBe(0);
    const detail = await f.handle.networkDetail(1);
    expect(detail?.requestHeaders).toEqual({ accept: "*/*" });
    // 头的值原样，名字统一小写。
    expect(detail?.responseHeaders).toEqual({
      "content-type": "Application/JSON; charset=utf-8",
    });
    expect(detail?.requestBodyBytes).toBe(0);
  });

  test("data: 与 blob: 不入缓冲；取不到 frame 的按 sub", () => {
    const f = fakePage();
    f.emit("request", request("data:image/png;base64,aaa"));
    f.emit("request", request("blob:https://a.test/x"));
    f.emit("request", request("https://a.test/worker", { frameThrows: true }));
    expect(f.handle.network().map((e) => e.url)).toEqual([
      "https://a.test/worker",
    ]);
    expect(f.handle.network()[0]?.frame).toBe("sub");
  });

  test("失败请求回填 failure 与耗时；详情里头的值原样", async () => {
    const f = fakePage();
    const req = request("https://a.test/api", {
      frame: f.frames.main,
      failure: "net::ERR_BLOCKED_BY_CLIENT",
      headers: { authorization: "Bearer abc", cookie: "sid=1", accept: "*/*" },
    });
    f.emit("request", req);
    f.emit("requestfailed", req);
    const [entry] = f.handle.network();
    expect(entry?.failure).toBe("net::ERR_BLOCKED_BY_CLIENT");
    expect(entry?.ms).toBeGreaterThanOrEqual(0);
    const detail = await f.handle.networkDetail(1);
    expect(detail?.requestHeaders).toEqual({
      authorization: "Bearer abc",
      cookie: "sid=1",
      accept: "*/*",
    });
    // 没收到响应：响应头是 null。
    expect(detail?.responseHeaders).toBeNull();
  });

  test("还没响应的请求：详情不等响应，响应头是 null，请求体大小取自 postDataBuffer", async () => {
    const f = fakePage();
    const req = request("https://a.test/slow", {
      frame: f.frames.main,
      method: "POST",
      body: "hello",
      headers: { accept: "*/*" },
    });
    f.emit("request", req);
    const detail = await Promise.race([
      f.handle.networkDetail(1),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 200)),
    ]);
    if (detail === "timeout")
      throw new Error("networkDetail 在等一个没有响应的请求");
    expect(detail?.entry.status).toBeNull();
    expect(detail?.responseHeaders).toBeNull();
    expect(detail?.requestHeaders).toEqual({ accept: "*/*" });
    expect(detail?.requestBodyBytes).toBe(5);
  });

  test("body：请求体与响应体原样给；没有请求体 / WebSocket / 失败 / pending / 没传完都给原因", async () => {
    const f = fakePage();
    expect(await f.handle.networkBody(1, "response")).toBeNull();

    const post = request("https://a.test/api/post", {
      frame: f.frames.main,
      method: "POST",
      body: '{"a":1}',
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      responseBody: Buffer.from('{"ok":true}'),
    });
    f.emit("request", post);
    f.emit("response", {
      request: () => post,
      status: () => 200,
      headers: () => ({ "content-type": "application/json; charset=utf-8" }),
    });
    f.emit("requestfinished", post);
    await new Promise((r) => setTimeout(r, 0));
    expect(await f.handle.networkBody(1, "request")).toMatchObject({
      ok: true,
      mime: "application/json",
    });
    const res = await f.handle.networkBody(1, "response");
    if (res?.ok !== true) throw new Error("取不到响应体");
    expect(res.mime).toBe("application/json");
    expect(res.bytes.toString("utf8")).toBe('{"ok":true}');

    // 没有请求体的 GET。
    const get = request("https://a.test/api", {
      frame: f.frames.main,
      status: 200,
    });
    f.emit("request", get);
    expect(await f.handle.networkBody(2, "request")).toEqual({
      ok: false,
      reason: "这个请求没有请求体",
    });

    // 收到响应头、还没结束（流式）：不去调 response.body()。
    const stream = request("https://a.test/stream", {
      frame: f.frames.main,
      status: 200,
      responseBodyThrows: "不该被调用",
    });
    f.emit("request", stream);
    f.emit("response", {
      request: () => stream,
      status: () => 200,
      headers: () => ({ "content-type": "text/plain" }),
    });
    expect(await f.handle.networkBody(3, "response")).toEqual({
      ok: false,
      reason: "响应还没传完（可能是流式连接），等它结束后再取",
    });

    // 还没响应。
    const slow = request("https://a.test/slow", { frame: f.frames.main });
    f.emit("request", slow);
    expect(await f.handle.networkBody(4, "response")).toEqual({
      ok: false,
      reason: "请求还没有响应（pending）",
    });

    // 失败。
    const bad = request("https://a.test/bad", {
      frame: f.frames.main,
      failure: "net::ERR_CONNECTION_RESET",
    });
    f.emit("request", bad);
    f.emit("requestfailed", bad);
    expect(await f.handle.networkBody(5, "response")).toEqual({
      ok: false,
      reason: "请求失败了（net::ERR_CONNECTION_RESET），没有响应体",
    });
  });

  test("body：响应体取不到时把 Playwright 报错的第一行写进 reason", async () => {
    const f = fakePage();
    const hop = request("https://a.test/redirect", {
      frame: f.frames.main,
      status: 302,
      responseBodyThrows:
        "response.body: Response body is unavailable for redirect responses\nmore detail",
    });
    f.emit("request", hop);
    f.emit("response", {
      request: () => hop,
      status: () => 302,
      headers: () => ({ location: "/x" }),
    });
    f.emit("requestfinished", hop);
    await new Promise((r) => setTimeout(r, 0));
    expect(await f.handle.networkBody(1, "response")).toEqual({
      ok: false,
      reason:
        "response.body: Response body is unavailable for redirect responses",
    });
  });

  test("编号不在缓冲里：networkDetail 是 null；超出容量时 evicted 增加", async () => {
    const f = fakePage();
    expect(await f.handle.networkDetail(1)).toBeNull();
    for (let i = 0; i < 502; i++)
      f.emit(
        "request",
        request(`https://a.test/${i}`, { frame: f.frames.main }),
      );
    const list = f.handle.network();
    expect(list).toHaveLength(500);
    expect(list[0]?.id).toBe(3);
    expect(f.handle.networkEvicted()).toBe(2);
    expect(await f.handle.networkDetail(1)).toBeNull();
  });
});

describe("network: WebSocket", () => {
  test("连接记一条 GET / websocket，关掉时补耗时", async () => {
    const f = fakePage();
    let close: (() => void) | null = null;
    f.emit("websocket", {
      url: () => "wss://a.test/socket?token=abc",
      on: (name: string, fn: () => void) => {
        if (name === "close") close = fn;
      },
    });
    expect(f.handle.network()[0]).toMatchObject({
      id: 1,
      method: "GET",
      type: "websocket",
      frame: "main",
      url: "wss://a.test/socket?token=abc",
      status: null,
      mime: "",
      size: null,
      ms: null,
      failure: null,
    });
    (close as (() => void) | null)?.();
    expect(f.handle.network()[0]?.ms).toBeGreaterThanOrEqual(0);
    // WebSocket 没有可读的内容。
    expect(await f.handle.networkBody(1, "request")).toEqual({
      ok: false,
      reason: "WebSocket 没有可读的请求体与响应体",
    });
    // 没有 Request 可回头查：详情只给条目本身。
    const detail = await f.handle.networkDetail(1);
    expect(detail).toMatchObject({
      requestHeaders: {},
      responseHeaders: null,
      requestBodyBytes: null,
    });
  });
});
