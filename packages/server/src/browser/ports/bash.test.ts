// 只包一层 BashOperations：输出原样到达调用方，同时被端口扫描看一眼；每次 exec 各扫各的。
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { scanBashOperations } from "./bash.js";

/** 假的操作层：按每次调用的块清单回吐输出。 */
function fakeOps(perCall: string[][]): BashOperations {
  return {
    exec: async (_command, _cwd, o) => {
      for (const chunk of perCall.shift() ?? []) o.onData(Buffer.from(chunk));
      return { exitCode: 0 };
    },
  };
}

test("输出原样到达调用方，端口被回调", async () => {
  const got: string[] = [];
  const ports: number[] = [];
  const wrapped = scanBashOperations(
    fakeOps([
      ["启动 localhost:3000\n", "还有 \x1b[32m127.0.0.1:8080\x1b[0m\n"],
    ]),
    (p) => void ports.push(p),
  );
  const r = await wrapped.exec("cmd", "/tmp", {
    onData: (d) => void got.push(d.toString("utf8")),
  });
  expect(r).toEqual({ exitCode: 0 });
  expect(got.join("")).toBe(
    "启动 localhost:3000\n还有 \x1b[32m127.0.0.1:8080\x1b[0m\n",
  );
  expect(ports).toEqual([3000, 8080]);
});

test("两次 exec 互不串行：上一次没结束的行不会拼到下一次", async () => {
  const ports: number[] = [];
  // 第一次输出半行就结束，第二次接着输出的是它自己的完整行
  const wrapped = scanBashOperations(
    fakeOps([["启动 localho"], ["st:3000\n"]]),
    (p) => void ports.push(p),
  );
  await wrapped.exec("a", "/", { onData: () => {} });
  expect(ports).toEqual([]);
  await wrapped.exec("b", "/", { onData: () => {} });
  // 拼起来会误认 3000；不串就不认
  expect(ports).toEqual([]);

  // 同一次 exec 内部的块边界照样拼得起来
  const same: number[] = [];
  const ok = scanBashOperations(
    fakeOps([["启动 localho", "st:3000\n"]]),
    (p) => void same.push(p),
  );
  await ok.exec("c", "/", { onData: () => {} });
  expect(same).toEqual([3000]);
});

test("exec 抛错时原样抛出", async () => {
  const boom = new Error("boom");
  const wrapped = scanBashOperations(
    {
      exec: async () => {
        throw boom;
      },
    },
    () => {},
  );
  await expect(wrapped.exec("x", "/", { onData: () => {} })).rejects.toBe(boom);
});
