// 技能库对外的错误、状态派生与响应形状。

import { HttpError } from "../lib/http-error.js";
import type { SkillRecord } from "../store/skills.js";
import type { DistItem } from "./dist.js";
import { compareVersions, FetchError } from "./fetch.js";
import { COMMIT_RE } from "./source.js";

export const reason = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

export class SkillError extends HttpError {
  constructor(
    code: string,
    message: string,
    status = 400,
    extra?: Record<string, unknown>,
  ) {
    super(code, message, status, extra);
  }
}

export function fromFetch(e: unknown): SkillError {
  if (!(e instanceof FetchError))
    return new SkillError("fetch_failed", reason(e), 502);
  switch (e.code) {
    case "network":
      return new SkillError("source_unreachable", e.message, 502);
    case "timeout":
      return new SkillError("source_timeout", e.message, 504);
    case "not_found":
      return new SkillError("source_not_found", e.message);
    case "no_skill":
      return new SkillError("no_skill", e.message);
    case "ambiguous":
      return new SkillError("ambiguous_skills", e.message, 409, {
        ...(e.candidates ? { candidates: e.candidates } : {}),
      });
    default:
      return new SkillError("fetch_failed", e.message, 502);
  }
}

// 两个版本都是提交号时只判等（提交号之间没有顺序）；其余沿用版本比较。
export const isNewer = (latest: string | null, current: string | null) => {
  if (latest === null || current === null) return false;
  if (COMMIT_RE.test(latest) && COMMIT_RE.test(current))
    return latest !== current;
  return compareVersions(latest, current) > 0;
};

export type SkillStatus = "ready" | "update-available" | "disabled";

export function statusOf(r: SkillRecord): SkillStatus {
  if (!r.enabled) return "disabled";
  // 锁定期间不催更新；只有库里版本落后于上次查到的最新版才算可更新。
  if (r.lockedVersion === null && isNewer(r.latestVersion, r.version))
    return "update-available";
  return "ready";
}

// 对外的技能形状：旧字段原样保留（source 仍是旧页面渲染的字符串），新字段追加；origin 才是结构化来源。
export function skillView(r: SkillRecord, dist?: DistItem[]) {
  return {
    name: r.name,
    description: r.description,
    scope: r.scope,
    source: r.source,
    hash: r.hash,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    origin: r.origin,
    version: r.version,
    lockedVersion: r.lockedVersion,
    latestVersion: r.latestVersion,
    enabled: r.enabled,
    status: statusOf(r),
    ...(dist ? { dist } : {}),
  };
}
export type SkillView = ReturnType<typeof skillView>;

export interface PushResult {
  hostId: string;
  status: "added" | "updated" | "unchanged" | "conflict" | "failed";
  message?: string;
}

export interface UninstallResult {
  // 已清理副本的环境；failed 是清理不了的环境（库里照常移除，残留副本可在环境恢复后再清）。
  cleaned: string[];
  failed: { hostId: string; message: string }[];
  // observed 的原件留在原处。
  keptInPlace?: string;
}

export type BatchAction = "update" | "disable" | "enable" | "uninstall";

export interface BatchItem {
  name: string;
  ok: boolean;
  error?: string;
  message?: string;
  changed?: boolean;
  cleaned?: string[];
  failed?: { hostId: string; message: string }[];
  keptInPlace?: string;
}
