// 开发调试类工具 browser_exec：在页面自己的 JS 环境里跑一段脚本，把结果取回来。
// 动作类骨架（租约 → 高敏感站点确认 → 做事 → 审计与回放），摘要里不放脚本。不带 intent、不经任何模型。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  guarded,
  pageIdArg,
  refArg,
  stringArg,
  text,
  UNTRUSTED,
} from "./args.js";
import type { BrowserToolsDeps } from "./deps.js";
import { renderExec } from "./exec-view.js";
import type { Kit } from "./kit.js";

/** 脚本长度上限（字符）。 */
const SCRIPT_MAX = 20_000;

/** 开发调试类工具：browser_exec。 */
export function registerExecTools(
  pi: Parameters<ExtensionFactory>[0],
  kit: Kit,
): void {
  const { confirmAction, acted } = kit;
  const deps: BrowserToolsDeps = kit.deps;
  const sessionId = kit.sessionId;

  pi.registerTool({
    name: "browser_exec",
    label: "在页面里执行脚本",
    description: `在页面自己的 JavaScript 环境里执行一段脚本并取回结果，用来读页面变量与状态、调用页面函数、读 IndexedDB、探测页面用的框架、改 DOM 看效果：快照与 browser_dom 够不着的东西都靠它。script 是一个 async 函数的函数体：可以 await，用 return 给出结果（不 return 就是 undefined）。给了 ref（最近一次快照里的编号，如 e12，iframe 里的 f1e3 也行）时函数体里多一个变量 el，就是那个元素；不给就没有 el。结果在页面里序列化成 JSON（缩进两个空格）：函数写成 [Function 名]，DOM 节点写成 [Element <标签#id.类名>]，环写成 [Circular]，Map 与 Set 写成 {"[Map]": [[k, v]…]} 与 {"[Set]": [v…]}，bigint 写成 123n，NaN / Infinity 写成字符串。脚本里抛的异常不会让工具失败，会照实写成 THREW: 加 name、message 与栈的前几行。30 秒没有返回算超时。脚本能做的事和页面自己的脚本一样多（改页面状态、发请求、跳转都行），所以用它改过页面之后要重新看快照；工具本身不影响快照的对比基线。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        script: {
          type: "string",
          maxLength: SCRIPT_MAX,
          description:
            "要执行的 async 函数体：可以 await，用 return 给结果；给了 ref 时可用变量 el",
        },
        ref: {
          type: "string",
          description:
            "可选：在这个元素上执行（最近一次快照里的编号，如 e12），函数体里多一个 el",
        },
      },
      required: ["pageId", "script"],
    } as never,
    async execute(_id, params) {
      const p = params as {
        pageId?: unknown;
        script?: unknown;
        ref?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const script = stringArg(
        p.script,
        "script",
        "要执行的 async 函数体，如 return document.title",
      );
      if (script.length > SCRIPT_MAX)
        throw new Error(
          `script 最长 ${SCRIPT_MAX} 字符，现在 ${script.length} 字符：请拆成几段执行`,
        );
      const ref = p.ref === undefined ? null : refArg(p.ref);
      return guarded(async () => {
        const handle = await deps.registry.use(pageId, sessionId, "act");
        // 摘要只写长度：脚本内容可能带密码、令牌。
        const summary = `执行脚本（${script.length} 字符）`;
        await confirmAction(handle, "browser_exec", summary);
        const outcome = await handle.exec(script, ref);
        await acted("browser_exec", pageId, summary);
        // 脚本可能弹出对话框把页面卡住：这时不去读标题（会一直等），标题写固定说明。
        const title =
          handle.dialog() !== null
            ? "（页面在等对话框）"
            : (await handle.title()) || "（无标题）";
        const view = renderExec(outcome, { title, url: handle.url() });
        if (!view.elided) return text(view.text);
        // 工具结果的文字有扩展统一遮罩，落文件的没有：这里自己遮一遍。
        const saved = await deps.saveAsset({
          sessionId,
          name: `exec-${pageId}.json`,
          bytes: Buffer.from(deps.mask(view.full), "utf8"),
        });
        return text(`${view.text}\nFULL RESULT: ${saved.marker}`);
      });
    },
  });
}
