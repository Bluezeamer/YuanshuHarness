import type { McpContextItem } from "../mcp/context.js";
import type { FileRow } from "../store/session-files.js";

// GET /sessions/:id/context：模型此刻看得见什么（压缩摘要在 /state，不在这里）。
export interface ContextSkill {
  name: string;
  // global 的 skill 同步在用户目录（library），project 的在 目录
  source: "library" | "directory";
  // 实际注入的 SKILL.md 在环境里的路径；拿不到来源时为 null，不编造。
  path: string | null;
  loadedAt: string;
}

export interface ContextView {
  files: (Omit<FileRow, "truncated"> & { truncated?: true })[];
  filesTruncated?: true;
  skills: ContextSkill[];
  mcp: McpContextItem[];
}

export const fileView = (f: FileRow): ContextView["files"][number] => {
  const { truncated, ...rest } = f;
  return truncated ? { ...rest, truncated } : rest;
};
