// 观察类工具：截图、读控制台。不返回页面内容，因此不带 intent，也不写审计与回放。
// 截图四种形态的差别只在取法与说明文字：视口截图与区域截图的像素坐标能拿去点击（设计稿 §1.10）。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { VIEWPORT } from "../engine/types.js";
import {
  coordArg,
  guarded,
  pageIdArg,
  refArg,
  text,
  UNTRUSTED,
  VIEWPORT_TEXT,
} from "./args.js";
import { renderConsole } from "./console-view.js";
import { pngSize } from "./image-size.js";
import type { Kit } from "./kit.js";

// 截图可以指到任意编号：非交互元素的编号也在快照里，只是机械层去掉了空壳 generic 的。
const REF_SOURCE =
  "元素编号来自最近一次快照（含图片、表格这类非交互元素的编号）";
// 只存不给图时的交代：之后用读文件工具读那个附件。
const NO_IMAGE_HINT = "图没有交给你；要看就用读文件工具读上面的文件。";

const CONSOLE_LEVELS = ["warn", "error"] as const;
type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

/** 观察类工具：截图、读控制台。 */
export function registerObserveTools(
  pi: Parameters<ExtensionFactory>[0],
  kit: Kit,
): void {
  const deps = kit.deps;
  const sessionId = kit.sessionId;

  /** 说明文字 + 现有的附件两行 +（没给图时的交代）。 */
  const withAttachment = (
    caption: string,
    marker: string,
    read: boolean,
  ): string =>
    [
      caption,
      `已存为附件：${marker}`,
      "Read it with the file tools (the address is shown above) or copy it into a working directory with transfer_files.",
      ...(read ? [] : [NO_IMAGE_HINT]),
    ].join("\n");

  pi.registerTool({
    name: "browser_screenshot",
    label: "页面截图",
    description: `截取页面画面，四种形态。缺省是不带 ref、不带 fullPage、不带区域的视口截图（${VIEWPORT_TEXT} 的 JPEG）：文字快照读不出的内容（画布、自绘控件、编号对不上）时用它定位。给 ref 就只截这个元素（PNG，${REF_SOURCE}），存表格、图表这类素材时用它；元素边界锁死在 DOM 上，截不到「半个元素」「跨两个元素」。给 fromX、fromY、toX、toY 四个视口坐标就只截这个矩形（PNG）：任意一块、跨元素、大元素里的一段都行；坐标与 browser_click 的 x、y 同一坐标系，所以可以先看视口截图再框一块；区域在视口之外的内容要先滚动到视口里。fullPage 为 true 截整页（JPEG），适合做素材；整页图可能被缩小，看不清细节时看细节用区域或视口截图。ref、fullPage、区域三个只能给一个。read 缺省 true（图随结果给你，同时存进本会话的附件区）；read 为 false 只存附件不给图，之后用读文件工具读那个文件。图上的位置能直接用于 browser_click / browser_move / browser_drag 的 x、y 的只有视口截图与区域截图；元素截图与整页截图不行，它们只用来看或存素材。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        ref: {
          type: "string",
          description: "可选：只截这个元素（最近一次快照里的编号，如 e12）",
        },
        fullPage: {
          type: "boolean",
          description: "true 时截整页（与 ref、区域三选一）",
        },
        fromX: {
          type: "number",
          description: `区域左上角视口横坐标，0–${VIEWPORT.width - 1}`,
        },
        fromY: {
          type: "number",
          description: `区域左上角视口纵坐标，0–${VIEWPORT.height - 1}`,
        },
        toX: {
          type: "number",
          description: `区域右下角视口横坐标，0–${VIEWPORT.width - 1}`,
        },
        toY: {
          type: "number",
          description: `区域右下角视口纵坐标，0–${VIEWPORT.height - 1}`,
        },
        read: {
          type: "boolean",
          description: "缺省 true：图交给模型；false 只存进附件区",
        },
      },
      required: ["pageId"],
    } as never,
    async execute(_id, params) {
      const p = params as {
        pageId?: unknown;
        ref?: unknown;
        fullPage?: unknown;
        fromX?: unknown;
        fromY?: unknown;
        toX?: unknown;
        toY?: unknown;
        read?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const ref = p.ref === undefined ? null : refArg(p.ref);
      const fullPage = p.fullPage === true;
      const corners = [p.fromX, p.fromY, p.toX, p.toY];
      const given = corners.filter((c) => c !== undefined).length;
      if (given !== 0 && given !== corners.length)
        throw new Error("区域要同时给 fromX、fromY、toX、toY");
      if ([ref !== null, fullPage, given !== 0].filter(Boolean).length > 1)
        throw new Error(
          "ref、fullPage、区域（fromX/fromY/toX/toY）只能给一个：要截某个元素就给 ref，要截整页就给 fullPage: true，要截视口里的一块就给四个坐标",
        );
      const rect =
        given === 0
          ? null
          : (() => {
              const x1 = coordArg(p.fromX, "x");
              const y1 = coordArg(p.fromY, "y");
              const x2 = coordArg(p.toX, "x");
              const y2 = coordArg(p.toY, "y");
              // 两个角的先后任意：取最小值，宽高含两端像素（单个点是 1×1）。
              return {
                x: Math.min(x1, x2),
                y: Math.min(y1, y2),
                width: Math.abs(x2 - x1) + 1,
                height: Math.abs(y2 - y1) + 1,
              };
            })();
      const read = p.read !== false;
      return guarded(async () => {
        const handle = await deps.registry.use(pageId, sessionId, "observe");
        const title = (await handle.title()) || "（无标题）";
        const page = `${title} ${handle.url()}`;
        const save = (name: string, bytes: Buffer) =>
          deps.saveAsset({ sessionId, name, bytes });
        /** 区域 / 元素 / 整页截图的结果：（给模型的图）+ 说明与附件行。 */
        const result = (
          image: { data: string; mimeType: string } | null,
          caption: string,
          marker: string,
        ) => ({
          content: [
            ...(image === null
              ? []
              : [
                  {
                    type: "image" as const,
                    data: image.data,
                    mimeType: image.mimeType,
                  },
                ]),
            {
              type: "text" as const,
              text: withAttachment(caption, marker, read),
            },
          ],
          details: {},
        });

        if (rect !== null) {
          const bytes = await handle.screenshotRect(rect);
          const original = pngSize(bytes);
          const saved = await save(
            `region-${rect.x}-${rect.y}-${rect.width}x${rect.height}.png`,
            bytes,
          );
          const image = read ? await deps.modelImage(bytes, "image/png") : null;
          const size =
            original === null
              ? ""
              : `，原图 ${original.width}×${original.height}`;
          // 说明里的两个角用归一后的左上 / 右下：「加上左上角」才是真的偏移。
          const left = `(${rect.x},${rect.y})`;
          const right = `(${rect.x + rect.width - 1},${rect.y + rect.height - 1})`;
          // 交给模型的尺寸与原图不同就声明：缩小过之后偏移量不再直接成立，要按比例换算。
          const w = image?.width ?? original?.width;
          const h = image?.height ?? original?.height;
          const scaled =
            original !== null &&
            w !== undefined &&
            h !== undefined &&
            (w !== original.width || h !== original.height);
          const caption = `区域截图：${page}；视口坐标 ${left}–${right} 的裁剪${size}${
            scaled
              ? `；给模型的是 ${w}×${h}，被缩小过，位置要按比例换算`
              : `；图上位置加上 ${left} 就是视口坐标，可用于 browser_click / browser_move 的 x、y`
          }`;
          return result(image, caption, saved.marker);
        }

        if (ref !== null) {
          const bytes = await handle.screenshotOf(ref);
          const original = pngSize(bytes);
          const saved = await save(`element-${ref}.png`, bytes);
          const image = read ? await deps.modelImage(bytes, "image/png") : null;
          const size =
            original === null
              ? ""
              : `，原图 ${original.width}×${original.height}`;
          let caption = `元素截图 ${ref}：${page}；这不是视口截图${size}，图上的位置不能用于点击，只用来看或存素材`;
          // 交给模型的尺寸与原图不同就声明：图被压缩过，位置更不能拿来点。
          if (image !== null && original !== null) {
            const w = image.width ?? original.width;
            const h = image.height ?? original.height;
            if (w !== original.width || h !== original.height)
              caption += `；给模型的是 ${w}×${h}`;
          }
          return result(image, caption, saved.marker);
        }

        if (fullPage) {
          const shot = await handle.screenshotFull();
          const saved = await save("fullpage.jpg", shot.bytes);
          const image = read
            ? await deps.modelImage(shot.bytes, "image/jpeg")
            : null;
          let caption = `整页截图：${page}；这不是视口截图，原图 ${shot.width}×${shot.height}，图上的位置不能用于点击`;
          if (shot.fullHeight > shot.height)
            caption += `（页面实际高 ${shot.fullHeight}px，只截了前 ${shot.height}px）`;
          if (image !== null) {
            const w = image.width ?? shot.width;
            const h = image.height ?? shot.height;
            if (w !== shot.width || h !== shot.height)
              caption += `；给模型的是 ${w}×${h}，看不清细节，要看细节用 ref 或视口截图`;
          }
          return result(image, caption, saved.marker);
        }

        // 视口截图绕过图片压缩：坐标契约不该依赖用户可调的省流量选项。
        const bytes = await handle.screenshot();
        const saved = await save("screenshot.jpg", bytes);
        const caption = `截图：${page}；视口截图，坐标系：${VIEWPORT_TEXT}，左上角为原点，图上的像素位置可直接用于 browser_click / browser_move / browser_drag 的 x、y`;
        return {
          content: [
            ...(read
              ? [
                  {
                    type: "image" as const,
                    mimeType: "image/jpeg",
                    data: bytes.toString("base64"),
                  },
                ]
              : []),
            {
              type: "text" as const,
              text: withAttachment(caption, saved.marker, read),
            },
          ],
          details: {},
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_console",
    label: "页面控制台",
    description: `读页面控制台消息与失败请求（与用户控制台抽屉读的是同一份缓冲）。相同的消息折叠成「×n」算一条；每条截到 500 字符，最多的几条之外按预算省略。level 取 warn 或 error，只看该级别及以上（失败请求与页面未捕获异常都算 error）。有省略时全文存成本会话的附件，结果里给出路径。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        level: {
          type: "string",
          enum: [...CONSOLE_LEVELS],
          description: "可选：warn 或 error，只看该级别及以上",
        },
      },
      required: ["pageId"],
    } as never,
    async execute(_id, params) {
      const p = params as { pageId?: unknown; level?: unknown };
      const pageId = pageIdArg(p.pageId);
      if (
        p.level !== undefined &&
        (typeof p.level !== "string" ||
          !CONSOLE_LEVELS.includes(p.level as never))
      )
        throw new Error("level 只能是 warn 或 error");
      const level = p.level as ConsoleLevel | undefined;
      return guarded(async () => {
        // 不碰页面线程：对话框挂着时照常能读。
        const handle = await deps.registry.use(pageId, sessionId, "observe", {
          allowDialog: true,
        });
        const view = renderConsole(handle.console(), {
          evicted: handle.consoleEvicted(),
          ...(level === undefined ? {} : { level }),
          now: Date.now(),
        });
        if (!view.elided) return text(view.text);
        const saved = await deps.saveAsset({
          sessionId,
          name: `console-${pageId}.txt`,
          bytes: Buffer.from(view.full, "utf8"),
        });
        return text(`${view.text}\nFULL LOG: ${saved.marker}`);
      });
    },
  });
}
