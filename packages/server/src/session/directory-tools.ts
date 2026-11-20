// list_directories / switch_directory 的工具与它们注入的通知。
// 地址规则见 session/address.ts：目录写作 `<host>:<name>`，相对路径相对当前目录。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ATTACHMENT_HOST, COLLAB_HOST } from "./address.js";

export interface DirectoryView {
  // 池内部与接口用；模型可见的文字里不出现 id。
  id: string;
  name: string;
  path: string;
  /** 目录的引用写法 `<host>:<name>`：模型原样抄回给 switch_directory、spawn_subagent 与 host 参数。 */
  ref: string;
  /** 主机名：local / server / 连接名，附件区是 attachment。 */
  host: string;
  state: string;
  current: boolean;
  // 主机身份：同一台主机上的多个 directory 此值相同（它们只是该主机上的不同目录）。
  hostId: string;
  // 会话里第 1 个是逻辑本地（local），其余都是 remote。
  role: "local" | "remote";
}

export interface DirectoryToolsApi {
  list(): DirectoryView[];
  // 按 `<host>:<name>` 切换；失败抛 Error，信息直接给模型看。子会话不给（只有一个目录，不能切换）。
  switchTo?(ref: string): DirectoryView;
  // 取走待发的切换通知；没有返回 null。
  takeNotice(): string | null | Promise<string | null>;
}

const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
});

export const ATTACHMENT_HOST_LINE = `${ATTACHMENT_HOST}: files the user uploaded and files saved by tools, read-only. Use host="attachment" with an absolute path, e.g. /2026-11-16/ab12cd34-chart.png`;

export const COLLAB_HOST_LINE = `${COLLAB_HOST}: the shared folder of this session tree: reports, the team board and files the sessions write for each other. Use host="collab" with an absolute path, e.g. /<id>/report.md; subagents write only under their own folder.`;

/** 两个虚拟主机都不是目录：它们在清单里各占一行说明用法。 */
const VIRTUAL_LINES: Record<string, string> = {
  [COLLAB_HOST]: COLLAB_HOST_LINE,
  [ATTACHMENT_HOST]: ATTACHMENT_HOST_LINE,
};

// 按主机分组列出：主机一节一行，其下是这个主机上的目录（引用写法 + 路径），当前目录前标 *。
// 虚拟主机各单列一行说明用法（它们不是目录）。
export function directoryRoster(views: readonly DirectoryView[]): string {
  const virtual = views
    .map((v) => VIRTUAL_LINES[v.host])
    .filter((l) => l !== undefined);
  const hosts = new Map<string, DirectoryView[]>();
  for (const v of views) {
    if (VIRTUAL_LINES[v.host] !== undefined) continue;
    const g = hosts.get(v.hostId);
    if (g) g.push(v);
    else hosts.set(v.hostId, [v]);
  }
  return [
    "Hosts and directories. A directory is written <host>:<name>. Relative paths and bash use the current directory (marked *); the host parameter of a tool names another host or directory.",
    ...[...hosts.values()].flatMap((g) => [
      `- ${g[0]?.host}: ${g[0]?.state}`,
      ...g.map((v) => `  ${v.current ? "* " : "  "}${v.ref}  ${v.path}`),
    ]),
    ...virtual.map((l) => `- ${l}`),
  ].join("\n");
}

export const switchNotice = (w: DirectoryView) =>
  `[System notice] The current directory is now ${w.ref} (${w.path}, host ${w.host}). Relative paths and bash run there from now on; the host parameter can still name any host.`;

// 会话的目录清单被用户改了（新增或移除）：在下一轮的尾部告知。完整清单在「环境信息」段里，那段的差异通知会一并带上。
export function directoriesChangedNotice(c: {
  added: readonly DirectoryView[];
  // 被移除的目录的引用写法 `<host>:<name>`：目录行已经删了，名字得提前算好。
  removed: readonly string[];
  current: DirectoryView;
  movedToLocal: boolean;
}): string {
  const parts = [
    "[System notice] The directories of this session have changed.",
  ];
  if (c.added.length)
    parts.push(
      `Added: ${c.added.map((v) => `${v.ref} (${v.path})`).join(", ")}.`,
    );
  if (c.removed.length) parts.push(`Removed: ${c.removed.join(", ")}.`);
  parts.push(
    c.movedToLocal
      ? `The directory you were in has been removed; you are back in ${c.current.ref} (${c.current.path}), and relative paths and bash run there from now on.`
      : `The current directory is still ${c.current.ref}.`,
  );
  return parts.join("\n");
}

// agent 查看与切换目录的工具；切换后的第一轮在上下文末尾追加通知（ADR-0034）。
// 子会话只有 list_directories：它只在一个目录里工作，不能切换。
export function directoryExtension(api: DirectoryToolsApi): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "list_directories",
      label: "list directories",
      description:
        "List the hosts and directories of this session, with their availability and the current directory (marked *). A directory is written <host>:<name>: that is what switch_directory, spawn_subagent and the host parameter of the file tools and bash accept. The main directory's host is called local; the attachment host is read-only and holds the files the user uploaded and tools saved.",
      parameters: { type: "object", properties: {} } as never,
      async execute() {
        return text(directoryRoster(api.list()));
      },
    });
    const switchTo = api.switchTo;
    if (switchTo) {
      pi.registerTool({
        name: "switch_directory",
        label: "switch directory",
        // 同批其他调用的权限判定与执行都依赖当前目录：含切换的一批必须按顺序逐个判定、执行。
        executionMode: "sequential",
        description:
          "Switch the current directory to another registered directory, written <host>:<name> (see list_directories), possibly on another host. Relative paths and bash then run in that directory and on its host, and approvals follow it. Files on any host can be reached without switching, with the host parameter of the file tools. You can only switch to registered directories; the attachment host is not a directory.",
        parameters: {
          type: "object",
          properties: {
            directory: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description: "Directory written <host>:<name>, e.g. dev1:train",
            },
          },
          required: ["directory"],
        } as never,
        async execute(_id, params) {
          const { directory } = params as { directory: string };
          const w = switchTo(directory);
          return text(
            `Switched to ${w.ref} (${w.path}). Relative paths and bash run there from now on, on host ${w.host}.`,
          );
        },
      });
    }
    pi.on("before_agent_start", async () => {
      const content = await api.takeNotice();
      return content
        ? {
            message: {
              customType: "directory-notice",
              content,
              display: false,
            },
          }
        : undefined;
    });
  };
}
