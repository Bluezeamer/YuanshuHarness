// 动态工作流：workflow_run（当场写脚本，或按名称跑已保存的流程）与 workflow_list（列出现有的命名流程）。
// 命名流程的文件形态与两层目录见 workflow/named.ts。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { JobError } from "../job/manager.js";
import { SubagentError } from "../subagent/runtime.js";
import type { NamedWorkflows, ParamDecl } from "./named.js";
import {
  type RunInput,
  WORKFLOW_LIMITS,
  WorkflowError,
  type WorkflowRuntime,
} from "./runtime.js";

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
  ...(isError ? { isError: true } : {}),
});

const DESCRIPTION = `Run a workflow: a JavaScript script that orchestrates many subagents without putting their intermediate results into your context. Use it when the steps are fixed and the amount of work is large (dozens to hundreds of agents, e.g. review every file, verify every claim, process every item). Do NOT use it for a few parallel tasks (issue several spawn_subagent calls in one message), for work that needs your judgement along the way (do it yourself), or for deterministic data processing (write a script file and run it with bash).
Every run asks the user to approve the script before it starts (not in the full-access tier); if they deny it, do not simply retry the same script.
The script is the body of an async function: use await, and finish with "return <JSON value>" (plain JSON only; the tool result is that value; if it is longer than ${WORKFLOW_LIMITS.inlineResultMax} characters it is saved to a file and you get the path and the start of it). It runs in a sandbox: no files, shell, network, timers, require or import; at most 2 seconds of pure computation between two awaits, 64 MB of memory. The script only orchestrates (who works, in which order, how results are combined); all real work, including reading files and running commands, is done by agents, under their own permissions (no approval channel: operations that need approval are refused). Date.now(), new Date() without arguments and Math.random() are not allowed, because runs must be repeatable.
Hooks (the only globals):
- agent(prompt, opts?) -> Promise<string | object | null>: runs one subagent (fresh context, so write the prompt completely; at most 20000 characters) and returns the summary it delivered (a short text of at most 2000 characters; if the agent also attached a long report, the string ends with a line "Full report file: <path>"). Returns null if the agent failed, was stopped or did not deliver: handle that in the script (e.g. .filter(Boolean)). opts: label (short name for the progress log), phase, schema (a JSON Schema: the agent is told to deliver one JSON document matching it, and the result is the parsed, validated object, or null if the delivery does not match; it must still fit in 2000 characters), agent (name of an Agent definition), model ("provider/model").
- parallel([() => ..., ...]) -> Promise<array>: runs the functions concurrently and returns their results in order; a function that throws gives null.
- pipeline(items, stage1, stage2, ...) -> Promise<array>: every item goes through the stages independently, with no waiting between stages; each stage is (prev, item, index) => value or promise (the first stage's prev is the item); an item whose stage throws becomes null. Prefer it for multi-stage work.
- phase(title) and log(message): progress markers (visible with job_list on the run's job).
- args: the JSON you passed as args.
Wrong use of a hook (bad arguments, unknown option, unsupported schema, a prompt that is too long, more than 4096 items in one parallel/pipeline call, more than ${WORKFLOW_LIMITS.totalMax} agents in one run) fails the whole run, even if the script catches the error. At most "concurrency" agents run at the same time (default ${WORKFLOW_LIMITS.concurrency}, at most ${WORKFLOW_LIMITS.concurrencyMax}); the rest wait. The agents are real subagents but do not count against your subagent alive limit.
The call blocks until the script returns. If it takes long it is turned into a background job (you are notified when it finishes); to start it in the background right away use job_start with name workflow_run, and stop it with job_stop (that stops every agent of the run). Do not poll. Example:
const files = args.files;
const reviews = await pipeline(files, (f) => agent("Review " + f + " for bugs. Deliver a short list.", { label: f }), (r, f) => r && agent("Summarize this review of " + f + " in one line:\\n" + r));
return reviews.filter(Boolean);
Named workflows: instead of writing a script, pass name to run one you or the user saved earlier; name and script are exclusive. workflow_list shows what exists, with its description and declared params. To save one, write a file with the write tool: <your current directory>/.ys/workflows/<name>.js (project layer) or ~/.ys/workflows/<name>.js (global layer). The file name is the workflow name (lowercase letters, digits, "-", "_"), and the file is a metadata comment block holding plain JSON, then the script:
/* @workflow
{ "description": "Review files", "params": { "files": { "type": "array", "required": true } } }
*/
return await parallel(args.files.map((f) => () => agent("Review " + f)));
Declared params are checked and get their defaults filled in before the run. A project file overrides a global one of the same name.`;

const LIST_DESCRIPTION = `List the named workflows you can run with workflow_run { name } (read-only). For each one: its name, which layer it comes from (project overrides global), its description, its declared params and its phases. Files that cannot be run are listed too, with the reason. Save a workflow by writing a file as described in the workflow_run tool description.`;

function paramList(params: Record<string, ParamDecl>): string {
  return Object.entries(params)
    .map(([name, d]) => {
      const facts = [
        d.type,
        d.required ? "required" : "optional",
        d.default === undefined ? "" : `default ${JSON.stringify(d.default)}`,
        d.description === undefined ? "" : d.description,
      ].filter((x) => x !== "");
      return `${name} (${facts.join("; ")})`;
    })
    .join(", ");
}

export function workflowExtension(
  rt: WorkflowRuntime,
  named: NamedWorkflows,
  sessionId: string,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "workflow_run",
      label: "workflow_run",
      description: DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Name of a saved workflow to run instead of script; see workflow_list",
          },
          script: {
            type: "string",
            minLength: 1,
            maxLength: WORKFLOW_LIMITS.scriptMax,
            description:
              "The script: the body of an async function; ends with return <JSON>",
          },
          args: {
            description: "Any JSON value, available in the script as args",
          },
          concurrency: {
            type: "integer",
            minimum: 1,
            description: `How many agents may run at the same time (default ${WORKFLOW_LIMITS.concurrency}; at most ${WORKFLOW_LIMITS.concurrencyMax})`,
          },
          label: {
            type: "string",
            maxLength: 80,
            description: "Short name to recognize the run by (optional)",
          },
        },
      } as never,
      // name 已在权限扩展的 tool_call 阶段解析成 script + args（弹窗要显示真正会运行的文本），
      // 所以这里只会看到 script。
      async execute(toolCallId, params, signal, _update, ctx) {
        const p = params as RunInput;
        try {
          const r = await rt.run(
            sessionId,
            {
              script: p.script,
              ...(p.args !== undefined ? { args: p.args } : {}),
              ...(p.concurrency !== undefined
                ? { concurrency: p.concurrency }
                : {}),
              ...(p.label !== undefined ? { label: p.label } : {}),
            },
            {
              toolCallId,
              signal,
              branch: ctx.sessionManager.getBranch() as never,
            },
          );
          return text(r.text, r.isError === true) as never;
        } catch (e) {
          if (
            e instanceof WorkflowError ||
            e instanceof SubagentError ||
            e instanceof JobError
          )
            return text(e.message, true) as never;
          throw e;
        }
      },
    });

    pi.registerTool({
      name: "workflow_list",
      label: "workflow_list",
      description: LIST_DESCRIPTION,
      parameters: { type: "object", properties: {} } as never,
      async execute() {
        const { entries, invalid } = await named.list(sessionId);
        if (entries.length === 0 && invalid.length === 0)
          return text(
            "No named workflow has been saved yet. Write a file as described in the workflow_run tool description to save one.",
          ) as never;
        const lines = [
          ...entries.map((e) => {
            const params = paramList(e.meta.params);
            const phases =
              e.meta.phases.length === 0
                ? ""
                : `\n  phases: ${e.meta.phases.join(" → ")}`;
            return `${e.name} | ${e.layer} | ${e.meta.description}${params === "" ? "" : `\n  params: ${params}`}${phases}`;
          }),
          ...invalid.map(
            (e) => `${e.name} | ${e.layer} | NOT RUNNABLE: ${e.error}`,
          ),
        ];
        return text(
          `Named workflows (run one with workflow_run { "name": ... }):\n${lines.join("\n")}`,
        ) as never;
      },
    });
  };
}
