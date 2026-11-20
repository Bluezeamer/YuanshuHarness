// 网页链接卡片的信息：抓页面开头一段，取标题、摘要、封面、站点图标。只给界面展示用，不写进画布文件。
// 由 Server 去抓（不是浏览器、也不是目录所在的主机）：只认 http / https，有超时与大小上限，不带 cookie。

export interface LinkMeta {
  /** 跟随跳转之后的最终地址 */
  url: string;
  title: string | null;
  description: string | null;
  /** 封面图地址（绝对的 http / https），界面直接给 <img> 用 */
  image: string | null;
  /** 站点图标地址 */
  icon: string | null;
  site: string | null;
  /** 页面没抓到（网络不通、超时、对方拒绝）：界面退回只显示地址 */
  failed: boolean;
}

export interface LinkServiceOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 只读页面开头这么多字节；标题与 meta 都在 <head> 里 */
  maxBytes?: number;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

const UA = "Mozilla/5.0 (compatible; YuanshuLinkPreview/1.0)";
const MAX_TITLE = 200;
const MAX_DESC = 400;

/** 只放行 http / https 的地址；其余（file:、javascript:、data: 等）返回 null */
export function parseHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X"
          ? Number.parseInt(e.slice(2), 16)
          : Number.parseInt(e.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const squash = (s: string): string =>
  decodeEntities(s).replace(/\s+/g, " ").trim();

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const m of tag.matchAll(re))
    out[(m[1] as string).toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

const clip = (s: string | null | undefined, max: number): string | null => {
  const t = s ? squash(s) : "";
  return t === "" ? null : t.slice(0, max);
};

/** 把页面里的相对地址换成绝对的 http(s) 地址；其余协议（data:、javascript:）丢掉 */
const absolute = (href: string | undefined, base: string): string | null => {
  if (!href) return null;
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
};

/** 从页面开头一段 HTML 里取标题、摘要、封面、图标（正则够用：只看 <head> 里的 meta 与 link） */
export function parseHtmlMeta(
  html: string,
  finalUrl: string,
): Omit<LinkMeta, "url" | "failed"> {
  const meta = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    const key = (a.property ?? a.name ?? "").toLowerCase();
    if (key !== "" && a.content !== undefined && !meta.has(key))
      meta.set(key, a.content);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let icon: string | null = null;
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    if (/(^|\s)(shortcut\s+)?icon(\s|$)/i.test(a.rel ?? "") && a.href) {
      icon = absolute(a.href, finalUrl);
      if (icon) break;
    }
  }
  return {
    title: clip(
      meta.get("og:title") ?? meta.get("twitter:title") ?? titleTag,
      MAX_TITLE,
    ),
    description: clip(
      meta.get("og:description") ??
        meta.get("twitter:description") ??
        meta.get("description"),
      MAX_DESC,
    ),
    image: absolute(
      meta.get("og:image") ?? meta.get("twitter:image"),
      finalUrl,
    ),
    icon: icon ?? absolute("/favicon.ico", finalUrl),
    site: clip(meta.get("og:site_name"), MAX_TITLE),
  };
}

const failed = (url: string): LinkMeta => ({
  url,
  title: null,
  description: null,
  image: null,
  icon: null,
  site: null,
  failed: true,
});

/** 读响应体的开头 maxBytes 字节（读够或看到 </head> 就停，不把整页拉下来） */
async function readHead(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const tail = new TextDecoder("latin1");
  let seen = "";
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
    // 连上一段的结尾一起找：</head> 可能被切在两块之间
    const text = seen + tail.decode(value, { stream: true });
    if (/<\/head>/i.test(text)) break;
    seen = text.slice(-8);
  }
  await reader.cancel().catch(() => undefined);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.subarray(0, Math.min(total, maxBytes));
}

/** 响应头里的 charset，没有就看页面开头 2KB 里的 <meta charset>，都没有按 utf-8 */
function decodeBody(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export class LinkService {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; meta: LinkMeta }>();
  /** 同一个地址的并发请求共用一次抓取 */
  private readonly inflight = new Map<string, Promise<LinkMeta>>();

  constructor(opts: LinkServiceOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.maxBytes = opts.maxBytes ?? 512 * 1024;
    this.ttlMs = opts.ttlMs ?? 6 * 3600 * 1000;
    this.maxEntries = opts.maxEntries ?? 500;
    this.now = opts.now ?? Date.now;
  }

  /** url 必须已经过 parseHttpUrl。抓失败不抛错：返回 failed 的结果（不进缓存，下次再试） */
  async get(url: string): Promise<LinkMeta> {
    const hit = this.cache.get(url);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.meta;
    const running = this.inflight.get(url);
    if (running) return running;
    const job = this.fetchMeta(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, job);
    return job;
  }

  private async fetchMeta(url: string): Promise<LinkMeta> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml",
        },
      });
    } catch {
      return failed(url);
    }
    // 跟随跳转之后可能落到别的协议（不会，fetch 只跟 http/https），以最终地址为准
    const finalUrl = res.url || url;
    if (!res.ok) return failed(url);
    const type = res.headers.get("content-type") ?? "";
    let meta: LinkMeta;
    if (/html/i.test(type)) {
      try {
        const html = decodeBody(await readHead(res, this.maxBytes), type);
        meta = {
          url: finalUrl,
          ...parseHtmlMeta(html, finalUrl),
          failed: false,
        };
      } catch {
        return failed(url);
      }
    } else {
      // 图片、PDF 等：没有页面信息，图片直接当封面
      await res.body?.cancel().catch(() => undefined);
      meta = {
        url: finalUrl,
        title: null,
        description: null,
        image: /^image\//i.test(type) ? finalUrl : null,
        icon: absolute("/favicon.ico", finalUrl),
        site: null,
        failed: false,
      };
    }
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(url, { at: this.now(), meta });
    return meta;
  }
}
