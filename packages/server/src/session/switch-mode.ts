import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { latestCarrier } from "./delivery.js";
import { readHead, STATEMARK_TYPE } from "./frozen.js";
import {
  renderNotice,
  type StateMapping,
  withListedSkills,
} from "./state-map.js";

// switch_mode：模型自己切换会话的工作模式。框架工具，只在会话有可切换的模式时启用。
// 工具结果里直接给出这次切换的通知（模式设定与工具变化），并记一个承载者，
// 下一次运行前的比较就不会再重复通知一遍。

export interface ModeChoice {
  id: string;
  name: string;
}

export function switchModeExtension(api: {
  /** 会话可切换的模式 */
  list(): ModeChoice[];
  /** 当前激活的模式 id */
  current(): string | null;
  /** 切换；modeId 为 null 表示退出模式 */
  switchTo(modeId: string | null): void;
  mapping(): StateMapping;
  skillPath?(name: string): string | undefined;
}): ExtensionFactory {
  const text = (t: string, isError = false) => ({
    content: [{ type: "text" as const, text: t }],
    details: {},
    ...(isError ? { isError: true } : {}),
  });
  return (pi) => {
    pi.registerTool({
      name: "switch_mode",
      label: "switch_mode",
      description:
        'Switch the working mode of this session. Pass mode: "list" to see the available modes, a mode name to enter it, or "none" to leave the current mode. A mode may change your instructions and which tools are available.',
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            description: 'A mode name, "list", or "none"',
          },
        },
        required: ["mode"],
      } as never,
      async execute(_id, params, _signal, _update, ctx) {
        const want = String((params as { mode?: unknown }).mode ?? "").trim();
        const modes = api.list();
        const listing = () =>
          modes.length === 0
            ? "No modes are available."
            : `Available modes: ${modes.map((m) => m.name).join(", ")}. Current: ${modes.find((m) => m.id === api.current())?.name ?? "none"}.`;
        if (want === "" || want.toLowerCase() === "list")
          return text(listing()) as never;
        const target =
          want.toLowerCase() === "none"
            ? null
            : modes.find(
                (m) =>
                  m.id === want || m.name.toLowerCase() === want.toLowerCase(),
              );
        if (target === undefined)
          return text(
            `There is no mode named "${want}". ${listing()}`,
            true,
          ) as never;
        if ((target?.id ?? null) === api.current())
          return text(`Already in that mode. ${listing()}`) as never;

        api.switchTo(target?.id ?? null);
        const after = api.mapping();
        const branch = ctx.sessionManager.getBranch();
        const declared = new Set(
          (readHead(branch).data?.head.toolsAdded ?? []).map((t) => t.name),
        );
        const before = latestCarrier(ctx.sessionManager.buildContextEntries());
        const def = (name: string) => {
          const t = pi.getAllTools().find((x) => x.name === name);
          return t
            ? { name, description: t.description, parameters: t.parameters }
            : undefined;
        };
        const note = before
          ? renderNotice(
              withListedSkills(
                before.state,
                readHead(branch).data?.head,
                after,
              ),
              after,
              declared,
              def,
              api.skillPath,
            )
          : null;
        pi.appendEntry(STATEMARK_TYPE, { state: after });
        return text(note ?? "Mode switched.") as never;
      },
    });
  };
}
