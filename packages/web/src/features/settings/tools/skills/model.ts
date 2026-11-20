import type {
  DistItem,
  InstallSource,
  SkillFile,
  SkillOrigin,
  SkillView,
} from "../../../../api/skillLibrary";

export type Hosts = Readonly<Record<string, string>>;
export const hostLabel = (hosts: Hosts, id: string) => hosts[id] ?? id;

// ---- 分发达标度 ----

const dist = (s: SkillView): readonly DistItem[] => s.dist ?? [];
/** 落后：环境里有副本但与库不同。 */
export const behindCount = (s: SkillView) =>
  dist(s).filter((d) => d.state === "behind").length;
/** 有副本的环境数（一致 + 落后）。 */
export const copyCount = (s: SkillView) =>
  dist(s).filter((d) => d.state !== "missing").length;
/** 未分发：库里有，所有环境都还没有副本（没有环境时同样算）。 */
export const undistributed = (s: SkillView) => copyCount(s) === 0;
export const isUpdatable = (s: SkillView) => s.status === "update-available";

export type StatusKey =
  | "busy"
  | "off"
  | "locked"
  | "update"
  | "drift"
  | "pending"
  | "ok";
export interface RowStatus {
  key: StatusKey;
  text: string;
  tone?: "warn" | "live";
}

/** 行状态，优先级：同步中 > 已禁用 > 锁定 > 可更新 > 落后 > 待分发 > 一致。「环境落后」与「未分发」是两个概念。 */
export function statusOf(s: SkillView, busy: string | null): RowStatus {
  if (busy) return { key: "busy", text: busy, tone: "warn" };
  if (!s.enabled) return { key: "off", text: "已禁用" };
  // 项目级技能随会话同步进被勾选工作区的目录，不按环境分发：没有「落后 / 待分发」可言
  const byEnv = s.scope === "global";
  const n = byEnv ? behindCount(s) : 0;
  // 锁定期间不催更新（服务端不给 update-available），但落后仍要补
  if (s.lockedVersion !== null)
    return n > 0
      ? { key: "drift", text: `锁定 · 落后 ${n}`, tone: "warn" }
      : { key: "locked", text: "锁定" };
  if (isUpdatable(s)) return { key: "update", text: "可更新", tone: "warn" };
  if (n > 0) return { key: "drift", text: `落后 ${n}`, tone: "warn" };
  if (byEnv && undistributed(s)) return { key: "pending", text: "待分发" };
  return { key: "ok", text: byEnv ? "一致" : "就绪", tone: "live" };
}

// ---- 来源 ----

export interface OriginText {
  kind: string;
  /** 包名 / 仓库名 / 目录名 / 环境名；不是安装位置。 */
  name: string;
}

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function originText(o: SkillOrigin | null, hosts: Hosts): OriginText {
  if (!o) return { kind: "手写", name: "—" };
  switch (o.kind) {
    case "npm":
      return { kind: "npm", name: o.pkg };
    case "git":
      return { kind: "git", name: o.subdir ? `${o.url} · ${o.subdir}` : o.url };
    case "dir":
      return { kind: "本地", name: base(o.path) };
    case "observed":
      return { kind: "环境", name: hostLabel(hosts, o.hostId) };
  }
}

/** 版本可跟踪（有候选、可锁定）的来源。 */
export const isTracked = (s: SkillView) =>
  s.origin?.kind === "npm" || s.origin?.kind === "git";

// ---- 搜索 ----

export function matchesSkill(s: SkillView, q: string, hosts: Hosts): boolean {
  const key = q.trim().toLowerCase();
  if (!key) return true;
  const o = originText(s.origin, hosts);
  return [s.name, s.description, o.kind, o.name, s.version ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(key);
}

// ---- 分发 ----

/** 原件所在的环境：observed 来源的那台，库不往那里推。 */
export const isHome = (s: SkillView, d: DistItem) =>
  s.origin?.kind === "observed" && s.origin.hostId === d.hostId;

/** 能推的环境：落后或没有副本，探测得到，且不是原件所在。 */
export const pushTargets = (s: SkillView): DistItem[] =>
  dist(s).filter(
    (d) =>
      (d.state === "behind" || d.state === "missing") &&
      !d.error &&
      !isHome(s, d),
  );

/** 与库一致的环境数（原件所在的环境服务端也算一致）。 */
export const inSyncCount = (s: SkillView) =>
  dist(s).filter((d) => d.state === "in-sync").length;

// ---- 安装来源：粘贴一段文字，服务端识别；这里只做预览，不拦截 ----

export type SourceKind = "auto" | "observed";
export const SOURCE_KINDS: readonly { id: SourceKind; label: string }[] = [
  { id: "auto", label: "仓库 / 包 / 目录" },
  { id: "observed", label: "从环境纳入" },
];

const LOCAL_PREFIX = /^(\.{1,2}\/|\/|~\/)/;
const HOST_REPO = /^[a-z0-9.-]+\.[a-z]{2,}\/[\w.-]+\/[\w.-]+/i;
const OWNER_REPO = /^[\w.-]+\/[\w.-]+(@[\w./-]+)?$/;
const NPM_NAME =
  /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[0-9][0-9a-zA-Z.+-]*)?$/;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

export interface Described {
  kind: "git" | "npm" | "dir";
  /** 预览里「来源」一行 */
  label: string;
  /** 仓库 / 包 / 目录名，只作名称提示；最终名称取自 SKILL.md */
  hint: string;
  /** 版本预览；null = 不跟踪 */
  version: string | null;
  /** 链接里带的仓库内子目录 */
  subdir?: string;
}

const repoLabel = (repo: string, ref: string | undefined, subdir?: string) =>
  `${repo}${ref ? `@${ref}` : ""}${subdir ? ` · ${subdir}` : ""}`;

const GIT_VERSION = "默认分支，装好后记提交号";

/** 与服务端 skills/source.ts 的识别顺序一致，只用来预览；识别不了返回 null，由服务端给最终结论。 */
export function describeSource(raw: string): Described | null {
  const s = raw.trim();
  if (!s) return null;
  if (LOCAL_PREFIX.test(s))
    return {
      kind: "dir",
      label: `本地目录 · ${s}`,
      hint: slug(base(s)),
      version: null,
    };
  const ssh = /^git@([^:]+):(.+?)(\.git)?$/.exec(s);
  if (ssh) {
    const repo = `${ssh[1]}/${ssh[2]}`;
    return {
      kind: "git",
      label: `git · ${repo}`,
      hint: slug(base(repo)),
      version: GIT_VERSION,
    };
  }
  if (/^https?:\/\//.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    const segs = u.pathname.split("/").filter(Boolean);
    const tree = segs.indexOf("tree");
    const cut =
      tree >= 0 ? (segs[tree - 1] === "-" ? tree - 1 : tree) : segs.length;
    const repoSegs =
      u.host === "github.com" ? segs.slice(0, 2) : segs.slice(0, cut);
    if (repoSegs.length < 2) return null;
    const last = (repoSegs.pop() ?? "").replace(/\.git$/, "");
    const [name = "", suffixRef] = last.split("@");
    const repo = `${u.host}/${[...repoSegs, name].join("/")}`;
    const ref = tree >= 0 ? segs[tree + 1] : suffixRef;
    const subdir = tree >= 0 ? segs.slice(tree + 2).join("/") : "";
    return {
      kind: "git",
      label: `git · ${repoLabel(repo, ref, subdir || undefined)}`,
      hint: slug(name),
      version: ref ?? GIT_VERSION,
      ...(subdir ? { subdir } : {}),
    };
  }
  if (HOST_REPO.test(s) || (OWNER_REPO.test(s) && !s.startsWith("@"))) {
    const at = s.lastIndexOf("@");
    const repoPart = at > 0 ? s.slice(0, at) : s;
    const ref = at > 0 ? s.slice(at + 1) : undefined;
    const repo = HOST_REPO.test(repoPart) ? repoPart : `github.com/${repoPart}`;
    return {
      kind: "git",
      label: `git · ${repoLabel(repo, ref)}`,
      hint: slug(base(repoPart).replace(/\.git$/, "")),
      version: ref ?? GIT_VERSION,
    };
  }
  if (NPM_NAME.test(s)) {
    const at = s.lastIndexOf("@");
    const pkg = at > 0 ? s.slice(0, at) : s;
    const ver = at > 0 ? s.slice(at + 1) : null;
    return {
      kind: "npm",
      label: `npm · ${pkg}`,
      hint: slug(pkg.split("/").pop() ?? ""),
      version: ver ?? "最新版",
    };
  }
  return null;
}

export const SOURCE_FORMS =
  "支持：owner/repo、仓库网址（含 /tree/分支/子目录）、npm 包名、本地路径（./ ../ / ~/）";

export type Inferred =
  | { ok: true; source: InstallSource; label: string; version: string | null }
  | { ok: false; message: string };

export interface InstallInput {
  kind: SourceKind;
  spec: string;
  hostId: string;
  path: string;
  /** 仓库里多个技能时用户选定的目录；改了来源就清掉 */
  subdir?: string;
}

/** 空输入返回 null（预览显示「—」）；识别不了返回原因；识别了给出来源标签与版本预览。 */
export function inferInstall(i: InstallInput): Inferred | null {
  if (i.kind === "observed") {
    const path = i.path.trim();
    if (!path) return null;
    if (!i.hostId) return { ok: false, message: "先选一个环境" };
    return {
      ok: true,
      source: { kind: "observed", hostId: i.hostId, path },
      label: `环境里的目录 · ${path}`,
      version: null,
    };
  }
  const spec = i.spec.trim();
  if (!spec) return null;
  const d = describeSource(spec);
  if (!d) return { ok: false, message: `识别不了这个来源。${SOURCE_FORMS}` };
  const subdir = i.subdir ?? d.subdir;
  return {
    ok: true,
    source: { kind: "auto", spec, ...(subdir ? { subdir } : {}) },
    label: d.label,
    version: d.version,
  };
}

// ---- 技能自带的脚本：只做静态提示，不探测主机、不替用户装运行时 ----

const SCRIPT_EXT = /\.(sh|bash|py|js|cjs|mjs|ts|rb|pl|php)$/i;

/** 技能文件里的脚本（按文件名判断），最多列前几个由界面截。 */
export const scripts = (files: readonly SkillFile[]): string[] =>
  files.map((f) => f.path).filter((p) => SCRIPT_EXT.test(p));

// ---- 展开区的环境行 ----

export const DIST_TEXT: Record<DistItem["state"], string> = {
  "in-sync": "一致",
  behind: "落后",
  missing: "未分发",
};
