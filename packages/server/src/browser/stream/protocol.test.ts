// 客户端消息校验：每条合法形状、每个拒绝分支与边界值。
import { describe, expect, test } from "vitest";
import {
  type ClientMessage,
  mergeInput,
  parseClientMessage,
} from "./protocol.js";

const ok = (raw: unknown): ClientMessage => {
  const r = parseClientMessage(raw);
  if (!r.ok) throw new Error(`本该通过：${r.error}`);
  return r.msg;
};

const bad = (raw: unknown): string => {
  const r = parseClientMessage(raw);
  if (r.ok) throw new Error(`本该被拒：${JSON.stringify(r.msg)}`);
  return r.error;
};

const input = (event: unknown) => ({ type: "input", event });

describe("鼠标", () => {
  test("move / down / up 都通过，坐标原样保留", () => {
    for (const action of ["move", "down", "up"]) {
      expect(ok(input({ type: "mouse", action, x: 10, y: 20 }))).toEqual({
        type: "input",
        event: { type: "mouse", action, x: 10, y: 20 },
      });
    }
  });

  test("边界：1279 / 799 通过，1280 / 800 拒绝", () => {
    expect(
      ok(input({ type: "mouse", action: "move", x: 1279, y: 799 })),
    ).toMatchObject({ event: { x: 1279, y: 799 } });
    expect(
      bad(input({ type: "mouse", action: "move", x: 1280, y: 0 })),
    ).toContain("超出视口 1280×800");
    expect(
      bad(input({ type: "mouse", action: "move", x: 0, y: 800 })),
    ).toContain("超出视口 1280×800");
  });

  test("负数、NaN、Infinity、字符串、缺字段都拒绝", () => {
    for (const x of [-1, Number.NaN, Number.POSITIVE_INFINITY, "10", null]) {
      expect(bad(input({ type: "mouse", action: "move", x, y: 0 }))).toContain(
        "鼠标坐标",
      );
    }
    expect(bad(input({ type: "mouse", action: "move", y: 0 }))).toContain(
      "鼠标坐标",
    );
  });

  test("动作、按键、点击次数各自校验", () => {
    expect(
      bad(input({ type: "mouse", action: "click", x: 1, y: 1 })),
    ).toContain("move / down / up");
    expect(
      ok(input({ type: "mouse", action: "down", x: 1, y: 1, button: "right" })),
    ).toMatchObject({ event: { button: "right" } });
    expect(
      bad(input({ type: "mouse", action: "down", x: 1, y: 1, button: "back" })),
    ).toContain("left / middle / right");
    for (const clickCount of [0, 4, 1.5, "2"]) {
      expect(
        bad(input({ type: "mouse", action: "down", x: 1, y: 1, clickCount })),
      ).toContain("1–3 的整数");
    }
    expect(
      ok(input({ type: "mouse", action: "down", x: 1, y: 1, clickCount: 3 })),
    ).toMatchObject({ event: { clickCount: 3 } });
  });

  test("只拷贝认识的字段", () => {
    const msg = ok(
      input({
        type: "mouse",
        action: "move",
        x: 5,
        y: 6,
        button: "left",
        clickCount: 2,
        evil: "x",
        __proto__: { polluted: true },
      }),
    );
    expect(msg).toEqual({
      type: "input",
      event: {
        type: "mouse",
        action: "move",
        x: 5,
        y: 6,
        button: "left",
        clickCount: 2,
      },
    });
  });
});

describe("滚轮", () => {
  test("合法：坐标与位移原样保留", () => {
    expect(
      ok(input({ type: "wheel", x: 3, y: 4, deltaX: -100, deltaY: 10000 })),
    ).toEqual({
      type: "input",
      event: { type: "wheel", x: 3, y: 4, deltaX: -100, deltaY: 10000 },
    });
  });

  test("坐标越界、位移超限或不是数字都拒绝", () => {
    expect(
      bad(input({ type: "wheel", x: 1280, y: 0, deltaX: 0, deltaY: 0 })),
    ).toContain("超出视口");
    for (const deltaY of [10001, -10001, Number.NaN, "1", null]) {
      expect(
        bad(input({ type: "wheel", x: 0, y: 0, deltaX: 0, deltaY })),
      ).toContain("滚轮位移");
    }
  });
});

describe("按键与文字", () => {
  test("按键：down / up，长度 1–32", () => {
    expect(ok(input({ type: "key", action: "down", key: "Enter" }))).toEqual({
      type: "input",
      event: { type: "key", action: "down", key: "Enter" },
    });
    expect(ok(input({ type: "key", action: "up", key: "中" }))).toMatchObject({
      event: { key: "中" },
    });
    expect(
      ok(input({ type: "key", action: "down", key: "a".repeat(32) })),
    ).toMatchObject({ event: { key: "a".repeat(32) } });
    expect(
      bad(input({ type: "key", action: "down", key: "a".repeat(33) })),
    ).toContain("1–32");
    expect(bad(input({ type: "key", action: "down", key: "" }))).toContain(
      "1–32",
    );
    expect(bad(input({ type: "key", action: "press", key: "a" }))).toContain(
      "down / up",
    );
    expect(bad(input({ type: "key", action: "down" }))).toContain("缺少按键名");
    expect(bad(input({ type: "key", action: "down", key: 1 }))).toContain(
      "按键名必须是字符串",
    );
  });

  test("文字：1–4000 个字符", () => {
    expect(ok(input({ type: "text", text: "你好" }))).toEqual({
      type: "input",
      event: { type: "text", text: "你好" },
    });
    expect(ok(input({ type: "text", text: "字".repeat(4000) }))).toMatchObject({
      event: { text: "字".repeat(4000) },
    });
    expect(bad(input({ type: "text", text: "字".repeat(4001) }))).toContain(
      "1–4000",
    );
    expect(bad(input({ type: "text", text: "" }))).toContain("1–4000");
    expect(bad(input({ type: "text", text: 1 }))).toContain("文字必须是字符串");
    expect(bad(input({ type: "text" }))).toContain("缺少文字");
  });

  test("未知输入事件类型、缺 event、event 不是对象都拒绝", () => {
    expect(bad(input({ type: "touch", x: 1 }))).toContain(
      "mouse / wheel / key / text",
    );
    expect(bad({ type: "input" })).toContain("缺少输入事件");
    expect(bad(input("mouse"))).toContain("缺少输入事件");
    expect(bad(input([1, 2]))).toContain("缺少输入事件");
  });
});

describe("导航", () => {
  test("back / forward / reload", () => {
    expect(ok({ type: "nav", action: "back" })).toEqual({
      type: "nav",
      action: "back",
    });
    expect(ok({ type: "nav", action: "forward" })).toEqual({
      type: "nav",
      action: "forward",
    });
    expect(ok({ type: "nav", action: "reload" })).toEqual({
      type: "nav",
      action: "reload",
    });
  });

  test("goto：trim 后非空、≤ 2000 字符", () => {
    expect(ok({ type: "nav", action: "goto", target: "  a.test  " })).toEqual({
      type: "nav",
      action: "goto",
      target: "a.test",
    });
    expect(
      ok({ type: "nav", action: "goto", target: "a".repeat(2000) }),
    ).toMatchObject({ target: "a".repeat(2000) });
    expect(
      bad({ type: "nav", action: "goto", target: "a".repeat(2001) }),
    ).toContain("最多 2000");
    expect(bad({ type: "nav", action: "goto", target: "   " })).toContain(
      "不能为空",
    );
    expect(bad({ type: "nav", action: "goto" })).toContain("缺少目标地址");
    expect(bad({ type: "nav", action: "goto", target: 1 })).toContain(
      "必须是字符串",
    );
    expect(bad({ type: "nav", action: "jump" })).toContain(
      "back / forward / reload / goto",
    );
  });
});

describe("mergeInput", () => {
  const msg = (event: unknown): ClientMessage => ok(input(event));
  const move = (x: number, y = 0) =>
    msg({ type: "mouse", action: "move", x, y });
  const wheel = (x: number, dx: number, dy: number) =>
    msg({ type: "wheel", x, y: 0, deltaX: dx, deltaY: dy });

  test("移动：只留后一条的位置", () => {
    expect(mergeInput(move(1, 2), move(3, 4))).toEqual(move(3, 4));
  });

  test("滚轮：位移相加，位置取后一条的", () => {
    expect(mergeInput(wheel(1, 5, 10), wheel(9, -2, 30))).toEqual(
      wheel(9, 3, 40),
    );
  });

  test("相加后的位移可以超过单条的上限（上限只管客户端发来的单条）", () => {
    // 期望值不能走 ok()：18000 过不了单条校验，这正是要证明的
    expect(mergeInput(wheel(1, 0, 9000), wheel(1, 0, 9000))).toEqual({
      type: "input",
      event: { type: "wheel", x: 1, y: 0, deltaX: 0, deltaY: 18000 },
    });
  });

  test("不同类、点击、键盘、文字、导航都不合并", () => {
    const down = msg({ type: "mouse", action: "down", x: 1, y: 2 });
    const key = msg({ type: "key", action: "down", key: "a" });
    const text = msg({ type: "text", text: "x" });
    expect(mergeInput(move(1), wheel(1, 0, 1))).toBeNull();
    expect(mergeInput(wheel(1, 0, 1), move(1))).toBeNull();
    expect(mergeInput(down, down)).toBeNull();
    expect(mergeInput(move(1), down)).toBeNull();
    expect(mergeInput(key, key)).toBeNull();
    expect(mergeInput(text, text)).toBeNull();
    const nav = ok({ type: "nav", action: "reload" });
    expect(mergeInput(nav, nav)).toBeNull();
    expect(mergeInput(ok({ type: "take" }), ok({ type: "take" }))).toBeNull();
  });
});

describe("其余", () => {
  test("copy 通过，多余字段丢弃；copy 不参与输入合并", () => {
    expect(ok({ type: "copy", extra: 1 })).toEqual({ type: "copy" });
    expect(mergeInput(ok({ type: "copy" }), ok({ type: "copy" }))).toBeNull();
  });

  test("take 通过，多余字段丢弃", () => {
    expect(ok({ type: "take", extra: 1 })).toEqual({ type: "take" });
  });

  test("未知 type、非对象都拒绝", () => {
    expect(bad({ type: "view", width: 800 })).toContain("未知消息类型");
    expect(bad({})).toContain("未知消息类型");
    for (const raw of [null, 42, "text", [1], undefined])
      expect(bad(raw)).toContain("JSON 对象");
  });
});
