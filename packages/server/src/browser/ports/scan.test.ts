// 端口扫描是纯逻辑：一段输出进，认到的端口出。用例覆盖写法、颜色码、块边界、去重与非法输入。
import { expect, test } from "vitest";
import { createPortScanner } from "./scan.js";

function scan(chunks: Array<string | Buffer>): number[] {
  const seen: number[] = [];
  const s = createPortScanner((p) => void seen.push(p));
  for (const c of chunks) s.push(c);
  return seen;
}

test("几种本机写法都认", () => {
  expect(scan(["listening on localhost:3000\n"])).toEqual([3000]);
  expect(scan(["http://127.0.0.1:8080/ 已启动\n"])).toEqual([8080]);
  expect(scan(["serving at 0.0.0.0:5173\n"])).toEqual([5173]);
  expect(scan(["http://[::1]:4000/x\n"])).toEqual([4000]);
  expect(scan(["绑定 [::]:4000\n"])).toEqual([4000]);
  // 大小写不敏感，一句里多个地址各算一次
  expect(scan(["LOCALHOST:80 与 localhost:443\n"])).toEqual([80, 443]);
  // 换行之前的部分不丢
  expect(scan(["ready on localhost:3000\n", "next localhost:3001\n"])).toEqual([
    3000, 3001,
  ]);
});

test("颜色码把地址切碎也认", () => {
  expect(
    scan(["\x1b[36mhttp://localhost:\x1b[1m3000\x1b[0m\x1b[0m 已启动\n"]),
  ).toEqual([3000]);
  // 一行被颜色码切成三段，属于同一行：分块喂也一样
  expect(
    scan(["\x1b[36mhttp://local", "host:\x1b[1m30", "00\x1b[0m\n"]),
  ).toEqual([3000]);
});

test("一行切在两块之间", () => {
  expect(scan(["启动中 localh", "ost:3000\n"])).toEqual([3000]);
  expect(scan(["端口 30", "00 在 localhost", ":", "3000\n"])).toEqual([3000]);
  // 端口号本身被切开：两半都不是合法端口，拼起来才认
  expect(scan(["http://localhost:30", "00\n"])).toEqual([3000]);
});

test("同一行里重复的端口只回调一次，不同行各算一次", () => {
  expect(scan(["localhost:3000 与 localhost:3000\n"])).toEqual([3000]);
  expect(scan(["localhost:3000\nlocalhost:3000\n"])).toEqual([3000, 3000]);
});

test("越界与非本机写法不认", () => {
  for (const line of [
    "localhost:0",
    "localhost:70000",
    "mylocalhost:3000",
    "example.com:3000",
    "10.0.0.1:3000",
    "10.0.0.0:3000",
    ":3000",
    "localhost:",
    "localhost:30a0",
  ])
    expect(scan([`${line}\n`]), line).toEqual([]);
  // 数字紧跟着更多数字不算端口（不截成 3000），整串越界就丢掉
  expect(scan(["localhost:300011\n"])).toEqual([]);
});

test("超长无换行的块：不抛错、不卡住，之后的完整行照样认", () => {
  const seen: number[] = [];
  const s = createPortScanner((p) => void seen.push(p));
  expect(() => {
    for (let i = 0; i < 200; i++) s.push("x".repeat(1024));
  }).not.toThrow();
  s.push("\nlocalhost:3000\n");
  expect(seen).toEqual([3000]);
});
