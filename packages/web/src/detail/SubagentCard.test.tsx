import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { parseSpawn, SubagentCard, spawnTask } from "./SubagentCard";

afterEach(cleanup);

const RESULT = JSON.stringify({
  childId: "c-1",
  agent: "coder",
  workspaces: ["web", "api"],
  tier: "auto",
});

test("parseSpawn 取出 spawn_subagent 的单行 JSON 结果", () => {
  expect(parseSpawn(RESULT)).toEqual({
    childId: "c-1",
    agent: "coder",
    workspaces: ["web", "api"],
    tier: "auto",
  });
});

test("parseSpawn 对非 JSON、缺 childId、空值都返回 null", () => {
  expect(parseSpawn(undefined)).toBeNull();
  expect(parseSpawn("")).toBeNull();
  expect(parseSpawn("派发失败：depth")).toBeNull();
  expect(parseSpawn(JSON.stringify({ agent: "x" }))).toBeNull();
});

test("spawnTask 取参数里的 task，参数坏掉时为空", () => {
  expect(spawnTask(JSON.stringify({ task: "读文件" }))).toBe("读文件");
  expect(spawnTask("{坏")).toBe("");
  expect(spawnTask(undefined)).toBe("");
});

test("卡片写明任务、agent、环境、档位，并链接到子会话", () => {
  const info = parseSpawn(RESULT);
  if (!info) throw new Error("parse");
  render(<SubagentCard info={info} task="读文件并返回暗号" />);
  expect(screen.getByText("读文件并返回暗号")).toBeTruthy();
  expect(screen.getByText("coder")).toBeTruthy();
  expect(screen.getByText("web、api")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: /查看子会话/ }).getAttribute("href"),
  ).toBe("/sessions/c-1");
});
