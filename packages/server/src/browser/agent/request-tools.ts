// 开发调试类工具 browser_request：以页面所在浏览器上下文的身份自己发一次 HTTP 请求并看响应。
// 带上下文的 cookie 与代理出口（所以与页面里的请求同一个登录态、同一个出口）；重定向由这里逐跳发、逐跳授权。
// 不自动加任何头；非只读方法在高敏感站点要用户逐次确认；摘要里只写方法与主机。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HttpResult } from "../engine/types.js";
import { resolveTarget, type Target } from "../net/target.js";
import { guarded, pageIdArg, stringArg, text, UNTRUSTED } from "./args.js";
import { presentBody } from "./body.js";
import type { BrowserToolsDeps } from "./deps.js";
import type { Kit } from "./kit.js";
import {
  type RedirectHop,
  type RequestBody,
  renderRequest,
} from "./request-view.js";

const URL_MAX = 2_000;
const BODY_MAX = 200_000;
/** 最多自动跟随这么多跳重定向。 */
const REDIRECT_MAX = 10;
/** 命名身份的名字长度上限。 */
const IDENTITY_MAX = 40;
const METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
type Method = (typeof METHODS)[number];
// 不改远端状态的方法：不需要逐动作确认。
const READ_ONLY = new Set<Method>(["GET", "HEAD", "OPTIONS"]);
// 会被自动跟随的状态码；其余 3xx 原样当最终响应。
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const IDENTITY_PATTERN = /^[A-Za-z0-9_.-]+$/;

const URL_HINT =
  "要请求的地址，可以是相对地址（按页面地址解析），如 /api/items?limit=1";

function methodArg(v: unknown): Method {
  if (v === undefined) return "GET";
  if (typeof v === "string" && (METHODS as readonly string[]).includes(v))
    return v as Method;
  throw new Error(`method 只能是 ${METHODS.join("、")}，缺省 GET`);
}

/** 请求头：对象、值都是字符串；名字大小写不敏感，这里原样交给上下文。 */
function headersArg(v: unknown): Record<string, string> {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error(
      'headers 必须是对象，如 {"Content-Type": "application/json"}',
    );
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(v)) {
    if (typeof value !== "string")
      throw new Error(`headers 的 ${name} 必须是字符串（值不帮转成 JSON）`);
    out[name] = value;
  }
  return out;
}

function bodyArg(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error("body 必须是字符串");
  if (v.length > BODY_MAX)
    throw new Error(`body 最长 ${BODY_MAX} 个字符，现在 ${v.length} 个`);
  return v;
}

function followArg(v: unknown): boolean {
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new Error("follow 必须是布尔值");
  return v;
}

/** 命名身份：只许字母、数字、下划线、点与连字符（会出现在结果的 JAR 行里）。 */
function identityArg(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (
    typeof v !== "string" ||
    !IDENTITY_PATTERN.test(v) ||
    v.length > IDENTITY_MAX
  )
    throw new Error(
      `identity 只能用字母、数字、下划线、点与连字符，最长 ${IDENTITY_MAX} 个字符`,
    );
  return v;
}

/** 相对地址按页面地址解析；解析不了或不是 http(s) 就报错。 */
function absoluteUrl(raw: string, pageUrl: string): string {
  let url: URL;
  try {
    url = new URL(raw, pageUrl);
  } catch {
    throw new Error(
      `url 解析不了：${raw}（相对地址按页面地址解析，页面地址是 ${pageUrl}）`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`url 只支持 http 与 https，现在的是 ${url.protocol}`);
  return url.href;
}

const hostOf = (url: string): string => new URL(url).hostname;

/** 响应头里某个名字的第一个值（名字已小写）。 */
function headerOf(
  headers: [string, string][],
  name: string,
): string | undefined {
  return headers.find(([n]) => n === name)?.[1];
}

/** 开发调试类工具：browser_request。 */
export function registerRequestTools(
  pi: Parameters<ExtensionFactory>[0],
  kit: Kit,
): void {
  const deps: BrowserToolsDeps = kit.deps;
  const sessionId = kit.sessionId;

  pi.registerTool({
    name: "browser_request",
    label: "以页面身份发请求",
    description: `以这个页面所在浏览器上下文的身份自己发一次 HTTP 请求并看响应：带这个上下文的 cookie 与代理出口，所以与页面里的请求是同一个登录态、同一个出口；响应里的 Set-Cookie 也会写回这个上下文。用来重放接口、改参数测越权与校验、带登录态调 API。要看页面自己发了什么请求用 browser_network。不自动加任何头：Referer、Origin、Content-Type 这些要自己给（cookie 与代理由上下文负责）。缺省不跟随重定向，3xx 原样返回（含 Location），想跟就再发一次；follow 为 true 才自动跟随（最多 ${REDIRECT_MAX} 跳，每一跳都要过站点授权）。给 identity 就用一个与页面隔离的命名身份发（自己的 cookie 罐、同一个出口）：先用它登录，再拿它访问页面的资源看有没有越权。访问新站点要过与 browser_open 相同的站点授权；POST 等会改变远端状态的方法在高敏感站点要用户逐次确认。响应体文本内联前 4000 字符，更长或二进制存成附件。30 秒超时。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          minLength: 1,
          description: "借哪个页面的上下文（cookie、代理、相对地址的基准）",
        },
        url: {
          type: "string",
          minLength: 1,
          maxLength: URL_MAX,
          description: URL_HINT,
        },
        method: {
          type: "string",
          enum: [...METHODS],
          description: "可选：HTTP 方法，缺省 GET",
        },
        headers: {
          type: "object",
          description:
            "可选：请求头，值都是字符串；名字大小写不敏感。不会自动加任何头",
        },
        body: {
          type: "string",
          maxLength: BODY_MAX,
          description:
            "可选：请求体（GET 与 HEAD 不能带）；JSON 要自己写成字符串并给 Content-Type",
        },
        follow: {
          type: "boolean",
          description: `可选：true 时自动跟随重定向（最多 ${REDIRECT_MAX} 跳）；缺省 false，3xx 原样返回`,
        },
        identity: {
          type: "string",
          maxLength: IDENTITY_MAX,
          description:
            "可选：用一个与页面隔离的命名身份发（自己的 cookie 罐，同一出口）；只能字母、数字、下划线、点与连字符",
        },
      },
      required: ["pageId", "url"],
    } as never,
    async execute(_id, params) {
      const p = params as Record<string, unknown> & {
        pageId?: unknown;
        url?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const raw = stringArg(p.url, "url", URL_HINT);
      if (raw.length > URL_MAX)
        throw new Error(`url 最长 ${URL_MAX} 个字符，现在 ${raw.length} 个`);
      const method = methodArg(p.method);
      const headers = headersArg(p.headers);
      const body = bodyArg(p.body);
      if (body !== undefined && (method === "GET" || method === "HEAD"))
        throw new Error("GET 与 HEAD 不能带 body：要带 body 请用 POST 等方法");
      const follow = followArg(p.follow);
      const identity = identityArg(p.identity);

      return guarded(async () => {
        // 只借上下文：这个工具不碰页面线程，对话框挂着也能发。
        const handle = await deps.registry.use(pageId, sessionId, "observe", {
          allowDialog: true,
        });
        let currentUrl = absoluteUrl(raw, handle.url());
        let currentMethod: Method = method;
        // 头行写这次请求的起点；跟到哪去了看 REDIRECTS。
        const first = { url: currentUrl, method: currentMethod };
        let currentBody = body;
        const hops: RedirectHop[] = [];
        let stopped: string | null = null;
        let final: {
          url: string;
          method: Method;
          res: HttpResult & { ok: true };
        } | null = null;
        let previousHost: string | null = null;
        let totalMs = 0;

        for (;;) {
          // 解析阶段就被拒：第一跳原样抛给模型，跟随中的下一跳就停在这里。
          let target: Target;
          try {
            target = resolveTarget(currentUrl, deps.targetOptions());
          } catch (err) {
            if (final === null) throw err;
            stopped = err instanceof Error ? err.message : String(err);
            break;
          }
          // 每一跳都要过站点授权：第一跳被拒是错误，跟随中的下一跳被拒就停在这里。
          const no = await kit.authorize(target, currentUrl);
          if (no !== null) {
            if (final === null) throw new Error(no);
            stopped = no;
            break;
          }
          const host = hostOf(currentUrl);
          // 会改远端状态的方法：第一跳必确认，跟随到别的主机时再确认一次。
          if (
            !READ_ONLY.has(currentMethod) &&
            (final === null || host !== previousHost)
          )
            await kit.confirmAction(
              handle,
              "browser_request",
              `发送 ${currentMethod} 请求到 ${host}`,
              host,
            );
          const res = await handle.request({
            url: currentUrl,
            method: currentMethod,
            headers,
            ...(currentBody === undefined ? {} : { body: currentBody }),
            ...(identity === undefined ? {} : { identity }),
          });
          if (!res.ok) {
            // 网络层没有给响应：第一跳就失败是错误，跟随中失败就停在这里。
            if (final === null) throw new Error(res.reason);
            stopped = res.reason;
            break;
          }
          totalMs += res.ms;
          previousHost = host;
          final = { url: currentUrl, method: currentMethod, res };
          // 不跟随时不写 REDIRECTS：3xx 原样交给模型，想跟就再发一次。
          if (!follow) break;

          const location = headerOf(res.headers, "location");
          const redirect =
            REDIRECT_STATUS.has(res.status) && location !== undefined;
          // 最后一跳不写箭头：只有确实跟过去的那几跳才写去向。
          const hop: RedirectHop = {
            status: res.status,
            method: currentMethod,
            url: currentUrl,
          };
          hops.push(hop);
          if (!redirect) break;
          // hops 里已有的条数就是已经跟随过的跳数：到上限就不再发下一跳。
          if (hops.length > REDIRECT_MAX) {
            stopped = `已经跟随了 ${REDIRECT_MAX} 跳重定向，没有继续跟随`;
            break;
          }
          let next: string;
          try {
            next = new URL(location, currentUrl).href;
          } catch {
            // 下一跳地址解析不了：停在这一跳，把 Location 原样写出来。
            stopped = `下一跳的地址解析不了：${location}`;
            break;
          }
          hop.location = location;
          // 浏览器的规矩：301 / 302 / 303 把 POST 改成 GET 且不带 body，307 / 308 原样重发。
          if (
            (res.status === 301 || res.status === 302 || res.status === 303) &&
            currentMethod === "POST"
          ) {
            currentMethod = "GET";
            currentBody = undefined;
          }
          currentUrl = next;
        }

        if (final === null) throw new Error("没有发出请求");
        const { res } = final;
        await kit.acted(
          "browser_request",
          pageId,
          `${final.method} ${hostOf(final.url)}`,
        );

        const mime =
          (headerOf(res.headers, "content-type") ?? "").split(";")[0]?.trim() ??
          "";
        let presented: RequestBody | string;
        if (final.method === "HEAD") {
          presented = "BODY: none (HEAD)";
        } else if (res.bytes.length === 0) {
          presented = "BODY: empty";
        } else {
          try {
            presented = {
              mime,
              ...(await presentBody(deps, sessionId, {
                bytes: res.bytes,
                mime,
                name: `request-${pageId}`,
              })),
            };
          } catch (err) {
            // 存不上附件不能连状态与头一起丢掉。
            presented = `BODY: not saved — ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        return text(
          renderRequest(
            {
              pageId,
              method: first.method,
              url: first.url,
              ...(identity === undefined ? {} : { identity }),
              jar:
                identity === undefined
                  ? null
                  : await handle.identityCookies(identity),
              ms: totalMs,
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            },
            hops,
            stopped,
            presented,
          ),
        );
      });
    },
  });
}
