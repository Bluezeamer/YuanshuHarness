// 缩略图文件：休眠前存、列表与唤醒时读，重启后清理孤儿文件。
import { readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { ThumbStore } from "./thumbs.js";

const jpeg = (s: string) => Buffer.from(s);

test("存、查、读、删", () => {
  const dir = `${makeTmpDir("yuanshu-thumb-")}/nested/thumbs`;
  const store = new ThumbStore(dir);
  expect(store.has("p1")).toBe(false);
  expect(store.read("p1")).toBeNull();
  store.save("p1", jpeg("aaa"));
  expect(store.has("p1")).toBe(true);
  expect(store.read("p1")?.toString()).toBe("aaa");
  store.save("p1", jpeg("bbb"));
  expect(store.read("p1")?.toString()).toBe("bbb");
  store.remove("p1");
  expect(store.has("p1")).toBe(false);
  // 删不存在的不报错
  store.remove("p1");
});

test("prune 只留 keep 里的文件，目录不存在也不报错", () => {
  const dir = makeTmpDir("yuanshu-thumb-prune-");
  expect(() => new ThumbStore(`${dir}/nope`).prune(new Set())).not.toThrow();
  const store = new ThumbStore(dir);
  store.save("keep", jpeg("a"));
  store.save("drop", jpeg("b"));
  store.prune(new Set(["keep"]));
  expect(store.has("keep")).toBe(true);
  expect(store.has("drop")).toBe(false);
  expect(readdirSync(dir)).toEqual(["keep.jpg"]);
});
