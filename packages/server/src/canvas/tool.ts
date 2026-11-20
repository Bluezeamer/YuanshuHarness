// `canvas_edit`：agent 写画布文件夹的唯一入口（canvas.md §4 CV4）。参数用扁平 schema，
// 每个 op 的字段都是可选属性、在校验里判：部分供应商对 oneOf 支持不好。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { applyOps, type CanvasOp, isCanvasOp, OP_NAMES } from "./ops.js";
import { CanvasError, type CanvasRepo } from "./repo.js";

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
  ...(isError ? { isError: true } : {}),
});

export interface CanvasToolDeps {
  sessionId: string;
  /** directory 写成 `<host>:<name>`；缺省是会话的主目录（画布在界面上就长在那里）。不切换当前目录。 */
  resolve(target?: string): { repo: CanvasRepo; label: string; envId: string };
  /** place / unplace 里写「主机名:绝对路径」时，主机名 → 环境 id（相对这个画布所在的环境）；不认识返回 null */
  resolveHost?(target: string, homeEnvId: string): string | null;
}

const DESCRIPTION = `Edit the idea canvas of a directory: collect quick idea cards, notes and references to project files on a board.
Where it lives: each directory has a canvas folder .canvas/ with its own git history. <name>.canvas is a standard JSON Canvas file (layout only), <name>.cards/<card>.md is one idea card of that board, a note is a plain markdown file anywhere else under .canvas/ (not inside a <name>.cards/ folder), it can sit on any number of boards and can link to boards and other notes with [[path]] in its text, and .canvas/index.md is a generated, read-only map: a directory tree, then every board with its nodes and edges, then every note with the boards it appears on and its links.
Reading: use the ordinary read, grep, find and ls tools with host set to the canvas's directory (the default canvas is in the main directory, for example host="local:proj"). Start with read on .canvas/index.md to see the boards, notes and their paths, find the board or note you need, then read the card or note like any markdown file.
Writing: only this tool may write inside .canvas/; write and edit are blocked there. Send a batch of ops in one call: the whole batch is validated first, then applied, and it either all succeeds or nothing changes. Paths are relative to .canvas/ (for example 产品想法.cards/风险.md); file in place/unplace is relative to the project directory (for example docs/design.md, or .canvas/设计原则.md for a note); a file on another host, or outside the project directory, is written as <host>:<absolute path> (for example dev-01:/home/me/notes.md), where <host> is a host name from list_directories (local is the host of the canvas's own directory) — index.md prints such references the same way. Do not invent node ids or positions, and do not edit the id, x, y, width, height fields: the framework handles file names, ids and placement. Connecting, grouping and moving nodes are done by the user in the UI and are not available here. The optional directory argument is written <host>:<name>. It defaults to the main directory, which is where the canvas is shown in the UI, not the directory the session has currently switched to; use another directory only when the user asks for its canvas.

Ops (one per array item, "op" picks the shape):
- {"op":"create_canvas","name":"产品想法"} — new empty board (a board name is its path under .canvas/; "产品/时间线" puts it in a sub-folder).
- {"op":"create_card","canvas":"产品想法","name":"风险","text":"..."} — new idea card on a board (name is optional).
- {"op":"create_note","path":"产品/用户研究","text":"...","canvas":"产品想法"} — new note at .canvas/产品/用户研究.md (".md" is added, missing folders are created; "canvas" is optional and also puts the note on that board). Fails if the note already exists.
- {"op":"update","path":"产品想法.cards/风险.md","old":"旧句","new":"新句"} — edit a card or a note; use "text" to replace the whole file, or "old" + "new" (old must appear exactly once).
- {"op":"rename","path":"产品想法.cards/风险.md","name":"风险与布局"} — rename a card or a note (it stays in its folder; boards that show a note follow it), or pass <name>.canvas to rename a board. [[links]] in every note that point to the renamed note or board are rewritten to the new name right away, so later ops in the same batch see the rewritten text.
- {"op":"delete","path":"产品想法.cards/风险.md"} — delete a card, a note (it disappears from every board) or a whole board with its cards.
- {"op":"promote","path":"产品想法.cards/风险.md","to":"产品/风险分析"} — turn an idea card into a note: the file moves to .canvas/产品/风险分析.md ("to" is optional, default .canvas/<card name>.md) and the board keeps showing it as a reference.
- {"op":"place","canvas":"产品想法","file":"docs/design.md"} — put an existing project file on a board as a reference. For a note: {"op":"place","canvas":"产品想法","file":".canvas/产品/用户研究.md"}. For a file on another host: {"op":"place","canvas":"产品想法","file":"dev-01:/home/me/notes.md"}.
- {"op":"unplace","canvas":"产品想法","file":"docs/design.md"} — remove a file reference from a board (same file notation as place).`;

const OPS_SCHEMA = {
  type: "array",
  minItems: 1,
  description:
    "Operations applied as one batch: all succeed or nothing changes.",
  items: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: [...OP_NAMES],
        description: "Operation name",
      },
      name: {
        type: "string",
        description:
          "create_canvas: board name. create_card: card name (optional, defaults to a timestamp). rename: new name (just the last part; the folder stays).",
      },
      canvas: {
        type: "string",
        description:
          "create_card / place / unplace: name of the board to act on. create_note: optional board to also put the note on.",
      },
      path: {
        type: "string",
        description:
          "update / rename / delete / promote: path relative to .canvas/, e.g. 产品想法.cards/风险.md, 产品想法.canvas or 产品/用户研究.md. create_note: where the new note goes, e.g. 产品/用户研究.",
      },
      text: {
        type: "string",
        description:
          "create_card / create_note: body. update: whole new file content",
      },
      old: {
        type: "string",
        description: "update: exact text to replace; must appear exactly once",
      },
      new: {
        type: "string",
        description: "update: replacement for old",
      },
      to: {
        type: "string",
        description:
          "promote: where the note goes, relative to .canvas/ (optional, default: the card name at the top of .canvas/)",
      },
      file: {
        type: "string",
        description:
          "place / unplace: project file path relative to the project directory, e.g. docs/design.md; .canvas/<path> for a note, e.g. .canvas/产品/用户研究.md; or <host>:<absolute path> for a file on another host, e.g. dev-01:/home/me/notes.md",
      },
    },
    required: ["op"],
  },
} as const;

export function canvasExtension(deps: CanvasToolDeps): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "canvas_edit",
      label: "canvas_edit",
      description: DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          directory: {
            type: "string",
            description:
              "Directory whose canvas to edit, written <host>:<name> (see list_directories). Default: the main directory, where the canvas is shown in the UI.",
          },
          ops: OPS_SCHEMA,
        },
        required: ["ops"],
      } as never,
      async execute(_id, params) {
        const p = params as { directory?: string; ops?: unknown };
        try {
          const target = deps.resolve(p.directory);
          const list = p.ops;
          if (!Array.isArray(list) || list.length === 0)
            return text("ops must be a non-empty array of operations.", true);
          const ops: CanvasOp[] = [];
          for (let i = 0; i < list.length; i++) {
            const one = list[i];
            if (!isCanvasOp(one)) {
              const shape = (one as { op?: unknown } | null)?.op;
              return text(
                `Operation ${i + 1} (${typeof shape === "string" ? shape : "?"}): missing or invalid fields for that op. See the tool description for the shape of each op.`,
                true,
              );
            }
            ops.push(one);
          }
          const lines = await applyOps(
            target.repo,
            ops,
            { kind: "agent", session: deps.sessionId },
            // 主机名相对这个画布所在的环境解析（与 index.md 打印的一致）
            deps.resolveHost
              ? (name: string) => deps.resolveHost?.(name, target.envId) ?? null
              : undefined,
          );
          return text(
            `Applied ${lines.length} operation${lines.length === 1 ? "" : "s"} on ${target.label}:\n${lines.map((l) => `- ${l}`).join("\n")}`,
          );
        } catch (e) {
          if (e instanceof CanvasError) return text(e.message, true);
          throw e;
        }
      },
    });
  };
}

const FS_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "powershell"]);

/**
 * agent 用普通工具读远端文件之前：先把画布副本里还没推过去的改动推完，免得读到旧的 index.md 与卡片。
 * 推不过去（远端不通、超时）就放行：那时 agent 对这台主机的工具本来也不通。
 */
export function canvasSyncExtension(
  settle: () => Promise<void>,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (e) => {
      if (FS_TOOLS.has(e.toolName)) await settle().catch(() => {});
    });
  };
}
