// 开发调试类工具 browser_route：拦截并改写页面发出的网络请求（屏蔽、造假响应、改请求、改真实响应）。
// 规则挂在单个页面上、不持久化；add / remove / clear 走动作骨架（站点授权 → 高敏感站点确认 → 做事 → 审计）。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { RouteAction, RouteRule } from "../engine/types.js";
import { resolveTarget } from "../net/target.js";
import {
  guarded,
  intArg,
  pageIdArg,
  stringArg,
  text,
  UNTRUSTED,
} from "./args.js";
import type { BrowserToolsDeps } from "./deps.js";
import type { Kit } from "./kit.js";
import { renderRoutes, routeSummary } from "./route-view.js";

const PATTERN_MAX = 500;
const BODY_MAX = 200_000;
/** replace 最多几项，每项的 find / with 各多长。 */
const REPLACE_MAX = 20;
const PIECE_MAX = 10_000;
/** 与引擎的 DELAY_MAX_MS 一致（引擎也会再校验一次）。 */
const DELAY_MAX_MS = 10_000;

const OPS = ["add", "list", "remove", "clear"] as const;
type Op = (typeof OPS)[number];
const ACTIONS = ["block", "mock", "modify", "patch"] as const;
type ActionKind = (typeof ACTIONS)[number];

/** add 认的全部参数：其余 op 给了就报错（不静默忽略）。 */
const ADD_PARAMS = [
  "pattern",
  "action",
  "method",
  "type",
  "delayMs",
  "error",
  "status",
  "headers",
  "body",
  "url",
  "modifyMethod",
  "replace",
] as const;

/** 每种动作自己的参数：别处给的就是错，报错时按这里说明它归谁。 */
const OWNER: Record<string, string> = {
  error: "error 只用于 block（Playwright 的 errorCode）",
  status: "status 只用于 mock 与 patch",
  headers: "headers 只用于 mock、modify 与 patch",
  body: "body 只用于 mock（造响应体）与 modify（改请求体）",
  url: "url 只用于 modify（改成别的地址）",
  modifyMethod: "modifyMethod 只用于 modify（改请求方法）",
  replace: "replace 只用于 patch（在真实响应体里做文字替换）",
};

const ALLOWED: Record<ActionKind, ReadonlySet<string>> = {
  block: new Set(["error"]),
  mock: new Set(["status", "headers", "body"]),
  modify: new Set(["url", "modifyMethod", "body", "headers"]),
  patch: new Set(["status", "headers", "replace"]),
};

function opArg(v: unknown): Op {
  if (v === undefined) return "list";
  if (typeof v === "string" && (OPS as readonly string[]).includes(v))
    return v as Op;
  throw new Error(`op 只能是 ${OPS.join("、")}，缺省 list`);
}

function actionArg(v: unknown): ActionKind {
  if (v === undefined)
    throw new Error(`add 要给 action：${ACTIONS.join("、")} 之一`);
  if (typeof v === "string" && (ACTIONS as readonly string[]).includes(v))
    return v as ActionKind;
  throw new Error(`action 只能是 ${ACTIONS.join("、")} 之一`);
}

function patternArg(v: unknown): string {
  const raw = stringArg(v, "pattern", "要拦的地址 glob，如 **/api/**");
  if (raw === "")
    throw new Error("pattern 不能是空串：写要拦的地址 glob，如 **/api/**");
  if (raw.length > PATTERN_MAX)
    throw new Error(
      `pattern 最长 ${PATTERN_MAX} 个字符，现在 ${raw.length} 个`,
    );
  return raw;
}

function delayArg(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (
    typeof v !== "number" ||
    !Number.isInteger(v) ||
    v < 0 ||
    v > DELAY_MAX_MS
  )
    throw new Error(`delayMs 必须是 0–${DELAY_MAX_MS} 的整数（毫秒）`);
  return v;
}

function statusArg(v: unknown, fallback?: number): number | undefined {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 100 || v > 599)
    throw new Error("status 必须是 100–599 的整数，如 500");
  return v;
}

function bodyArg(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error("body 必须是字符串");
  if (v.length > BODY_MAX)
    throw new Error(`body 最长 ${BODY_MAX} 个字符，现在 ${v.length} 个`);
  return v;
}

/** 请求头 / 响应头：值都是字符串。 */
function plainHeaders(v: unknown): Record<string, string> {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error(
      'headers 必须是对象，如 {"Content-Type": "application/json"}',
    );
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(v)) {
    if (name === "") throw new Error("headers 的头名不能是空串");
    if (typeof value !== "string")
      throw new Error(
        `headers 的 ${name} 必须是字符串：mock 的 headers 是要造出来的响应头`,
      );
    out[name] = value;
  }
  return out;
}

/** 要改的头：值为 null 表示删掉这个头（只有 modify 与 patch 允许）。 */
function headerChanges(v: unknown): Record<string, string | null> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error(
      'headers 必须是对象，如 {"X-Trace-ID": "t1", "X-Debug": null}',
    );
  const out: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(v)) {
    if (name === "") throw new Error("headers 的头名不能是空串");
    if (value !== null && typeof value !== "string")
      throw new Error(
        `headers 的 ${name} 必须是字符串，或 null 表示删掉这个头`,
      );
    out[name] = value;
  }
  return out;
}

function replaceArg(v: unknown): { find: string; with: string }[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v))
    throw new Error(
      'replace 必须是数组，如 [{"find": "旧文字", "with": "新文字"}]',
    );
  if (v.length > REPLACE_MAX)
    throw new Error(`replace 最多 ${REPLACE_MAX} 项，现在 ${v.length} 项`);
  return v.map((item, at) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new Error(
        `replace 第 ${at + 1} 项要是 {"find": "...", "with": "..."} 对象`,
      );
    const { find, with: to } = item as { find?: unknown; with?: unknown };
    const from = stringArg(
      find,
      `replace 第 ${at + 1} 项的 find`,
      "要替换的文字",
    );
    const into = stringArg(
      to,
      `replace 第 ${at + 1} 项的 with`,
      "替换成的文字（可以是空串）",
    );
    if (from.length > PIECE_MAX || into.length > PIECE_MAX)
      throw new Error(
        `replace 每项的 find 与 with 最长 ${PIECE_MAX} 个字符，第 ${at + 1} 项太长了`,
      );
    return { find: from, with: into };
  });
}

/** 动作参数 → RouteAction；缺的项按动作的缺省补齐，不许给无关的项。 */
function actionOf(kind: ActionKind, p: Record<string, unknown>): RouteAction {
  const extra = Object.keys(OWNER).filter(
    (k) => !ALLOWED[kind].has(k) && p[k] !== undefined,
  );
  if (extra.length > 0)
    throw new Error(
      `${kind} 不用 ${extra.join("、")}：${extra.map((k) => OWNER[k]).join("；")}`,
    );
  if (kind === "block") {
    const error =
      p.error === undefined
        ? undefined
        : stringArg(
            p.error,
            "error",
            "如 failed、blockedbyclient、connectionrefused",
          );
    return { kind, ...(error === undefined ? {} : { error }) };
  }
  if (kind === "mock")
    return {
      kind,
      status: statusArg(p.status, 200) ?? 200,
      headers: plainHeaders(p.headers),
      body: bodyArg(p.body) ?? "",
    };
  if (kind === "modify") {
    const url =
      p.url === undefined
        ? undefined
        : stringArg(p.url, "url", "要改成的新地址，写完整的 http(s) 地址");
    const method =
      p.modifyMethod === undefined
        ? undefined
        : stringArg(p.modifyMethod, "modifyMethod", "要改成的方法，如 POST")
            .trim()
            .toUpperCase();
    if (method === "") throw new Error("modifyMethod 不能是空串");
    const body = bodyArg(p.body);
    const headers = headerChanges(p.headers);
    if (
      url === undefined &&
      method === undefined &&
      body === undefined &&
      headers === undefined
    )
      throw new Error(
        "modify 没有要改的内容：url、modifyMethod、body、headers 至少给一项",
      );
    return {
      kind,
      ...(method === undefined ? {} : { method }),
      ...(url === undefined ? {} : { url }),
      ...(body === undefined ? {} : { body }),
      ...(headers === undefined ? {} : { headers }),
    };
  }
  const status = statusArg(p.status);
  const headers = headerChanges(p.headers);
  const replace = replaceArg(p.replace);
  if (status === undefined && headers === undefined && replace === undefined)
    throw new Error(
      "patch 没有要改的内容：status、headers、replace 至少给一项",
    );
  return {
    kind,
    ...(status === undefined ? {} : { status }),
    ...(headers === undefined ? {} : { headers }),
    ...(replace === undefined ? {} : { replace }),
  };
}

/** 开发调试类工具：browser_route。 */
export function registerRouteTools(
  pi: Parameters<ExtensionFactory>[0],
  kit: Kit,
): void {
  const { confirmAction, acted } = kit;
  const deps: BrowserToolsDeps = kit.deps;
  const sessionId = kit.sessionId;

  pi.registerTool({
    name: "browser_route",
    label: "拦截并改写网络请求",
    description: `拦截并改写这个页面发出的网络请求（开发调试用）：屏蔽第三方脚本与图片、让接口返回 500 / 超时 / 假数据看页面怎么反应、给请求加删头（认证头、X-Forwarded-For）或改请求体、在真实响应上做文字替换（例如去掉 Content-Security-Policy）。规则挂在这个页面上，按 URL glob 匹配（** 跨路径、* 不跨 /），可再按 method 与资源类型（type）限定；delayMs（0–10000）先等这么久再处理，用来造慢响应。op 缺省 list：add 加一条、remove 删一条、list 列出全部（带每条命中过多少请求）、clear 清空。四种动作：block 让请求失败（error 缺省 failed，也可以是 blockedbyclient / connectionrefused 这类 Playwright errorCode）；mock 不发请求、直接给造出来的响应（status 缺省 200、headers、body）；modify 改写请求再发出去（modifyMethod 改方法、url 改成同协议的别的地址、body 改请求体、headers 里值为 null 表示删掉这个头，没列的头保持原样；Cookie、Host 这类浏览器自己管的头不保证改得动，改 Cookie 用 browser_storage）；patch 照常发出请求、改写真实的响应（status 改状态码、headers 里 null 删头、replace 是 [{find, with}] 字面量替换，只对文本响应体生效、全部出现处都换）。多条规则时后加的先匹配，命中并处理后就不再往下传。规则只在这个页面存活：页面关闭、或休眠后重新唤醒就没了（不持久化），每页最多 20 条。开着规则期间浏览器对这个页面的 HTTP 缓存失效（Playwright 的限制）。效果用 browser_network 看（list 里的 hits 是命中次数）。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        op: {
          type: "string",
          enum: [...OPS],
          description:
            "缺省 list：add 加一条、remove 删一条、list 列出现有的、clear 清空",
        },
        pattern: {
          type: "string",
          maxLength: PATTERN_MAX,
          description:
            "add 必填：要拦的地址 glob（Playwright 语法），如 **/api/**、https://x.test/*.png",
        },
        action: {
          type: "string",
          enum: [...ACTIONS],
          description:
            "add 必填：block 让请求失败、mock 造一个响应、modify 改写请求、patch 改写真实响应",
        },
        method: {
          type: "string",
          description: "可选：只拦这个方法（如 GET、POST），缺省不限",
        },
        type: {
          type: "string",
          description:
            "可选：只拦这种资源类型（Playwright 的 resourceType：document / script / xhr / fetch / image …），缺省不限",
        },
        delayMs: {
          type: "integer",
          minimum: 0,
          maximum: DELAY_MAX_MS,
          description: "可选：处理前先等这么多毫秒（0–10000），用来造慢响应",
        },
        error: {
          type: "string",
          description: "block 用：Playwright 的 errorCode，缺省 failed",
        },
        status: {
          type: "integer",
          minimum: 100,
          maximum: 599,
          description:
            "mock 用：造出来的响应状态码（缺省 200）；patch 用：改成这个状态码",
        },
        headers: {
          type: "object",
          description:
            "mock 用：响应头（值都是字符串）；modify / patch 用：要设置的头，值为 null 表示删掉这个头",
        },
        body: {
          type: "string",
          maxLength: BODY_MAX,
          description:
            "mock 用：造出来的响应体（缺省空串）；modify 用：改成的请求体",
        },
        url: {
          type: "string",
          description:
            "modify 用：把请求改到别的地址（要写完整的 http(s) 地址，同协议）",
        },
        modifyMethod: {
          type: "string",
          description: "modify 用：把请求方法改成这个（如 POST）",
        },
        replace: {
          type: "array",
          maxItems: REPLACE_MAX,
          description:
            "patch 用：在真实响应体里做字面量替换（全部出现处），如 [{find, with}]",
        },
      },
      required: ["pageId"],
    } as never,
    async execute(_id, params) {
      const p = params as Record<string, unknown> & { pageId?: unknown };
      const pageId = pageIdArg(p.pageId);
      const op = opArg(p.op);

      if (op === "list" || op === "clear") {
        const given = [...ADD_PARAMS, "id"].filter((k) => p[k] !== undefined);
        if (given.length > 0)
          throw new Error(
            `${op} 不用 ${given.join("、")}：${op === "list" ? "list 只看现有规则，要加规则用 op=add" : "clear 清掉全部规则，要删一条用 op=remove"}`,
          );
      }
      if (op === "add" && p.id !== undefined)
        throw new Error(
          "add 只用规则参数：id 由引擎分配，要删规则用 op=remove",
        );
      if (op === "remove") {
        const given = ADD_PARAMS.filter((k) => p[k] !== undefined);
        if (given.length > 0)
          throw new Error(
            `remove 只用 id：${given.join("、")} 用不上，要加规则用 op=add`,
          );
      }
      if (op === "remove" && p.id === undefined)
        throw new Error("remove 要给 id：先用 op=list 看规则编号");
      const rule: RouteRule | null =
        op === "add"
          ? {
              pattern: patternArg(p.pattern),
              action: actionOf(actionArg(p.action), p),
              ...(p.method === undefined
                ? {}
                : {
                    method: stringArg(
                      p.method,
                      "method",
                      "如 GET、POST",
                    ).toUpperCase(),
                  }),
              ...(p.type === undefined
                ? {}
                : { type: stringArg(p.type, "type", "如 xhr、image、script") }),
              ...(p.delayMs === undefined
                ? {}
                : { delayMs: delayArg(p.delayMs) as number }),
            }
          : null;
      const removeId =
        op === "remove" ? (intArg(p.id, "id", 1) as number) : undefined;

      // 改地址的规则把请求发到别处：与 browser_request 走同一套站点授权。
      const targetUrl =
        rule?.action.kind === "modify" ? rule.action.url : undefined;
      if (targetUrl !== undefined && !/^https?:\/\//i.test(targetUrl))
        throw new Error("modify 的 url 要写完整的 http(s) 地址");

      return guarded(async () => {
        if (op === "list") {
          // 规则表是内存里的，不碰页面线程，对话框挂着也能读。
          const handle = await deps.registry.use(pageId, sessionId, "observe", {
            allowDialog: true,
          });
          return text(
            renderRoutes(handle.routeList(), {
              title: (await handle.title()) || "（无标题）",
              url: handle.url(),
            }),
          );
        }

        const handle = await deps.registry.use(pageId, sessionId, "act");
        if (op === "add" && rule !== null) {
          if (targetUrl !== undefined) {
            // 解析阶段就被拒的地址原样抛给模型；过不了站点授权就不登记规则。
            const target = resolveTarget(targetUrl, deps.targetOptions());
            const no = await kit.authorize(target, targetUrl);
            if (no !== null) throw new Error(no);
          }
          const summary = `添加拦截规则 ${rule.action.kind} ${rule.pattern}`;
          await confirmAction(handle, "browser_route", summary);
          const info = await handle.routeAdd(rule);
          await acted("browser_route", pageId, summary);
          return text(`ADDED rule #${info.id}: ${routeSummary(info)}`);
        }
        if (op === "remove" && removeId !== undefined) {
          const summary = `删除拦截规则 #${removeId}`;
          await confirmAction(handle, "browser_route", summary);
          if (!(await handle.routeRemove(removeId)))
            throw new Error(`没有编号为 ${removeId} 的规则`);
          await acted("browser_route", pageId, summary);
          return text(`REMOVED rule #${removeId}`);
        }
        const summary = "清空拦截规则";
        await confirmAction(handle, "browser_route", summary);
        const cleared = await handle.routeClear();
        await acted("browser_route", pageId, summary);
        return text(`CLEARED ${cleared} rules`);
      });
    },
  });
}
