// 「默认行为构建」：默认 Agent 用到的全部卡片与预设，是用户调优自己 Agent 时的参考基线。
// 内置（只读、不可删、只能复制一份再改），启动时由 ensureBuiltinAgents 按这里的数据覆盖。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_GROUP, type PromptCard } from "../store/prompt-cards.js";
import type { PresetKind, PromptNode } from "../store/prompt-presets.js";

export const BASELINE_AGENT_ID = "p-agent-coder";
export const BASELINE_MODE_ID = "p-mode-plan";

// 卡片内容来自随包发布的 prompts/base；YUANSHU_PROMPTS_DIR 可覆盖（开发时指向源码）。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = (): string =>
  process.env.YUANSHU_PROMPTS_DIR ?? path.resolve(HERE, "../../prompts/base");

const read = (rel: string): string => {
  const file = path.join(promptsDir(), rel);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

// 只读能力：计划模式用。todo_write 也带上（进度条要靠它）。
export const READ_ONLY_TOOLS = [
  "tool:read",
  "tool:grep",
  "tool:find",
  "tool:ls",
  "tool:todo_write",
  "tool:list_directories",
];

/** 基线卡：分组固定，全部内置只读 */
const card = (
  id: string,
  title: string,
  body: string,
  origin: PromptCard["origin"],
): Omit<PromptCard, "createdAt" | "updatedAt"> => ({
  id,
  group: BASELINE_GROUP,
  title,
  body,
  builtin: true,
  origin,
  copyOf: null,
});

// codemode 暂时关闭：pi 原文里提到它的行不送给模型（prompts/base 是 pi 对照基线，不改）
const withoutCodemode = (text: string): string =>
  text
    .split("\n")
    .filter((l) => !l.includes("codemode"))
    .join("\n");

// 我们叠加的三张卡（英文，pi 的卡原样不动）：路径与主机、附件、向用户展示文件与图片。
// 写法与 session/address.ts（地址）、session/attachments.ts（标记行）、前端 imageRef.ts（file: 引用）一一对应，改一处要核对另几处。
const PATHS_BODY = `Hosts, directories and paths:
- A host is a machine: local (the host of the main directory, that is the project), a named remote host, or attachment (a read-only virtual host, see Attachments). The <environment> section lists the hosts and their directories.
- A directory is a registered project folder on a host, written <host>:<name>, for example local:proj or dev1:train. Only listed directories can be named (list_directories). One host can have several.
- The current directory is one of them. You start in the main directory (see <cwd>). switch_directory changes it, which moves relative paths and bash to that directory's host; approvals follow it.

Tools with a host parameter (read, write, edit, ls, find, grep, bash, transfer_files as from_host and to_host, browser_upload) share one rule:
- Omit host: you are where the current directory is. Relative paths start there, absolute paths and ~ are on its host, bash runs there.
- host="dev1": that host. The path must be absolute (/... or ~/...); a relative path, or no path, is rejected.
- host="dev1:train": that directory. Relative paths start there; ls, find and grep without a path search it.
bash accepts only the host:directory form. It is the working directory of that one command and the current directory does not change. Inside a command use plain paths of the machine it runs on.
Paths printed by a command belong to the host it ran on: pass that host when you use them elsewhere. Never put a host inside path (dev1:/x): it goes in host. MCP servers run on local.`;

const ATTACHMENTS_BODY = `Attachments:
Files the user attaches, and files saved by tools (screenshots, downloads), live on the read-only virtual host attachment, shared by every session of this workspace. A user message that carries attachments ends with lines like:
[attach_file] attachment:/2026-11-16/ab12cd34-report.pdf (application/pdf, 120 KB)
The address before the parentheses is <host>:<path>. To use it, put the host in host and the rest in path: read(host="attachment", path="/2026-11-16/ab12cd34-report.pdf"). attachment is not a directory: you cannot switch to it, run commands there or write to it. To process or change a file, copy it first with transfer_files (from_host="attachment", to a path in a working directory). Images the user attaches are also shown to you directly.`;

const SHOWING_BODY = `Showing files and images to the user:
The user reads your reply as Markdown. To show a file or an image, write its address as a file: reference. Never use base64, bare paths or external image URLs.
- Image, shown inline: ![short description](file:<host>:<absolute path>), for example ![loss curve](file:local:/home/me/proj/out/loss.png) or ![screenshot](file:attachment:/2026-11-16/ab12cd34-shot.png).
- Any other file, opened in a preview tab (attachment files are downloaded instead): [name](file:<host>:<absolute path>), for example [report](file:dev1:/data/run/report.md).
- Copy the path from tool output (ls, find, the [attach_file] line) instead of retyping it, and make sure the file exists. Percent-encode spaces and parentheses in the path (%20, %28, %29).
- A relative path in a reference resolves against the main directory (host local); prefer the full form so the host is explicit.
- If an image cannot be loaded the user sees a placeholder with the reason, so a wrong host or path is visible to them.`;

/** 七张基线卡：三张 pi 原生片段（来自 prompts/base，去掉 codemode 行；pi 的文档索引不要，之后换成我们自己的）+ 我们叠加的三张 + 计划模式 */
export function baselineCards(): Omit<PromptCard, "createdAt" | "updatedAt">[] {
  return [
    card("k-identity-pi", "pi 原生身份", read("identity.md"), "pi"),
    card(
      "k-tools",
      "工具清单",
      withoutCodemode(read("convention/tools.md")),
      "pi",
    ),
    card(
      "k-rules",
      "工具使用规则",
      withoutCodemode(read("convention/rules.md")),
      "pi",
    ),
    card("k-paths", "主机、目录与路径", PATHS_BODY, "ours"),
    card("k-attachments", "附件", ATTACHMENTS_BODY, "ours"),
    card("k-showing", "向用户展示文件与图片", SHOWING_BODY, "ours"),
    card(
      "k-mode-plan",
      "plan 模式",
      "Plan mode is on. You can only read and search, not modify anything. Present a plan and its risks first, and wait for the user's confirmation before acting.",
      "ours",
    ),
  ];
}

/** 内置预设的定义：段上写卡片 id，写入时换成 items */
export interface BuiltinPreset {
  id: string;
  kind: PresetKind;
  name: string;
  description: string;
  /** null = 不限制 */
  capabilities: string[] | null;
  nodes: readonly (Omit<PromptNode, "presetId" | "position" | "items"> & {
    /** 卡片 id，按拼接顺序 */
    cards: string[];
  })[];
}

/** 默认 Agent：编码助手的完整形态（能力不限制：全部内置工具 + 目录已分发的技能/MCP） */
export const BASELINE_AGENT: BuiltinPreset = {
  id: BASELINE_AGENT_ID,
  kind: "agent",
  name: "coder-full",
  description:
    "Default coding agent: reads and searches code, edits files, runs commands.",
  capabilities: null,
  nodes: [
    {
      id: "a1-identity",
      tag: null,
      title: "角色定义",
      slotKind: "custom",
      channel: "system",
      builtin: false,
      cards: ["k-identity-pi"],
    },
    {
      id: "a1-tools",
      tag: "tools-rules",
      title: "工具与规则",
      slotKind: "custom",
      channel: "system",
      builtin: false,
      cards: ["k-tools", "k-rules"],
    },
    {
      id: "a1-hosts",
      tag: "hosts-and-files",
      title: "主机与文件",
      slotKind: "custom",
      channel: "system",
      builtin: false,
      cards: ["k-paths", "k-attachments", "k-showing"],
    },
    {
      id: "a1-skills",
      tag: "skills",
      title: "技能清单",
      slotKind: "system",
      channel: "system",
      builtin: true,
      cards: [],
    },
    {
      id: "a1-env",
      tag: "cwd",
      title: "环境信息",
      slotKind: "system_content",
      channel: "system",
      builtin: true,
      cards: [],
    },
  ],
};

/** 默认模式：只读 + 方案优先（模式只管提示词与能力操作，不带权限） */
export const BASELINE_MODE: BuiltinPreset = {
  id: BASELINE_MODE_ID,
  kind: "mode",
  name: "plan",
  description: "只读 + 方案优先",
  capabilities: [...READ_ONLY_TOOLS],
  nodes: [
    {
      id: "m1-root",
      tag: null,
      title: "模式提示词",
      slotKind: "custom",
      channel: "system",
      builtin: false,
      cards: ["k-mode-plan"],
    },
  ],
};
