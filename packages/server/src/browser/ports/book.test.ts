import { expect, test } from "vitest";
import { PortBook } from "./book.js";

test("按工作区与按环境隔离", () => {
  const book = new PortBook();
  book.note("w1", "local", 3000);
  expect(book.has("w1", "local", 3000)).toBe(true);
  // 别的工作区、别的环境、别的端口都不算
  expect(book.has("w2", "local", 3000)).toBe(false);
  expect(book.has("w1", "e2", 3000)).toBe(false);
  expect(book.has("w1", "local", 3001)).toBe(false);
  expect(book.list("w2")).toEqual([]);
});

test("重复记不增加，按记下的先后列出", () => {
  const book = new PortBook();
  book.note("w1", "local", 3000);
  book.note("w1", "e2", 8080);
  book.note("w1", "local", 3000);
  expect(book.list("w1")).toEqual([
    { envId: "local", port: 3000 },
    { envId: "e2", port: 8080 },
  ]);
});

test("每个工作区最多 64 条，超出丢最早记的", () => {
  const book = new PortBook();
  for (let p = 1; p <= 70; p++) book.note("w1", "local", p);
  const list = book.list("w1");
  expect(list).toHaveLength(64);
  expect(list[0]).toEqual({ envId: "local", port: 7 });
  expect(list.at(-1)).toEqual({ envId: "local", port: 70 });
  expect(book.has("w1", "local", 6)).toBe(false);
  expect(book.has("w1", "local", 7)).toBe(true);
  // 上限按工作区算，不影响别人
  book.note("w2", "local", 3000);
  expect(book.list("w2")).toHaveLength(1);
});

test("forget 只清自己的工作区", () => {
  const book = new PortBook();
  book.note("w1", "local", 3000);
  book.note("w2", "local", 3000);
  book.forget("w1");
  expect(book.has("w1", "local", 3000)).toBe(false);
  expect(book.list("w1")).toEqual([]);
  expect(book.has("w2", "local", 3000)).toBe(true);
});
