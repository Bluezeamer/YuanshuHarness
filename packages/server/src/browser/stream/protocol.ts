// 画面流的协议：服务端事件、客户端消息与校验。纯逻辑，不碰 HTTP / WebSocket；
// 校验通过后只拷贝认识的字段，客户端多传的东西不会漏进句柄。
import { isObject } from "../../lib/validate.js";
import type { ConsoleEntry, InputEvent } from "../engine/types.js";
import type { PageView } from "../pages/types.js";

/** 画面参数：先定一组，之后可调。 */
export const FRAME_OPTS = {
  maxWidth: 1280,
  maxHeight: 800,
  maxFps: 30,
  quality: 60,
} as const;

// 输入坐标的合法范围就是画面尺寸：越界拒绝，不夹取。
const MAX_X = FRAME_OPTS.maxWidth;
const MAX_Y = FRAME_OPTS.maxHeight;
const MAX_WHEEL_DELTA = 10_000;
const MAX_KEY_LEN = 32;
const MAX_TEXT_LEN = 4000;
const MAX_TARGET_LEN = 2000;

export type StreamEvent =
  | { type: "state"; page: PageView; operator: boolean }
  | { type: "console"; entry: ConsoleEntry }
  | { type: "copied"; text: string } // 回给发起 copy 的那个窗口：页面里此刻选中的文字
  | { type: "clipboard"; text: string } // 页面自己写了剪贴板（分享 / 复制按钮）：只发给操作窗口
  | { type: "error"; message: string }
  | { type: "pong" } // 回给客户端的 ping（回前台探活）：连接层直接答，不经中枢
  | { type: "closed" };

export type ClientMessage =
  | { type: "input"; event: InputEvent }
  | { type: "nav"; action: "back" | "forward" | "reload" }
  | { type: "nav"; action: "goto"; target: string }
  | { type: "copy" } // 取页面里选中的文字（浏览器的剪贴板只能由前端写）
  | { type: "take" };

export type Parsed =
  | { ok: true; msg: ClientMessage }
  | { ok: false; error: string };

const fail = (error: string): Parsed => ({ ok: false, error });

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const isClickCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 3;

/** 视口内的坐标；不合法时返回中文原因。 */
function coord(v: unknown, max: number): number | string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "鼠标坐标必须是数字";
  if (v < 0 || v >= max) return `鼠标坐标超出视口 ${MAX_X}×${MAX_Y}`;
  return v;
}

/** 一次取 x、y：先报不合格的那个，避免两个都错时说错重点。 */
function point(m: Record<string, unknown>): { x: number; y: number } | string {
  const x = coord(m.x, MAX_X);
  if (typeof x === "string") return x;
  const y = coord(m.y, MAX_Y);
  if (typeof y === "string") return y;
  return { x, y };
}

function mouse(m: Record<string, unknown>): Parsed {
  const { action, button, clickCount } = m;
  if (action !== "move" && action !== "down" && action !== "up")
    return fail("鼠标动作只能是 move / down / up");
  const p = point(m);
  if (typeof p === "string") return fail(p);
  if (
    button !== undefined &&
    button !== "left" &&
    button !== "middle" &&
    button !== "right"
  )
    return fail("鼠标按键只能是 left / middle / right");
  if (clickCount !== undefined && !isClickCount(clickCount))
    return fail("点击次数必须是 1–3 的整数");
  return {
    ok: true,
    msg: {
      type: "input",
      event: {
        type: "mouse",
        action,
        x: p.x,
        y: p.y,
        ...(button === undefined ? {} : { button }),
        ...(clickCount === undefined ? {} : { clickCount }),
      },
    },
  };
}

function wheel(m: Record<string, unknown>): Parsed {
  const p = point(m);
  if (typeof p === "string") return fail(p);
  const { deltaX, deltaY } = m;
  if (!isFiniteNumber(deltaX) || !isFiniteNumber(deltaY))
    return fail("滚轮位移必须是数字");
  if (Math.abs(deltaX) > MAX_WHEEL_DELTA || Math.abs(deltaY) > MAX_WHEEL_DELTA)
    return fail(`滚轮位移过大，绝对值不能超过 ${MAX_WHEEL_DELTA}`);
  return {
    ok: true,
    msg: {
      type: "input",
      event: { type: "wheel", x: p.x, y: p.y, deltaX, deltaY },
    },
  };
}

function key(m: Record<string, unknown>): Parsed {
  const { action, key: name } = m;
  if (action !== "down" && action !== "up")
    return fail("按键动作只能是 down / up");
  if (name === undefined) return fail("缺少按键名 key");
  if (typeof name !== "string") return fail("按键名必须是字符串");
  // 按字符数算：中文输入法递进来的一个字符也算 1 个。
  const len = [...name].length;
  if (len < 1 || len > MAX_KEY_LEN)
    return fail(`按键名长度必须是 1–${MAX_KEY_LEN} 个字符`);
  return {
    ok: true,
    msg: { type: "input", event: { type: "key", action, key: name } },
  };
}

function text(m: Record<string, unknown>): Parsed {
  const value = m.text;
  if (value === undefined) return fail("缺少文字 text");
  if (typeof value !== "string") return fail("文字必须是字符串");
  const len = [...value].length;
  if (len < 1 || len > MAX_TEXT_LEN)
    return fail(`文字长度必须是 1–${MAX_TEXT_LEN} 个字符`);
  return {
    ok: true,
    msg: { type: "input", event: { type: "text", text: value } },
  };
}

function input(m: Record<string, unknown>): Parsed {
  const ev = m.event;
  if (!isObject(ev)) return fail("缺少输入事件 event");
  if (ev.type === "mouse") return mouse(ev);
  if (ev.type === "wheel") return wheel(ev);
  if (ev.type === "key") return key(ev);
  if (ev.type === "text") return text(ev);
  return fail("输入事件的 type 只能是 mouse / wheel / key / text");
}

function nav(m: Record<string, unknown>): Parsed {
  const { action, target: raw } = m;
  if (action === "back" || action === "forward" || action === "reload")
    return { ok: true, msg: { type: "nav", action } };
  if (action !== "goto")
    return fail("导航动作只能是 back / forward / reload / goto");
  if (raw === undefined) return fail("goto 缺少目标地址 target");
  if (typeof raw !== "string") return fail("目标地址必须是字符串");
  const target = raw.trim();
  if (target === "") return fail("目标地址不能为空");
  if (target.length > MAX_TARGET_LEN)
    return fail(`目标地址过长，最多 ${MAX_TARGET_LEN} 个字符`);
  return { ok: true, msg: { type: "nav", action: "goto", target } };
}

/**
 * 排队时相邻的两条输入能不能并成一条：鼠标移动只留最后的位置，滚轮位移相加（位置取最后的）；
 * 点击、键盘等不合并。它们每秒几十条、每条一次浏览器往返，处理不过来就越排越长，后面的点击要等很久。
 */
export function mergeInput(
  prev: ClientMessage,
  next: ClientMessage,
): ClientMessage | null {
  if (prev.type !== "input" || next.type !== "input") return null;
  const a = prev.event;
  const b = next.event;
  if (
    a.type === "mouse" &&
    a.action === "move" &&
    b.type === "mouse" &&
    b.action === "move"
  )
    return next;
  if (a.type === "wheel" && b.type === "wheel")
    return {
      type: "input",
      event: {
        ...b,
        deltaX: a.deltaX + b.deltaX,
        deltaY: a.deltaY + b.deltaY,
      },
    };
  return null;
}

export function parseClientMessage(raw: unknown): Parsed {
  if (!isObject(raw)) return fail("消息必须是 JSON 对象");
  switch (raw.type) {
    case "input":
      return input(raw);
    case "nav":
      return nav(raw);
    case "copy":
      return { ok: true, msg: { type: "copy" } };
    case "take":
      return { ok: true, msg: { type: "take" } };
    default:
      return fail("未知消息类型，只支持 input / nav / copy / take");
  }
}
