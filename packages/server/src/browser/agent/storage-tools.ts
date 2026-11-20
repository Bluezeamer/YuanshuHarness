// 开发调试类工具 browser_storage：读写 Cookie（含 HttpOnly 与各属性）与 localStorage / sessionStorage。
// get 只读观察；set / delete / clear 走动作骨架（租约 → 高敏感站点确认 → 做事 → 审计与回放），摘要里不放值。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CookieInput } from "../engine/types.js";
import { guarded, pageIdArg, stringArg, text, UNTRUSTED } from "./args.js";
import type { Budgeted } from "./budget.js";
import type { BrowserToolsDeps } from "./deps.js";
import type { Kit } from "./kit.js";
import {
  renderCookies,
  renderStorageWrite,
  renderStore,
  type StorageWrite,
  storageName,
} from "./storage-view.js";

/** set 的值上限（字符）。 */
const VALUE_MAX = 100_000;

const KINDS = ["cookies", "local", "session"] as const;
const OPS = ["get", "set", "delete", "clear"] as const;
const SCOPES = ["page", "all"] as const;
const SAME_SITES = ["Strict", "Lax", "None"] as const;
type SameSite = (typeof SAME_SITES)[number];
type Store = "local" | "session";

/** Cookie 的属性：只对 cookies 的 set 有意义。 */
const COOKIE_ATTRS = [
  "domain",
  "path",
  "expires",
  "httpOnly",
  "secure",
  "sameSite",
] as const;

const COOKIE_ATTRS_TEXT =
  "domain、path、expires、httpOnly、secure、sameSite 只对 kind=cookies 的 set 有意义";

/** 枚举参数：不传用缺省，传了必须是给定值之一。 */
function enumArg<T extends string>(
  v: unknown,
  name: string,
  values: readonly T[],
  fallback: T,
  hint: string,
): T {
  if (v === undefined) return fallback;
  if (typeof v === "string" && (values as readonly string[]).includes(v))
    return v as T;
  throw new Error(`${name} 只能是 ${hint}`);
}

/** Cookie 属性的可选参数；类型不对就报错。 */
function cookieAttrs(
  p: Record<string, unknown>,
): Omit<CookieInput, "name" | "value"> {
  if (p.domain !== undefined && typeof p.domain !== "string")
    throw new Error("domain 必须是字符串，如 example.com");
  if (p.path !== undefined && typeof p.path !== "string")
    throw new Error("path 必须是字符串，如 /app");
  if (
    p.expires !== undefined &&
    (typeof p.expires !== "number" || !Number.isFinite(p.expires))
  )
    throw new Error("expires 必须是 Unix 秒（数字）；要会话 Cookie 就不要给");
  if (p.httpOnly !== undefined && typeof p.httpOnly !== "boolean")
    throw new Error("httpOnly 必须是布尔值");
  if (p.secure !== undefined && typeof p.secure !== "boolean")
    throw new Error("secure 必须是布尔值");
  if (
    p.sameSite !== undefined &&
    !(
      typeof p.sameSite === "string" &&
      (SAME_SITES as readonly string[]).includes(p.sameSite)
    )
  )
    throw new Error("sameSite 只能是 Strict、Lax、None");
  return {
    ...(p.domain === undefined ? {} : { domain: p.domain as string }),
    ...(p.path === undefined ? {} : { path: p.path as string }),
    ...(p.expires === undefined ? {} : { expires: p.expires as number }),
    ...(p.httpOnly === undefined ? {} : { httpOnly: p.httpOnly as boolean }),
    ...(p.secure === undefined ? {} : { secure: p.secure as boolean }),
    ...(p.sameSite === undefined ? {} : { sameSite: p.sameSite as SameSite }),
  };
}

/** 开发调试类工具：browser_storage。 */
export function registerStorageTools(
  pi: Parameters<ExtensionFactory>[0],
  kit: Kit,
): void {
  const { confirmAction, acted } = kit;
  const deps: BrowserToolsDeps = kit.deps;
  const sessionId = kit.sessionId;

  pi.registerTool({
    name: "browser_storage",
    label: "读写 Cookie 与 Web 存储",
    description: `读写 Cookie（含 HttpOnly、Secure、SameSite、过期时间等属性：页面脚本读不到的 HttpOnly Cookie 也能读）与 localStorage / sessionStorage（主 frame 当前源）。kind 选 cookies、local 或 session；op 缺省 get：get 列出全部（给 name 就只列这一个，Cookie 与存储键都适用），set 要 name 与 value，delete 要 name，clear 清掉整个范围。Cookie 的 scope 缺省 page（当前页面地址会带上的那些），all 是这个工作区浏览器里的全部 Cookie；set 的 domain 缺省按当前页面地址设置。值原样返回，含会话令牌等敏感内容（开发调试用）。IndexedDB 与 Cache Storage 用 browser_exec 读。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        kind: {
          type: "string",
          enum: [...KINDS],
          description:
            "cookies、local（localStorage）或 session（sessionStorage）",
        },
        op: {
          type: "string",
          enum: [...OPS],
          description: "缺省 get：get 读、set 写、delete 删一个、clear 清空",
        },
        name: {
          type: "string",
          description:
            "可选：Cookie 名或存储键；get 时只列这一个，set / delete 必给，clear 不要给",
        },
        value: {
          type: "string",
          maxLength: VALUE_MAX,
          description: "set 要写的值（可以是空串，最长 100000 字符）",
        },
        scope: {
          type: "string",
          enum: [...SCOPES],
          description:
            "可选：只对 cookies 的 get / delete / clear 有意义；缺省 page（当前页面地址会带上的），all 是这个工作区浏览器里的全部",
        },
        domain: {
          type: "string",
          description:
            "可选：Cookie 的域（只对 cookies 的 set 有意义）；缺省按当前页面地址",
        },
        path: {
          type: "string",
          description: "可选：Cookie 的路径（只对 cookies 的 set 有意义）",
        },
        expires: {
          type: "number",
          description: "可选：过期时间（Unix 秒）；缺省是会话 Cookie",
        },
        httpOnly: { type: "boolean", description: "可选：Cookie 的 HttpOnly" },
        secure: { type: "boolean", description: "可选：Cookie 的 Secure" },
        sameSite: {
          type: "string",
          enum: [...SAME_SITES],
          description: "可选：Cookie 的 SameSite",
        },
      },
      required: ["pageId", "kind"],
    } as never,
    async execute(_id, params) {
      const p = params as Record<string, unknown> & { pageId?: unknown };
      const pageId = pageIdArg(p.pageId);
      const kind = enumArg(
        p.kind,
        "kind",
        KINDS,
        "cookies",
        "cookies、local 或 session（必填）",
      );
      if (p.kind === undefined)
        throw new Error("kind 必填：cookies、local 或 session");
      const op = enumArg(p.op, "op", OPS, "get", "get、set、delete 或 clear");
      const scope = enumArg(
        p.scope,
        "scope",
        SCOPES,
        "page",
        "page 或 all；只对 cookies 有意义",
      );
      const name =
        p.name === undefined
          ? undefined
          : stringArg(p.name, "name", "Cookie 名或存储键");
      const value =
        p.value === undefined
          ? undefined
          : stringArg(p.value, "value", "set 要写的值");

      if (op === "set" && name === undefined)
        throw new Error("set 要给 name：要写哪个 Cookie 或哪个存储键");
      if (op === "delete" && name === undefined)
        throw new Error("delete 要给 name：要删哪个 Cookie 或哪个存储键");
      if (op === "set" && value === undefined)
        throw new Error("set 要给 value（可以是空串）：要写进去的值");
      if (op === "clear" && name !== undefined)
        throw new Error("clear 清掉整个范围，不要给 name；要删一个用 delete");
      const store: Store | null = kind === "cookies" ? null : kind;
      // 非 cookies 的 kind 给了 Cookie 与 scope 的字段就报错，不静默忽略。
      if (store !== null) {
        const given = COOKIE_ATTRS.filter((k) => p[k] !== undefined);
        if (given.length > 0)
          throw new Error(
            `${given.join("、")} 只能跟 kind=cookies 一起给：${COOKIE_ATTRS_TEXT}，${storageName(store)} 没有这些属性`,
          );
        if (p.scope !== undefined)
          throw new Error(
            "scope 只对 kind=cookies 有意义：Cookie 分当前页面的与整个浏览器的，Web 存储没有这个区分",
          );
      }
      const cookie: CookieInput | null =
        kind === "cookies" &&
        op === "set" &&
        name !== undefined &&
        value !== undefined
          ? { name, value, ...cookieAttrs(p) }
          : null;

      return guarded(async () => {
        // get 只读：不确认、不写审计与回放。
        if (op === "get") {
          const handle = await deps.registry.use(pageId, sessionId, "observe");
          const title = (await handle.title()) || "（无标题）";
          let view: Budgeted;
          if (store !== null) {
            const out = await handle.webStorage(
              store,
              name === undefined ? { op: "get" } : { op: "get", key: name },
            );
            view = renderStore(store, out.entries, {
              title,
              origin: originOf(handle.url()),
            });
          } else {
            const all = await handle.cookies(scope);
            const shown =
              name === undefined ? all : all.filter((c) => c.name === name);
            view = renderCookies(shown, { title, url: handle.url(), scope });
          }
          if (!view.elided) return text(view.text);
          // 工具结果的文字有扩展统一遮罩，落文件的没有：这里自己遮一遍。
          const saved = await deps.saveAsset({
            sessionId,
            name: `storage-${pageId}.txt`,
            bytes: Buffer.from(deps.mask(view.full), "utf8"),
          });
          return text(`${view.text}\nFULL LIST: ${saved.marker}`);
        }

        // 写操作：过租约、问高敏感站点、做事、记审计与回放。摘要里不放值。
        const handle = await deps.registry.use(pageId, sessionId, "act");
        let summary: string;
        let write: StorageWrite;
        if (store !== null) {
          const key = name ?? "";
          summary =
            op === "set"
              ? `写入 ${storageName(store)} 键 ${key}`
              : op === "delete"
                ? `删除 ${storageName(store)} 键 ${key}`
                : `清空 ${storageName(store)}`;
          await confirmAction(handle, "browser_storage", summary);
          const out = await handle.webStorage(
            store,
            op === "set"
              ? { op: "set", key, value: value ?? "" }
              : op === "delete"
                ? { op: "delete", key }
                : { op: "clear" },
          );
          await acted("browser_storage", pageId, summary);
          write =
            op === "set"
              ? { op: "set-store", kind: store, key }
              : op === "delete"
                ? { op: "del-store", kind: store, key, changed: out.changed }
                : { op: "clear-store", kind: store, changed: out.changed };
        } else if (cookie !== null) {
          summary = `写入 cookie ${cookie.name}`;
          await confirmAction(handle, "browser_storage", summary);
          await handle.setCookie(cookie);
          await acted("browser_storage", pageId, summary);
          write = { op: "set-cookie", cookie, pageUrl: handle.url() };
        } else {
          summary =
            name === undefined
              ? `清空 cookies（${scope}）`
              : `删除 cookie ${name}`;
          await confirmAction(handle, "browser_storage", summary);
          const removed = await handle.removeCookies(scope, name);
          await acted("browser_storage", pageId, summary);
          write = {
            op: "del-cookie",
            scope,
            removed,
          };
        }
        return text(renderStorageWrite(write));
      });
    },
  });
}

/** 主 frame 的源；解析不了就原样给地址。 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
