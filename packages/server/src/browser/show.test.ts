// ShowBus：按工作区投递、按订阅者计数、取消幂等；一个订阅者抛错不影响别的。
import { describe, expect, test } from "vitest";
import { createShowBus, type ShowRequest } from "./show.js";

const show = (note = ""): ShowRequest => ({
  sessionId: "s1",
  by: "会话一",
  pageId: "p1",
  title: "示例页",
  url: "https://example.com/a",
  note,
});

describe("ShowBus", () => {
  test("按工作区分组投递", () => {
    const bus = createShowBus();
    const w1: ShowRequest[] = [];
    const w2: ShowRequest[] = [];
    bus.subscribe("w1", (s) => w1.push(s));
    bus.subscribe("w2", (s) => w2.push(s));
    bus.publish("w1", show("看这里"));
    expect(w1.map((s) => s.note)).toEqual(["看这里"]);
    // 别的工作区收不到
    expect(w2).toEqual([]);
    bus.publish("w2", show("给二"));
    expect(w2.map((s) => s.note)).toEqual(["给二"]);
    expect(w1.map((s) => s.note)).toEqual(["看这里"]);
  });

  test("返回送达的订阅者个数：没有界面是 0，多个界面就逐个送", () => {
    const bus = createShowBus();
    expect(bus.publish("w1", show())).toBe(0);
    const seen: string[] = [];
    bus.subscribe("w1", (s) => seen.push(`a:${s.pageId}`));
    expect(bus.publish("w1", show())).toBe(1);
    bus.subscribe("w1", (s) => seen.push(`b:${s.pageId}`));
    expect(bus.publish("w1", show())).toBe(2);
    expect(seen).toEqual(["a:p1", "a:p1", "b:p1"]);
  });

  test("一个订阅者抛错不影响其他订阅者，也不把错误抛给调用方", () => {
    const bus = createShowBus();
    const seen: ShowRequest[] = [];
    bus.subscribe("w1", () => {
      throw new Error("界面坏了");
    });
    bus.subscribe("w1", (s) => seen.push(s));
    expect(() => bus.publish("w1", show("ok"))).not.toThrow();
    expect(seen.map((s) => s.note)).toEqual(["ok"]);
  });

  test("取消订阅后不再收到；重复取消没有副作用", () => {
    const bus = createShowBus();
    const seen: ShowRequest[] = [];
    const off = bus.subscribe("w1", (s) => seen.push(s));
    const other: ShowRequest[] = [];
    bus.subscribe("w1", (s) => other.push(s));
    off();
    off();
    expect(bus.publish("w1", show())).toBe(1);
    expect(seen).toEqual([]);
    expect(other).toHaveLength(1);
  });
});
