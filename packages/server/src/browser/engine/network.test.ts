// 网络环形缓冲：纯数据，不碰 Playwright。
import { describe, expect, test } from "vitest";
import { NetworkBuffer } from "./network.js";

const input = (url = "https://x.test/a") => ({
  ts: 1000,
  method: "GET",
  url,
  type: "xhr",
  frame: "main" as const,
});

describe("NetworkBuffer", () => {
  test("编号从 1 起、单调递增；新条目其余字段为空值", () => {
    const b = new NetworkBuffer();
    expect(b.push(input()).entry).toEqual({
      id: 1,
      ts: 1000,
      method: "GET",
      url: "https://x.test/a",
      type: "xhr",
      frame: "main",
      status: null,
      mime: "",
      size: null,
      ms: null,
      failure: null,
    });
    expect(b.push(input()).entry.id).toBe(2);
    expect(b.list().map((e) => e.id)).toEqual([1, 2]);
    expect(b.evicted()).toBe(0);
  });

  test("list 返回拷贝：改它不影响缓冲", () => {
    const b = new NetworkBuffer();
    b.push(input());
    const copy = b.list();
    if (copy[0]) copy[0].status = 500;
    expect(b.list()[0]?.status).toBeNull();
  });

  test("超过 max 挤出最旧的，evicted 累计条数", () => {
    const b = new NetworkBuffer(2);
    b.push(input("https://x.test/1"));
    b.push(input("https://x.test/2"));
    expect(b.push(input("https://x.test/3")).evicted).toBe(1);
    expect(b.list().map((e) => e.url)).toEqual([
      "https://x.test/2",
      "https://x.test/3",
    ]);
    expect(b.evicted()).toBe(1);
    b.push(input("https://x.test/4"));
    expect(b.evicted()).toBe(2);
    expect(b.list().map((e) => e.id)).toEqual([3, 4]);
  });

  test("update 回填响应 / 结束的字段；已被挤出的编号无效", () => {
    const b = new NetworkBuffer(1);
    b.push(input());
    b.update(1, { status: 200, mime: "application/json" });
    expect(b.list()[0]).toMatchObject({
      status: 200,
      mime: "application/json",
    });
    b.push(input());
    // 编号 1 已被挤出：晚到的响应不改任何东西，也不抛。
    expect(() => b.update(1, { status: 500 })).not.toThrow();
    expect(b.list().map((e) => e.status)).toEqual([null]);
  });
});
