import type { SyncReport } from "./capabilities";
import { call, enc, get } from "./http";

export interface DirectoryInfo {
  id: string;
  name: string;
  path: string;
  environmentId: string;
  createdAt: string;
}

export interface RuleInfo {
  id: string;
  kind: "path" | "command";
  access: "read" | "write" | null;
  value: string;
  createdAt: string;
}

// 会话附件区是服务端内部目录（id 固定为 attachment），用户可见的目录列表里不出现。
const ATTACHMENT_DIRECTORY = "attachment";

export const listDirectories = (token: string | null) =>
  get("/api/v1/directories", token, (b: { directories: DirectoryInfo[] }) => {
    if (!Array.isArray(b.directories)) throw new Error("shape");
    return b.directories.filter((w) => w.id !== ATTACHMENT_DIRECTORY);
  });

export interface SessionDirectoryInfo {
  id: string;
  name: string;
  path: string;
  environmentId: string;
  role: "local" | "remote";
  current: boolean;
}

/** 会话挂载的 directory 清单（含各自的绝对路径与主机），用于把对话里的相对路径还原成真实文件。 */
export const sessionDirectories = (token: string | null, sessionId: string) =>
  call(
    "GET",
    `/api/v1/sessions/${enc(sessionId)}/directories`,
    token,
    undefined,
    (b: { directories: SessionDirectoryInfo[] }) => {
      if (!Array.isArray(b.directories)) throw new Error("shape");
      return b.directories;
    },
  );

export const createDirectory = (
  token: string | null,
  body: { path: string; name?: string },
) => call("POST", "/api/v1/directories", token, body, (b: DirectoryInfo) => b);

export const patchDirectory = (
  token: string | null,
  id: string,
  body: { name: string },
) =>
  call(
    "PATCH",
    `/api/v1/directories/${enc(id)}`,
    token,
    body,
    (b: DirectoryInfo) => b,
  );

export const deleteDirectory = (token: string | null, id: string) =>
  call("DELETE", `/api/v1/directories/${enc(id)}`, token, undefined, () => {});

export const listRules = (token: string | null, directoryId: string) =>
  get(
    `/api/v1/directories/${enc(directoryId)}/rules`,
    token,
    (b: { rules: RuleInfo[] }) => {
      if (!Array.isArray(b.rules)) throw new Error("shape");
      return b.rules;
    },
  );

export const deleteRule = (
  token: string | null,
  directoryId: string,
  ruleId: string,
) =>
  call(
    "DELETE",
    `/api/v1/directories/${enc(directoryId)}/rules/${enc(ruleId)}`,
    token,
    undefined,
    () => {},
  );

// 权限硬边界清单（服务端判定代码里的同一份常量，只读）。
export interface BoundaryInfo {
  id: string;
  title: string;
  detail: string;
  items?: string[];
  // 目录为「完全允许」时是否仍然拦截。
  inFull: boolean;
}

export const getBoundaries = (token: string | null) =>
  get(
    "/api/v1/permission/boundaries",
    token,
    (b: { boundaries: BoundaryInfo[]; noRemember: string[] }) => {
      if (!Array.isArray(b.boundaries) || !Array.isArray(b.noRemember))
        throw new Error("shape");
      return b;
    },
  );

// 目录挂载的 skill / MCP 名单与 skill 同步。
export const getDirectoryNames = (
  token: string | null,
  directoryId: string,
  kind: "skills" | "mcp",
) =>
  call(
    "GET",
    `/api/v1/directories/${enc(directoryId)}/${kind}`,
    token,
    undefined,
    (b: { names: string[] }) => {
      if (!Array.isArray(b.names)) throw new Error("shape");
      return b.names;
    },
  );

export const setDirectoryNames = (
  token: string | null,
  directoryId: string,
  kind: "skills" | "mcp",
  names: string[],
) =>
  call(
    "PUT",
    `/api/v1/directories/${enc(directoryId)}/${kind}`,
    token,
    { names },
    (b: { names: string[] }) => b.names,
  );

export const getSkillSync = (token: string | null, directoryId: string) =>
  call(
    "GET",
    `/api/v1/directories/${enc(directoryId)}/skills/sync`,
    token,
    undefined,
    (b: { report: SyncReport | null }) => b.report,
  );

export const runSkillSync = (token: string | null, directoryId: string) =>
  call(
    "POST",
    `/api/v1/directories/${enc(directoryId)}/skills/sync`,
    token,
    undefined,
    (b: { report: SyncReport }) => b.report,
  );
