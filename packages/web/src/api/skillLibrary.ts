import { enc, request } from "./http";

// 技能库：与服务端 api/skills-library.ts、skills/view.ts、skills/source.ts 对应。
// 旧的 capabilities.ts 里的 skill 是旧形状，新界面不用；这里不声明 source 字段。

/** global = 每个会话都带上，镜像到主机的全局技能目录；project = 只在被勾给的工作区里生效。 */
export type SkillScope = "global" | "project";

export type SkillOrigin =
  | { kind: "npm"; pkg: string }
  | { kind: "git"; url: string; ref?: string; subdir?: string }
  | { kind: "dir"; path: string }
  | { kind: "observed"; path: string; hostId: string };

export type SkillStatus = "ready" | "update-available" | "disabled";

/** 某个环境上的副本状态：in-sync 与库一致，behind 有副本但与库不同，missing 没有副本（探测不到时也是，并带 error）。 */
export interface DistItem {
  hostId: string;
  version: string | null;
  hash: string | null;
  state: "in-sync" | "behind" | "missing";
  error?: string;
}

export interface SkillView {
  name: string;
  /** 取自 SKILL.md，不接受手填。 */
  description: string;
  scope: SkillScope;
  hash: string | null;
  origin: SkillOrigin | null;
  version: string | null;
  /** 非空 = 已锁定：一切自动行为以它为上限。 */
  lockedVersion: string | null;
  latestVersion: string | null;
  enabled: boolean;
  status: SkillStatus;
  createdAt: string;
  updatedAt: string;
  dist?: DistItem[];
}

export interface SkillFile {
  path: string;
  size: number;
}

/**
 * 来源：auto 是粘贴的一段文字（仓库网址、owner/repo、npm 包名、本地路径…），由服务端识别；
 * subdir 是仓库里的技能目录（一个仓库里有多个技能时，用服务端给的候选路径再提交一次）。
 * observed 是环境里已有的目录（原地登记）。
 */
export type InstallSource =
  | { kind: "auto"; spec: string; subdir?: string }
  | { kind: "observed"; hostId: string; path: string };

/** 一个仓库里有多个技能时服务端返回的候选（409 ambiguous_skills）。path 相对仓库根。 */
export interface SkillCandidate {
  name: string;
  path: string;
  description: string;
}

/** 提交号版本只显示前 7 位。 */
export const shortVersion = (v: string): string =>
  /^[0-9a-f]{40}$/.test(v) ? v.slice(0, 7) : v;

export interface SkillVersions {
  name: string;
  /** false = 来源不跟踪版本（本地目录、环境纳入），没有候选。 */
  tracked: boolean;
  current: string | null;
  locked: string | null;
  latest: string | null;
  versions: { version: string; current: boolean; latest: boolean }[];
}

export interface PushResult {
  hostId: string;
  status: "added" | "updated" | "unchanged" | "conflict" | "failed";
  message?: string;
}

export type BatchAction = "update" | "disable" | "enable" | "uninstall";

export interface BatchItem {
  name: string;
  ok: boolean;
  error?: string;
  message?: string;
  changed?: boolean;
  /** 卸载：已清理副本的环境；failed 是清理不了的环境。 */
  cleaned?: string[];
  failed?: { hostId: string; message: string }[];
  /** 卸载 observed：原件留在原处。 */
  keptInPlace?: string;
}

const base = "/api/v1/skills";
const one = (name: string) => `${base}/${enc(name)}`;

export const listSkills = async (token: string | null) =>
  (await request<{ skills: SkillView[] }>("GET", base, token)).skills;

export const getSkill = (token: string | null, name: string) =>
  request<{ skill: SkillView; files: SkillFile[] }>("GET", one(name), token);

/** 装进库，停在「待分发」；名称与描述取自 SKILL.md。重名 409 name_exists。 */
export const installSkill = (token: string | null, source: InstallSource) =>
  request<SkillView>("POST", `${base}/install`, token, { source });

export const patchSkillScope = (
  token: string | null,
  name: string,
  scope: SkillScope,
) => request<SkillView>("PATCH", one(name), token, { scope });

export const getSkillVersions = (token: string | null, name: string) =>
  request<SkillVersions>("GET", `${one(name)}/versions`, token);

/** 跟最新：只改库版本，不分发。已锁定 409 locked。 */
export const updateSkill = (token: string | null, name: string) =>
  request<{ skill: SkillView; changed: boolean }>(
    "POST",
    `${one(name)}/update`,
    token,
  );

export const lockSkill = (
  token: string | null,
  name: string,
  version: string,
) => request<SkillView>("POST", `${one(name)}/lock`, token, { version });

export const unlockSkill = (token: string | null, name: string) =>
  request<SkillView>("POST", `${one(name)}/unlock`, token);

/** 补齐：把库里现有版本（锁定时即锁定版）推到落后的环境；不联网、不换版本。 */
export const syncSkill = (
  token: string | null,
  name: string,
  hostIds?: string[],
) =>
  request<{ skill: SkillView; results: PushResult[] }>(
    "POST",
    `${one(name)}/sync`,
    token,
    hostIds ? { hostIds } : {},
  );

export const distributeSkill = (
  token: string | null,
  name: string,
  hostIds: string[],
) =>
  request<{ skill: SkillView; results: PushResult[] }>(
    "POST",
    `${one(name)}/distribute`,
    token,
    { hostIds },
  );

export const batchSkills = async (
  token: string | null,
  names: string[],
  action: BatchAction,
) =>
  (
    await request<{ results: BatchItem[] }>("POST", `${base}/batch`, token, {
      names,
      action,
    })
  ).results;

export const readSkillFile = (
  token: string | null,
  name: string,
  path: string,
) =>
  request<{ path: string; content: string }>(
    "GET",
    `${one(name)}/file?path=${enc(path)}`,
    token,
  );
