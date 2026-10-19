import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface WorkspaceView {
  id: string;
  name: string;
  path: string;
  environment: string;
  state: string;
  current: boolean;
}

export interface WorkspaceToolsApi {
  list(): WorkspaceView[];
  // 按 id 或名称切换；失败抛 Error，信息直接给模型看。
  switchTo(target: string): WorkspaceView;
  // 取走待发的切换通知；没有返回 null。
  takeNotice(): string | null;
}

const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
});

const line = (w: WorkspaceView) =>
  `${w.current ? "* " : "  "}${w.name}  环境：${w.environment}（${w.state}）  目录：${w.path}  id：${w.id}`;

export const switchNotice = (w: WorkspaceView) =>
  `[系统通知] 当前 workspace 已切换为「${w.name}」（环境：${w.environment}，目录：${w.path}）。此后工具都在该环境与目录下执行，路径以它为准。`;

// agent 查看与切换 workspace 的工具；切换后的第一轮在上下文末尾追加通知（ADR-0034）。
export function workspaceExtension(api: WorkspaceToolsApi): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "list_workspaces",
      label: "列出 workspace",
      description:
        "列出所有已登记的 workspace 及其所属环境（本机或远程）。带 * 的是当前 workspace。",
      parameters: { type: "object", properties: {} } as never,
      async execute() {
        return text(api.list().map(line).join("\n"));
      },
    });
    pi.registerTool({
      name: "switch_workspace",
      label: "切换 workspace",
      description:
        "切换到另一个已登记的 workspace（可能在另一台机器上）。之后的工具调用都在它的环境与目录下执行。只能切到已登记的，不能新增。",
      parameters: {
        type: "object",
        properties: {
          workspace: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "workspace 的名称或 id",
          },
        },
        required: ["workspace"],
      } as never,
      async execute(_id, params) {
        const { workspace } = params as { workspace: string };
        const w = api.switchTo(workspace);
        return text(
          `已切换到「${w.name}」（环境：${w.environment}，目录：${w.path}）`,
        );
      },
    });
    pi.on("before_agent_start", () => {
      const content = api.takeNotice();
      return content
        ? {
            message: {
              customType: "workspace-notice",
              content,
              display: false,
            },
          }
        : undefined;
    });
  };
}
