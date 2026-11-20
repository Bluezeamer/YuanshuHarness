// 载荷：tag 规则、按码点截断标题、恒 ≤ 2048 字节。
import { expect, test } from "vitest";
import { buildPayload, encodePayload } from "./payload.js";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

test("tag：会话事件一律 s:<会话 id>，测试推送用 test", () => {
  for (const kind of ["blocked", "error", "done", "resolved"] as const)
    expect(buildPayload(kind, "abc", "标题").tag).toBe("s:abc");
  expect(buildPayload("test", "", "").tag).toBe("test");
  expect(buildPayload("blocked", "abc", "标题")).toMatchObject({
    v: 1,
    kind: "blocked",
    sid: "abc",
    title: "标题",
  });
});

test("标题按码点截到 60 个，被截时补省略号；不拆代理对", () => {
  const long = "😀".repeat(80);
  const p = buildPayload("done", "abc", long);
  expect(Array.from(p.title)).toHaveLength(61);
  expect(p.title.endsWith("…")).toBe(true);
  expect(p.title.slice(0, -1)).toBe("😀".repeat(60));

  const exact = "a".repeat(60);
  expect(buildPayload("done", "abc", exact).title).toBe(exact);
  expect(buildPayload("done", "abc", "a".repeat(61)).title).toBe(
    `${"a".repeat(60)}…`,
  );
});

test("encodePayload 恒 ≤ 2048 字节：一堆 4 字节码点也一样", () => {
  // 会话 id 是 uuidv7（36 字符），取 64 字符的余量；title 只有 60 个码点。
  const heavy = buildPayload("blocked", "s".repeat(64), "𠀋".repeat(60));
  const json = encodePayload(heavy);
  expect(bytes(json)).toBeLessThanOrEqual(2048);
  expect(JSON.parse(json)).toEqual(heavy);
  expect(json).not.toContain("\ufffd");

  const normal = buildPayload("error", "abc", "修好了吗");
  const out = encodePayload(normal);
  expect(JSON.parse(out)).toEqual(normal);
  expect(bytes(out)).toBeLessThanOrEqual(2048);
});

test("超出预算时只削标题，直到缩到 2048 字节内", () => {
  // sid 与 tag 已占去大半预算，标题只能活下来一小段。
  const p = buildPayload("done", "s".repeat(980), "y".repeat(60));
  const json = encodePayload(p);
  expect(bytes(json)).toBeLessThanOrEqual(2048);
  const parsed = JSON.parse(json) as { sid: string; title: string };
  expect(parsed.sid).toBe(p.sid);
  expect(parsed.title.length).toBeLessThan(60);
  expect(parsed.title).toBe("y".repeat(parsed.title.length));
});

test("会话 id 本身就用掉预算时，只能把标题削到空", () => {
  const json = encodePayload(buildPayload("blocked", "s".repeat(2000), "标题"));
  expect((JSON.parse(json) as { title: string }).title).toBe("");
});

test("极端长标题也能压到预算内，且仍是合法 JSON", () => {
  const json = encodePayload(buildPayload("done", "abc", "x".repeat(5000)));
  expect(bytes(json)).toBeLessThanOrEqual(2048);
  expect(JSON.parse(json)).toMatchObject({ kind: "done", sid: "abc" });
});
