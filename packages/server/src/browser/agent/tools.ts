// agent 看得见的浏览器工具（动作类在 act-tools.ts，资源类在 assets-tools.ts，观察类在 observe-tools.ts，检查类在 inspect-tools.ts，开发调试类在 exec-tools.ts / storage-tools.ts / emulate-tools.ts / cdp-tools.ts，接管与展示在 handoff-tools.ts）。页面归工作区、操作权与休眠都在 pages/registry，这里只做
// 「翻译模型参数 → 注册表调用 → 压缩层的快照」这一层；权限与站点授权由注入的 access / approveOpen 决定。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { denyText } from "../net/proxy.js";
import { resolveTarget, type Target } from "../net/target.js";
import type { PageView } from "../pages/types.js";
import { registerActTools } from "./act-tools.js";
import {
  DOWNLOAD_HINT,
  guarded,
  INTENT_DESCRIPTION,
  intentArg,
  pageIdArg,
  stringArg,
  text,
  UNTRUSTED,
} from "./args.js";
import { registerAssetTools } from "./assets-tools.js";
import { registerCdpTools } from "./cdp-tools.js";
import type { BrowserToolsDeps } from "./deps.js";
import { registerEmulateTools } from "./emulate-tools.js";
import { registerExecTools } from "./exec-tools.js";
import { registerHandoffTools } from "./handoff-tools.js";
import { registerInspectTools } from "./inspect-tools.js";
import { createKit } from "./kit.js";
import { registerObserveTools } from "./observe-tools.js";
import { registerRequestTools } from "./request-tools.js";
import { registerRouteTools } from "./route-tools.js";
import { registerStorageTools } from "./storage-tools.js";

/** 工具名与顺序即权限层与目录里的名单，S5 切换时用它替换旧名单。 */
export const BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_pages",
  "browser_close",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_dialog",
  "browser_move",
  "browser_scroll",
  "browser_drag",
  "browser_nav",
  "browser_upload",
  "browser_screenshot",
  "browser_console",
  "browser_assets",
  "browser_dom",
  "browser_network",
  "browser_exec",
  "browser_storage",
  "browser_request",
  "browser_route",
  "browser_emulate",
  "browser_cdp",
  "browser_handoff",
  "browser_show",
] as const;

// 一行一个页面：编号、标题、地址、状态、操作者、与本会话的关系。
function pageLine(page: PageView, sessionId: string): string {
  const flags = [
    page.state === "active" ? "激活" : "休眠",
    page.controller === "user" ? "用户操作" : "agent 操作",
    ...(page.handoffPending ? ["等用户接管"] : []),
    ...(page.dialog === null ? [] : [`DIALOG: ${page.dialog.type}`]),
    ...(page.usedBy.includes(sessionId) ? ["本会话用过"] : []),
  ];
  const title = page.title === "" ? "（无标题）" : page.title;
  return `${page.id} · ${title} · ${page.url}（${flags.join("，")}）`;
}

export function browserTools(
  deps: BrowserToolsDeps,
  sessionId: string,
): ExtensionFactory {
  const openNew = async (workspaceKey: string, url: string) => {
    const { page, status, deny } = await deps.registry.open({
      workspaceKey,
      actor: sessionId,
      url,
    });
    return { pageId: page.id, status, deny };
  };

  const navigate = async (pageId: string, url: string) => {
    const handle = await deps.registry.use(pageId, sessionId, "act");
    const res = await handle.goto(url);
    return { pageId, status: res.status, deny: res.deny };
  };

  // 动作类工具在 act-tools.ts，共用同一个 kit（审计、下载窗口、确认）。
  const kit = createKit(deps, sessionId);
  const { acted, authorize, content, withDownloads } = kit;

  return (pi) => {
    pi.registerTool({
      name: "browser_open",
      label: "打开网页",
      description: `在浏览器里打开一个地址，返回页面内容（默认是页面概览）。target 可以是网址（要带 http:// 或 https://）、绝对文件路径、或 host:port（本工作区与各环境的服务）。host 取 list_directories 里的主机名，local 是主目录所在的主机；裸 localhost:port 不接受。给了 pageId 就在那个页面里导航，不给就新开一个页面。访问外部站点、或打开没在命令输出里出现过的端口服务，需要用户批准。${UNTRUSTED}${DOWNLOAD_HINT}`,
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            minLength: 1,
            maxLength: 4096,
            description:
              "网址、绝对文件路径、或 host:port（host 见 list_directories，local 是主目录所在的主机）",
          },
          pageId: {
            type: "string",
            description: "可选：在这个已有页面里导航；不给就新开页面",
          },
          intent: {
            type: "string",
            maxLength: 500,
            description: INTENT_DESCRIPTION,
          },
        },
        required: ["target"],
      } as never,
      async execute(_id, params, signal) {
        const p = params as {
          target?: unknown;
          pageId?: unknown;
          intent?: unknown;
        };
        const raw = stringArg(
          p.target,
          "target",
          "网址要带 http:// 或 https://；文件用绝对路径或 host:/绝对路径；服务写 host:port（host 见 list_directories；裸 localhost 不接受）",
        );
        const pageId = p.pageId === undefined ? null : pageIdArg(p.pageId);
        const intent = intentArg(p.intent);
        return guarded(async () => {
          const target: Target = resolveTarget(raw, deps.targetOptions());

          // 目标解析阶段就被拒的地址已经抛错（TargetError 原样给模型），这里只管站点授权。
          const workspaceKey = deps.workspaceKey();
          const no = await authorize(target, raw);
          if (no !== null) return text(no);

          // 卡片里的「来源页面」：导航时是导航前的地址，新开页面时是刚开出来的地址。
          let pageUrl = pageId
            ? (deps.registry.get(pageId)?.url ?? target.url)
            : target.url;
          const { value: opened, lines } = await withDownloads(
            pageId,
            () => pageUrl,
            async () => {
              const res = pageId
                ? await navigate(pageId, target.url)
                : await openNew(workspaceKey, target.url);
              if (pageId === null)
                pageUrl = deps.registry.get(res.pageId)?.url ?? target.url;
              return res;
            },
          );
          // 新开的页面若是下载地址：goto 返回 status 为 null 且收到了下载，说明它是文件不是网页。
          // 把刚开的这个页面关掉，不给 pageId 也不要快照。
          if (pageId === null && opened.status === null && lines.length > 0) {
            await deps.registry.close(opened.pageId, { session: sessionId });
            return text(
              [
                `地址 ${target.url} 是文件下载，不是网页，没有打开页面。`,
                ...lines,
              ].join("\n"),
            );
          }
          await acted(
            "browser_open",
            opened.pageId,
            `${pageId ? "导航到" : "打开"} ${target.url}`,
          );
          // 被网络层拒绝的那一支仍给现有的拒绝文字：页面上没有内容可以读。
          if (opened.deny !== null)
            return text(
              `页面 ${opened.pageId} 已打开（HTTP ${opened.status ?? "无响应"}）\n${denyText(opened.deny)}。${lines.length === 0 ? "" : `\n${lines.join("\n")}`}`,
            );
          const handle = await deps.registry.use(
            opened.pageId,
            sessionId,
            "observe",
          );
          return text(
            await content({
              pageId: opened.pageId,
              handle,
              action: `open ${target.url}`,
              ...(intent === undefined ? {} : { intent }),
              notes: [
                `PAGE ID: ${opened.pageId} · HTTP ${opened.status ?? "none"}`,
                ...lines,
              ],
              ...(signal ? { signal } : {}),
            }),
          );
        });
      },
    });

    pi.registerTool({
      name: "browser_pages",
      label: "浏览器页面列表",
      description:
        "列出本工作区的所有浏览器页面：页面编号、标题、地址、是否激活、谁在操作、是不是本会话用过的。休眠的页面也会列出（下次用会重新加载，页面里没提交的内容会丢）。",
      parameters: { type: "object", properties: {} } as never,
      async execute() {
        return guarded(async () => {
          const pages = deps.registry.list(deps.workspaceKey());
          if (pages.length === 0)
            return text(
              "这个工作区还没有浏览器页面；用 browser_open 打开一个。",
            );
          return text(
            pages.map((page) => pageLine(page, sessionId)).join("\n"),
          );
        });
      },
    });

    pi.registerTool({
      name: "browser_close",
      label: "关闭页面",
      description:
        "关闭一个浏览器页面并删掉它的记录。只能关自己打开或认领过的、且不是用户手动操作的页面。",
      parameters: {
        type: "object",
        properties: { pageId: { type: "string", minLength: 1 } },
        required: ["pageId"],
      } as never,
      async execute(_id, params) {
        const pageId = pageIdArg((params as { pageId?: unknown }).pageId);
        return guarded(async () => {
          await deps.registry.close(pageId, { session: sessionId });
          deps.audit?.({ tool: "browser_close", pageId, summary: "关闭页面" });
          return text(`页面 ${pageId} 已关闭。`);
        });
      },
    });

    pi.registerTool({
      name: "browser_snapshot",
      label: "页面快照",
      description: `重新读一遍页面。默认给一份页面概览（带元素编号），带了 intent 就按它从页面里提取相关内容；raw 为 true 时给完整原始快照（保底用，压缩或提取漏掉验证码、报错这类关键信息时看它）。这个工具永远走完整路径，不因页面没变而省掉内容，并且会重置后续动作的对比基线。要看图片 / 视频 / iframe 的地址、data-* 属性、表单 action 或 HTML 原貌，用 browser_dom。${UNTRUSTED}`,
      parameters: {
        type: "object",
        properties: {
          pageId: { type: "string", minLength: 1 },
          intent: {
            type: "string",
            maxLength: 500,
            description: INTENT_DESCRIPTION,
          },
          raw: {
            type: "boolean",
            description: "true 时返回完整原始快照（保底）",
          },
        },
        required: ["pageId"],
      } as never,
      async execute(_id, params, signal) {
        const p = params as {
          pageId?: unknown;
          intent?: unknown;
          raw?: unknown;
        };
        const pageId = pageIdArg(p.pageId);
        const intent = intentArg(p.intent);
        return guarded(async () => {
          const handle = await deps.registry.use(pageId, sessionId, "observe");
          if (p.raw === true) {
            const raw = await handle.snapshot();
            deps.cleaner.rebase(sessionId, pageId, raw, handle.url());
            return text(`（原始快照，未压缩）\n${raw}`);
          }
          return text(
            await content({
              pageId,
              handle,
              explicit: true,
              ...(intent === undefined ? {} : { intent }),
              ...(signal ? { signal } : {}),
            }),
          );
        });
      },
    });

    // 动作类：点击、输入、按键、移动、滚动、拖拽、后退 / 前进 / 刷新、上传。
    registerActTools(pi, kit);

    // 观察类：截图、读控制台。
    registerObserveTools(pi, kit);

    // 资源类：列页面资源清单、按地址存进附件区。
    registerAssetTools(pi, kit);

    // 检查类：读页面原始 DOM。
    registerInspectTools(pi, kit);

    // 开发调试类：在页面里跑脚本、读写 Cookie 与 Web 存储、以页面的身份发请求、改环境模拟、发 CDP 命令。
    registerExecTools(pi, kit);
    registerStorageTools(pi, kit);
    registerRequestTools(pi, kit);
    registerRouteTools(pi, kit);
    registerEmulateTools(pi, kit);
    registerCdpTools(pi, kit);

    // 接管与展示：browser_handoff、browser_show。
    registerHandoffTools(pi, kit);
  };
}
