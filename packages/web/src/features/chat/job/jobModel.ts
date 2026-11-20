// 后台任务的展示用纯函数：种类与状态文案、用时、点开去哪、日志文本整理。

import type { JobInfo, JobSnapshot } from "../../../api";
import { fmtDuration } from "../model/metrics";

export type JobTone = "run" | "ok" | "failed" | "idle";

/** 任务是哪一类：命令、工具、工作流、子代理、团队成员（服务端用固定的任务名区分后两类） */
export function jobKind(j: JobSnapshot): string {
  if (j.kind === "command") return "后台命令";
  if (j.kind === "subagent")
    return j.name === "team_member" ? "团队成员" : "子代理";
  return j.name === "workflow_run" ? "工作流" : "后台工具";
}

/** 子代理与团队成员有自己的执行体标签：点开去那里；其余开任务标签 */
export const execOf = (j: JobSnapshot): string | null =>
  j.kind === "subagent" ? j.ref : null;

export function jobState(j: JobSnapshot): { tone: JobTone; word: string } {
  switch (j.state) {
    case "running":
      return { tone: "run", word: "运行中" };
    case "done":
      return { tone: "ok", word: j.kind === "subagent" ? "已交付" : "已完成" };
    case "failed":
      return { tone: "failed", word: "失败" };
    case "stopped":
      return { tone: "idle", word: "已停止" };
    case "interrupted":
      return { tone: "idle", word: "因重启中断" };
  }
}

/** 用时；没结束的算到 now */
export function ranText(j: JobSnapshot, now: number): string {
  const from = Date.parse(j.startedAt);
  if (!Number.isFinite(from)) return "";
  const to = j.endedAt === null ? now : Date.parse(j.endedAt);
  return Number.isFinite(to) ? fmtDuration(Math.max(0, to - from)) : "";
}

/** 退出码：0 与没有都不写，非 0 才值得露出来 */
export const exitText = (j: JobSnapshot): string =>
  j.exitCode !== null && j.exitCode !== 0 ? `退出码 ${j.exitCode}` : "";

/** 完整命令（bash）原样；其他工具的参数是一行 JSON，排成缩进好读的样子 */
export function inputText(j: JobInfo): string {
  if (j.input === "" || j.kind === "command") return j.input;
  try {
    return JSON.stringify(JSON.parse(j.input), null, 2);
  } catch {
    return j.input;
  }
}

/** 客户端最多留这么多日志文本；更早的丢掉，界面提示「已省略更早的输出」 */
export const LOG_KEEP = 1_000_000;

export function appendLog(
  prev: string,
  chunk: string,
): { text: string; cut: boolean } {
  const all = prev + chunk;
  return all.length > LOG_KEEP
    ? { text: all.slice(all.length - LOG_KEEP), cut: true }
    : { text: all, cut: false };
}

// 终端控制序列：CSI（颜色、光标）与 OSC（标题、超链接）；界面不是终端，只留文字
const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配的就是控制字符
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * 日志整理成可读文本：去掉终端控制序列；`\r` 覆写（进度条）只留每行最后一次写的内容。
 * 整理的是整段缓冲而不是单个分片，所以分片切在序列中间也不影响。
 */
export function cleanLog(raw: string): string {
  return raw
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const at = line.lastIndexOf("\r");
      return at < 0 ? line : line.slice(at + 1) || line.slice(0, at);
    })
    .join("\n");
}
