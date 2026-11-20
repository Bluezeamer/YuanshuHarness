import { expect, test } from "vitest";
import type { JobInfo, JobSnapshot } from "../../../api";
import {
  appendLog,
  cleanLog,
  execOf,
  exitText,
  inputText,
  jobKind,
  jobState,
  LOG_KEEP,
  ranText,
} from "./jobModel";

const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: "a1b2c3d4",
  kind: "command",
  name: "bash",
  label: "npm run build",
  ref: null,
  state: "done",
  exitCode: 0,
  startedAt: "2026-11-17T08:00:00.000Z",
  endedAt: "2026-11-17T08:01:23.000Z",
  ...over,
});

test("种类：命令、工具、工作流、子代理、团队成员各有名字", () => {
  expect(jobKind(job())).toBe("后台命令");
  expect(jobKind(job({ kind: "tool", name: "mcp_fetch" }))).toBe("后台工具");
  expect(jobKind(job({ kind: "tool", name: "workflow_run" }))).toBe("工作流");
  expect(jobKind(job({ kind: "subagent", name: "spawn_subagent" }))).toBe(
    "子代理",
  );
  expect(jobKind(job({ kind: "subagent", name: "team_member" }))).toBe(
    "团队成员",
  );
});

test("状态：完成与交付分开说，失败是红，停止与中断是中性", () => {
  expect(jobState(job())).toEqual({ tone: "ok", word: "已完成" });
  expect(jobState(job({ kind: "subagent", ref: "c1" }))).toEqual({
    tone: "ok",
    word: "已交付",
  });
  expect(jobState(job({ state: "failed", exitCode: 2 }))).toEqual({
    tone: "failed",
    word: "失败",
  });
  expect(jobState(job({ state: "stopped" })).tone).toBe("idle");
  expect(jobState(job({ state: "interrupted" })).word).toBe("因重启中断");
  expect(jobState(job({ state: "running", endedAt: null })).tone).toBe("run");
});

test("点开去哪：只有子代理 / 团队成员有执行体可去", () => {
  expect(execOf(job())).toBeNull();
  expect(execOf(job({ kind: "subagent", ref: "child-1" }))).toBe("child-1");
});

test("用时：结束的算到结束时间，没结束的算到现在，时间坏了不写", () => {
  expect(ranText(job(), 0)).toBe("1 分 23 秒");
  const run = job({ state: "running", endedAt: null });
  expect(ranText(run, Date.parse("2026-11-17T08:00:12.000Z"))).toBe("12.0 秒");
  expect(ranText(job({ startedAt: "坏的" }), 0)).toBe("");
});

test("退出码：0 与没有都不写", () => {
  expect(exitText(job())).toBe("");
  expect(exitText(job({ exitCode: null }))).toBe("");
  expect(exitText(job({ state: "failed", exitCode: 137 }))).toBe("退出码 137");
});

test("输入：命令原样，其他工具的参数 JSON 排成缩进", () => {
  const info = (over: Partial<JobInfo>): JobInfo => ({
    ...job(),
    sessionId: "s1",
    remindMs: 0,
    input: "",
    ...over,
  });
  expect(inputText(info({ input: "echo 'a  b'\nls" }))).toBe("echo 'a  b'\nls");
  expect(
    inputText(info({ kind: "tool", name: "fetch", input: '{"url":"x"}' })),
  ).toBe('{\n  "url": "x"\n}');
  expect(inputText(info({ kind: "tool", input: "不是 JSON" }))).toBe(
    "不是 JSON",
  );
});

test("日志缓冲：超出上限只留末尾并标记被截", () => {
  expect(appendLog("ab", "cd")).toEqual({ text: "abcd", cut: false });
  const r = appendLog("x".repeat(LOG_KEEP), "tail");
  expect(r.cut).toBe(true);
  expect(r.text).toHaveLength(LOG_KEEP);
  expect(r.text.endsWith("tail")).toBe(true);
});

test("日志整理：去掉颜色与标题序列，进度条只留最后一次写", () => {
  expect(cleanLog("\u001b[32mok\u001b[0m done\n")).toBe("ok done\n");
  expect(cleanLog("\u001b]0;title\u0007text")).toBe("text");
  expect(cleanLog("10%\r50%\r100%\nnext")).toBe("100%\nnext");
  expect(cleanLog("a\r\nb")).toBe("a\nb");
  // 行尾的 \r（光标回到行首但什么也没写）不能把整行吃掉
  expect(cleanLog("line\r\n")).toBe("line\n");
});
