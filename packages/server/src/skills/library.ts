// 技能库的版本、来源与分发（S5a）：安装、更新、锁定、补齐、分发达标度、卸载。
// 约定：库里只有一份内容；更新与锁定只改库（A9），环境在下次会话启动或手动同步时才拉取；
// 锁定后一切自动行为以锁定版为上限（D11）——补齐 / 分发只推库里现有的内容，不联网、不换版本。
import { statSync } from "node:fs";
import type { EnvHub } from "../env/hub.js";
import type { ExecEnv } from "../env/types.js";
import { pathOf } from "../permission/paths.js";
import type { CapabilityStore } from "../store/capabilities.js";
import type { DirectoryStore } from "../store/directories.js";
import type { Environment, EnvironmentStore } from "../store/environments.js";
import type { SkillRecord, SkillStore } from "../store/skills.js";
import type { WorkspaceDirectoryStore } from "../store/workspace-directories.js";
import {
  type DistItem,
  HostGuard,
  missing,
  probeCopies,
  timed,
} from "./dist.js";
import { type EnvSkill, readEnvSkillDir, scanEnvSkills } from "./env.js";
import {
  FetchError,
  type FoundSkill,
  loadLocalSkill,
  type SkillFetcher,
} from "./fetch.js";
import {
  isSafeRef,
  isTracked,
  NPM_VERSION_RE,
  type ParsedInstall,
  parseInstallSource,
  SKILL_NAME_RE,
  sourceLabel,
  type TrackedSource,
} from "./source.js";
import {
  checkSkillMd,
  hashFiles,
  SKILL_FILE,
  type SkillFile,
  safeRelPath,
} from "./spec.js";
import { readManifest, type SyncInput, syncSkills, targetDir } from "./sync.js";
import {
  type BatchAction,
  type BatchItem,
  fromFetch,
  isNewer,
  type PushResult,
  reason,
  SkillError,
  type UninstallResult,
} from "./view.js";

export interface LibraryDeps {
  skills: SkillStore;
  capabilities: CapabilityStore;
  directories: DirectoryStore;
  workspaceDirectories: WorkspaceDirectoryStore;
  environments: EnvironmentStore;
  hub: EnvHub;
  fetcher: SkillFetcher;
  // 探测与清理单台环境的超时；分发写文件另算。
  probeTimeoutMs?: number;
  pushTimeoutMs?: number;
}

export class SkillLibrary {
  private readonly guard = new HostGuard();
  private readonly probeMs: number;
  private readonly pushMs: number;

  constructor(private readonly deps: LibraryDeps) {
    this.probeMs = deps.probeTimeoutMs ?? 5_000;
    this.pushMs = deps.pushTimeoutMs ?? 60_000;
  }

  must(name: string): SkillRecord {
    const r = this.deps.skills.get(name);
    if (!r) throw new SkillError("not_found", "skill 不存在", 404);
    return r;
  }

  // ---- 安装 ----

  async install(raw: unknown): Promise<SkillRecord> {
    const parsed = parseInstallSource(raw);
    if (!parsed.ok) throw new SkillError("invalid_source", parsed.message);
    const p = parsed.value;
    if (p.source.kind === "observed") return this.installObserved(p);
    const { found, version } = await this.obtain(p);
    this.assertName(found.name);
    const { skills } = this.deps;
    const origin = p.source;
    const r = skills.create(
      found.name,
      "project",
      sourceLabel(origin),
      found.files,
      { version, origin },
    );
    if (!r.ok) throw new SkillError("invalid_skill", r.error);
    return r.value;
  }

  private assertName(name: string): void {
    if (!SKILL_NAME_RE.test(name))
      throw new SkillError(
        "invalid_name",
        `技能名称「${name}」不合法：需 1–64 个字符，只含小写字母、数字、连字符，不以连字符开头或结尾，不含连续连字符`,
      );
    if (this.deps.skills.get(name))
      throw new SkillError("name_exists", `库中已有同名技能：${name}`, 409);
  }

  // npm / git 经取回器取得；dir 直接读本地目录。没写版本时 npm 取 latest、git 取默认分支。
  private async obtain(
    p: ParsedInstall,
  ): Promise<{ found: FoundSkill; version: string | null }> {
    const s = p.source;
    if (s.kind === "observed") throw new Error("observed 不经此处取回");
    if (s.kind === "dir")
      return { found: this.readDir(s.path, p.hint), version: null };
    if (s.kind === "npm") {
      const version = p.version ?? (await this.listVersions(s))[0];
      if (!version)
        throw fromFetch(new FetchError("not_found", "来源没有可用的版本"));
      return { found: await this.fetch(s, version, p.hint), version };
    }
    // git：ref 是 tag 时库里存 tag 名，分支 / 提交号 / 缺省 ref 都存取回的提交号
    // （分支会前进，只有存提交号才能判断「可更新」）。
    const found = await this.fetch(s, p.version ?? "HEAD", p.hint);
    const version =
      found.tag && p.version !== null ? p.version : (found.commit ?? p.version);
    return { found, version };
  }

  private async listVersions(source: TrackedSource): Promise<string[]> {
    try {
      return await this.deps.fetcher.versions(source);
    } catch (e) {
      throw fromFetch(e);
    }
  }

  // 取回；报错统一翻成业务错误（含多技能候选）。
  private async fetch(
    source: TrackedSource,
    version: string,
    hint: string,
  ): Promise<FoundSkill> {
    try {
      return await this.deps.fetcher.fetch(source, version, hint);
    } catch (e) {
      throw fromFetch(e);
    }
  }

  private readDir(dir: string, hint: string): FoundSkill {
    try {
      if (!statSync(dir).isDirectory()) throw new Error("not a dir");
    } catch {
      throw new SkillError("source_not_found", "本地目录不存在或不是目录");
    }
    try {
      return loadLocalSkill(dir, hint);
    } catch (e) {
      throw fromFetch(e);
    }
  }

  private async installObserved(p: ParsedInstall): Promise<SkillRecord> {
    const { source } = p;
    if (source.kind !== "observed") throw new Error("unreachable");
    const env = this.envOf(source.hostId);
    const hit = (await this.scanHost(source.hostId, env)).find(
      (s) => s.dir === source.path && !s.managed,
    );
    if (!hit)
      throw new SkillError(
        "not_a_skill_dir",
        "该目录不是环境里可登记的技能目录",
      );
    this.assertName(hit.name);
    const live = await this.readObserved(env, source.path, hit.name);
    const r = this.deps.skills.register(
      hit.name,
      "project",
      sourceLabel(source),
      live.description,
      live.hash,
      source,
    );
    if (!r.ok) throw new SkillError("invalid_skill", r.error);
    return r.value;
  }

  private envOf(hostId: string): ExecEnv {
    const env = this.deps.hub.get(hostId);
    if (!env) throw new SkillError("host_not_found", "环境不存在", 404);
    return env;
  }

  // 环境里可登记的技能：用户目录与该环境上各 directory 的项目目录（同旧版识别范围）。
  private async scanHost(hostId: string, env: ExecEnv): Promise<EnvSkill[]> {
    const roots = this.deps.directories
      .list()
      .filter((w) => w.environmentId === hostId)
      .map((w) => w.path);
    const seen = new Map<string, EnvSkill>();
    try {
      for (const root of roots.length > 0 ? roots : [null])
        for (const s of await scanEnvSkills(env, root)) seen.set(s.dir, s);
    } catch (e) {
      throw new SkillError("env_unavailable", reason(e), 502);
    }
    return [...seen.values()];
  }

  // 读出 observed 原件的当前内容；描述按 SKILL.md、哈希按全部文件。
  private async readObserved(env: ExecEnv, dir: string, name: string) {
    let files: SkillFile[];
    try {
      files = await readEnvSkillDir(env, dir);
    } catch (e) {
      throw new SkillError("invalid_skill", reason(e));
    }
    const md = files.find((f) => f.path === SKILL_FILE);
    if (!md) throw new SkillError("invalid_skill", `缺少 ${SKILL_FILE}`);
    const check = checkSkillMd(name, md.content.toString("utf8"));
    if (check.errors.length > 0)
      throw new SkillError("invalid_skill", check.errors.join("；"));
    return {
      files,
      description: check.description ?? "",
      hash: hashFiles(files),
    };
  }

  // ---- 版本 ----

  // 候选版本；向来源联网查询，并记下结果供列表判断「可更新」。
  async versions(name: string) {
    const rec = this.must(name);
    if (!isTracked(rec.origin))
      return {
        tracked: false,
        current: null,
        locked: null,
        latest: null,
        versions: [],
      };
    let list: string[];
    try {
      list = await this.deps.fetcher.versions(rec.origin);
    } catch (e) {
      throw fromFetch(e);
    }
    this.deps.skills.setVersions(name, list);
    // 当前版本不在候选里（提交号、重复分支的旧版、被撤的版本）也要列出，免得界面找不到「当前」。
    const all =
      rec.version !== null && !list.includes(rec.version)
        ? [...list, rec.version]
        : list;
    return {
      tracked: true,
      current: rec.version,
      locked: rec.lockedVersion,
      latest: list[0] ?? null,
      versions: all.map((v) => ({
        version: v,
        current: v === rec.version,
        latest: v === list[0],
      })),
    };
  }

  // 跟最新：只改库版本，不分发（A9）。锁定中拒绝。
  async update(
    name: string,
  ): Promise<{ skill: SkillRecord; changed: boolean }> {
    const rec = this.must(name);
    if (rec.lockedVersion !== null)
      throw new SkillError(
        "locked",
        `已锁定在 ${rec.lockedVersion}，先解除锁定再更新`,
        409,
      );
    const o = rec.origin;
    const { skills } = this.deps;
    if (isTracked(o)) {
      const list = await this.listVersions(o);
      const latest = list[0];
      if (!latest)
        throw new SkillError("no_versions", "来源没有可用的版本", 409);
      skills.setVersions(name, list);
      if (latest === rec.version)
        return { skill: this.must(name), changed: false };
      return { skill: await this.moveTo(rec, o, latest), changed: true };
    }
    if (o?.kind === "dir") {
      const found = this.readDir(o.path, rec.name);
      this.assertSameName(rec, found.name);
      const r = skills.replace(name, found.files, { version: null });
      if (!r.ok) throw new SkillError("invalid_skill", r.error);
      return { skill: r.value, changed: r.value.hash !== rec.hash };
    }
    if (o?.kind === "observed") {
      const live = await this.readObserved(this.envOf(o.hostId), o.path, name);
      skills.setObserved(name, live.description, live.hash);
      return { skill: this.must(name), changed: live.hash !== rec.hash };
    }
    throw new SkillError(
      "not_updatable",
      "手写或旧版纳入的技能没有来源，无法更新",
      400,
    );
  }

  private assertSameName(rec: SkillRecord, found: string) {
    if (found !== rec.name)
      throw new SkillError(
        "name_changed",
        `来源里的技能名已变为「${found}」，与库里的「${rec.name}」不一致`,
        409,
      );
  }

  // 把库里的内容换成来源在 version 下的内容。
  // git 取的是 tag 就存 tag 名，否则存实际提交号（分支会前进，只有提交号能判断「可更新」）。
  private async moveTo(
    rec: SkillRecord,
    o: TrackedSource,
    version: string,
  ): Promise<SkillRecord> {
    const found = await this.fetch(o, version, rec.name);
    this.assertSameName(rec, found.name);
    const keepTag = o.kind === "git" && found.tag === true;
    const stored =
      o.kind === "git" && !keepTag ? (found.commit ?? version) : version;
    // git 的 ref 跟着 tag 走；分支 / 缺省 ref 不改写——写成提交号后就永远查不到更新了。
    const origin = keepTag ? { ...o, ref: version } : o;
    const r = this.deps.skills.replace(rec.name, found.files, {
      version: stored,
      origin,
      latestVersion:
        rec.latestVersion !== null && isNewer(rec.latestVersion, stored)
          ? null
          : stored,
    });
    if (!r.ok) throw new SkillError("invalid_skill", r.error);
    return r.value;
  }

  // 锁到某一版：库里换成该版本并锁定，之后更新与补齐都不越过它。
  async lock(name: string, version: unknown): Promise<SkillRecord> {
    const rec = this.must(name);
    const o = rec.origin;
    if (!isTracked(o))
      throw new SkillError("version_not_tracked", "该来源不跟踪版本，无法锁定");
    if (typeof version !== "string" || version === "")
      throw new SkillError("invalid_version", "version 必填");
    if (!(o.kind === "npm" ? NPM_VERSION_RE.test(version) : isSafeRef(version)))
      throw new SkillError("invalid_version", "version 格式不合法");
    if (version !== rec.version) await this.moveTo(rec, o, version);
    // 锁定库里实际存的版本（分支会落成提交号），否则与 pushTo 的一致性校验对不上。
    this.deps.skills.setLocked(name, this.must(name).version ?? version);
    return this.must(name);
  }

  unlock(name: string): SkillRecord {
    this.must(name);
    this.deps.skills.setLocked(name, null);
    return this.must(name);
  }

  // ---- 分发达标度 ----

  // 每个项目级 skill 被分配到哪些工作区，再摊成这些工作区的目录 id。
  private assignments(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const rec of this.deps.skills.list()) {
      if (rec.scope === "global") continue;
      const ids = this.deps.capabilities
        .workspacesWith("skill", rec.name)
        .flatMap((wsId) => this.deps.workspaceDirectories.get(wsId));
      if (ids.length > 0) out.set(rec.name, [...new Set(ids)]);
    }
    return out;
  }

  // 该技能在某台环境上应有副本的目录：全局技能在用户目录，项目级在被分配工作区的目录里。
  private dirsOn(
    rec: SkillRecord,
    e: ExecEnv,
    home: string,
    hostId: string,
    assigned: Map<string, string[]>,
  ): string[] {
    if (rec.scope === "global")
      return [targetDir(e, home, home, "global", rec.name)];
    const ids = new Set(assigned.get(rec.name) ?? []);
    return this.deps.directories
      .list()
      .filter((w) => w.environmentId === hostId && ids.has(w.id))
      .map((w) => targetDir(e, home, w.path, "project", rec.name));
  }

  // 各技能在各环境上的副本状态；环境之间并行，单台探测不到时该环境标 missing 并带原因。
  // 项目级技能随会话同步进被勾选工作区的目录，不按环境分发，所以不探测、状态为空。
  async distribution(all: SkillRecord[]): Promise<Map<string, DistItem[]>> {
    const out = new Map<string, DistItem[]>(all.map((r) => [r.name, []]));
    const recs = all.filter((r) => r.scope === "global");
    if (recs.length === 0) return out;
    const hosts = this.deps.environments.list();
    const assigned = this.assignments();
    const probed = await Promise.all(
      hosts.map(async (h): Promise<DistItem[] | string> => {
        try {
          return await this.guard.run(h.id, this.probeMs, async () => {
            const e = this.deps.hub.get(h.id);
            if (!e) throw new Error("环境不可用");
            const home = await e.homedir();
            const items: DistItem[] = [];
            for (const rec of recs)
              items.push(
                await probeCopies(
                  e,
                  h.id,
                  rec,
                  this.dirsOn(rec, e, home, h.id, assigned),
                ),
              );
            return items;
          });
        } catch (e) {
          return reason(e);
        }
      }),
    );
    hosts.forEach((h, i) => {
      const r = probed[i];
      recs.forEach((rec, j) => {
        const item = typeof r === "string" ? missing(h.id, r) : r?.[j];
        out.get(rec.name)?.push(item ?? missing(h.id, "探测失败"));
      });
    });
    return out;
  }

  // ---- 分发与补齐 ----

  // 同步用的内容；observed 的内容在环境里，读出当前版本并顺手刷新库里的哈希。
  async loadInput(rec: SkillRecord): Promise<SyncInput> {
    const o = rec.origin;
    if (o?.kind !== "observed")
      return { meta: rec, files: this.deps.skills.files(rec.name) };
    const live = await this.readObserved(
      this.envOf(o.hostId),
      o.path,
      rec.name,
    );
    if (live.hash !== rec.hash)
      this.deps.skills.setObserved(rec.name, live.description, live.hash);
    return {
      meta: { ...rec, description: live.description, hash: live.hash },
      files: live.files,
    };
  }

  // 把库里现有内容推到这些环境；不联网、不换版本，所以锁定版永远不会被越过。
  private async pushTo(
    rec: SkillRecord,
    hostIds: string[],
  ): Promise<PushResult[]> {
    if (rec.scope !== "global")
      throw new SkillError(
        "project_scope",
        "项目级技能随工作区勾选在会话里同步，不能按环境分发",
        409,
      );
    if (rec.lockedVersion !== null && rec.version !== rec.lockedVersion)
      throw new SkillError(
        "lock_mismatch",
        `库里版本 ${rec.version ?? "—"} 与锁定版 ${rec.lockedVersion} 不一致，先重新锁定`,
        409,
      );
    const known = new Set(this.deps.environments.list().map((h) => h.id));
    const bad = hostIds.find((h) => !known.has(h));
    if (bad !== undefined)
      throw new SkillError("unknown_host", `环境不存在：${bad}`);
    if (hostIds.length === 0) return [];
    const input = await this.loadInput(rec);
    return Promise.all(
      [...new Set(hostIds)].map(async (hostId): Promise<PushResult> => {
        if (rec.origin?.kind === "observed" && rec.origin.hostId === hostId)
          return {
            hostId,
            status: "unchanged",
            message: "原件所在环境，无需分发",
          };
        try {
          const env = this.envOf(hostId);
          const [item] = await timed(
            syncSkills(env, null, [input]),
            this.pushMs,
            "分发",
          );
          if (!item) return { hostId, status: "failed", message: "无结果" };
          return {
            hostId,
            status: item.status,
            ...(item.message ? { message: item.message } : {}),
          };
        } catch (e) {
          return { hostId, status: "failed", message: reason(e) };
        }
      }),
    );
  }

  distribute(name: string, hostIds: string[]): Promise<PushResult[]> {
    return this.pushTo(this.must(name), hostIds);
  }

  // 补齐：默认只拉回落后的环境；也可指定环境。
  async sync(name: string, hostIds?: string[]): Promise<PushResult[]> {
    const rec = this.must(name);
    const targets =
      hostIds ??
      (await this.distribution([rec]))
        .get(name)
        ?.filter((d) => d.state === "behind")
        .map((d) => d.hostId) ??
      [];
    return this.pushTo(rec, targets);
  }

  // ---- 卸载与批量 ----

  private async cleanHost(
    h: Environment,
    rec: SkillRecord,
    assigned: Map<string, string[]>,
  ): Promise<number> {
    // 清理不走探测的失败缓存：掉线的主机恢复后第一次卸载就应该试一次。
    const clean = async () => {
      const e = this.deps.hub.get(h.id);
      if (!e) throw new Error("环境不可用");
      const home = await e.homedir();
      let n = 0;
      for (const dir of this.dirsOn(rec, e, home, h.id, assigned)) {
        if (!(await e.lstat(dir))) continue;
        // 只清自己写的：没有同步清单的同名目录是用户手写的，留着。
        if (!(await readManifest(e, dir))) continue;
        await e.remove(dir, true);
        n++;
      }
      return n;
    };
    return timed(clean(), this.pushMs, "清理");
  }

  // 卸载：清理库分发到各环境的副本，再从库移除；observed 的原件不动。
  async uninstall(name: string): Promise<UninstallResult> {
    const rec = this.must(name);
    const assigned = this.assignments();
    const cleaned: string[] = [];
    const failed: { hostId: string; message: string }[] = [];
    await Promise.all(
      this.deps.environments.list().map(async (h) => {
        try {
          if ((await this.cleanHost(h, rec, assigned)) > 0) cleaned.push(h.id);
        } catch (e) {
          failed.push({ hostId: h.id, message: reason(e) });
        }
      }),
    );
    this.deps.skills.remove(name);
    return {
      cleaned,
      failed,
      ...(rec.origin?.kind === "observed"
        ? { keptInPlace: rec.origin.path }
        : {}),
    };
  }

  // 逐项执行，单项失败不影响其余，也不回滚已成功的。
  async batch(names: string[], action: BatchAction): Promise<BatchItem[]> {
    const out: BatchItem[] = [];
    for (const name of names) {
      try {
        switch (action) {
          case "update": {
            const r = await this.update(name);
            out.push({ name, ok: true, changed: r.changed });
            break;
          }
          case "uninstall": {
            const r = await this.uninstall(name);
            out.push({ name, ok: true, ...r });
            break;
          }
          default:
            this.must(name);
            this.deps.skills.setEnabled(name, action === "enable");
            out.push({ name, ok: true });
        }
      } catch (e) {
        out.push(
          e instanceof SkillError
            ? { name, ok: false, error: e.code, message: e.message }
            : { name, ok: false, error: "failed", message: reason(e) },
        );
      }
    }
    return out;
  }

  // ---- 文件树（详情弹窗）----

  async listFiles(rec: SkillRecord): Promise<{ path: string; size: number }[]> {
    const files =
      rec.origin?.kind === "observed"
        ? await readEnvSkillDir(this.envOf(rec.origin.hostId), rec.origin.path)
        : this.deps.skills.files(rec.name);
    return files
      .map((f) => ({ path: f.path, size: f.content.length }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async readFile(rec: SkillRecord, rel: string): Promise<Buffer | null> {
    if (rec.origin?.kind !== "observed")
      return this.deps.skills.readFile(rec.name, rel);
    const env = this.envOf(rec.origin.hostId);
    const safe = safeRelPath(rel);
    if (!safe) return null;
    const full = pathOf(env).join(rec.origin.path, ...safe.split("/"));
    return (await env.lstat(full))?.isFile ? env.readFile(full) : null;
  }
}
