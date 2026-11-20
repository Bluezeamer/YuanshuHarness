// 后台任务工具（subagent.md §2）：job_start / job_list / job_stop / job_remind。
// 框架工具：全部会话都有，不受模式约束；内层调用的校验、钩子与权限与直接调用相同。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { parseCall, validateCall } from "../session/call-tool.js";
import {
  JOB_REMIND_MAX_S as REMIND_MAX_S,
  JOB_REMIND_MIN_S as REMIND_MIN_S,
} from "../store/defaults.js";
import type { JobRow } from "../store/jobs.js";
import type { JobManager } from "./manager.js";
import { duration, listLine } from "./messages.js";

export const JOB_TOOLS = [
  "job_start",
  "job_list",
  "job_stop",
  "job_remind",
] as const;

/**
 * 有些任务底下是别的机制（团队成员、工作流里的 agent），在任务工具里不当普通任务看：
 * 清单里不逐个列，对它们的停止、调提醒被拒并指向正确的工具。
 */
export interface JobView {
  /** 这一行不是普通任务时，返回拒绝的说明（给模型看）；普通任务返回 null */
  refusal(row: JobRow, tool: string): string | null;
  /** 清单里额外给的几行（例如团队只占一行） */
  lines(owner: string): string[];
}

export const combineViews = (...views: JobView[]): JobView => ({
  refusal: (row, tool) => {
    for (const v of views) {
      const r = v.refusal(row, tool);
      if (r !== null) return r;
    }
    return null;
  },
  lines: (owner) => views.flatMap((v) => v.lines(owner)),
});

/** 不能放进后台的工具：交互的、改模式的、任务工具自己、团队与成员间消息 */
const FOREGROUND_ONLY = new Set<string>([
  ...JOB_TOOLS,
  "call_tool",
  "ask_user",
  "switch_mode",
  "deliver",
  "post",
  "workflow_list",
  "team_create",
  "team_update",
  "team_stop",
  "team_status",
  "team_disband",
  "team_diff",
]);

const LOG_LINES_DEFAULT = 100;
const LOG_LINES_MAX = 2000;

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
  ...(isError ? { isError: true } : {}),
});

const seconds = (what: string, extra = "") => ({
  type: "number",
  minimum: 0,
  maximum: REMIND_MAX_S,
  description: `${what}, in seconds, between ${REMIND_MIN_S} and ${REMIND_MAX_S}${extra}`,
});

type Content = { type: string; text?: string };
const textOf = (r: unknown): string =>
  ((r as { content?: Content[] }).content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

/** 0 或不小于下限；0 仅限 allowZero。不合法返回说明。 */
function checkRemind(v: unknown, allowZero: boolean): string | null {
  if (v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v))
    return "remind_after must be a number of seconds.";
  if (v === 0)
    return allowZero
      ? null
      : "remind_after: 0 (no reminders) is only allowed for bash; other tools and subagents must have reminders.";
  return v >= REMIND_MIN_S && v <= REMIND_MAX_S
    ? null
    : `remind_after must be 0 or between ${REMIND_MIN_S} and ${REMIND_MAX_S} seconds.`;
}

export function jobExtension(
  jobs: JobManager,
  owner: string,
  // 此刻可以调用的工具名（启用集合）
  callable: () => string[],
  view?: JobView,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "job_start",
      label: "job_start",
      description:
        "Run one call of any tool in the background and return a job id immediately. Same shape as call_tool: { name, arguments }; the inner call goes through the same validation, hooks and permission checks as a direct call. When the job finishes (or fails, or is stopped) you are notified automatically, and while it runs you get a periodic reminder. Do NOT poll or sleep: do other work that does not overlap with it, or briefly tell the user it was started and end your turn. Use it for long-running commands, dev servers and slow tools. A short job that ends within a moment returns its result directly.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the tool to run" },
          arguments: {
            description: "Arguments object for that tool (omit for none)",
          },
          label: {
            type: "string",
            maxLength: 80,
            description: "Short name to recognize the job by (optional)",
          },
          remind_after: seconds(
            "Reminder interval (optional; default from settings)",
            ". 0 = no reminders, allowed for bash only (e.g. a dev server)",
          ),
        },
        required: ["name"],
      } as never,
      prepareArguments: (a: unknown) => a as never,
      async execute(_id, params, _signal, _update, ctx) {
        const p = params as {
          name?: unknown;
          arguments?: unknown;
          label?: unknown;
          remind_after?: unknown;
        };
        const names = callable().filter((n) => !FOREGROUND_ONLY.has(n));
        const parsed = parseCall(
          { name: p.name, arguments: p.arguments },
          names,
        );
        if (!parsed.ok)
          return text(parsed.error.replaceAll("call_tool", "job_start"), true);
        const bad = checkRemind(p.remind_after, parsed.name === "bash");
        if (bad) return text(bad, true);
        const tool = ctx.tools.find((t) => t.name === parsed.name);
        if (tool) {
          const v = validateCall(tool as never, parsed.args);
          if (!v.ok)
            return text(v.error.replaceAll("call_tool", "job_start"), true);
        }
        const isBash = parsed.name === "bash";
        const label =
          (typeof p.label === "string" && p.label.trim()) ||
          (isBash && typeof parsed.args.command === "string"
            ? parsed.args.command.split("\n")[0]?.slice(0, 80)
            : parsed.name) ||
          parsed.name;
        const remindMs =
          typeof p.remind_after === "number"
            ? p.remind_after * 1000
            : undefined;
        const r = await jobs.startTool(
          owner,
          {
            kind: isBash ? "command" : "tool",
            name: parsed.name,
            label,
            // 界面详情用：bash 存命令原文，其余工具存参数 JSON
            input: isBash
              ? typeof parsed.args.command === "string"
                ? parsed.args.command
                : ""
              : JSON.stringify(parsed.args),
            ...(remindMs === undefined ? {} : { remindMs }),
          },
          async (h) => {
            const out = await ctx.executeTool(parsed.name, parsed.args, {
              signal: h.signal,
            });
            const exit = (
              out.result as { structuredContent?: { exit_code?: number } }
            ).structuredContent?.exit_code;
            return {
              ok: !out.isError,
              exitCode: exit ?? null,
              // 命令的输出已经流式进了日志；没跑起来（被拦、参数错）或不是命令时，把结果文字记进去
              ...(isBash && exit !== undefined
                ? {}
                : { text: textOf(out.result) }),
              result: out,
            };
          },
        );
        if (r.settled && !r.settled.result)
          return text(
            `Job ${r.id} failed at once: ${r.settled.text ?? "unknown error"}`,
            true,
          );
        if (r.settled?.result) {
          const out = r.settled.result as {
            result: { content: Content[] };
            isError: boolean;
          };
          return {
            ...out.result,
            content: [
              { type: "text" as const, text: `Job ${r.id} finished at once:` },
              ...out.result.content,
            ],
            ...(out.isError ? { isError: true } : {}),
          } as never;
        }
        const row = jobs.own(owner, r.id);
        return text(
          `Started job ${r.id}. You will be notified when it finishes${
            row.remindMs > 0
              ? ` (and every ${duration(row.remindMs)} while it runs)`
              : ""
          }. Don't poll: do other work that does not overlap with it, or end your turn.`,
        );
      },
    });

    pi.registerTool({
      name: "job_list",
      label: "job_list",
      description:
        "List your background jobs with their state; with an id, show that job and the end of its log. Use it to find a job id again (e.g. after context compaction) or to read more of a log.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job id (optional)" },
          lines: {
            type: "integer",
            minimum: 1,
            maximum: LOG_LINES_MAX,
            description: `With id: how many lines of the log's end to show (default ${LOG_LINES_DEFAULT})`,
          },
        },
      } as never,
      async execute(_id, params) {
        const p = params as { id?: string; lines?: number };
        if (p.id === undefined) {
          const lines = [
            ...jobs
              .list(owner)
              .filter((r) => view?.refusal(r, "job_list") == null)
              .map((r) => listLine(r)),
            ...(view?.lines(owner) ?? []),
          ];
          return text(lines.length === 0 ? "No jobs." : lines.join("\n"));
        }
        const row = jobs.own(owner, p.id);
        const refused = view?.refusal(row, "job_list");
        if (refused != null) return text(refused, true);
        const tail = jobs.tail(row.id, p.lines ?? LOG_LINES_DEFAULT);
        return text(`${listLine(row)}\n${tail === "" ? "(no output)" : tail}`);
      },
    });

    pi.registerTool({
      name: "job_stop",
      label: "job_stop",
      description:
        "Stop a background job. Everything under it (its own background jobs and subagents) is stopped too; the result lists what was stopped. You are not notified about a stop you requested.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Job id" } },
        required: ["id"],
      } as never,
      async execute(_id, params) {
        const { id } = params as { id: string };
        const row = jobs.own(owner, id);
        const refused = view?.refusal(row, "job_stop");
        if (refused != null) return text(refused, true);
        const stopped = await jobs.stop(owner, id, "owner");
        return text(
          stopped.length === 0
            ? `Job ${id} has already ended.`
            : `Stopped: ${stopped.join(", ")}.`,
        );
      },
    });

    pi.registerTool({
      name: "job_remind",
      label: "job_remind",
      description:
        "Change how often a running job reminds you, and restart the timer.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job id" },
          every: seconds("Reminder interval", ". 0 = no reminders, bash only"),
        },
        required: ["id", "every"],
      } as never,
      async execute(_id, params) {
        const p = params as { id: string; every: number };
        const row = jobs.own(owner, p.id);
        const refused = view?.refusal(row, "job_remind");
        if (refused != null) return text(refused, true);
        const bad = checkRemind(p.every, row.name === "bash");
        if (bad) return text(bad.replace("remind_after", "every"), true);
        const next = jobs.setRemind(owner, p.id, p.every * 1000);
        return text(
          next.remindMs > 0
            ? `Job ${p.id} will remind you every ${duration(next.remindMs)}.`
            : `Job ${p.id} will not remind you.`,
        );
      },
    });
  };
}
