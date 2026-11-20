// 打码与折叠缓冲：用户看的控制台抽屉和 agent 读的必须是同一份。
import { describe, expect, test, vi } from "vitest";
import {
  ConsoleBuffer,
  clipText,
  firstFrame,
  locationUrl,
  redactText,
  redactUrl,
} from "./console.js";
import type { ConsoleInput } from "./types.js";

const input = (text: string, ts = 1): ConsoleInput => ({
  ts,
  kind: "console",
  level: "log",
  text,
});

describe("redactUrl", () => {
  test("令牌类查询参数换成 ***，其余参数保留", () => {
    const out = redactUrl("https://x.test/a?token=abc&q=1&API_KEY=k");
    expect(out).toContain("token=***");
    expect(out).toContain("q=1");
    expect(out).toContain("API_KEY=***");
    expect(out).not.toContain("abc");
  });

  test("常见名字都算令牌", () => {
    for (const name of [
      "access_token",
      "password",
      "auth",
      "code",
      "signature",
      "session_id",
      "jwt",
      "Bearer",
    ])
      expect(redactUrl(`https://x.test/?${name}=v`)).toBe(
        `https://x.test/?${name}=***`,
      );
  });

  test("不是合法 URL 原样返回", () => {
    expect(redactUrl("not a url")).toBe("not a url");
    expect(redactUrl("/relative?token=abc")).toBe("/relative?token=abc");
  });

  test("没有敏感参数时不动原串", () => {
    const u = "https://x.test/a/b?q=1#h";
    expect(redactUrl(u)).toBe(u);
  });
});

describe("redactText", () => {
  test("文本里的 URL 也打码", () => {
    expect(redactText("请求 https://x.test/a?token=abc 失败")).toBe(
      "请求 https://x.test/a?token=*** 失败",
    );
  });

  test("普通文本不动", () => {
    expect(redactText("hello 世界")).toBe("hello 世界");
  });
});

describe("locationUrl", () => {
  test("带上行号并打码", () => {
    expect(locationUrl("https://x.test/a?key=1", 7)).toBe(
      "https://x.test/a?key=***:7",
    );
    expect(locationUrl(undefined)).toBeUndefined();
  });
});

describe("firstFrame", () => {
  test("带函数名的一帧", () => {
    expect(
      firstFrame("Error: boom\n    at fn (https://x.test/a.js?token=abc:12:5)"),
    ).toEqual({ url: "https://x.test/a.js?token=abc", line: 12 });
  });

  test("消息行（不以 at 开头）里恰好带着位置，也不能当成栈帧", () => {
    expect(
      firstFrame(
        "Error: failed to load https://x.test/m.js:1:1\n    at fn (https://x.test/a.js:12:5)",
      ),
    ).toEqual({ url: "https://x.test/a.js", line: 12 });
  });

  test("匿名 / 没有函数名的一帧", () => {
    expect(firstFrame("Error: boom\n    at https://x.test/a.js:3:9")).toEqual({
      url: "https://x.test/a.js",
      line: 3,
    });
    expect(firstFrame("    at <anonymous>:1:1")).toEqual({
      url: "<anonymous>",
      line: 1,
    });
  });

  test("eval 帧取最里层的源码位置", () => {
    expect(
      firstFrame(
        "    at eval (eval at run (https://x.test/a.js:9:3), <anonymous>:1:1)",
      ),
    ).toEqual({ url: "<anonymous>", line: 1 });
  });

  test("没有栈、或没有可解析的帧就是 null", () => {
    expect(firstFrame(undefined)).toBeNull();
    expect(firstFrame("")).toBeNull();
    expect(firstFrame("Error: boom")).toBeNull();
    expect(firstFrame("    at fn (native)")).toBeNull();
  });

  test("第一帧解析不出时看后面的帧", () => {
    expect(
      firstFrame("    at fn (native)\n    at https://x.test/b:4:2"),
    ).toEqual({ url: "https://x.test/b", line: 4 });
  });
});

describe("clipText", () => {
  test("恰在上限不截断，超出加标记", () => {
    expect(clipText("x".repeat(10_000))).toBe("x".repeat(10_000));
    const cut = clipText("x".repeat(10_005));
    expect(cut.endsWith(" …(+5 chars)")).toBe(true);
    expect(cut.startsWith("x".repeat(10_000))).toBe(true);
  });
});

describe("ConsoleBuffer", () => {
  test("按首次出现排序，最近出现的组只更新 ts", () => {
    const buf = new ConsoleBuffer();
    buf.push(input("a", 1));
    buf.push(input("b", 2));
    buf.push(input("a", 3));
    const list = buf.list();
    expect(list.map((e) => e.text)).toEqual(["a", "b"]);
    expect(list.map((e) => e.firstTs)).toEqual([1, 2]);
    expect(list.map((e) => e.ts)).toEqual([3, 2]);
    expect(list.map((e) => e.count)).toEqual([2, 1]);
    // 组编号按创建顺序，不随出现次数变
    expect(list.map((e) => e.id)).toEqual([1, 2]);
  });

  test("四项完全一致才合并", () => {
    const buf = new ConsoleBuffer();
    buf.push(input("重试 3/10", 1));
    buf.push(input("重试 4/10", 2));
    buf.push({ ...input("x", 3), level: "warn" });
    buf.push({ ...input("x", 4), kind: "error", level: "error" });
    buf.push({ ...input("x", 5), url: "https://x.test/a" });
    buf.push(input("x", 6));
    buf.push(input("x", 7));
    const list = buf.list();
    // 文字 "x" 的三组：级别、类别、地址各有一处不同，最后一条跟前一条完全一致才合并
    expect(list).toHaveLength(6);
    expect(list.map((e) => e.count)).toEqual([1, 1, 1, 1, 1, 2]);
  });

  test("返回拷贝，改它不影响缓冲", () => {
    const buf = new ConsoleBuffer();
    buf.push(input("a", 1));
    const list = buf.list();
    const first = list[0];
    if (!first) throw new Error("缓冲是空的");
    list.push({ ...first, text: "c" });
    first.text = "改过";
    expect(buf.list().map((e) => e.text)).toEqual(["a"]);
  });

  test("同一组再出现时订阅者收到更新后的组，编号不变", () => {
    const buf = new ConsoleBuffer();
    const cb = vi.fn();
    buf.subscribe(cb);
    buf.push(input("a", 1));
    buf.push(input("a", 2));
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0]?.[0]).toMatchObject({ id: 1, count: 1 });
    expect(cb.mock.calls[1]?.[0]).toMatchObject({
      id: 1,
      count: 2,
      ts: 2,
      firstTs: 1,
    });
    // payload 是拷贝：改它不影响缓冲
    const payload = cb.mock.calls[1]?.[0] as { count: number };
    payload.count = 99;
    expect(buf.list()[0]?.count).toBe(2);
  });

  test("退订后不再收到", () => {
    const buf = new ConsoleBuffer();
    const cb = vi.fn();
    const off = buf.subscribe(cb);
    buf.push(input("a"));
    off();
    buf.push(input("b"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test("容量按组算，默认 500", () => {
    const buf = new ConsoleBuffer();
    for (let i = 0; i < 520; i++) buf.push(input(`m${i}`, i));
    const list = buf.list();
    expect(list).toHaveLength(500);
    expect(list[0]?.text).toBe("m20");
    expect(list.at(-1)?.text).toBe("m519");
    expect(buf.evicted()).toBe(20);
  });

  test("挤掉最久没再出现的组，不是最早创建的", () => {
    const buf = new ConsoleBuffer(2);
    buf.push(input("A", 1));
    buf.push(input("B", 2));
    buf.push(input("A", 3)); // A 又出现：B 成了最久没再出现的
    buf.push(input("C", 4));
    expect(buf.list().map((e) => e.text)).toEqual(["A", "C"]);
    expect(buf.evicted()).toBe(1);
  });

  test("evicted 累加被挤掉组的出现次数", () => {
    const buf = new ConsoleBuffer(1);
    buf.push(input("A", 1));
    buf.push(input("A", 2));
    buf.push(input("A", 3));
    buf.push(input("B", 4)); // A 的三次被挤掉
    buf.push(input("B", 5));
    buf.push(input("C", 6)); // B 的两次被挤掉
    expect(buf.list().map((e) => e.text)).toEqual(["C"]);
    expect(buf.evicted()).toBe(5);
  });

  test("刷屏一条 600 次不挤掉其他组", () => {
    const buf = new ConsoleBuffer(2);
    buf.push(input("起因", 1));
    for (let i = 0; i < 600; i++) buf.push(input("poll failed", i + 2));
    const list = buf.list();
    expect(list.map((e) => e.text)).toEqual(["起因", "poll failed"]);
    expect(list[1]?.count).toBe(600);
    expect(buf.evicted()).toBe(0);
  });

  test("写入时截断超长文字，同一组按截断后的文字合并", () => {
    const buf = new ConsoleBuffer();
    buf.push(input("x".repeat(10_010), 1));
    buf.push(input("x".repeat(10_010), 2));
    const list = buf.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.count).toBe(2);
    expect(list[0]?.text.length).toBeLessThan(10_030);
    expect(list[0]?.text.endsWith(" …(+10 chars)")).toBe(true);
  });

  test("总次数 = 现存各组 count 之和 + evicted；种数 = list().length", () => {
    const buf = new ConsoleBuffer(1);
    buf.push(input("A", 1));
    buf.push(input("A", 2));
    buf.push(input("B", 3));
    buf.push(input("B", 4));
    buf.push(input("B", 5));
    const sum = buf.list().reduce((n, e) => n + e.count, 0);
    expect(sum + buf.evicted()).toBe(5);
    expect(buf.list()).toHaveLength(1);
  });
});
