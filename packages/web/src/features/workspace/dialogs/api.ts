// 面板专用的接口适配：补 api/ 里没有的字段与调用，不改 api/ 下的文件。
import { listMcp, listSkills } from "../../../api/capabilities";
import { listConnections } from "../../../api/connections";
import { DEFAULT_DIRECTORY_START, getDefaults } from "../../../api/defaults";
import { listDirectories } from "../../../api/directories";
import { listDirs, listFiles } from "../../../api/files";
import { type CallResult, enc, type Result, request } from "../../../api/http";
import { listMcp as listLibraryMcp } from "../../../api/mcpLibrary";
import { listProviders } from "../../../api/providers";
import type { LibrarySession } from "../../../api/sessionLibrary";
import { listSkills as listLibrarySkills } from "../../../api/skillLibrary";
import { listPresets, type StudioPreset } from "../../../api/studio";
import {
  fetchVariables,
  fetchWorkspaceVariables,
  type VariableView,
} from "../../../api/variables";
import {
  fetchWorkspaceCapabilities,
  type WorkspaceCapabilities,
} from "../../../api/workspaceCapabilities";
import {
  type Catalog,
  type Host,
  hostsOf,
  type ToolRow,
} from "./model/catalog";
import { joinPath } from "./model/path";

/** 把旧式 Result / CallResult 转成抛错，面板里统一 try/catch */
const need = <T>(r: Result<T> | CallResult<T>): T => {
  if (!r.ok) throw new Error(r.kind);
  return r.data;
};

const listToolRows = async (token: string | null) =>
  (await request<{ tools: ToolRow[] }>("GET", "/api/v1/tools", token)).tools;

export const getSessionView = (token: string | null, id: string) =>
  request<LibrarySession>("GET", `/api/v1/sessions/${enc(id)}`, token);

/** Server 用户 home；取不到不影响面板 */
const serverHome = async (token: string | null): Promise<string | null> => {
  const r = await listDirs(token);
  return r.ok ? r.data.path : null;
};

/** 全局默认值里面板要用的几项（目录起点、默认审批档、有没有审批模型）；取不到按缺省，不影响面板 */
const globalsOf = async (
  token: string | null,
): Promise<
  Pick<Catalog, "directoryStart" | "globalTier" | "hasReviewModel">
> => {
  try {
    const d = await getDefaults(token);
    return {
      directoryStart: d.directoryStart || DEFAULT_DIRECTORY_START,
      globalTier: d.permissionTier,
      hasReviewModel: d.reviewModel !== null,
    };
  } catch {
    return {
      directoryStart: DEFAULT_DIRECTORY_START,
      globalTier: "rules",
      hasReviewModel: false,
    };
  }
};

export async function loadCatalog(token: string | null): Promise<Catalog> {
  const [
    agent,
    modes,
    templates,
    providers,
    conns,
    skills,
    mcp,
    tools,
    directories,
    home,
    globals,
  ] = await Promise.all([
    listPresets("agent").then(need),
    listPresets("mode").then(need),
    listPresets("project-agentsmd").then(need),
    listProviders(token),
    listConnections(token),
    listSkills(token).then(need),
    listMcp(token).then(need),
    listToolRows(token),
    listDirectories(token).then(need),
    serverHome(token),
    globalsOf(token),
  ]);
  return {
    agentPresets: agent as StudioPreset[],
    modePresets: modes as StudioPreset[],
    agentsTemplates: templates as StudioPreset[],
    providers,
    hosts: hostsOf(conns),
    skills,
    mcp,
    tools,
    directories,
    home,
    ...globals,
  };
}

// ---- 目录浏览 ----

export interface DirView {
  path: string;
  parent: string | null;
  /** 子目录的绝对路径 */
  dirs: string[];
}

/** 列出主机上的目录；不存在或读不了返回 null */
async function listDir(
  token: string | null,
  host: Host,
  path: string,
): Promise<DirView | null> {
  if (host.kind === "local") {
    const r = await listDirs(token, path);
    if (!r.ok) return null;
    return {
      path: r.data.path,
      parent: r.data.parent,
      dirs: r.data.dirs.map((n) => joinPath(r.data.path, n)),
    };
  }
  const r = await listFiles(token, host.id, path, false);
  if (!r.ok) return null;
  return {
    path: r.data.path,
    parent: r.data.parent,
    dirs: r.data.entries
      .filter((e) => e.type === "dir")
      .map((e) => joinPath(r.data.path, e.name)),
  };
}

/**
 * 浏览主机上的目录。没给 path 时从 `start`（全局默认起点，local 与远程一视同仁，
 * `~` 由服务端按各主机展开）开始；起点在这台主机上不存在就退回根。
 */
export async function browseDir(
  token: string | null,
  host: Host,
  start: string,
  path?: string,
): Promise<DirView | null> {
  const view = await listDir(token, host, path ?? start);
  if (view || path !== undefined) return view;
  return listDir(token, host, "/");
}

/** 工作区弹窗里「隐私变量」要用的：全部变量，以及这个工作区已启用的 id。 */
export interface VariablePick {
  variables: VariableView[];
  enabled: string[];
}

/** 取不到按空：此时启用清单读回来等于原值，保存不会发出覆盖请求，不会误清掉已有的启用。 */
export async function loadVariablePick(
  token: string | null,
  workspaceId?: string,
): Promise<VariablePick> {
  try {
    const [variables, enabled] = await Promise.all([
      fetchVariables(token),
      workspaceId
        ? fetchWorkspaceVariables(token, workspaceId)
        : Promise.resolve<string[]>([]),
    ]);
    return { variables, enabled: [...enabled].sort() };
  } catch {
    return { variables: [], enabled: [] };
  }
}

export interface CapabilityRow {
  name: string;
  desc: string;
  /** 已设为全局：每个会话都带上，不用勾 */
  global: boolean;
  enabled: boolean;
}

export interface CapabilityPick {
  skills: CapabilityRow[];
  mcp: CapabilityRow[];
  /** 这个工作区已勾选的（新建时为空） */
  picked: WorkspaceCapabilities;
}

/** 取不到按空：此时勾选读回来等于原值，保存不会发出覆盖请求，不会误清掉已有的勾选。 */
export async function loadCapabilityPick(
  token: string | null,
  workspaceId?: string,
): Promise<CapabilityPick> {
  try {
    const [skills, mcp, picked] = await Promise.all([
      listLibrarySkills(token),
      listLibraryMcp(token),
      workspaceId
        ? fetchWorkspaceCapabilities(token, workspaceId)
        : Promise.resolve<WorkspaceCapabilities>({ skill: [], mcp: [] }),
    ]);
    return {
      skills: skills.map((k) => ({
        name: k.name,
        desc: k.description,
        global: k.scope === "global",
        enabled: k.enabled,
      })),
      mcp: mcp.map((m) => ({
        name: m.name,
        desc: m.description,
        global: m.global,
        enabled: m.enabled,
      })),
      picked: { skill: [...picked.skill].sort(), mcp: [...picked.mcp].sort() },
    };
  } catch {
    return { skills: [], mcp: [], picked: { skill: [], mcp: [] } };
  }
}
