// 子代理的三个工具（subagent.md §2）：spawn_subagent、message_subagent 只在能派发的会话里，
// deliver 只在子代理会话里。失败信息直接给模型看，工具层只做参数的最后一道把关。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { JobError } from "../job/manager.js";
import type { SubagentHooks } from "../session/pool.js";
import { JOB_REMIND_MAX_S, JOB_REMIND_MIN_S } from "../store/defaults.js";
import { SUBAGENT_LIMITS } from "./limits.js";
import {
  type SpawnInput,
  SubagentError,
  type SubagentRuntime,
} from "./runtime.js";

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
  ...(isError ? { isError: true } : {}),
});

const SPAWN_DESCRIPTION = `Dispatch a subagent to work on a task independently. By default the call blocks until the subagent delivers, and its delivery is the tool result: to run several subagents in parallel, issue several spawn_subagent calls in the same message. If the subagent is still running after remind_after seconds, the call returns early ("still running, job <id>") and the subagent keeps running in the background; you are notified when it delivers. To start one in the background right away, use job_start with name spawn_subagent. Do NOT poll or sleep for a subagent: do other work that does not overlap with it, or briefly tell the user it was dispatched and end your turn.
context: "fresh" (default) starts the subagent from an empty context, so write the task completely. "fork" starts it from your conversation so far, up to but NOT including the message that contains this call, so state your intent in task. The subagent has no approval channel, its permissions are never wider than yours, and it hands back a short summary (and optionally a report file). The subagent works in one directory only (directory; default: your current directory) and cannot switch: relative paths and commands start there, and it can reach only that directory's host and the read-only attachment host. Write paths in the task that are valid on that host; to give it files from another host, copy them into its directory first with transfer_files.`;

export function subagentExtension(
  rt: SubagentRuntime,
  sessionId: string,
  isChild: boolean,
): ExtensionFactory {
  // 失败抛 SubagentError / JobError：信息直接给模型看；其余异常照常抛。
  const guard = async (
    run: () => Promise<{ text: string; isError?: boolean }>,
  ) => {
    try {
      const r = await run();
      return text(r.text, r.isError === true);
    } catch (e) {
      if (e instanceof SubagentError || e instanceof JobError)
        return text(e.message, true);
      throw e;
    }
  };

  return (pi) => {
    pi.registerTool({
      name: "spawn_subagent",
      label: "spawn_subagent",
      description: SPAWN_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            minLength: 1,
            description:
              "What the subagent should do. With context: fresh it sees nothing else of your conversation, so be complete.",
          },
          context: {
            type: "string",
            enum: ["fresh", "fork"],
            description: "fresh (default) or fork; see the tool description",
          },
          agent: {
            type: "string",
            description:
              "Name or id of the Agent definition to use (default: yours). Not allowed with context: fork.",
          },
          mode: {
            type: "string",
            description:
              "Mode for the subagent. Only when you have no active mode; otherwise it inherits yours.",
          },
          model: {
            type: "string",
            description:
              'Model as "provider/model" (default: yours). Not allowed with context: fork.',
          },
          directory: {
            type: "string",
            description:
              "Directory the subagent works in, written <host>:<name> (see list_directories). It cannot switch directories. Default: your current directory.",
          },
          tier: {
            type: "string",
            enum: ["rules", "auto"],
            description:
              "A stricter permission tier: rules allows only operations covered by rules. Default: auto.",
          },
          remind_after: {
            type: "number",
            minimum: JOB_REMIND_MIN_S,
            maximum: JOB_REMIND_MAX_S,
            description: `Seconds the call may block before it returns early and the subagent continues in the background; also the interval of later reminders. Default from settings.`,
          },
        },
        required: ["task"],
      } as never,
      async execute(toolCallId, params, signal, _update, ctx) {
        const p = params as {
          task: string;
          context?: "fresh" | "fork";
          agent?: string;
          mode?: string;
          model?: string;
          directory?: string;
          tier?: "rules" | "auto";
          remind_after?: number;
        };
        const input: SpawnInput = {
          task: p.task,
          ...(p.context !== undefined ? { context: p.context } : {}),
          ...(p.agent !== undefined ? { agent: p.agent } : {}),
          ...(p.mode !== undefined ? { mode: p.mode } : {}),
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.directory !== undefined ? { directory: p.directory } : {}),
          ...(p.tier !== undefined ? { tier: p.tier } : {}),
          ...(p.remind_after !== undefined
            ? { remindAfter: p.remind_after }
            : {}),
        };
        return guard(() =>
          rt.spawn(sessionId, input, {
            toolCallId,
            signal,
            branch: ctx.sessionManager.getBranch() as never,
          }),
        ) as never;
      },
    });

    pi.registerTool({
      name: "message_subagent",
      label: "message_subagent",
      description:
        "Say something to a subagent you dispatched, by its id (the job id). If it is running, the message reaches it after its current step. If it has already delivered, it is woken up for a new round and you are notified when it delivers again. Use it to give a subagent information it asked for or a follow-up task; to learn how it is doing, use job_list with its id instead.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            minLength: 1,
            description: "Subagent (job) id",
          },
          text: {
            type: "string",
            minLength: 1,
            maxLength: SUBAGENT_LIMITS.taskMax,
            description: "What to tell it",
          },
        },
        required: ["id", "text"],
      } as never,
      async execute(_id, params) {
        const p = params as { id: string; text: string };
        return guard(() => rt.message(sessionId, p.id, p.text)) as never;
      },
    });

    if (!isChild) return;
    pi.registerTool({
      name: "deliver",
      label: "deliver",
      description:
        "Hand your result over to the session that dispatched you. summary is a short conclusion; report is optional, for a long write-up (it is stored as a file and your caller receives its path). You can call deliver more than once: the last call wins, and it is sent when you end your turn. You cannot deliver while background jobs of yours are still running.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            minLength: 1,
            maxLength: SUBAGENT_LIMITS.summaryMax,
            description:
              "Short conclusion; goes straight into your caller's context",
          },
          report: {
            type: "string",
            description: "Optional long report; stored as a file",
          },
        },
        required: ["summary"],
      } as never,
      async execute(_id, params) {
        const p = params as { summary: string; report?: string };
        return guard(async () => ({
          text: rt.deliver(sessionId, {
            summary: p.summary,
            ...(p.report !== undefined ? { report: p.report } : {}),
          }),
        })) as never;
      },
    });
  };
}

/** 把另一组工具（团队、工作流）并进子代理的钩子：会话池只认一个 tools 入口 */
export function withTools(
  hooks: SubagentHooks,
  make: (sessionId: string, isChild: boolean) => ExtensionFactory,
): SubagentHooks {
  return {
    ...hooks,
    tools: (id, isChild) => {
      const base = hooks.tools(id, isChild);
      const extra = make(id, isChild);
      return async (pi) => {
        await base(pi);
        await extra(pi);
      };
    },
  };
}
