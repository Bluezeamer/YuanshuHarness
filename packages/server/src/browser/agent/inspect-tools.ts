// 检查类工具：读页面原始 DOM、看页面发出的网络请求，给快照查漏补缺。确定性读取、不经任何模型，因此不带 intent，也不写审计与回放。
// 以后的只读检查类工具（样式表一类）也放这里。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { DomTarget } from "../engine/types.js";
import {
  guarded,
  intArg,
  pageIdArg,
  refArg,
  stringArg,
  text,
  UNTRUSTED,
} from "./args.js";
import { presentBody } from "./body.js";
import type { BrowserToolsDeps } from "./deps.js";
import { renderDom } from "./dom-view.js";
import type { Kit } from "./kit.js";
import {
  filterNetwork,
  type NetworkFilters,
  renderBody,
  renderNetwork,
  renderRequest,
} from "./network-view.js";

/** 检查类工具：读页面原始 DOM、看页面发出的网络请求。 */
export function registerInspectTools(
  pi: Parameters<ExtensionFactory>[0],
  kit: Kit,
): void {
  const deps: BrowserToolsDeps = kit.deps;
  const sessionId = kit.sessionId;

  pi.registerTool({
    name: "browser_dom",
    label: "读取页面 DOM",
    description: `读页面原始 DOM（HTML 原貌），用来读快照读不到的东西：图片 / 视频 / 音频 / iframe 的地址、data-* 属性（懒加载的真地址常在这里）、表单的 action、<area> 热区、download 属性、隐藏元素。快照适合导航与操作（角色、名字、状态、链接地址），这个工具用来给它查漏补缺。selector（CSS；穿透 open shadow DOM，会在每个 iframe 里各查一遍）与 ref（快照编号，看这个元素的子树）二选一；都不给就是整个文档（通常很大，会存成附件，用读文件与搜索去分析）。每个元素一行、带全部属性，缩进表示层级；属性值超过 300 字符与 data: 地址会截短或写成说明。@ 开头是浏览器算出来的值：@box 是视口坐标（能直接当 browser_click / browser_move 的 x、y），@natural 是图片自然尺寸（1×1 或 0×0 多半是占位图），@src 是实际生效的地址。脚本正文、样式正文、svg 内部与 template 内容只给长度说明，注释丢掉，iframe 的内容不跟进去。不影响快照的对比基线。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        selector: {
          type: "string",
          maxLength: 500,
          description: "可选：CSS 选择器，如 img、a[download]（与 ref 二选一）",
        },
        ref: {
          type: "string",
          description: "可选：看这个元素的子树（最近一次快照里的编号，如 e12）",
        },
      },
      required: ["pageId"],
    } as never,
    async execute(_id, params) {
      const p = params as {
        pageId?: unknown;
        selector?: unknown;
        ref?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const raw = p.selector === undefined ? null : p.selector;
      if (raw !== null && (typeof raw !== "string" || raw.trim() === ""))
        throw new Error("selector 必须是非空的 CSS 选择器字符串");
      const selector: string | null = raw;
      const ref = p.ref === undefined ? null : refArg(p.ref);
      if (selector !== null && ref !== null)
        throw new Error(
          "selector 与 ref 只能给一个：要查一类元素给 selector，要看某个快照元素的子树给 ref",
        );
      const target: DomTarget =
        selector !== null ? { selector } : ref !== null ? { ref } : null;
      return guarded(async () => {
        const handle = await deps.registry.use(pageId, sessionId, "observe");
        const capture = await handle.dom(target);
        const view = renderDom(capture, {
          title: (await handle.title()) || "（无标题）",
          url: handle.url(),
          target,
        });
        if (!view.elided) return text(view.text);
        // 工具结果的文字有扩展统一遮罩，落文件的没有：这里自己遮一遍。
        const saved = await deps.saveAsset({
          sessionId,
          name: `dom-${pageId}.txt`,
          bytes: Buffer.from(deps.mask(view.full), "utf8"),
        });
        return text(`${view.text}\nFULL DOM: ${saved.marker}`);
      });
    },
  });

  pi.registerTool({
    name: "browser_network",
    label: "页面网络请求",
    description: `看这个页面发出过哪些网络请求（只读观察，不发送也不修改请求）。用来看滚动 / 点击之后页面又加载了什么（懒加载的图片、媒体、接口）、哪些请求失败了或返回 4xx / 5xx、页面背后调的是哪个接口。每页只留最近 500 条，按开始时间升序，每条带编号。可按 type（xhr / fetch / image / media / document / script / stylesheet / font / websocket / other）、url（子串）、failed（只看失败与 4xx / 5xx）、after（上次结果头里的 last id，只看更新的请求）过滤；给 id 看单条详情（完整的请求头与响应头），给 id 与 body（request / response）取请求体或响应体（文本内联预览，超长与二进制存成附件）。内容多时全文存成本会话的附件。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        type: {
          type: "string",
          description:
            "可选：只看这种资源类型，如 xhr、fetch、image、media、document、script、stylesheet、font、websocket、other",
        },
        url: {
          type: "string",
          maxLength: 300,
          description: "可选：只看地址里包含这段文字的请求（不分大小写）",
        },
        failed: {
          type: "boolean",
          description: "true 时只看失败的与返回 4xx / 5xx 的请求",
        },
        after: {
          type: "integer",
          minimum: 0,
          description: "可选：只看编号大于它的请求（传上次结果头里的 last id）",
        },
        id: {
          type: "integer",
          minimum: 1,
          description: "可选：看这一条请求的详情（给了它就忽略其余过滤）",
        },
        body: {
          type: "string",
          enum: ["request", "response"],
          description: "可选：取这一条请求的请求体或响应体（要与 id 一起给）",
        },
      },
      required: ["pageId"],
    } as never,
    async execute(_id, params) {
      const p = params as {
        pageId?: unknown;
        type?: unknown;
        url?: unknown;
        failed?: unknown;
        after?: unknown;
        id?: unknown;
        body?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      if (p.body !== undefined && p.body !== "request" && p.body !== "response")
        throw new Error(
          "body 只能是 request 或 response：要取请求体给 request，要取响应体给 response",
        );
      const which: "request" | "response" | undefined =
        p.body === undefined ? undefined : p.body;
      const id = intArg(p.id, "id", 1);
      if (which !== undefined && id === undefined)
        throw new Error("body 要和 id 一起给：先用列表找到请求编号");
      const type =
        p.type === undefined
          ? undefined
          : stringArg(p.type, "type", "如 xhr、image、document");
      const url =
        p.url === undefined
          ? undefined
          : stringArg(p.url, "url", "要匹配的地址片段，如 api");
      if (p.failed !== undefined && typeof p.failed !== "boolean")
        throw new Error(
          "failed 必须是布尔值：true 只看失败的与返回 4xx / 5xx 的请求",
        );
      const failed = p.failed === true ? true : undefined;
      const after = intArg(p.after, "after", 0);
      const filters: NetworkFilters = {
        ...(type === undefined ? {} : { type }),
        ...(url === undefined ? {} : { url }),
        ...(failed === undefined ? {} : { failed }),
        ...(after === undefined ? {} : { after }),
      };
      return guarded(async () => {
        // 不碰页面线程：对话框挂着时照常能读。
        const handle = await deps.registry.use(pageId, sessionId, "observe", {
          allowDialog: true,
        });
        const title = (await handle.title()) || "（无标题）";
        const where = { title, url: handle.url() };
        if (id !== undefined) {
          if (which !== undefined) {
            const content = await handle.networkBody(id, which);
            if (content === null)
              throw new Error(
                `没有编号为 ${id} 的请求：它可能已被挤出缓冲（每页只留最近 500 条）`,
              );
            if (!content.ok) throw new Error(content.reason);
            const info = await presentBody(deps, sessionId, {
              bytes: content.bytes,
              mime: content.mime,
              name: `network-${pageId}-${id}-${which}`,
            });
            return text(
              renderBody({ ...info, id, which, mime: content.mime }, where),
            );
          }
          const detail = await handle.networkDetail(id);
          if (detail === null)
            throw new Error(
              `没有编号为 ${id} 的请求：它可能已被挤出缓冲（每页只留最近 500 条）`,
            );
          return text(renderRequest(detail, where));
        }
        const entries = handle.network();
        const view = renderNetwork(filterNetwork(entries, filters), {
          ...where,
          total: entries.length,
          lastId: entries.at(-1)?.id ?? 0,
          evicted: handle.networkEvicted(),
          filters,
        });
        if (!view.elided) return text(view.text);
        // 工具结果的文字有扩展统一遮罩，落文件的没有：这里自己遮一遍。
        const saved = await deps.saveAsset({
          sessionId,
          name: `network-${pageId}.txt`,
          bytes: Buffer.from(deps.mask(view.full), "utf8"),
        });
        return text(`${view.text}\nFULL LOG: ${saved.marker}`);
      });
    },
  });
}
