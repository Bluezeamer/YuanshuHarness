// 技能来源（IMPLEMENTATION §5.4、§8.4）：四种已存储形态的解析、校验与名称推断；
// 请求里的来源另有 auto（自动识别常见写法）与显式的 npm / git / dir / observed。
import os from "node:os";
import path from "node:path";

export type NpmSource = { kind: "npm"; pkg: string };
// git 一律走 https 取回；ref 是用户写的分支 / tag / 提交号，缺省表示仓库默认分支。
export type GitSource = {
  kind: "git";
  url: string;
  ref?: string;
  subdir?: string;
};
export type DirSource = { kind: "dir"; path: string };
// 环境里发现的目录：只登记、不复制；hostId 指明目录在哪台环境上。
export type ObservedSource = { kind: "observed"; path: string; hostId: string };
export type SkillSource = NpmSource | GitSource | DirSource | ObservedSource;

// 版本可跟踪的来源（库里有版本号、可更新可锁定）。
export type TrackedSource = NpmSource | GitSource;
export const isTracked = (s: SkillSource | null): s is TrackedSource =>
  s?.kind === "npm" || s?.kind === "git";

// 与 pi 的加载器一致：1–64 个字符，小写字母 / 数字 / 连字符，不以连字符开头或结尾，无连续连字符。
export const SKILL_NAME_RE = /^[a-z0-9]([a-z0-9]|-(?=[a-z0-9])){0,63}$/;
// 提交号：git 的完整 40 位十六进制。
export const COMMIT_RE = /^[0-9a-f]{40}$/;

// 解析后的安装请求；version 对 npm 是包版本、对 git 是 ref，null 表示用户没写（由库定）。
export type ParsedInstall =
  | { source: NpmSource; version: string | null; hint: string }
  | { source: GitSource; version: string | null; hint: string }
  | { source: DirSource; version: null; hint: string }
  | { source: ObservedSource; version: null; hint: string };

export type Parsed =
  | { ok: true; value: ParsedInstall }
  | { ok: false; message: string };

// npm 包名（可带作用域）与版本（以数字开头）。
const NPM_SPEC =
  /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[0-9][0-9a-zA-Z.+-]*)?$/;
// host/owner/repo[/子组...]，不带协议；host 须含点（与 pi 的简写规则一致），@ref 可选。
const GIT_REPO = /^[a-z0-9.-]+\.[a-z]{2,}\/[\w.-]+(\/[\w.-]+)+$/i;
// scp 形式：git@host:owner/repo[.git]。
const SCP_SPEC = /^git@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;
// 恰两段的 owner/repo（第一段不以 @ 开头，那是 npm 作用域包）。
const SHORT_SPEC = /^([\w.-]+)\/([\w.-]+)$/;
const LOCAL_PREFIX = /^(\.{1,2}\/|\/|~\/)/;

export const NPM_VERSION_RE = /^[0-9][0-9a-zA-Z.+-]*$/;
// ref 会被传给 git：不许以 - 开头（选项注入）、不许含 ..。
export const isSafeRef = (ref: string): boolean =>
  /^[\w./-]+$/.test(ref) && !ref.startsWith("-") && !ref.includes("..");

// subdir 是仓库内的相对目录：不许绝对路径、不许 ..、不许 NUL，规范化后必须仍落在仓库内。
export function safeSubdir(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^\.\//, "");
  if (s === "" || s.includes("\0") || s.startsWith("/")) return null;
  if (!/^[\w.@/+ -]+$/.test(s)) return null;
  const segs = s.split("/");
  if (segs.includes("..")) return null;
  const norm = segs.filter((x) => x !== "" && x !== ".").join("/");
  return norm === "" ? null : norm;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

export function resolveLocalPath(spec: string): string {
  return path.resolve(
    spec.startsWith("~/") ? path.join(os.homedir(), spec.slice(2)) : spec,
  );
}

const fail = (message: string): Parsed => ({ ok: false, message });

// ---- 来源识别（纯函数）----

export type Detected =
  | { kind: "git"; spec: string; ref?: string; subdir?: string }
  | { kind: "npm"; spec: string }
  | { kind: "dir"; spec: string };

const FORMS = [
  "https://github.com/owner/repo（或 owner/repo，可带 @分支或标签，也可写成 .../tree/<ref>/<目录>）",
  "git@github.com:owner/repo.git",
  "host/owner/repo@ref",
  "@scope/包名@1.0.0 或 包名@1.0.0",
  "./本地技能目录",
];

const unknown = (): { error: string } => ({
  error: `无法识别来源，支持的写法：\n${FORMS.map((f) => `- ${f}`).join("\n")}`,
});

const stripGit = (s: string) => s.replace(/\.git$/i, "");

// 网页地址：github.com 只看前两段；其余主机取 tree 之前的全部路径（GitLab 是 /-/tree/）。
function webSource(host: string, rest: string): Detected | { error: string } {
  const segs = rest.split("/").filter((s) => s !== "");
  const github = /^(www\.)?github\.com$/i.test(host);
  // github 的仓库固定是前两段，其余主机取 tree 之前的全部路径。
  const repoLen = github ? 2 : 1;
  // tree 后面没有 ref 时不当 tree 看（仓库本身可能就叫 tree）。
  const mark = segs.findIndex(
    (s, i) => s === "tree" && i >= repoLen && i + 1 < segs.length,
  );
  // 末尾的 @ref 只在没有 tree 标记时取：tree 之后是目录路径，里面的 @ 属于目录名。
  let tailRef: string | undefined;
  const last = segs.at(-1) ?? "";
  const at = last.lastIndexOf("@");
  if (mark < 0 && at > 0) {
    tailRef = last.slice(at + 1);
    segs[segs.length - 1] = last.slice(0, at);
  }
  if (segs.length < 2) return { error: "地址里缺少仓库路径" };
  if (mark < 0)
    return {
      kind: "git",
      spec: `${host}/${stripGit((github ? segs.slice(0, repoLen) : segs).join("/"))}`,
      ...(tailRef ? { ref: tailRef } : {}),
    };
  // GitLab 在 tree 前多一段 -，它不是仓库路径的一部分。
  const end = github ? repoLen : segs[mark - 1] === "-" ? mark - 1 : mark;
  const ref = segs[mark + 1] as string;
  if (!isSafeRef(ref)) return { error: "git ref 不合法" };
  const subdir = segs.slice(mark + 2).join("/");
  return {
    kind: "git",
    spec: `${host}/${stripGit(segs.slice(0, end).join("/"))}`,
    ref,
    ...(subdir ? { subdir } : {}),
  };
}

// 把用户粘贴的写法识别成某一种来源；不合法时给一行中文说明支持的写法。
export function detectSource(raw: string): Detected | { error: string } {
  const spec = raw.trim();
  if (spec === "") return { error: "来源不能为空" };
  // 1. 本地目录
  if (LOCAL_PREFIX.test(spec)) return { kind: "dir", spec };
  // 2. scp 形式（一律改用 https 取回）
  const scp = SCP_SPEC.exec(spec);
  if (scp) return { kind: "git", spec: `${scp[1]}/${scp[2]}/${scp[3]}` };
  // 3. 网页地址
  if (/^https?:\/\//i.test(spec)) {
    const url = spec.replace(/^https?:\/\//i, "");
    const slash = url.indexOf("/");
    if (slash < 0) return { error: "地址里缺少仓库路径" };
    return webSource(url.slice(0, slash).toLowerCase(), url.slice(slash + 1));
  }
  const at = spec.lastIndexOf("@");
  const base = at > 0 ? spec.slice(0, at) : spec;
  const ref = at > 0 ? spec.slice(at + 1) : undefined;
  // 4. host/owner/repo[@ref]
  if (GIT_REPO.test(base))
    return { kind: "git", spec: base, ...(ref ? { ref } : {}) };
  // 5. owner/repo[@ref]，主机补成 github.com
  if (!base.startsWith("@") && SHORT_SPEC.test(base))
    return { kind: "git", spec: `github.com/${base}`, ...(ref ? { ref } : {}) };
  // 6. npm 包名[@版本]，版本可选
  if (NPM_SPEC.test(spec)) return { kind: "npm", spec };
  return unknown();
}

// ---- 各形态的子解析器 ----

function parseNpm(spec: string): Parsed {
  if (!NPM_SPEC.test(spec))
    return fail(
      `npm 包名不合法：${spec}；版本须以数字开头，例如 @acme/pi-skills@1.5.0`,
    );
  // 作用域包的 @ 在开头，版本分隔符是它之后的那个。
  const at = spec.lastIndexOf("@");
  const pkg = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : null;
  return {
    ok: true,
    value: {
      source: { kind: "npm", pkg },
      version,
      hint: slug(pkg.split("/").pop() ?? ""),
    },
  };
}

function parseGit(
  spec: string,
  subdir: string | null,
  refHint?: string,
): Parsed {
  const at = spec.lastIndexOf("@");
  const url = stripGit(at > 0 ? spec.slice(0, at) : spec);
  const ref = refHint ?? (at > 0 ? spec.slice(at + 1) : undefined);
  if (!GIT_REPO.test(url))
    return fail(
      `git 来源需为 host/org/repo[@ref]，例如 github.com/org/repo 或 github.com/org/repo@v1（当前：${spec}）`,
    );
  if (ref !== undefined && !isSafeRef(ref)) return fail("git ref 不合法");
  const source: GitSource = {
    kind: "git",
    url,
    ...(ref !== undefined ? { ref } : {}),
    ...(subdir ? { subdir } : {}),
  };
  return {
    ok: true,
    value: {
      source,
      version: ref ?? null,
      hint: slug(url.split("/").pop() ?? ""),
    },
  };
}

function parseDir(spec: string): Parsed {
  if (!LOCAL_PREFIX.test(spec)) return fail("本地目录需以 ./ ../ / ~/ 开头");
  const abs = resolveLocalPath(spec);
  return {
    ok: true,
    value: {
      source: { kind: "dir", path: abs },
      version: null,
      hint: slug(path.basename(abs)),
    },
  };
}

// 把请求里的 source 解析成可执行的形态；名称不在这里定，只给一个推断出的提示用于多技能包挑选。
export function parseInstallSource(raw: unknown): Parsed {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return fail("source 必须是对象");
  const r = raw as Record<string, unknown>;
  if (r.kind === "observed") {
    if (typeof r.hostId !== "string" || r.hostId === "")
      return fail("observed 来源需要 hostId");
    if (typeof r.path !== "string" || r.path === "" || r.path.includes("\0"))
      return fail("observed 来源需要 path");
    return {
      ok: true,
      value: {
        source: { kind: "observed", path: r.path, hostId: r.hostId },
        version: null,
        hint: slug(r.path.split(/[\\/]/).filter(Boolean).pop() ?? ""),
      },
    };
  }
  const spec = typeof r.spec === "string" ? r.spec.trim() : "";
  if (spec === "") return fail("来源不能为空");
  const subdir = r.subdir === undefined || r.subdir === "" ? null : r.subdir;
  if (subdir !== null && safeSubdir(subdir) === null)
    return fail(`subdir 不合法：${String(subdir)}`);
  switch (r.kind) {
    case "npm":
      return parseNpm(spec);
    case "git": {
      if (/^[a-z]+:\/\//i.test(spec))
        return fail("git 来源不带协议，例如 github.com/org/repo@v1");
      return parseGit(spec, typeof subdir === "string" ? subdir : null);
    }
    case "dir":
      return parseDir(spec);
    case "auto": {
      const d = detectSource(spec);
      if ("error" in d) return fail(d.error);
      switch (d.kind) {
        case "npm":
          return parseNpm(d.spec);
        case "dir":
          return parseDir(d.spec);
        default: {
          // 来源里自带的 subdir（tree 后面的路径）不合法就报错，不静默丢掉。
          const fromSpec = d.subdir === undefined ? null : safeSubdir(d.subdir);
          if (d.subdir !== undefined && fromSpec === null)
            return fail(`subdir 不合法：${d.subdir}`);
          return parseGit(
            d.spec,
            typeof subdir === "string" ? subdir : fromSpec,
            d.ref,
          );
        }
      }
    }
    default:
      return fail("来源类型必须是 auto / npm / git / dir / observed 之一");
  }
}

// 旧接口与旧页面里 source 是一个字符串；新来源在这里压成同形的简短标签。
export function sourceLabel(s: SkillSource): string {
  switch (s.kind) {
    case "npm":
      return `npm:${s.pkg}`;
    case "git":
      return `git:${s.url}${s.subdir ? `#${s.subdir}` : ""}`;
    case "dir":
      return `dir:${s.path}`;
    case "observed":
      return `observed:${s.hostId}`;
  }
}

// 解析 origin 列里的 JSON；格式不对按无来源处理（旧行与手写 skill 就是没有来源）。
export function parseOrigin(raw: string | null): SkillSource | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as SkillSource;
    return v && typeof v === "object" && typeof v.kind === "string" ? v : null;
  } catch {
    return null;
  }
}
