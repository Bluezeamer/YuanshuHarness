// 会话与 skill 库之间的胶水：解析应生效的 skill、同步到 directory 的环境、产出提示词条目与切换通知（ADR-0055）。
import {
  createSyntheticSourceInfo,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type { ExecEnv } from "../env/types.js";
import { pathOf } from "../permission/paths.js";
import type { AuditLog } from "../store/audit.js";
import type { CapabilityStore } from "../store/capabilities.js";
import { auditSkipped } from "../store/capability-refs.js";
import type { Directory } from "../store/directories.js";
import type { SkillRecord, SkillScope, SkillStore } from "../store/skills.js";
import { resolveSkills } from "./resolve.js";
import { SKILL_FILE } from "./spec.js";
import { type SyncInput, type SyncItem, syncSkills } from "./sync.js";

export interface SessionSkill {
  name: string;
  description: string;
  scope: SkillScope;
  // SKILL.md 在环境里的绝对路径；模型用 read 工具（按环境路由）读取。
  filePath: string;
  baseDir: string;
}

export interface SyncReport {
  directoryId: string;
  at: string;
  items: SyncItem[];
}

export interface SkillRuntimeDeps {
  skills: SkillStore;
  capabilities: CapabilityStore;
  audit?: AuditLog;
  // 取某个 skill 要同步的内容；缺省读库目录。observed 的内容在环境里，由技能库按需读出。
  load?: (meta: SkillRecord) => Promise<SyncInput>;
}

export class SkillRuntime {
  private readonly reports = new Map<string, SyncReport>();

  constructor(private readonly deps: SkillRuntimeDeps) {}

  last(directoryId: string): SyncReport | undefined {
    return this.reports.get(directoryId);
  }

  // 会话应生效的技能集合的指纹：集合、内容、启用与作用域任一变了就不同。只读库，不碰环境。
  signature(
    agentNames: string[] = [],
    workspaceId: string | null = null,
  ): string {
    const { skills, capabilities } = this.deps;
    const wsNames =
      workspaceId === null ? [] : capabilities.list(workspaceId, "skill");
    const { skills: metas } = resolveSkills(skills.list(), agentNames, wsNames);
    return JSON.stringify(
      metas.map((m) => [m.name, m.hash, m.scope, m.version]),
    );
  }

  // 同步并返回可注入提示词的 skill（全局 ∪ agent 引用 ∪ workspace 分配）；
  // 任何失败都落在 report 里，不抛出、不阻断会话。库里不存在的引用跳过并记审计。
  async prepare(
    sessionId: string | null,
    ws: Directory,
    env: ExecEnv,
    agentNames: string[] = [],
    workspaceId: string | null = null,
  ): Promise<{ report: SyncReport; skills: SessionSkill[] }> {
    const { skills, capabilities, audit } = this.deps;
    const wsNames =
      workspaceId === null ? [] : capabilities.list(workspaceId, "skill");
    const { skills: metas, missing } = resolveSkills(
      skills.list(),
      agentNames,
      wsNames,
    );
    auditSkipped(audit, sessionId, "skill", missing);
    const inputs: SyncInput[] = [];
    const failed: SyncItem[] = missing.map((name) => ({
      name,
      scope: "project",
      description: "",
      status: "failed",
      dir: null,
      message: "库里已不存在",
    }));
    for (const meta of metas) {
      try {
        inputs.push(
          (await this.deps.load?.(meta)) ?? {
            meta,
            files: skills.files(meta.name),
          },
        );
      } catch (err) {
        failed.push({
          name: meta.name,
          scope: meta.scope,
          description: meta.description,
          status: "failed",
          dir: null,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const items = [...(await syncSkills(env, ws.path, inputs)), ...failed];
    const report: SyncReport = {
      directoryId: ws.id,
      at: new Date().toISOString(),
      items,
    };
    this.reports.set(ws.id, report);
    const p = pathOf(env);
    return {
      report,
      skills: items.flatMap((i) =>
        i.dir !== null && i.status !== "conflict" && i.status !== "failed"
          ? [
              {
                name: i.name,
                description: i.description,
                scope: i.scope,
                filePath: p.join(i.dir, SKILL_FILE),
                baseDir: i.dir,
              },
            ]
          : [],
      ),
    };
  }
}

const NS = /[\\/]\.agents[\\/]skills[\\/]yuanshu[\\/]/;
const DESC_SHORT = 80;

// 本机会话里 pi 会自己扫到命名空间下的同步产物，与会话分配无关；只保留本会话分配到的，再补上环境里的条目。
export function mergeSkills(base: Skill[], injected: SessionSkill[]): Skill[] {
  const names = new Set(injected.map((s) => s.name));
  const kept = base.filter((s) => !names.has(s.name) && !NS.test(s.filePath));
  return [
    ...kept,
    ...injected.map(
      (s): Skill => ({
        name: s.name,
        description: s.description,
        filePath: s.filePath,
        baseDir: s.baseDir,
        sourceInfo: createSyntheticSourceInfo(s.filePath, {
          source: "yuanshu",
          scope: s.scope === "global" ? "user" : "project",
          baseDir: s.baseDir,
        }),
        disableModelInvocation: false,
      }),
    ),
  ];
}

const short = (d: string) =>
  d.length > DESC_SHORT ? `${d.slice(0, DESC_SHORT)}…` : d;

// 切换 directory 后的尾部通知片段（ADR-0008）：只列提示词里还没有的 skill（按目录判，同名在另一环境也算新），以及同步中的问题。
export function skillNotice(items: SyncItem[], known: Set<string>): string {
  const fresh = items.filter(
    (i) =>
      i.dir !== null &&
      (i.status === "added" ||
        i.status === "updated" ||
        i.status === "unchanged") &&
      !known.has(i.dir),
  );
  const bad = items.filter(
    (i) => i.status === "conflict" || i.status === "failed",
  );
  const out: string[] = [];
  if (fresh.length > 0)
    out.push(
      `该环境可用的 skill（需要时用 read 读取目录下的 ${SKILL_FILE}）：\n${fresh
        .map((i) => `- ${i.name}：${short(i.description)}（目录：${i.dir}）`)
        .join("\n")}`,
    );
  if (bad.length > 0)
    out.push(
      `skill 同步未完成：\n${bad
        .map((i) => `- ${i.name}：${i.message ?? i.status}`)
        .join("\n")}`,
    );
  return out.join("\n");
}
