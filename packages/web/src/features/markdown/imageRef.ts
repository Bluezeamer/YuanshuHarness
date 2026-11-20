import { sessionDirectories } from "../../api/directories";
import { listEnvironments } from "../../api/environments";
import { loadToken } from "../../api/http";

// 对话里的图片引用：`file:<主机>:<绝对路径>`（也接受 file:// 形式），主机名规则与服务端 session/address.ts 一致：
// local = 会话主目录所在的主机，server = Server 本机，attachment = 附件区（路径以附件区根为 `/`），其余是连接名或 id。
// 绝对路径必须带主机；裸相对路径按会话的主目录解析 —— 模型直接写 ![](chart.png) 也能显示。
// 解析不了就抛 RefError，message 是给用户看的原因。

const LOCAL_ENV = "local";
export const ATTACHMENT_ENV = "attachment";

/** 引用解析失败：message 直接显示给用户 */
export class RefError extends Error {}

export interface ImageTarget {
  env: string;
  path: string;
}

/** 文档里的相对图片地址相对于谁（对话里没有这个，按会话 directory 解析） */
export type ImageBase =
  /** 普通文件：相对这个 md 所在目录，走文件接口 */
  | { kind: "file"; env: string; dir: string }
  /** `.canvas/` 里的笔记：project 是画布所在项目目录，note 是笔记路径（相对 `.canvas/`），走画布接口（读 Server 本机副本） */
  | { kind: "canvas"; env: string; project: string; note: string };

interface ParsedRef {
  host?: string;
  path: string;
  relative: boolean;
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** 解析图片地址；不是可识别的文件引用返回 null。 */
export function parseImageRef(raw: string): ParsedRef | null {
  const src = raw.trim();
  if (src === "") return null;
  if (/^file:\/\//i.test(src)) {
    const rest = src.replace(/^file:\/\//i, "");
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    const host = decode(rest.slice(0, slash));
    return {
      ...(host === "" ? {} : { host }),
      path: decode(rest.slice(slash)),
      relative: false,
    };
  }
  if (/^file:/i.test(src)) {
    const rest = src.replace(/^file:/i, "");
    if (rest.startsWith("/")) return { path: decode(rest), relative: false };
    const colon = rest.indexOf(":");
    if (colon <= 0) return null;
    return {
      host: decode(rest.slice(0, colon)),
      path: decode(rest.slice(colon + 1)),
      relative: false,
    };
  }
  if (src.startsWith("/")) return { path: decode(src), relative: false };
  return { path: decode(src), relative: true };
}

export function joinPath(root: string, rel: string): string {
  const base = `${root.replace(/\/+$/, "")}/${rel.replace(/^(\.?\/)+/, "")}`;
  const out: string[] = [];
  for (const part of base.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

let envs: Promise<Map<string, string>> | null = null;
function envIndex(): Promise<Map<string, string>> {
  envs ??= listEnvironments(loadToken())
    .then((res) => {
      const map = new Map<string, string>();
      for (const e of res.ok ? res.data : []) {
        map.set(e.id, e.id);
        map.set(e.name, e.id);
      }
      return map;
    })
    .catch(() => new Map<string, string>());
  return envs;
}

/** 会话的主目录（第一个 directory）：相对路径与 local 主机都指向它 */
interface Primary {
  env: string;
  path: string;
}

const primaryCache = new Map<string, Promise<Primary | null>>();
function primaryOf(sessionId: string): Promise<Primary | null> {
  const hit = primaryCache.get(sessionId);
  if (hit) return hit;
  const p = sessionDirectories(loadToken(), sessionId)
    .then((res) => {
      const d = res.ok ? res.data[0] : undefined;
      return d ? { env: d.environmentId, path: d.path } : null;
    })
    .catch(() => null);
  primaryCache.set(sessionId, p);
  return p;
}

async function envOfHost(
  host: string,
  sessionId: string | undefined,
): Promise<string> {
  const name = host.toLowerCase();
  if (name === ATTACHMENT_ENV) return ATTACHMENT_ENV;
  if (name === "server") return LOCAL_ENV;
  if (name === "local") {
    // 没有会话（独立预览）时无从知道主目录，按 Server 本机
    const primary = sessionId ? await primaryOf(sessionId) : null;
    return primary?.env ?? LOCAL_ENV;
  }
  const map = await envIndex();
  const hit = [...map].find(([k]) => k.toLowerCase() === name);
  if (!hit) throw new RefError(`没有叫「${host}」的主机`);
  return hit[1];
}

/**
 * 笔记里的相对图片地址 → 相对 `.canvas/` 的路径（`产品/访谈.assets/a.png`，出了 `.canvas/` 的是 `../…`）。
 * 不是相对路径（绝对路径、file:、外链）返回 null。
 */
export function canvasRelOf(raw: string, note: string): string | null {
  const parsed = parseImageRef(raw);
  if (!parsed?.relative || /^[a-z][a-z0-9+.-]*:/i.test(parsed.path))
    return null;
  const out = note.split("/").slice(0, -1);
  for (const part of parsed.path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") out.push(part);
    else if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push("..");
  }
  return out.join("/");
}

/** 把引用解析成「环境 + 绝对路径」；解析不了抛 RefError。attachment 环境的路径以附件区根为 `/`。 */
export async function resolveImageTarget(
  raw: string,
  sessionId: string | undefined,
  base?: Extract<ImageBase, { kind: "file" }>,
): Promise<ImageTarget> {
  const parsed = parseImageRef(raw);
  if (!parsed) throw new RefError("地址格式不对，应为 file:主机:/绝对路径");
  if (parsed.relative && /^[a-z][a-z0-9+.-]*:/i.test(parsed.path))
    throw new RefError(
      "不会自动加载外链图片，请用 file:主机:/路径 引用本地文件",
    );
  if (parsed.relative) {
    if (base) return { env: base.env, path: joinPath(base.dir, parsed.path) };
    const primary = sessionId ? await primaryOf(sessionId) : null;
    if (!primary) throw new RefError("没有会话目录，无法定位相对路径");
    return { env: primary.env, path: joinPath(primary.path, parsed.path) };
  }
  if (!parsed.host)
    throw new RefError("绝对路径缺少主机名，应写成 file:主机:/绝对路径");
  if (!parsed.path.startsWith("/"))
    throw new RefError("主机名后面要跟以 / 开头的绝对路径");
  return { env: await envOfHost(parsed.host, sessionId), path: parsed.path };
}
