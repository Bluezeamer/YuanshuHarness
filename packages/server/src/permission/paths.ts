// 路径解析与敏感路径判定（ADR-0030）。
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * 相对 cwd 解析并解析符号链接；尚不存在的路径取最近已存在祖先的真实路径再拼回尾部。
 * 悬空链接、循环链接、权限等任何无法可靠解析的情况返回 null，调用方须按 cwd 外处理（不放行）。
 */
export function resolveTarget(raw: string, cwd: string): string | null {
  let p = raw.startsWith("@") ? raw.slice(1) : raw;
  if (p === "~" || p.startsWith("~/")) p = path.join(homedir(), p.slice(1));
  const abs = path.resolve(cwd, p);
  let head = abs;
  const tail: string[] = [];
  // 用 lstat 而非 existsSync：悬空链接本身也算“存在”，交给 realpath 判失败
  for (;;) {
    try {
      lstatSync(head);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const up = path.dirname(head);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || up === head) return null;
      tail.unshift(path.basename(head));
      head = up;
    }
  }
  try {
    return path.join(realpathSync(head), ...tail);
  } catch {
    return null;
  }
}

/** p 是否在 dir 内（含自身）；二者都应已解析。 */
export function isInside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
