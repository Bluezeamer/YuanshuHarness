// 页面「已加载的资源」：CDP 的资源树 + Page.getResourceContent。
// 不触 DOM、不发新请求：同源 / 跨源 / data: / blob: 的资源都按浏览器手里的字节原样取回。
import type { BrowserContext, CDPSession, Page } from "playwright-core";

/** 资源树里的一项（上层要用的字段）。 */
export interface ResourceInfo {
  url: string;
  /** 浏览器的资源类型，小写：image / media / script / stylesheet / font / document / other … */
  type: string;
  mime: string;
  /** contentSize；没有或 0 是 null */
  size: number | null;
  frameId: string;
  main: boolean;
}

export interface LoadedResource {
  url: string;
  mime: string;
  bytes: Buffer;
}

/** 资源树里的一个节点（只要这一层字段）。 */
interface ResourceNode {
  url: string;
  type: string;
  mimeType: string;
  contentSize?: number;
}

interface FrameTreeNode {
  frame: { id: string };
  resources?: ResourceNode[];
  childFrames?: FrameTreeNode[];
}

const noop = () => {};

/** 递归收集 frame 树里的资源（所有类型，子 frame 也要）：按地址去重，先出现的先留下。 */
function collectResources(
  node: FrameTreeNode,
  main: boolean,
  into: Map<string, ResourceInfo>,
): void {
  for (const res of node.resources ?? []) {
    if (res.url === "" || into.has(res.url)) continue;
    into.set(res.url, {
      url: res.url,
      type: res.type.toLowerCase(),
      mime: res.mimeType,
      size:
        res.contentSize === undefined || res.contentSize === 0
          ? null
          : res.contentSize,
      frameId: node.frame.id,
      main,
    });
  }
  for (const child of node.childFrames ?? [])
    collectResources(child, false, into);
}

/** 一次开 CDP 会话取整棵资源树；用完 detach。 */
export async function listResources(
  ctx: BrowserContext,
  page: Page,
): Promise<ResourceInfo[]> {
  const cdp: CDPSession = await ctx.newCDPSession(page);
  try {
    await cdp.send("Page.enable");
    const tree = (await cdp.send("Page.getResourceTree")) as {
      frameTree: FrameTreeNode;
    };
    const index = new Map<string, ResourceInfo>();
    collectResources(tree.frameTree, true, index);
    return [...index.values()];
  } finally {
    await cdp.detach().catch(noop);
  }
}

/**
 * 一次开 CDP 会话取一批 URL 的字节；取不到的（不在资源树里、已被回收）不在结果里。
 * 单个失败只跳过这一个，不影响其余；会话用完 detach。
 */
export async function loadResources(
  ctx: BrowserContext,
  page: Page,
  urls: string[],
): Promise<Map<string, LoadedResource>> {
  const out = new Map<string, LoadedResource>();
  if (urls.length === 0) return out;
  const cdp: CDPSession = await ctx.newCDPSession(page);
  try {
    // 不 enable 时 getResourceContent 报 "Agent is not enabled"。
    await cdp.send("Page.enable");
    const tree = (await cdp.send("Page.getResourceTree")) as {
      frameTree: FrameTreeNode;
    };
    const index = new Map<string, ResourceInfo>();
    collectResources(tree.frameTree, true, index);
    for (const url of new Set(urls)) {
      const hit = index.get(url);
      if (!hit) continue;
      try {
        const res = (await cdp.send("Page.getResourceContent", {
          frameId: hit.frameId,
          url,
        })) as { content: string; base64Encoded: boolean };
        out.set(url, {
          url,
          mime: hit.mime,
          bytes: res.base64Encoded
            ? Buffer.from(res.content, "base64")
            : Buffer.from(res.content, "utf8"),
        });
      } catch {
        // 资源已被回收：这一份没有，继续下一份。
      }
    }
    return out;
  } finally {
    await cdp.detach().catch(noop);
  }
}
