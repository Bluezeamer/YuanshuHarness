// Web 版的 ExtensionUIContext（docs/model/plugin.md §4）：插件的 select / confirm / input /
// editor 走与 ask_user、审批弹窗同一条通道——会话的弹窗表发 prompt.requested，前端经 WS 的
// answer_prompt 答复；通知、状态条、输入框预填是单向的，发 `extension.ui` 事件。
//
// 对话类的线上形状（前端按这个渲染，改动即破坏契约）：
//   select : { source: "question", title, options: [{ id: "0", label }, …] }；optionId 映射回原字符串
//   confirm: { source: "question", title, body: message, options: [{id:"yes",label:"确认"},{id:"no",label:"取消"}] }
//   input  : { source: "question", title, body: placeholder, input: "text" }
//   editor : { source: "question", title, body: prefill, input: "text" }（前端这批不做多行编辑器，先退化）
// select / confirm 是严格选项：pi 的返回值类型固定，自由文字放不进去，所以不给 input。
// 超时、撤销、未答统一按「用户没答」收尾：select / input / editor 给 undefined，confirm 给 false。
//
// 单向事件的线上形状：{ type: "extension.ui", method, … }
//   notify { message, notifyType } / setStatus { statusKey, statusText } /
//   setWidget { widgetKey, widgetLines, widgetPlacement } / setTitle { title } /
//   set_editor_text { text }
// 这些事件不进会话快照（不是状态，前端只做瞬时展示）。
import {
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";

/** 插件单向 UI 事件类型；前端按 method 分派。 */
export const EXTENSION_UI_EVENT = "extension.ui";

/** 问前端一个问题：可选的选项 + 可选的输入框。 */
export interface ExtensionUiAsk {
  source: "question";
  title: string;
  body?: string;
  options?: { id: string; label: string }[];
  input?: "text";
}

export interface ExtensionUiAnswer {
  outcome: "answered" | "timeout" | "cancelled";
  optionId?: string;
  text?: string;
}

/** 通道的需求：一条能提问并等答复的路，加一条只广播事件的路。 */
export interface ExtensionUiHost {
  ask(spec: ExtensionUiAsk): Promise<ExtensionUiAnswer>;
  publish(type: string, data: Record<string, unknown>): void;
}

// pi 的 Theme 实例不对外导出，只有 initTheme() 把它放到全局；Web 端只为满足接口，
// 用深色内置主题兜底（插件若在终端配色上取巧，拿到的是 ANSI 序列，不影响功能）。
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
function webTheme(): Theme {
  const holder = globalThis as unknown as Record<symbol, Theme | undefined>;
  if (holder[THEME_KEY] === undefined) initTheme("dark", false);
  const theme = holder[THEME_KEY];
  if (theme === undefined) throw new Error("Web 端加载 pi 主题失败");
  return theme;
}

const answered = (r: ExtensionUiAnswer) => r.outcome === "answered";

export function makeExtensionUiContext(
  host: ExtensionUiHost,
): ExtensionUIContext {
  // 弹窗本身的超时由会话的弹窗表管（PROMPT_TIMEOUT_MS）；这里只处理插件自己带的 signal
  // 与更短的 opts.timeout：先到者按「用户没答」收尾。
  const dialog = <T>(
    opts: ExtensionUIDialogOptions | undefined,
    cancelled: T,
    spec: ExtensionUiAsk,
    pick: (r: ExtensionUiAnswer) => T,
  ): Promise<T> => {
    if (opts?.signal?.aborted) return Promise.resolve(cancelled);
    const reply = host.ask(spec).then(pick);
    if (!opts?.signal && opts?.timeout === undefined) return reply;
    let timer: NodeJS.Timeout | undefined;
    let giveUp = () => {};
    const stop = () => {
      if (timer !== undefined) clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", giveUp);
    };
    const early = new Promise<T>((ok) => {
      giveUp = () => {
        stop();
        ok(cancelled);
      };
      opts?.signal?.addEventListener("abort", giveUp, { once: true });
      if (opts?.timeout !== undefined) {
        timer = setTimeout(giveUp, opts.timeout);
        timer.unref?.();
      }
    });
    return Promise.race([reply, early]).finally(stop);
  };

  const fire = (request: Record<string, unknown>) =>
    host.publish(EXTENSION_UI_EVENT, request);

  const textOf = (r: ExtensionUiAnswer) => (answered(r) ? r.text : undefined);

  return {
    select: (title, options, opts) =>
      dialog(
        opts,
        undefined,
        {
          source: "question",
          title,
          options: options.map((label, i) => ({ id: String(i), label })),
        },
        (r) =>
          answered(r) && r.optionId !== undefined
            ? options[Number(r.optionId)]
            : undefined,
      ),
    confirm: (title, message, opts) =>
      dialog(
        opts,
        false,
        {
          source: "question",
          title,
          body: message,
          options: [
            { id: "yes", label: "确认" },
            { id: "no", label: "取消" },
          ],
        },
        (r) => answered(r) && r.optionId === "yes",
      ),
    input: (title, placeholder, opts) =>
      dialog(
        opts,
        undefined,
        {
          source: "question",
          title,
          input: "text",
          ...(placeholder === undefined ? {} : { body: placeholder }),
        },
        textOf,
      ),
    editor: (title, prefill) =>
      dialog(
        undefined,
        undefined,
        {
          source: "question",
          title,
          input: "text",
          ...(prefill === undefined ? {} : { body: prefill }),
        },
        textOf,
      ),
    notify(message, type) {
      fire({ method: "notify", message, notifyType: type });
    },
    setStatus(key, text) {
      fire({ method: "setStatus", statusKey: key, statusText: text });
    },
    // 组件工厂（终端组件）在 Web 端不渲染，只接受字符串行。
    setWidget(key, content, options) {
      if (content === undefined || Array.isArray(content))
        fire({
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        });
    },
    setTitle(title) {
      fire({ method: "setTitle", title });
    },
    setEditorText(text) {
      fire({ method: "set_editor_text", text });
    },
    pasteToEditor(text) {
      fire({ method: "set_editor_text", text });
    },
    getEditorText() {
      // 同步接口等不了前端的回答；输入框的真实内容由前端自己维护。
      return "";
    },
    get theme() {
      return webTheme();
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "Web 端不支持切换主题" };
    },
    getToolsExpanded() {
      return false;
    },
    // 以下都是终端专属能力，Web 端按空操作处理（与 pi 的 RPC 模式一致）。
    onTerminalInput: () => () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setFooter: () => {},
    setHeader: () => {},
    async custom<T>() {
      return undefined as T;
    },
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    setToolsExpanded: () => {},
  } satisfies ExtensionUIContext;
}
