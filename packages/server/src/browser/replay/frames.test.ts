// 回放图片：存、读、删。会话删除时整个目录一起删。
import { existsSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { FrameStore } from "./frames.js";

const jpeg = (s: string) => Buffer.from(s);

test("存、读、删：缺的文件与目录都忽略", () => {
  const dir = `${makeTmpDir("yuanshu-replay-")}/nested/replay`;
  const store = new FrameStore(dir);
  expect(store.read("s1", 1)).toBeNull();
  expect(() => store.remove("s1", [1])).not.toThrow();
  expect(() => store.removeSession("s1")).not.toThrow();

  store.save("s1", 1, jpeg("aaa"));
  store.save("s1", 2, jpeg("bbb"));
  store.save("s2", 1, jpeg("ccc"));
  expect(store.read("s1", 1)?.toString()).toBe("aaa");
  expect(store.read("s1", 2)?.toString()).toBe("bbb");
  expect(store.read("s2", 1)?.toString()).toBe("ccc");
  expect(store.read("s1", 3)).toBeNull();

  store.remove("s1", [1, 3]);
  expect(store.read("s1", 1)).toBeNull();
  expect(store.read("s1", 2)?.toString()).toBe("bbb");
});

test("removeSession 删掉整个会话目录，别的不动", () => {
  const dir = makeTmpDir("yuanshu-replay-rm-");
  const store = new FrameStore(dir);
  store.save("s1", 1, jpeg("a"));
  store.save("s1", 2, jpeg("b"));
  store.save("s2", 1, jpeg("c"));
  store.removeSession("s1");
  expect(existsSync(`${dir}/s1`)).toBe(false);
  expect(store.read("s1", 1)).toBeNull();
  expect(store.read("s2", 1)?.toString()).toBe("c");
  store.removeSession("s1");
  expect(readdirSync(dir)).toEqual(["s2"]);
});
