// 目标工具：get_goal / create_goal / update_goal。框架工具，实现全部委托给 GoalDriver。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { GOAL_DETAIL_MAX, GOAL_MAX } from "./goal.js";
import type { GoalDriver, GoalToolResult } from "./goal-driver.js";
import {
  CREATE_GOAL_DESCRIPTION,
  GET_GOAL_DESCRIPTION,
  UPDATE_GOAL_DESCRIPTION,
} from "./goal-messages.js";

export const GOAL_TOOLS = ["get_goal", "create_goal", "update_goal"] as const;

const result = (r: GoalToolResult) => ({
  content: [{ type: "text" as const, text: r.text }],
  details: {},
  ...(r.isError ? { isError: true } : {}),
});

const UNAVAILABLE = "The goal is unavailable in this session.";

export function goalToolsExtension(
  driver: () => GoalDriver | undefined,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "get_goal",
      label: "get_goal",
      description: GET_GOAL_DESCRIPTION,
      parameters: { type: "object", properties: {} } as never,
      async execute() {
        const d = driver();
        return result(d ? d.modelGet() : { text: UNAVAILABLE, isError: true });
      },
    });

    pi.registerTool({
      name: "create_goal",
      label: "create_goal",
      description: CREATE_GOAL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            minLength: 1,
            maxLength: GOAL_MAX,
            description: "What the goal is, including how to verify it",
          },
        },
        required: ["objective"],
      } as never,
      async execute(_id, params) {
        const d = driver();
        if (!d) return result({ text: UNAVAILABLE, isError: true });
        const { objective } = params as { objective?: unknown };
        return result(
          d.modelCreate(typeof objective === "string" ? objective : ""),
        );
      },
    });

    pi.registerTool({
      name: "update_goal",
      label: "update_goal",
      description: UPDATE_GOAL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "Goal id from get_goal" },
          revision: {
            type: "integer",
            minimum: 1,
            description: "Revision from get_goal",
          },
          action: {
            type: "string",
            enum: ["edit", "complete", "blocked"],
            description: "What to do with the goal",
          },
          objective: {
            type: "string",
            minLength: 1,
            maxLength: GOAL_MAX,
            description: 'New goal text; required for action "edit"',
          },
          blocked_reason: {
            type: "string",
            minLength: 1,
            maxLength: GOAL_DETAIL_MAX,
            description: 'The concrete obstacle; required for action "blocked"',
          },
        },
        required: ["goal_id", "revision", "action"],
      } as never,
      async execute(_id, params) {
        const d = driver();
        if (!d) return result({ text: UNAVAILABLE, isError: true });
        const p = params as {
          goal_id?: unknown;
          revision?: unknown;
          action?: unknown;
          objective?: unknown;
          blocked_reason?: unknown;
        };
        const action = p.action;
        if (action !== "edit" && action !== "complete" && action !== "blocked")
          return result({
            text: 'action must be "edit", "complete" or "blocked".',
            isError: true,
          });
        return result(
          d.modelUpdate({
            goalId: typeof p.goal_id === "string" ? p.goal_id : "",
            revision: typeof p.revision === "number" ? p.revision : -1,
            action,
            ...(typeof p.objective === "string"
              ? { objective: p.objective }
              : {}),
            ...(typeof p.blocked_reason === "string"
              ? { blockedReason: p.blocked_reason }
              : {}),
          }),
        );
      },
    });
  };
}
