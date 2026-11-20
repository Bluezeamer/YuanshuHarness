import { afterEach, expect, test, vi } from "vitest";
import {
  decodeLocal,
  flushLocal,
  localKey,
  localPrefix,
  readLocal,
  removeLocal,
  sweepLocal,
  writeLocal,
  writeLocalSoon,
} from "./localState";

const asString = (v: unknown) => (typeof v === "string" ? v : null);

afterEach(() => {
  flushLocal();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("键：统一前缀，分段做编码，所以前缀清理不会串到别的段里", () => {
  expect(localKey("canvas.tree")).toBe("ys.canvas.tree");
  expect(localKey("file.draft", "local", "/a b/c.md")).toBe(
    "ys.file.draft:local:%2Fa%20b%2Fc.md",
  );
  expect(localKey("x", "a:b", "c")).toBe("ys.x:a%3Ab:c");
  expect(localKey("x", "a:b", "c").startsWith(localPrefix("x", "a"))).toBe(
    false,
  );
  expect(localKey("x", "a", "c").startsWith(localPrefix("x", "a"))).toBe(true);
  // 命名空间之间也不串：ys.canvas.tree 不是 ys.canvas.treeview 的前缀
  expect(
    localKey("canvas.treeview", "a").startsWith(localPrefix("canvas.tree")),
  ).toBe(false);
});

test("读写：存了读回来；没有、坏了、校验不过都当没有，不抛错", () => {
  const k = localKey("t", "1");
  expect(readLocal(k, asString)).toBeNull();
  writeLocal(k, "你好\n世界");
  expect(readLocal(k, asString)).toBe("你好\n世界");
  expect(readLocal(k, (v) => (typeof v === "number" ? v : null))).toBeNull();
  localStorage.setItem(k, "{oops");
  expect(readLocal(k, asString)).toBeNull();
  expect(decodeLocal(null, asString)).toBeNull();
  expect(decodeLocal('"x"', asString)).toBe("x");
  removeLocal(k);
  expect(localStorage.getItem(k)).toBeNull();
});

test("太大不存，并且把旧值删掉（留着旧的会在恢复时冒出过期内容）", () => {
  const k = localKey("t", "big");
  writeLocal(k, "小", 100);
  expect(readLocal(k, asString)).toBe("小");
  writeLocal(k, "大".repeat(200), 100);
  expect(localStorage.getItem(k)).toBeNull();
});

test("存储不可用（配额、隐私模式）：读写都不抛错，当没有", () => {
  const k = localKey("t", "broken");
  writeLocal(k, "旧");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(() => writeLocal(k, "新")).not.toThrow();
  expect(localStorage.getItem(k)).toBeNull();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(readLocal(k, asString)).toBeNull();
  expect(() => removeLocal(k)).not.toThrow();
});

test("防抖写：连续写只落最后一次；读同一个键、flush、页面隐藏都会先落下", () => {
  vi.useFakeTimers();
  const k = localKey("t", "soon");
  const set = vi.spyOn(Storage.prototype, "setItem");
  writeLocalSoon(k, "a");
  writeLocalSoon(k, "ab");
  writeLocalSoon(k, "abc");
  expect(localStorage.getItem(k)).toBeNull();
  vi.advanceTimersByTime(399);
  expect(localStorage.getItem(k)).toBeNull();
  vi.advanceTimersByTime(1);
  expect(readLocal(k, asString)).toBe("abc");
  expect(set).toHaveBeenCalledTimes(1);

  writeLocalSoon(k, "读之前");
  expect(readLocal(k, asString)).toBe("读之前");

  writeLocalSoon(k, "关页面");
  window.dispatchEvent(new Event("pagehide"));
  expect(localStorage.getItem(k)).toBe('"关页面"');

  writeLocalSoon(k, "后台");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(localStorage.getItem(k)).toBe('"后台"');
});

test("防抖写：等待期间删了就不会又被写回来", () => {
  vi.useFakeTimers();
  const k = localKey("t", "gone");
  writeLocalSoon(k, "x");
  removeLocal(k);
  vi.advanceTimersByTime(1000);
  expect(localStorage.getItem(k)).toBeNull();
});

test("按前缀清理：只动这个前缀下的键，坏记录一律删，其余按 drop 判断", () => {
  writeLocal(localKey("sw", "a"), 1);
  writeLocal(localKey("sw", "b"), 2);
  writeLocal(localKey("sw", "c"), 3);
  localStorage.setItem(localKey("sw", "bad"), "{oops");
  writeLocal(localKey("sw2", "a"), 9);
  const seen: unknown[] = [];
  sweepLocal(localPrefix("sw"), (_k, v) => {
    seen.push(v);
    return v === 2;
  });
  expect(seen.sort()).toEqual([1, 2, 3]);
  expect(localStorage.getItem(localKey("sw", "a"))).not.toBeNull();
  expect(localStorage.getItem(localKey("sw", "b"))).toBeNull();
  expect(localStorage.getItem(localKey("sw", "bad"))).toBeNull();
  expect(localStorage.getItem(localKey("sw2", "a"))).not.toBeNull();
});
