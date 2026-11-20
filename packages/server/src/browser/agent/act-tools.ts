// 动作类工具：点击、输入、按键、移动、滚动、拖拽、后退 / 前进 / 刷新、上传。
// 与 tools.ts 同一层：翻译模型参数 → 页面句柄调用 → 压缩层的快照。
// 逐动作确认只给高敏感站点的 click / type / press / drag；move / scroll / nav 不确认，但都过租约并写审计与回放（设计稿 §1.8）。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { formatSize } from "../../session/attachments.js";
import { hostProperty } from "../../session/host-param.js";
import {
  type PointTarget,
  type ScrollArgs,
  type ScrollPos,
  VIEWPORT,
} from "../engine/types.js";
import { checkUploadTotal, UPLOAD_MAX_TOTAL_BYTES } from "../uploads/limits.js";
import { withNote } from "./approve.js";
import {
  coordArg,
  DOWNLOAD_HINT,
  guarded,
  INTENT_DESCRIPTION,
  intentArg,
  originOf,
  pageIdArg,
  refArg,
  stringArg,
  text,
  UNTRUSTED,
} from "./args.js";
import { cutUrl } from "./download.js";
import type { Kit } from "./kit.js";
import { readUploadSource, UPLOAD_MAX_FILES } from "./upload.js";

const TYPE_MAX = 2000;
// 对话框摘要在确认卡片与审计里最多写这么长（不写 prompt 的输入）。
const DIALOG_SUMMARY_MAX = 60;
const NO_DIALOG =
  "这个页面现在没有等待回答的对话框（可能已被用户回答，或超时自动取消了）";
// 逐键输入每个字符都要发完整的按键事件，慢，所以上限小得多。
const PER_KEY_MAX = 200;
const SCROLL_AMOUNT_MAX = 20000;

const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];
const DIRECTION_TEXT: Record<ScrollDirection, string> = {
  up: "向上",
  down: "向下",
  left: "向左",
  right: "向右",
};

const NAV_ACTIONS = ["back", "forward", "reload"] as const;
type NavAction = (typeof NAV_ACTIONS)[number];
const NAV_TEXT: Record<NavAction, string> = {
  back: "后退",
  forward: "前进",
  reload: "刷新",
};
/** 点击的三种目标写法：ref、一对坐标、都不给（点当前鼠标位置）；三击能选中一整段文字，选字不用拖拽。 */
const CLICK_TARGET_USAGE =
  "点击目标给 ref（如 e12），或给 x 和 y（视口坐标），或都不给（点当前鼠标位置，先用 browser_move 移动）；只给 x 或只给 y 不行";

/** 鼠标动作的位置目标：ref 或一对坐标，二选一必给。 */
function targetArg(p: {
  ref?: unknown;
  x?: unknown;
  y?: unknown;
  names: { ref: string; x: string; y: string };
  usage: string;
}): PointTarget {
  const hasRef = p.ref !== undefined;
  const hasPoint = p.x !== undefined || p.y !== undefined;
  if (hasRef && hasPoint)
    throw new Error(
      `${p.names.ref} 与 ${p.names.x}、${p.names.y} 只能给一组：${p.usage}`,
    );
  if (!hasRef && !hasPoint) throw new Error(p.usage);
  if (hasRef) return { ref: refArg(p.ref) };
  if (p.x === undefined || p.y === undefined)
    throw new Error(`${p.names.x} 与 ${p.names.y} 要成对给：${p.usage}`);
  return { x: coordArg(p.x, "x"), y: coordArg(p.y, "y") };
}

/** 目标的一行中文说明：ref 原样，坐标写成 (x,y)。 */
function targetText(target: PointTarget): string {
  return "ref" in target ? target.ref : `(${target.x},${target.y})`;
}

function directionArg(v: unknown): ScrollDirection | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !SCROLL_DIRECTIONS.includes(v as never))
    throw new Error("direction 只能是 up、down、left、right");
  return v as ScrollDirection;
}

/** 点击的摘要：给目标时写「点击 e12」，点鼠标当前位置时写「点击当前鼠标位置」。 */
function clickSummary(
  count: 1 | 2 | 3,
  button: "left" | "right",
  target: string | null,
): string {
  const verb = count === 2 ? "双击" : count === 3 ? "三击" : "点击";
  const what = target ?? "当前鼠标位置";
  if (button === "left")
    return target === null ? `${verb}${what}` : `${verb} ${what}`;
  if (count === 1) return `右键点击 ${what}`;
  return `${verb} ${what}（右键）`;
}

/** 点击的 ACTION 行：次数与右键各自带后缀。 */
function clickAction(
  count: 1 | 2 | 3,
  button: "left" | "right",
  where: string,
): string {
  return `click ${where}${count > 1 ? ` ×${count}` : ""}${button === "right" ? " (right button)" : ""}`;
}

/** 滚动后 ACTION 行里的页面位置：变了写前后，没变写当前并注明没动；到底 / 到顶各加一句。 */
function scrollPosText(
  before: ScrollPos,
  after: ScrollPos,
  axis: "x" | "y",
  direction: ScrollDirection | null,
): string {
  const vertical = axis === "y";
  const prev = vertical ? before.y : before.x;
  const cur = vertical ? after.y : after.x;
  const total = vertical ? after.height : after.width;
  const view = vertical ? after.viewHeight : after.viewWidth;
  const atEnd = cur + view >= total - 1;
  const atStart = cur <= 0 && direction === (vertical ? "up" : "left");
  const head =
    prev === cur
      ? `page ${axis} ${cur} of ${total}, did not move`
      : `page ${axis} ${prev} → ${cur} of ${total}`;
  const edge = atEnd
    ? vertical
      ? ", at bottom"
      : ", at right"
    : atStart
      ? vertical
        ? ", at top"
        : ", at left"
      : "";
  return ` (${head}${edge})`;
}

/** 动作类工具：点击、输入、按键、移动、滚动、拖拽、后退 / 前进 / 刷新、上传。 */
export function registerActTools(
  pi: Parameters<ExtensionFactory>[0],
  kit: Kit,
): void {
  const { acted, content, withDownloads, confirmAction } = kit;
  const deps = kit.deps;
  const sessionId = kit.sessionId;

  pi.registerTool({
    name: "browser_click",
    label: "点击页面元素",
    description: `点击页面里的一个元素或一个坐标，返回点击后的页面内容。点 ref 会自动滚到它可见处，不需要先滚动。count 为 2 是双击（双击编辑、双击打开），为 3 是三击（选中一整段文字，选文字不用拖拽）。button 为 right 弹右键菜单，只对网站自己实现的菜单有意义（浏览器原生右键菜单在无头模式下既不渲染也读不到）。不给目标就点当前鼠标位置（browser_move 之后用）。${UNTRUSTED}${DOWNLOAD_HINT}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        ref: { type: "string", description: "元素编号，如 e12" },
        x: {
          type: "number",
          description: `视口横坐标，0–${VIEWPORT.width - 1}`,
        },
        y: {
          type: "number",
          description: `视口纵坐标，0–${VIEWPORT.height - 1}`,
        },
        count: {
          type: "integer",
          enum: [1, 2, 3],
          description: "点击次数，缺省 1；2 是双击，3 是三击（全选一段文字）",
        },
        button: {
          type: "string",
          enum: ["left", "right"],
          description: "鼠标键，缺省 left",
        },
        intent: {
          type: "string",
          maxLength: 500,
          description: INTENT_DESCRIPTION,
        },
      },
      required: ["pageId"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as {
        pageId?: unknown;
        ref?: unknown;
        x?: unknown;
        y?: unknown;
        count?: unknown;
        button?: unknown;
        intent?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const hasRef = p.ref !== undefined;
      const hasPoint = p.x !== undefined || p.y !== undefined;
      if (hasRef && hasPoint)
        throw new Error(`ref 与 x、y 只能给一组：${CLICK_TARGET_USAGE}`);
      const ref = hasRef ? refArg(p.ref) : null;
      let point: { x: number; y: number } | null = null;
      if (hasPoint) {
        if (p.x === undefined || p.y === undefined)
          throw new Error(`x 与 y 要成对给：${CLICK_TARGET_USAGE}`);
        point = { x: coordArg(p.x, "x"), y: coordArg(p.y, "y") };
      }
      const count = (p.count === undefined ? 1 : p.count) as 1 | 2 | 3;
      if (count !== 1 && count !== 2 && count !== 3)
        throw new Error("count 只能是 1、2、3");
      const button = (p.button === undefined ? "left" : p.button) as
        | "left"
        | "right";
      if (button !== "left" && button !== "right")
        throw new Error("button 只能是 left 或 right");
      const intent = intentArg(p.intent);
      const opts = { count, button };
      return guarded(async () => {
        const handle = await deps.registry.use(pageId, sessionId, "act");
        // 点当前鼠标位置时，ACTION 行要写出那个位置的坐标：取动作之前的鼠标位置。
        const mouse = ref === null && point === null ? handle.mouse() : null;
        const summary = clickSummary(
          count,
          button,
          ref ?? (point === null ? null : `(${point.x},${point.y})`),
        );
        await confirmAction(handle, "browser_click", summary);
        // 来源页面取动作之前的地址：点击可能把页面带去别处。
        const pageUrl = handle.url();
        const { lines } = await withDownloads(
          pageId,
          () => pageUrl,
          async () => {
            if (ref !== null) await handle.click(ref, opts);
            else await handle.clickAt(point, opts);
          },
        );
        // 鼠标还没移过、页面上没有位置的那条路，引擎已经在 clickAt 里报错了。
        const where =
          ref ??
          (point !== null
            ? `(${point.x},${point.y})`
            : mouse === null
              ? "at mouse"
              : `at mouse (${mouse.x},${mouse.y})`);
        const action = clickAction(count, button, where);
        await acted("browser_click", pageId, summary);
        return text(
          await content({
            pageId,
            handle,
            action,
            notes: lines,
            ...(intent === undefined ? {} : { intent }),
            ...(signal ? { signal } : {}),
          }),
        );
      });
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "在页面输入",
    description: `往输入框输入文字，返回输入后的页面内容。默认整段插入（快）；若输入后页面没反应（按钮仍是灰的、联想不出现——页面依赖按键事件），用 perKey: true 逐键重试（慢，每个字符发完整的按键事件，最长 200 字符）。带 ref 会替换框内原有内容（text 为空串表示清空）；要追加就先点击聚焦、再不带 ref 输入。给 ref 就输入到那个输入框，不给就输入到当前聚焦的元素。ref 指到原生下拉框（<select>，快照里是 combobox）时，text 是要选的选项（按文字或 value 匹配；多选框用换行分隔多项），不是输入文字。submit 为 true 时输入后回车。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        text: {
          type: "string",
          maxLength: TYPE_MAX,
          description: "要输入的文字（下拉框时是要选的选项）",
        },
        ref: {
          type: "string",
          description: "可选：输入框编号，如 e12（也可以指下拉框）",
        },
        submit: { type: "boolean", description: "输入后是否回车，缺省否" },
        perKey: {
          type: "boolean",
          description: `逐键输入（每个字符发完整按键事件），页面只认按键事件时用；最长 ${PER_KEY_MAX} 字符`,
        },
        intent: {
          type: "string",
          maxLength: 500,
          description: INTENT_DESCRIPTION,
        },
      },
      required: ["pageId", "text"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as {
        pageId?: unknown;
        text?: unknown;
        ref?: unknown;
        submit?: unknown;
        perKey?: unknown;
        intent?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const input = stringArg(p.text, "text", "要输入的文字");
      const ref = p.ref === undefined ? null : refArg(p.ref);
      const submit = p.submit === true;
      const perKey = p.perKey === true;
      const limit = perKey ? PER_KEY_MAX : TYPE_MAX;
      if (input.length > limit)
        throw new Error(
          perKey
            ? `逐键输入最长 ${PER_KEY_MAX} 字符，现在 ${input.length} 字符：请分段输入，或改用默认的整段输入`
            : `text 最长 ${TYPE_MAX} 字符，现在 ${input.length} 字符`,
        );
      const intent = intentArg(p.intent);
      return guarded(async () => {
        const handle = await deps.registry.use(pageId, sessionId, "act");
        const where = ref === null ? "聚焦元素" : ref;
        await confirmAction(
          handle,
          "browser_type",
          `输入 ${input.length} 个字符到 ${where}${perKey ? "（逐键）" : ""}${submit ? "并回车" : ""}`,
        );
        const pageUrl = handle.url();
        const doType = async () =>
          (await handle.type(ref, input, { submit, perKey }))?.selected ?? null;
        // 只有回车提交才可能触发下载（输入本身不会）：不提交就不开下载窗口。
        let lines: string[] = [];
        let selected: string[] | null = null;
        if (submit) {
          const out = await withDownloads(pageId, () => pageUrl, doType);
          lines = out.lines;
          selected = out.value;
        } else selected = await doType();
        // 审计与回放只写长度：输入框里可能是密码。
        await acted(
          "browser_type",
          pageId,
          `${ref === null ? "输入到聚焦元素" : `输入到 ${ref}`}，${input.length} 字${perKey ? "，逐键" : ""}${submit ? "，回车" : ""}`,
        );
        return text(
          await content({
            pageId,
            handle,
            action:
              selected === null
                ? `type ${input.length} chars into ${ref ?? "focused element"}${perKey ? ", per-key" : ""}${submit ? ", Enter" : ""}`
                : `select ${selected.map((s) => `"${s}"`).join(", ")} in ${ref ?? "focused element"}`,
            notes: lines,
            ...(intent === undefined ? {} : { intent }),
            ...(signal ? { signal } : {}),
          }),
        );
      });
    },
  });

  pi.registerTool({
    name: "browser_press",
    label: "按键",
    description: `在页面上按一个键，如 Enter、Tab、Escape、ArrowDown。返回按键后的页面内容。${UNTRUSTED}${DOWNLOAD_HINT}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        key: {
          type: "string",
          minLength: 1,
          maxLength: 40,
          description: "键名，如 Enter",
        },
        intent: {
          type: "string",
          maxLength: 500,
          description: INTENT_DESCRIPTION,
        },
      },
      required: ["pageId", "key"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as {
        pageId?: unknown;
        key?: unknown;
        intent?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const key = stringArg(
        p.key,
        "key",
        "键名如 Enter、Tab、Escape、ArrowDown",
      );
      if (key === "") throw new Error("key 不能是空串");
      const intent = intentArg(p.intent);
      return guarded(async () => {
        const handle = await deps.registry.use(pageId, sessionId, "act");
        await confirmAction(handle, "browser_press", `按键 ${key}`);
        const pageUrl = handle.url();
        const { lines } = await withDownloads(
          pageId,
          () => pageUrl,
          () => handle.press(key),
        );
        await acted("browser_press", pageId, `按键 ${key}`);
        return text(
          await content({
            pageId,
            handle,
            action: `press ${key}`,
            notes: lines,
            ...(intent === undefined ? {} : { intent }),
            ...(signal ? { signal } : {}),
          }),
        );
      });
    },
  });

  pi.registerTool({
    name: "browser_dialog",
    label: "回答页面对话框",
    description: `页面弹出 alert / confirm / prompt / beforeunload 时，页面会被对话框挂起（卡住）：快照、截图、点击都会一直等，其它工具会拒绝并提示先回答。用这个工具回答：accept 为 true 是确定（confirm 的确定、prompt 的确认），false 是取消；prompt 用 text 给输入（不给就用对话框自带的默认值）。用户在界面上也能回答，先答先得。不回答的话 120 秒后自动取消。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        accept: {
          type: "boolean",
          description: "true 是确定，false 是取消",
        },
        text: {
          type: "string",
          maxLength: TYPE_MAX,
          description: "可选：prompt 的输入；不给就用对话框的默认值",
        },
        intent: {
          type: "string",
          maxLength: 500,
          description: INTENT_DESCRIPTION,
        },
      },
      required: ["pageId", "accept"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as {
        pageId?: unknown;
        accept?: unknown;
        text?: unknown;
        intent?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      if (typeof p.accept !== "boolean")
        throw new Error("accept 必须是 true（确定）或 false（取消）");
      const accept = p.accept;
      const input =
        p.text === undefined
          ? undefined
          : stringArg(p.text, "text", "prompt 的输入文字");
      if (input !== undefined && input.length > TYPE_MAX)
        throw new Error(
          `text 最长 ${TYPE_MAX} 字符，现在 ${input.length} 字符`,
        );
      const intent = intentArg(p.intent);
      return guarded(async () => {
        const handle = await deps.registry.use(pageId, sessionId, "act", {
          allowDialog: true,
        });
        const dialog = handle.dialog();
        if (dialog === null) throw new Error(NO_DIALOG);
        const summary = `${accept ? "确定" : "取消"}对话框「${dialog.message.slice(0, DIALOG_SUMMARY_MAX)}」`;
        await confirmAction(handle, "browser_dialog", summary);
        if (!(await handle.answerDialog(accept, input)))
          throw new Error(NO_DIALOG);
        await acted("browser_dialog", pageId, summary);
        const action = `${accept ? "accept" : "dismiss"} ${dialog.type} dialog`;
        return text(
          await content({
            pageId,
            handle,
            action,
            ...(intent === undefined ? {} : { intent }),
            ...(signal ? { signal } : {}),
          }),
        );
      });
    },
  });

  pi.registerTool({
    name: "browser_move",
    label: "移动鼠标",
    description: `把鼠标移到页面元素或坐标上，返回页面内容。只悬停才出现的菜单、按钮只能靠它；移完可以不带目标用 browser_click 点当前位置。ref 的位置现查，视口外会先滚到可见处。鼠标位置在页面整页导航之后清空。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        ref: { type: "string", description: "元素编号，如 e12" },
        x: {
          type: "number",
          description: `视口横坐标，0–${VIEWPORT.width - 1}`,
        },
        y: {
          type: "number",
          description: `视口纵坐标，0–${VIEWPORT.height - 1}`,
        },
        intent: {
          type: "string",
          maxLength: 500,
          description: INTENT_DESCRIPTION,
        },
      },
      required: ["pageId"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as {
        pageId?: unknown;
        ref?: unknown;
        x?: unknown;
        y?: unknown;
        intent?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const target = targetArg({
        ref: p.ref,
        x: p.x,
        y: p.y,
        names: { ref: "ref", x: "x", y: "y" },
        usage:
          "移动鼠标要选一个目标：给 ref（如 e12），或给 x 和 y（视口坐标），二选一",
      });
      const intent = intentArg(p.intent);
      return guarded(async () => {
        // 不逐动作确认，但仍过租约：用户正在操作的页面不能被 agent 动。
        const handle = await deps.registry.use(pageId, sessionId, "act");
        await handle.move(target);
        const summary = `移动鼠标到 ${targetText(target)}`;
        await acted("browser_move", pageId, summary);
        return text(
          await content({
            pageId,
            handle,
            action: `move to ${targetText(target)}`,
            ...(intent === undefined ? {} : { intent }),
            ...(signal ? { signal } : {}),
          }),
        );
      });
    },
  });

  pi.registerTool({
    name: "browser_scroll",
    label: "滚动页面",
    description: `滚动页面，返回滚动后的页面内容。读页面不需要滚动（快照已含全页），滚动只用于触发懒加载 / 分页加载（无限滚动）、滚动页面里的内部容器、截图前定位；PgUp / PgDn 用 browser_press，点元素也不需要先滚。两种用法：to 把某个元素滚进视口；direction 朝一个方向滚，amount 是像素（缺省一屏），落点 ref 或 x、y 指定在哪个元素 / 坐标处滚（缺省视口中心）。触发加载要注意：①滚动之后会等页面内容变化（新增的元素、新发出的请求跑完），最多等约 2.5 秒，所以新加载的内容通常就在这一次返回里；没有东西可加载时只多等不到 1 秒。返回 NO CHANGES 多半是真没有更多了，但响应慢于 2.5 秒、或滚动很久之后才发请求的站点会漏——不放心就再滚一次；连续两次都没有新增、ACTION 行里的页面总高度（形如 of N）也不再变大，才说明到底了。②一次滚动最多触发一批加载，要加载更多就用默认的一屏步长连续滚；一次滚几千像素没有好处，有的站点（实测过知乎）还会因此根本不触发加载。③要找的元素已经在快照里，就直接用 to 滚过去，不必一屏一屏滚着找。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        to: { type: "string", description: "滚到这个元素进入视口，如 e12" },
        direction: {
          type: "string",
          enum: [...SCROLL_DIRECTIONS],
          description: "滚动方向",
        },
        amount: {
          type: "integer",
          minimum: 1,
          maximum: SCROLL_AMOUNT_MAX,
          description:
            "滚动距离（像素），缺省一屏；触发加载请用缺省值连续滚，不要一次滚很远",
        },
        ref: {
          type: "string",
          description: "可选：在哪个元素处滚（页面里的内部容器），缺省视口中心",
        },
        x: {
          type: "number",
          description: `可选：在哪个视口横坐标处滚，0–${VIEWPORT.width - 1}`,
        },
        y: {
          type: "number",
          description: `可选：在哪个视口纵坐标处滚，0–${VIEWPORT.height - 1}`,
        },
        intent: {
          type: "string",
          maxLength: 500,
          description: INTENT_DESCRIPTION,
        },
      },
      required: ["pageId"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as {
        pageId?: unknown;
        to?: unknown;
        direction?: unknown;
        amount?: unknown;
        ref?: unknown;
        x?: unknown;
        y?: unknown;
        intent?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const to = p.to === undefined ? null : refArg(p.to);
      const direction = directionArg(p.direction);
      if ((to === null) === (direction === undefined))
        throw new Error(
          "to 与 direction 要给且只给一个：给 to 是滚到某个元素，给 direction 是朝一个方向滚",
        );
      if (
        to !== null &&
        (p.amount !== undefined ||
          p.ref !== undefined ||
          p.x !== undefined ||
          p.y !== undefined)
      )
        throw new Error("amount 与 ref、x、y 只能跟 direction 一起给");
      let amount: number | undefined;
      if (p.amount !== undefined) {
        const v = p.amount;
        if (
          typeof v !== "number" ||
          !Number.isInteger(v) ||
          v < 1 ||
          v > SCROLL_AMOUNT_MAX
        )
          throw new Error(
            `amount 必须是 1–${SCROLL_AMOUNT_MAX} 之间的整数（像素）`,
          );
        amount = v;
      }
      let at: PointTarget | undefined;
      if (p.ref !== undefined || p.x !== undefined || p.y !== undefined)
        at = targetArg({
          ref: p.ref,
          x: p.x,
          y: p.y,
          names: { ref: "ref", x: "x", y: "y" },
          usage:
            "落点给 ref，或给 x 和 y（视口坐标），二选一；不给就在视口中心滚",
        });
      const intent = intentArg(p.intent);
      const args: ScrollArgs =
        to !== null
          ? { to }
          : {
              direction: direction as ScrollDirection,
              ...(amount === undefined ? {} : { amount }),
              ...(at === undefined ? {} : { at }),
            };
      return guarded(async () => {
        // 不逐动作确认（滚动基本不改状态），但仍过租约并写审计与回放。
        const handle = await deps.registry.use(pageId, sessionId, "act");
        const { before, after } = await handle.scroll(args);
        const where = at === undefined ? "" : `（在 ${targetText(at)} 处）`;
        const summary =
          to !== null
            ? `滚动到 ${to}`
            : amount === undefined
              ? `${DIRECTION_TEXT[direction as ScrollDirection]}滚动一屏`
              : `${DIRECTION_TEXT[direction as ScrollDirection]}滚动 ${amount} 像素`;
        await acted(
          "browser_scroll",
          pageId,
          to !== null ? summary : `${summary}${where}`,
        );
        // 滚动后页面内容（元素树 / 文字）常常没变，所以位置作为事实写进 ACTION 行，否则 agent 会以为没滚。
        const axis = direction === "left" || direction === "right" ? "x" : "y";
        const action =
          (to !== null
            ? `scroll to ${to}`
            : `scroll ${direction} ${amount === undefined ? "one screen" : `${amount}px`}${at === undefined ? "" : ` at ${targetText(at)}`}`) +
          scrollPosText(before, after, axis, direction ?? null);
        return text(
          await content({
            pageId,
            handle,
            action,
            ...(intent === undefined ? {} : { intent }),
            ...(signal ? { signal } : {}),
          }),
        );
      });
    },
  });

  pi.registerTool({
    name: "browser_drag",
    label: "拖拽",
    description: `用真实鼠标事件从一处按下、移动、松开到另一处（网页原生拖放与滑块都能用），返回拖拽后的页面内容。两端各给 ref 或 x、y（视口坐标），ref 的位置现查，坐标必须在视口内。选中文字不用拖拽，用 browser_click 的 count: 3。验证码类的拖动校验常会检测轨迹，不承诺成功，这类页面请用 browser_handoff 请用户接管。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        fromRef: { type: "string", description: "起点元素编号，如 e5" },
        fromX: {
          type: "number",
          description: `起点视口横坐标，0–${VIEWPORT.width - 1}`,
        },
        fromY: {
          type: "number",
          description: `起点视口纵坐标，0–${VIEWPORT.height - 1}`,
        },
        toRef: { type: "string", description: "终点元素编号，如 e9" },
        toX: {
          type: "number",
          description: `终点视口横坐标，0–${VIEWPORT.width - 1}`,
        },
        toY: {
          type: "number",
          description: `终点视口纵坐标，0–${VIEWPORT.height - 1}`,
        },
        intent: {
          type: "string",
          maxLength: 500,
          description: INTENT_DESCRIPTION,
        },
      },
      required: ["pageId"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as {
        pageId?: unknown;
        fromRef?: unknown;
        fromX?: unknown;
        fromY?: unknown;
        toRef?: unknown;
        toX?: unknown;
        toY?: unknown;
        intent?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const from = targetArg({
        ref: p.fromRef,
        x: p.fromX,
        y: p.fromY,
        names: { ref: "fromRef", x: "fromX", y: "fromY" },
        usage:
          "起点给 fromRef（如 e5），或给 fromX 和 fromY（视口坐标），二选一",
      });
      const to = targetArg({
        ref: p.toRef,
        x: p.toX,
        y: p.toY,
        names: { ref: "toRef", x: "toX", y: "toY" },
        usage: "终点给 toRef（如 e9），或给 toX 和 toY（视口坐标），二选一",
      });
      const intent = intentArg(p.intent);
      const summary = `拖拽 ${targetText(from)} → ${targetText(to)}`;
      return guarded(async () => {
        const handle = await deps.registry.use(pageId, sessionId, "act");
        await confirmAction(handle, "browser_drag", summary);
        await handle.drag(from, to);
        await acted("browser_drag", pageId, summary);
        return text(
          await content({
            pageId,
            handle,
            action: `drag ${targetText(from)} to ${targetText(to)}`,
            ...(intent === undefined ? {} : { intent }),
            ...(signal ? { signal } : {}),
          }),
        );
      });
    },
  });

  pi.registerTool({
    name: "browser_nav",
    label: "页面后退 / 前进 / 刷新",
    description: `后退、前进或刷新当前页面，返回页面内容。后退与前进通常改地址，会重新读页面；刷新与交出前对比。没有上一页 / 下一页时报错。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        action: {
          type: "string",
          enum: [...NAV_ACTIONS],
          description: "back 后退、forward 前进、reload 刷新",
        },
        intent: {
          type: "string",
          maxLength: 500,
          description: INTENT_DESCRIPTION,
        },
      },
      required: ["pageId", "action"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as {
        pageId?: unknown;
        action?: unknown;
        intent?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const action = p.action;
      if (typeof action !== "string" || !NAV_ACTIONS.includes(action as never))
        throw new Error("action 只能是 back、forward、reload");
      const intent = intentArg(p.intent);
      return guarded(async () => {
        // 不逐动作确认，但仍过租约并写审计与回放。
        const handle = await deps.registry.use(pageId, sessionId, "act");
        if (action === "back") {
          if (!(await handle.back()))
            throw new Error("没有上一页，后退没有生效");
        } else if (action === "forward") {
          if (!(await handle.forward()))
            throw new Error("没有下一页，前进没有生效");
        } else await handle.reload();
        await acted("browser_nav", pageId, NAV_TEXT[action as NavAction]);
        return text(
          await content({
            pageId,
            handle,
            action,
            ...(intent === undefined ? {} : { intent }),
            ...(signal ? { signal } : {}),
          }),
        );
      });
    },
  });

  pi.registerTool({
    name: "browser_upload",
    label: "上传文件到页面",
    description: `Upload local files through an upload entry of the page: ref is the element number of the entry (a file picker button, or <input type=file>). Each entry in files is a path, relative to the base set by host or absolute; host names the machine (or the host:directory) all of them are on — run list_directories to see the hosts and directories of this session. Every file must stay inside its registered directory after resolving symlinks, and must not be a secret or credential file; copy files from elsewhere in first with transfer_files. All files together must stay under 50 MB (what the browser accepts at once). Every upload asks the user for approval, and the card shows the files and the target site.${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        ref: { type: "string", description: "上传入口的元素编号，如 e12" },
        files: {
          type: "array",
          minItems: 1,
          maxItems: UPLOAD_MAX_FILES,
          description: `Paths to upload, 1–${UPLOAD_MAX_FILES}, 50 MB in total at most`,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 4096,
          },
        },
        host: hostProperty(),
        intent: {
          type: "string",
          maxLength: 500,
          description: INTENT_DESCRIPTION,
        },
      },
      required: ["pageId", "ref", "files"],
    } as never,
    async execute(_id, params, signal) {
      const p = params as {
        pageId?: unknown;
        ref?: unknown;
        files?: unknown;
        host?: unknown;
        intent?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const ref = refArg(p.ref);
      const raw = p.files;
      if (!Array.isArray(raw) || raw.length === 0)
        throw new Error(`files 至少要有一个文件，最多 ${UPLOAD_MAX_FILES} 个`);
      if (raw.length > UPLOAD_MAX_FILES)
        throw new Error(
          `一次最多上传 ${UPLOAD_MAX_FILES} 个文件，现在给了 ${raw.length} 个`,
        );
      const files = raw.map((it) => {
        if (typeof it !== "string" || it === "")
          throw new Error(
            "每个 files 项都要是一个非空路径：相对 base 的路径，或绝对路径",
          );
        return it;
      });
      const host = typeof p.host === "string" ? p.host : undefined;
      const intent = intentArg(p.intent);
      return guarded(async () => {
        const handle = await deps.registry.use(pageId, sessionId, "act");
        // 任何一个文件违反硬边界就整体报错：一个字都不传、也不弹卡片。
        const sources = await Promise.all(
          files.map((f) => deps.resolveUpload(host, f)),
        );
        // 合计超限也在这里挡：做不到的请求不去烦用户。
        checkUploadTotal(sources);
        const pageUrl = handle.url();
        const verdict = await deps.approveUpload({
          origin: originOf(pageUrl),
          pageUrl: cutUrl(pageUrl),
          files: sources.map((s) => ({
            name: s.name,
            sizeText: formatSize(s.size),
            display: s.display,
          })),
        });
        if (!verdict.allowed)
          return text(withNote("用户没有批准上传，已取消。", verdict.note));
        // 内容读进内存交给浏览器：交路径再删源文件的话，页面真正读时就读不到了。
        const limit = Math.min(deps.fileMaxBytes(), UPLOAD_MAX_TOTAL_BYTES);
        const payloads: { name: string; buffer: Buffer }[] = [];
        for (const src of sources)
          payloads.push({
            name: src.name,
            buffer: await readUploadSource(src, limit),
          });
        // stat 之后文件可能变大：整体再核一次。
        checkUploadTotal(payloads.map((p) => ({ size: p.buffer.length })));
        await handle.upload(ref, payloads);
        const names = sources.map((s) => s.name);
        await acted(
          "browser_upload",
          pageId,
          `上传 ${names.join("、")} 到 ${ref}`,
        );
        const uploaded = sources
          .map((s) => `${s.name} (${formatSize(s.size)})`)
          .join(", ");
        return text(
          await content({
            pageId,
            handle,
            action: `upload ${sources.length} files to ${ref}`,
            notes: [`UPLOADED: ${uploaded}`],
            ...(intent === undefined ? {} : { intent }),
            ...(signal ? { signal } : {}),
          }),
        );
      });
    },
  });
}
