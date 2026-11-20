import { expect, test } from "vitest";
import type { SessionContext } from "../../../api/flows";
import { filterSlash, pickable, slashOptions } from "./slash";

const M = { global: false, transport: "stdio" as const };
const ctx = (over: Partial<SessionContext> = {}): SessionContext => ({
  files: [],
  skills: [{ name: "ys-ui", source: "library", path: null, loadedAt: "" }],
  mcp: [
    { ...M, name: "github", state: "ready", tools: 12 },
    { ...M, name: "db", state: "failed", tools: 0, error: "连接被拒绝" },
    { ...M, name: "old", state: "disabled", tools: 3 },
    { ...M, name: "slow", state: "connecting", tools: 0 },
    { ...M, name: "late", state: "pending", tools: 0 },
  ],
  ...over,
});

test("三组：内置命令 → 会话技能 → MCP；MCP 带状态说明", () => {
  const all = slashOptions(ctx(), () => {});
  const groups = [...new Set(all.map((o) => o.group))];
  expect(groups).toEqual(["command", "skill", "mcp"]);
  expect(all.filter((o) => o.group === "command").map((o) => o.label)).toEqual([
    "/goal",
    "/compact",
    "/mcp",
    "/reload",
    "/plan",
    "/review",
  ]);
  expect(all.find((o) => o.id === "skill:ys-ui")?.label).toBe("/ys-ui");
  const mcp = all.filter((o) => o.group === "mcp");
  expect(mcp.map((o) => [o.label, o.hint, o.ready])).toEqual([
    ["github", "12 个工具", true],
    ["db", "连接被拒绝", false],
    ["old", "已停用", false],
    ["slow", "连接中", false],
    ["late", "下一条消息时加载", false],
  ]);
});

test("MCP 行只读：不能选中，键盘选择只在命令与技能里走", () => {
  const picked: string[] = [];
  const all = slashOptions(ctx(), (n) => picked.push(n));
  expect(pickable(all).every((o) => o.group !== "mcp")).toBe(true);
  all.find((o) => o.id === "compact")?.run?.();
  all.find((o) => o.id === "skill:ys-ui")?.run?.();
  expect(picked).toEqual(["compact", "ys-ui"]);
});

test("没读到会话上下文时只有内置命令", () => {
  expect(slashOptions(null, () => []).every((o) => o.group === "command")).toBe(
    true,
  );
});

test("过滤匹配名称与说明，不分大小写；空查询原样返回", () => {
  const all = slashOptions(ctx(), () => {});
  expect(filterSlash(all, "git").map((o) => o.label)).toEqual(["github"]);
  expect(filterSlash(all, "上下文").map((o) => o.label)).toEqual(["/compact"]);
  expect(filterSlash(all, "")).toHaveLength(all.length);
});
