// 开发调试类工具 browser_cdp：直接向页面的 Chrome DevTools Protocol 发一条命令。
// 其它调试工具覆盖不到的东西（性能追踪、堆快照、覆盖率、证书信息、设备尺寸模拟）都从这里走。
// 动作类骨架（租约 → 高敏感站点确认 → 做事 → 审计与回放），摘要里只放方法名、不放 params。不带 intent、不经任何模型。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { guarded, pageIdArg, stringArg, text, UNTRUSTED } from "./args.js";
import { renderCdp } from "./cdp-view.js";
import type { BrowserToolsDeps } from "./deps.js";
import type { Kit } from "./kit.js";

/** method 的长度上限与形状：Domain.method。 */
const METHOD_MAX = 100;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;
/** params 序列化后的长度上限（字符）。 */
const PARAMS_MAX = 100_000;
/** 一条命令最多等多久。 */
const CDP_TIMEOUT_MS = 30_000;

const NO_RETURN = (method: string) =>
  new Error(`CDP 命令 ${method} ${CDP_TIMEOUT_MS / 1000} 秒内没有返回`);

/** 开发调试类工具：browser_cdp。 */
export function registerCdpTools(
  pi: Parameters<ExtensionFactory>[0],
  kit: Kit,
): void {
  const { confirmAction, acted } = kit;
  const deps: BrowserToolsDeps = kit.deps;
  const sessionId = kit.sessionId;

  pi.registerTool({
    name: "browser_cdp",
    label: "发送 CDP 命令",
    description: `直接向这个页面的 Chrome DevTools Protocol 发一条命令并取回结果，是其它调试工具覆盖不到时的逃生口：性能追踪、堆快照、覆盖率、证书与安全状态、设备尺寸模拟（Emulation.setDeviceMetricsOverride）等等。method 写成 Domain.method，如 Network.getCookies；params 是命令的参数对象。只发命令，收不到事件（要收事件得自己在页面里订阅）。一些命令要先 Domain.enable 才能用。它能做的事和 DevTools 一样多：能改变页面与浏览器的状态，也可能和本系统自己的用法冲突（比如 Emulation.setDeviceMetricsOverride 之后点击坐标会错位，视口不再是固定的 1280×800），出了问题关掉页面重开。30 秒没有返回算超时。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        method: {
          type: "string",
          maxLength: METHOD_MAX,
          description: "Domain.method，如 Network.getCookies",
        },
        params: {
          type: "object",
          description: "可选：命令的参数对象",
        },
      },
      required: ["pageId", "method"],
    } as never,
    async execute(_id, params) {
      const p = params as {
        pageId?: unknown;
        method?: unknown;
        params?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const method = stringArg(
        p.method,
        "method",
        "Domain.method 形式，如 Network.getCookies",
      );
      if (!METHOD_PATTERN.test(method))
        throw new Error("method 要写成 Domain.method，如 Network.getCookies");
      if (method.length > METHOD_MAX)
        throw new Error(
          `method 最长 ${METHOD_MAX} 个字符，现在 ${method.length} 个`,
        );
      if (
        p.params !== undefined &&
        (typeof p.params !== "object" ||
          p.params === null ||
          Array.isArray(p.params))
      )
        throw new Error('params 必须是对象，如 {"url": "https://x.test"}');
      const command = p.params as Record<string, unknown> | undefined;
      if (command !== undefined) {
        const size = JSON.stringify(command).length;
        if (size > PARAMS_MAX)
          throw new Error(
            `params 序列化后最长 ${PARAMS_MAX} 个字符，现在 ${size} 个：请拆成几条命令`,
          );
      }

      return guarded(async () => {
        const handle = await deps.registry.use(pageId, sessionId, "act");
        // 摘要只写方法名：params 里可能有令牌与要写进页面的内容。
        const summary = `发送 CDP 命令 ${method}`;
        await confirmAction(handle, "browser_cdp", summary);
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, fail) => {
          timer = setTimeout(() => fail(NO_RETURN(method)), CDP_TIMEOUT_MS);
          timer.unref();
        });
        let result: unknown;
        try {
          result = await Promise.race([handle.cdp(method, command), timeout]);
        } finally {
          clearTimeout(timer);
        }
        await acted("browser_cdp", pageId, `CDP ${method}`);
        const json = JSON.stringify(result ?? {}, null, 2);
        const view = renderCdp(json, {
          method,
          title: (await handle.title()) || "（无标题）",
          url: handle.url(),
        });
        if (!view.elided) return text(view.text);
        // 工具结果的文字有扩展统一遮罩，落文件的没有：这里自己遮一遍。
        const saved = await deps.saveAsset({
          sessionId,
          name: `cdp-${pageId}.json`,
          bytes: Buffer.from(deps.mask(view.full), "utf8"),
        });
        return text(`${view.text}\nFULL RESULT: ${saved.marker}`);
      });
    },
  });
}
