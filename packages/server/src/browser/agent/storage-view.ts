// Cookie 与 Web 存储 → 给模型看的文字与落文件的全文。纯函数：不碰工具与引擎，格式固定。
// 外壳是固定英文，值一律原样（开发调试用，会含会话令牌）；只看单条长度的上限。
import type {
  CookieInput,
  PageCookie,
  WebStorageEntry,
} from "../engine/types.js";
import { type Budgeted, budgetLines } from "./budget.js";

/** 单个 Cookie / 条目值的显示上限：超过就截，并标出剩下的字符数。 */
const VALUE_MAX = 2_000;

export interface StorageQuery {
  title: string;
  url: string;
}

type Kind = "local" | "session";

/** local / session 写成页面里那个对象的名字。 */
export function storageName(kind: Kind): string {
  return kind === "local" ? "localStorage" : "sessionStorage";
}

/** 值超过上限就截断并标出剩下的字符数。 */
function clip(value: string): string {
  if (value.length <= VALUE_MAX) return value;
  return `${value.slice(0, VALUE_MAX)}…(+${value.length - VALUE_MAX} chars)`;
}

/** 过期时间：Unix 秒取 UTC 到秒；会话 Cookie（-1）写 session。 */
function expiresText(expires: number): string {
  if (expires < 0) return "session";
  return `expires ${new Date(expires * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

/** 一行 Cookie：`#1 name  domain  path  expires|session  [httpOnly] [secure] SameSite=X  value: v`。 */
function cookieLine(cookie: PageCookie, n: number): string {
  const flags = [
    ...(cookie.httpOnly ? ["httpOnly"] : []),
    ...(cookie.secure ? ["secure"] : []),
    `SameSite=${cookie.sameSite}`,
  ];
  return [
    `#${n} ${cookie.name}`,
    cookie.domain,
    cookie.path,
    expiresText(cookie.expires),
    flags.join(" "),
    `value: ${clip(cookie.value)}`,
  ].join("  ");
}

/** Cookie 清单：头行 + COOKIES 计数 + 每行一个；没有就写 No cookies. */
export function renderCookies(
  cookies: readonly PageCookie[],
  query: StorageQuery & { scope: "page" | "all" },
): Budgeted {
  const head = [
    `STORAGE: cookies · scope ${query.scope}${query.scope === "page" ? ` (${query.url})` : ""} | ${query.title}`,
    `COOKIES: ${cookies.length}`,
  ];
  const body =
    cookies.length === 0
      ? ["No cookies."]
      : cookies.map((c, i) => cookieLine(c, i + 1));
  return budgetLines(head, body, "full list");
}

/** Web 存储清单：头行 + 每行一个 `#n key: value`；没有就写 No entries. */
export function renderStore(
  kind: Kind,
  entries: readonly WebStorageEntry[],
  query: { title: string; origin: string },
): Budgeted {
  const head = [
    `STORAGE: ${storageName(kind)} · ${query.origin} | ${query.title}`,
  ];
  const body =
    entries.length === 0
      ? ["No entries."]
      : entries.map((e, i) => `#${i + 1} ${e.key}: ${clip(e.value)}`);
  return budgetLines(head, body, "full list");
}

/** URL 形式的 Cookie 缺省 path 是它路径的目录（与浏览器一致）：`/app/x` → `/app/`。 */
export function defaultCookiePath(url: string): string {
  try {
    const dir = new URL(url).pathname.replace(/[^/]*$/, "");
    return dir === "" ? "/" : dir;
  } catch {
    return "/";
  }
}

/** 写操作的一行结果；只有地址与键名，不贴值。 */
export type StorageWrite =
  | {
      op: "set-cookie";
      cookie: CookieInput;
      /** URL 形式（没给 domain）时用来补出实际落下的 domain 与 path */
      pageUrl: string;
    }
  | { op: "del-cookie"; scope: "page" | "all"; removed: number }
  | { op: "set-store"; kind: Kind; key: string }
  | { op: "del-store"; kind: Kind; key: string; changed: number }
  | { op: "clear-store"; kind: Kind; changed: number };

/** 写操作的返回：一句，不贴值（值可能是会话令牌）。 */
export function renderStorageWrite(write: StorageWrite): string {
  if (write.op === "set-cookie") {
    const c = write.cookie;
    // path 的实际值：没给时，给了 domain 就是 /（引擎的缺省），没给 domain 是按地址推出来的目录。
    const path =
      c.path ??
      (c.domain === undefined ? defaultCookiePath(write.pageUrl) : "/");
    return `SET cookie ${c.name} (domain ${c.domain ?? hostOf(write.pageUrl)}, path ${path})`;
  }
  if (write.op === "del-cookie") {
    // 1 个写单数，其余写复数（包括 0）。
    const count = `${write.removed} ${write.removed === 1 ? "cookie" : "cookies"}`;
    return `DELETED ${count} (scope ${write.scope})`;
  }
  const name = storageName(write.kind);
  if (write.op === "set-store")
    return `SET ${name} key ${JSON.stringify(write.key)}`;
  if (write.op === "del-store")
    return write.changed > 0
      ? `DELETED ${name} key ${JSON.stringify(write.key)}`
      : `DELETED 0 entries from ${name} (key ${JSON.stringify(write.key)})`;
  return `CLEARED ${write.changed} entries from ${name}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
