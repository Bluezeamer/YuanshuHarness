// 页面资源的「清单」与「按地址取字节」。
// 清单来自浏览器的资源树（resource.ts）；取字节先试浏览器缓存，取不到再用本上下文发一次新请求
// （带页面的 cookie 与本上下文的代理，出口与浏览器一致）。
import type { APIResponse, BrowserContext, Page } from "playwright-core";
import { formatSize } from "../../session/attachments.js";
import { denyText } from "../net/proxy.js";
import { listResources, loadResources } from "./resource.js";
import type { AssetResult, PageAsset } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;

/** 页面里收集到的一张 <img>（在浏览器里跑，必须自包含）。 */
export interface CollectedImage {
  src: string;
  alt: string;
  width: number;
  height: number;
}

// 浏览器里的 DOM 形状（server 的 tsconfig 不含 dom 库）。
interface DomImage {
  tagName: string;
  complete: boolean;
  currentSrc: string;
  alt: string;
  naturalWidth: number;
  naturalHeight: number;
}

interface DomScope {
  querySelectorAll(selectors: string): ArrayLike<DomImage>;
}

/**
 * 在页面里收集范围内的 <img>：给了 root（ref 指到的元素）就收它里面的，指到 <img> 本身就只有它；
 * 不给就收整页。函数会被序列化进浏览器执行，只能引用 DOM 与自己的参数（上面的形状只为过类型）。
 */
export function collectImages(
  root: DomImage | DomScope | undefined,
): CollectedImage[] {
  const scope: DomScope =
    (root as DomScope | undefined) ??
    (globalThis as unknown as { document: DomScope }).document;
  // <img> 元素自己也有 querySelectorAll，所以按 tagName 判断「指到图片本身」。
  const list: Iterable<DomImage> =
    root !== undefined && (root as DomImage).tagName === "IMG"
      ? [root as DomImage]
      : Array.from(scope.querySelectorAll("img"));
  const out: CollectedImage[] = [];
  for (const img of list) {
    if (!img.complete || img.currentSrc === "") continue;
    out.push({
      src: img.currentSrc,
      alt: img.alt,
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  }
  return out;
}

// 浏览器里要读的媒体元素（tsconfig 没有 dom 库，只写用到的成员）。
interface DomMediaElement {
  tagName: string;
  currentSrc: string;
  getAttribute(name: string): string | null;
}

interface DomMediaScope {
  querySelectorAll(selectors: string): ArrayLike<DomMediaElement>;
  baseURI: string;
}

/**
 * 在页面里收集 ref 范围内引用的资源地址：<img> 的 currentSrc、<video> / <audio> 的 currentSrc 与
 * poster 属性。CSS 背景图不算（那个只在整页清单里看）。地址在这里就按 baseURI 解析成绝对地址。
 * 同样会被序列化进浏览器执行。
 */
export function collectRefUrls(
  root: DomMediaElement | DomMediaScope | undefined,
): string[] {
  const scope: DomMediaScope =
    (root as DomMediaScope | undefined) ??
    (globalThis as unknown as { document: DomMediaScope }).document;
  // 指到媒体元素本身时只有它（它自己也有 querySelectorAll，按 tagName 判断）。
  const tag = (root as DomMediaElement | undefined)?.tagName;
  const list: DomMediaElement[] =
    tag === "IMG" || tag === "VIDEO" || tag === "AUDIO"
      ? [root as DomMediaElement]
      : Array.from(scope.querySelectorAll("img, video, audio"));
  const out: string[] = [];
  const push = (raw: string | null) => {
    if (raw === null || raw === "") return;
    try {
      out.push(new URL(raw, scope.baseURI).href);
    } catch {
      // 不是能解析的地址：清单里本来也不会有它
    }
  };
  for (const el of list) {
    push(el.currentSrc);
    if (el.tagName !== "IMG") push(el.getAttribute("poster"));
  }
  return [...new Set(out)];
}

/**
 * 页面此刻已加载的资源清单（所有类型，交给上层筛）。图片按地址补上 alt 与自然尺寸；
 * 给了 scope.ref 就只留这个元素子树里引用的地址。
 */
export async function listAssets(
  ctx: BrowserContext,
  page: Page,
  scope: { ref?: string } = {},
): Promise<PageAsset[]> {
  const ref = scope.ref;
  const locator = ref === undefined ? null : page.locator(`aria-ref=${ref}`);
  const [resources, collected] = await Promise.all([
    listResources(ctx, page),
    locator === null
      ? page.evaluate(collectImages, undefined)
      : locator.evaluate(collectImages),
  ]);
  const refUrls =
    locator === null ? null : new Set(await locator.evaluate(collectRefUrls));
  const images = new Map(collected.map((i) => [i.src, i]));
  const out: PageAsset[] = [];
  for (const res of resources) {
    if (refUrls !== null && !refUrls.has(res.url)) continue;
    const img = images.get(res.url);
    out.push({
      url: res.url,
      type: res.type,
      mime: res.mime,
      size: res.size,
      frame: res.main ? "main" : "sub",
      ...(img === undefined
        ? {}
        : { alt: img.alt, width: img.width, height: img.height }),
    });
  }
  return out;
}

/** Playwright 的报错取第一行（多行里第一行才是原因）。 */
export function firstLine(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return (
    m
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? m
  );
}

/** 响应头里的 content-type 去掉参数部分。 */
function mimeOf(res: { headers(): Record<string, string> }): string {
  return (res.headers()["content-type"] ?? "").split(";")[0]?.trim() ?? "";
}

/**
 * 逐个取这些地址的字节，每个结果立刻交给 onResult（不攒缓冲区）。
 * 先读浏览器缓存（与页面同一身份、不发新请求）；取不到再发一次新请求：
 * 已知局限：APIRequestContext 会把整个响应读进内存，没有流式读取，头部也拿不到可靠的大小，
 * 所以对不支持 Range 的服务器上的大文件会整份进内存再丢弃。不为此另加保护。
 */
export async function fetchAssets(
  ctx: BrowserContext,
  page: Page,
  urls: string[],
  opts: { referer: string; maxBytes: number },
  onResult: (r: AssetResult) => Promise<void>,
): Promise<void> {
  const cached = await loadResources(ctx, page, urls);
  for (const url of urls) {
    const hit = cached.get(url);
    if (hit !== undefined) {
      await onResult(
        hit.bytes.length > opts.maxBytes
          ? {
              url,
              ok: false,
              reason: `超过大小上限（${formatSize(opts.maxBytes)}）`,
            }
          : {
              url,
              ok: true,
              mime: hit.mime,
              bytes: hit.bytes,
              viaRequest: false,
            },
      );
      continue;
    }
    // data: / blob: 只在浏览器手里，缓存取不到就没有别处可取。
    if (!/^https?:/i.test(url)) {
      await onResult({ url, ok: false, reason: "浏览器缓存里没有这份资源" });
      continue;
    }
    let res: APIResponse;
    try {
      res = await ctx.request.get(url, {
        headers: { referer: opts.referer },
        timeout: REQUEST_TIMEOUT_MS,
        failOnStatusCode: false,
      });
    } catch (err) {
      await onResult({ url, ok: false, reason: firstLine(err) });
      continue;
    }
    let result: AssetResult;
    try {
      result = await fromResponse(url, res, opts.maxBytes);
    } finally {
      // Playwright 把响应体留在上下文里直到 dispose：不释放，30 个大文件会一直占着内存。
      await res.dispose().catch(() => {});
    }
    await onResult(result);
  }
}

/** 新请求的响应 → 结果：网络层拒绝、非 2xx、读不出内容、超上限各自写清原因。 */
async function fromResponse(
  url: string,
  res: APIResponse,
  maxBytes: number,
): Promise<AssetResult> {
  const deny = res.headers()["x-yuanshu-deny"];
  if (deny !== undefined) return { url, ok: false, reason: denyText(deny) };
  if (res.status() < 200 || res.status() > 299)
    return { url, ok: false, reason: `HTTP ${res.status()}` };
  const body = await res.body().catch(() => null);
  if (body === null) return { url, ok: false, reason: "读取响应内容失败" };
  if (body.length > maxBytes)
    return {
      url,
      ok: false,
      reason: `超过大小上限（${formatSize(maxBytes)}）`,
    };
  return { url, ok: true, mime: mimeOf(res), bytes: body, viaRequest: true };
}
