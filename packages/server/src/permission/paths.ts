// 路径解析与敏感路径判定（ADR-0030；ADR-0034：文件系统访问走环境原语）。
import path from "node:path";
import type { ExecEnv } from "../env/types.js";

/** 判定所用的文件系统视图：本机与 ssh 环境同一套接口。 */
export type PathEnv = Pick<
  ExecEnv,
  "kind" | "homedir" | "stat" | "lstat" | "realpath" | "readdir"
>;

/** ssh 环境一律按 POSIX 路径处理（Windows 远端经 Git Bash，路径形如 /c/Users）。 */
export const pathOf = (env: Pick<ExecEnv, "kind">): path.PlatformPath =>
  env.kind === "ssh" ? path.posix : path;

// SDK 工具会把这些空格改写成 U+0020，并把 `file://` 转成它指向的绝对路径；
// 权限层不重复这套改写，直接当作无法可靠解析（不 fork SDK）。
const SDK_REWRITTEN_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/;

/**
 * 相对 cwd 解析并解析符号链接；尚不存在的路径取最近已存在祖先的真实路径再拼回尾部。
 * 悬空链接、循环链接、权限、连接失败、`file://` 前缀与 SDK 会改写的 Unicode 空格等
 * 任何无法可靠解析的情况返回 null，调用方须按 cwd 外处理（不放行）。
 */
export async function resolveTarget(
  raw: string,
  cwd: string,
  env: PathEnv,
): Promise<string | null> {
  const pm = pathOf(env);
  try {
    if (SDK_REWRITTEN_SPACES.test(raw)) return null;
    let p = raw.startsWith("@") ? raw.slice(1) : raw;
    if (p.startsWith("file://")) return null;
    if (p === "~" || p.startsWith("~/"))
      p = pm.join(await env.homedir(), p.slice(1));
    let head = pm.resolve(cwd, p);
    const tail: string[] = [];
    // lstat 而非 stat：悬空链接本身也算“存在”，交给 realpath 判失败
    while ((await env.lstat(head)) === null) {
      const up = pm.dirname(head);
      if (up === head) return null;
      tail.unshift(pm.basename(head));
      head = up;
    }
    const real = await env.realpath(head);
    return real === null ? null : pm.join(real, ...tail);
  } catch {
    return null;
  }
}

/** p 是否在 dir 内（含自身）；二者都应已解析。 */
export function isInside(
  dir: string,
  p: string,
  pm: path.PlatformPath = path,
): boolean {
  const rel = pm.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !pm.isAbsolute(rel));
}

const SENSITIVE_SEGMENT = /^(\.env(\..*)?|\.ssh|\.aws|\.kube|\.gnupg)$/;
const SENSITIVE_NAME =
  /^(\.npmrc|\.netrc|id_rsa.*|id_ed25519.*|.*\.pem|.*\.key)$/;
// 大小写折叠：Windows/macOS 默认大小写不敏感，`.ENV`、`ID_RSA` 与小写等价。
const sensitiveName = (s: string) => {
  const l = s.toLowerCase();
  return SENSITIVE_SEGMENT.test(l) || SENSITIVE_NAME.test(l);
};

// 通配符词的保守判定：把通配符替换为任意字符后可能命中清单即算敏感。
const GLOB = /[*?[]/;
/** 清单各族的代表名，用来反向匹配 glob。 */
const SAMPLE_NAMES = [
  ".env",
  ".env.a",
  ".ssh",
  ".aws",
  ".kube",
  ".gnupg",
  ".npmrc",
  ".netrc",
  "id_rsa",
  "id_rsa.pub",
  "id_ed25519",
  "id_ed25519.pub",
  "a.pem",
  "a.key",
  ".pem",
  ".key",
];

function globToRegExp(g: string): RegExp {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = g.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        const body = g
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        re += `[${body}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** 把 glob 里的通配符换成具体字符得到的实例（* 取空或 a）。 */
function globInstances(g: string): string[] {
  const inst = (star: string) =>
    g
      .replace(/\[!?\^?([^\]]?)[^\]]*\]/g, (_m, c: string) => c || "a")
      .replace(/\*/g, star)
      .replace(/\?/g, "a");
  return [inst(""), inst("a")];
}

function globMaySensitive(seg: string): boolean {
  if (globInstances(seg).some(sensitiveName)) return true;
  let re: RegExp;
  try {
    re = globToRegExp(seg);
  } catch {
    return true; // 无法理解的 glob：保守视为敏感
  }
  // shell 里以通配符开头的 glob 不匹配点文件
  return SAMPLE_NAMES.some(
    (n) => re.test(n) && !(n.startsWith(".") && GLOB.test(seg[0] ?? "")),
  );
}

const BRACE_MAX_RESULTS = 64;
const BRACE_MAX_LENGTH = 4096;

/**
 * 展开 {a,b}。结果超过 64 个、或词过长则返回 null（调用方按敏感处理，不能丢弃后续分支）。
 * 叶子数达上限即短路：每个内部节点至少两个分支，总步数不超过上限的两倍，指数嵌套也是毫秒级。
 */
function expandBraces(p: string): string[] | null {
  if (p.length > BRACE_MAX_LENGTH) return null;
  const out: string[] = [];
  const walk = (q: string): boolean => {
    const m = /\{([^{}]*,[^{}]*)\}/.exec(q);
    if (!m) {
      out.push(q);
      return out.length <= BRACE_MAX_RESULTS;
    }
    for (const alt of (m[1] ?? "").split(","))
      if (!walk(q.slice(0, m.index) + alt + q.slice(m.index + m[0].length)))
        return false;
    return true;
  };
  return walk(p) ? out : null;
}

const segmentSensitive = (s: string) =>
  sensitiveName(s) || (GLOB.test(s) && globMaySensitive(s.toLowerCase()));

/** 路径（或命令里的一个词）是否命中敏感清单：任一段或文件名匹配；含通配符按保守口径。 */
export function isSensitive(p: string): boolean {
  const alts = expandBraces(p);
  if (alts === null) return true; // 展开超限：无法逐个确认，保守视为敏感
  return alts.some((q) =>
    q.split(/[\\/]/).filter(Boolean).some(segmentSensitive),
  );
}

/**
 * grep 的 glob / find 的 pattern 这类“文件选择器”是否可能选中敏感文件。
 * 纯 `*` 段（如 `**` 或 `*`）单独不算：它们本身不指名任何文件，否则常见的 `**\/*.ts` 会永远被拦。
 */
export function isSensitiveSelector(sel: string): boolean {
  const alts = expandBraces(sel);
  if (alts === null) return true;
  return alts.some((q) =>
    q
      .split(/[\\/]/)
      .filter((s) => s !== "" && !/^\*+$/.test(s))
      .some(segmentSensitive),
  );
}

/** 选择器是否指向 cwd 外：绝对路径、`~`、含 `..` 段。 */
export function selectorEscapes(sel: string): boolean {
  return (
    path.isAbsolute(sel) ||
    sel.startsWith("~") ||
    sel.split(/[\\/]/).includes("..")
  );
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * 在目录树内找首个敏感名条目（不跟随符号链接，最多看 limit 个条目）；
 * grep/find 不带选择器时会连隐藏文件一起读，用它判断是否会扫到敏感文件。超限视为有。
 */
export async function findSensitiveBelow(
  dir: string,
  env: PathEnv,
  limit = 5000,
): Promise<string | null> {
  const pm = pathOf(env);
  const queue = [dir];
  let seen = 0;
  for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
    let entries: Awaited<ReturnType<PathEnv["readdir"]>>;
    try {
      entries = await env.readdir(d);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > limit) return ".env";
      if (segmentSensitive(e.name)) return e.name;
      if (e.isDirectory && !SKIP_DIRS.has(e.name))
        queue.push(pm.join(d, e.name));
    }
  }
  return null;
}
