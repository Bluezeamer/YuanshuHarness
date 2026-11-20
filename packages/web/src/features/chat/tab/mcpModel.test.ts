import { expect, test } from "vitest";
import type { ContextMcp } from "../../../api/flows";
import { needsHostDeps, sortMcp, stillConnecting, whereText } from "./mcpModel";

const m = (over: Partial<ContextMcp>): ContextMcp => ({
  name: "a",
  state: "ready",
  tools: 0,
  global: false,
  transport: "stdio",
  ...over,
});

test("要处理的排前面：失败、连接中、就绪、停用；同类按名字", () => {
  const list = [
    m({ name: "z", state: "disabled" }),
    m({ name: "b", state: "ready" }),
    m({ name: "a", state: "ready" }),
    m({ name: "c", state: "connecting" }),
    m({ name: "d", state: "failed" }),
    m({ name: "p", state: "pending" }),
  ];
  expect(sortMcp(list).map((x) => x.name)).toEqual([
    "d",
    "c",
    "p",
    "a",
    "b",
    "z",
  ]);
});

test("有「连接中」就要继续读", () => {
  expect(stillConnecting([m({}), m({ state: "connecting" })])).toBe(true);
  expect(stillConnecting([m({}), m({ state: "failed" })])).toBe(false);
});

test("运行位置：http 是 Server 直连；stdio 优先用服务端给的主机名，没有就说明范围", () => {
  expect(whereText(m({ transport: "http", where: "Server" }))).toBe(
    "Server 直连",
  );
  expect(whereText(m({ transport: "http" }))).toBe("Server 直连");
  expect(whereText(m({ where: "测试机" }))).toBe("测试机");
  expect(whereText(m({}))).toBe("会话第一个目录所在的主机");
});

test("只有 stdio 服务失败时才提醒自行装依赖", () => {
  expect(needsHostDeps([m({ state: "failed" })])).toBe(true);
  expect(needsHostDeps([m({ state: "failed", transport: "http" })])).toBe(
    false,
  );
  expect(needsHostDeps([m({ state: "ready" })])).toBe(false);
});
