import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "./runtime.js";

const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
});

const WAIT_MAX_SECONDS = 24 * 3600;

// 父会话的 spawn/wait/interrupt 三件套（ADR-0010、ADR-0060）。失败抛 Error，信息直接给模型看。
export function subagentExtension(
  rt: SubagentRuntime,
  sessionId: string,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "spawn_subagent",
      label: "派发子代理",
      description:
        "派发一个子代理去独立完成任务，立即返回子会话 id，不等它跑完。子代理没有人工审批通道，权限只会比你更窄。需要它的结果时用 wait_subagent。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            minLength: 1,
            description: "任务描述；子代理看不到你的上下文，需写清楚",
          },
          agent: {
            type: "string",
            description: "agent 定义的名称或 id，缺省与你相同",
          },
          workspaces: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description:
              "子代理可用的 workspace（名称或 id），必须是你可用的子集，第一个是起始；缺省只给当前 workspace",
          },
          inherit_capabilities: {
            type: "boolean",
            description: "是否继承你的内置工具，缺省否",
          },
          inherit_history: {
            type: "boolean",
            description: "是否把你最近的对话作为参考带给子代理，缺省否",
          },
          model: { type: "string", description: "模型 id，缺省用 agent 的" },
          tier: {
            type: "string",
            enum: ["rules", "auto"],
            description:
              "更严的权限档位：rules 只允许规则内的操作；缺省 auto，拿不准的操作按拒绝",
          },
        },
        required: ["task"],
      } as never,
      async execute(_id, params) {
        const p = params as {
          task: string;
          agent?: string;
          workspaces?: string[];
          inherit_capabilities?: boolean;
          inherit_history?: boolean;
          model?: string;
          tier?: "rules" | "auto";
        };
        const r = await rt.spawn(sessionId, {
          task: p.task,
          ...(p.agent !== undefined ? { agent: p.agent } : {}),
          ...(p.workspaces !== undefined ? { workspaces: p.workspaces } : {}),
          ...(p.inherit_capabilities !== undefined
            ? { inheritCapabilities: p.inherit_capabilities }
            : {}),
          ...(p.inherit_history !== undefined
            ? { inheritHistory: p.inherit_history }
            : {}),
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.tier !== undefined ? { tier: p.tier } : {}),
        });
        // 单行 JSON：模型好读，WebUI 的派发卡片也靠它取 childId。
        return text(JSON.stringify(r));
      },
    });

    pi.registerTool({
      name: "wait_subagent",
      label: "等待子代理",
      description:
        "等待一个或多个子代理完成并取回它们的结果。设了超时则到时停止等待（子代理继续跑，可再次 wait）；不设则一直等。",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: 16,
            description: "要等的子会话 id",
          },
          timeout_seconds: {
            type: "number",
            exclusiveMinimum: 0,
            maximum: WAIT_MAX_SECONDS,
          },
        },
        required: ["ids"],
      } as never,
      async execute(_id, params, signal) {
        const p = params as { ids: string[]; timeout_seconds?: number };
        return text(
          await rt.wait(
            sessionId,
            p.ids,
            p.timeout_seconds === undefined
              ? undefined
              : Math.min(p.timeout_seconds, WAIT_MAX_SECONDS) * 1000,
            signal,
          ),
        );
      },
    });

    pi.registerTool({
      name: "interrupt_subagent",
      label: "中断子代理",
      description: "中断一个运行中的子代理（它的子孙一并中断）。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
      } as never,
      async execute(_id, params) {
        const { id } = params as { id: string };
        return text(await rt.interrupt(sessionId, id));
      },
    });
  };
}
