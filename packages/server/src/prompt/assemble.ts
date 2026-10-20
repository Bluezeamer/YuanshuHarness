import { GLOBAL_GROUP, PROJECT_GROUP, ROLE_GROUP } from "../store/blocks.js";

export interface BlockRef {
  id: string;
  name: string;
  group: string;
  content: string;
}

export interface AssembleInput {
  // agent 定义里的有序块引用（已解析出当前内容）。
  blocks: BlockRef[];
  // Server 级 AGENTS.md；没有或为空传 null。
  globalConventions: string | null;
  // workspace 里的 AGENTS.md；未开启注入或不存在传 null。
  projectConventions: string | null;
  // 当前模式的提示词（build 为 null）；状态类内容放在最末尾，和压缩后重建基线的位置一致。
  modePrompt: string | null;
}

export const MODE_GROUP = "运行模式";

export interface Part {
  kind: "block" | "global-file" | "project-file" | "mode";
  group: string;
  // 块的 id；文件来源没有。
  id?: string;
  name: string;
  chars: number;
}

export interface Assembled {
  text: string;
  parts: Part[];
}

const clean = (s: string) => s.trim();

// 纯函数：角色 → 全局约定 → 项目约定 → 自定义分组（按首次出现的顺序）→ 运行模式；组内保持块的原有顺序，
// 约定组里的文件内容排在该组的块之后。空内容不产生输出，但块仍列在 parts 里（字数为 0）。
export function assemble(input: AssembleInput): Assembled {
  const order: string[] = [ROLE_GROUP, GLOBAL_GROUP, PROJECT_GROUP];
  for (const b of input.blocks)
    if (!order.includes(b.group)) order.push(b.group);

  const parts: Part[] = [];
  const sections: string[] = [];
  for (const group of order) {
    const bodies: string[] = [];
    for (const b of input.blocks) {
      if (b.group !== group) continue;
      const body = clean(b.content);
      parts.push({
        kind: "block",
        group,
        id: b.id,
        name: b.name,
        chars: body.length,
      });
      if (body) bodies.push(body);
    }
    const file =
      group === GLOBAL_GROUP
        ? {
            kind: "global-file" as const,
            name: "AGENTS.md（Server）",
            text: input.globalConventions,
          }
        : group === PROJECT_GROUP
          ? {
              kind: "project-file" as const,
              name: "AGENTS.md（项目）",
              text: input.projectConventions,
            }
          : null;
    const fileBody = file?.text ? clean(file.text) : "";
    if (file && fileBody) {
      parts.push({
        kind: file.kind,
        group,
        name: file.name,
        chars: fileBody.length,
      });
      bodies.push(fileBody);
    }
    if (bodies.length) sections.push(`## ${group}\n\n${bodies.join("\n\n")}`);
  }
  const mode = input.modePrompt ? clean(input.modePrompt) : "";
  if (mode) {
    parts.push({
      kind: "mode",
      group: MODE_GROUP,
      name: "模式提示词",
      chars: mode.length,
    });
    sections.push(`## ${MODE_GROUP}\n\n${mode}`);
  }
  return { text: sections.join("\n\n"), parts };
}
