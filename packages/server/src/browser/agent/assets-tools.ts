// 资源类工具：列页面已加载的资源清单，或按地址把资源存进附件区。
// 只读 / 观察类（不带 intent、不记回放）；清单外的地址要过与 browser_open 同一套站点授权。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AssetResult } from "../engine/types.js";
import { resolveTarget, type Target } from "../net/target.js";
import { guarded, pageIdArg, refArg, text, UNTRUSTED } from "./args.js";
import { assetFileName } from "./assets.js";
import {
  renderAssetList,
  renderSaveResult,
  type SaveRow,
} from "./assets-view.js";
import type { Kit } from "./kit.js";

/** 一次最多保存这么多个地址。 */
const URLS_MAX = 30;
/** 不带 type 时只列这两类（搜集资料用得最多）。 */
const DEFAULT_TYPES = ["image", "media"];

/** 可选的地址数组：不是数组、有非字符串、空数组、超过上限都直接报错。 */
function urlsArg(v: unknown): string[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) throw new Error("urls 必须是地址数组");
  if (v.length === 0)
    throw new Error("urls 不能是空数组：要取资源就给至少一个地址");
  if (v.length > URLS_MAX)
    throw new Error(
      `urls 一次最多 ${URLS_MAX} 个地址，现在 ${v.length} 个：请分几次取`,
    );
  return v.map((u, i) => {
    if (typeof u !== "string" || u === "")
      throw new Error(`urls 的第 ${i + 1} 项必须是非空字符串（地址）`);
    return u;
  });
}

/** 可选类型串：逗号分隔，不分大小写；不传就是缺省的 image、media。 */
function typesArg(v: unknown): string[] {
  if (v === undefined) return [...DEFAULT_TYPES];
  if (typeof v !== "string")
    throw new Error("type 必须是逗号分隔的类型，如 image,media");
  const types = v
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== "");
  if (types.length === 0) throw new Error("type 不能是空串");
  return [...new Set(types)];
}

/** 资源类工具：browser_assets（清单 / 保存）。 */
export function registerAssetTools(
  pi: Parameters<ExtensionFactory>[0],
  kit: Kit,
): void {
  const deps = kit.deps;
  const sessionId = kit.sessionId;

  pi.registerTool({
    name: "browser_assets",
    label: "页面资源",
    description: `把页面里的资源（图片、音视频、脚本、样式、字体等）存进本会话的附件区。不带 urls 先列清单（只读）：给出页面此刻已加载的资源、地址、大小与图片的尺寸，占位图与真图一眼可辨；带 urls 就按地址保存这些资源。地址可以来自清单，也可以来自 browser_dom、快照里看到的地址。保存时优先从浏览器缓存取（不发新请求、与页面同一身份），取不到才用本上下文发一次新请求（同样带页面的登录态、走同一个出口）；清单外（页面没加载过）的地址要过与 browser_open 相同的站点授权。清单只含页面已加载的资源：favicon、fetch / XHR 请求不在里面（看网络请求用调试组的工具）；data: 内联图在清单里只有说明、不能按地址取，要存用 browser_screenshot 的 ref 截图。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        urls: {
          type: "array",
          items: { type: "string", minLength: 1 },
          maxItems: URLS_MAX,
          description: `要保存的地址（相对地址按页面地址解析），最多 ${URLS_MAX} 个；给了就不列清单`,
        },
        ref: {
          type: "string",
          description:
            "可选：只列这个元素子树里引用的资源（快照编号，如 e12）；只在列清单时用，给 urls 时忽略",
        },
        type: {
          type: "string",
          description:
            "可选：只要这些类型，逗号分隔（如 script,stylesheet），缺省是 image,media；只在列清单时用，给 urls 时忽略",
        },
      },
      required: ["pageId"],
    } as never,
    async execute(_id, params) {
      const p = params as {
        pageId?: unknown;
        urls?: unknown;
        ref?: unknown;
        type?: unknown;
      };
      const pageId = pageIdArg(p.pageId);
      const urls = urlsArg(p.urls);
      // ref 与 type 只在列清单时用：给了 urls 就不解析它们（也不报错）。
      const types = urls === null ? typesArg(p.type) : null;
      const ref = urls !== null || p.ref === undefined ? null : refArg(p.ref);
      return guarded(async () => {
        const handle = await deps.registry.use(pageId, sessionId, "observe");
        const title = (await handle.title()) || "（无标题）";
        const pageUrl = handle.url();

        // 清单外地址的站点授权：解析阶段被拒的、拒签的都记成该地址的失败原因。
        const permit = async (url: string): Promise<string | null> => {
          let target: Target;
          try {
            target = resolveTarget(url, deps.targetOptions());
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
          return kit.authorize(target, url);
        };

        if (urls === null) {
          const assets = await handle.assets(ref === null ? {} : { ref });
          return text(
            renderAssetList(assets, {
              title,
              url: pageUrl,
              ...(ref === null ? {} : { ref }),
              types: types ?? [],
            }),
          );
        }

        // 页面已加载的地址：清单内免审批（清单不受 type 限制）。
        const loaded = new Set((await handle.assets()).map((a) => a.url));
        const absolute = urls.map((u) => {
          try {
            return new URL(u, pageUrl).href;
          } catch {
            return null;
          }
        });
        const failures: { url: string; reason: string }[] = [];
        const fail = (url: string, reason: string) =>
          failures.push({ url, reason });
        const allowed: string[] = [];
        for (const [i, url] of absolute.entries()) {
          const raw = urls[i] ?? "";
          if (url === null) {
            fail(raw, "地址无法解析成绝对地址");
            continue;
          }
          if (!loaded.has(url)) {
            if (!/^https?:/i.test(url)) {
              fail(url, "清单外的地址只支持 http 与 https");
              continue;
            }
            const no = await permit(url);
            if (no !== null) {
              fail(url, no);
              continue;
            }
          }
          allowed.push(url);
        }

        const rows: SaveRow[] = [];
        let requested = 0;
        const onResult = async (r: AssetResult): Promise<void> => {
          if (!r.ok) {
            rows.push({ url: r.url, ok: false, reason: r.reason });
            return;
          }
          if (r.viaRequest) requested += 1;
          const saved = await deps.saveAsset({
            sessionId,
            name: assetFileName(r.url, r.mime),
            bytes: r.bytes,
          });
          rows.push({
            url: r.url,
            ok: true,
            marker: saved.marker,
            mime: r.mime,
            size: r.bytes.length,
            viaRequest: r.viaRequest,
          });
        };
        if (allowed.length > 0)
          await handle.fetchAssets(
            allowed,
            { referer: pageUrl, maxBytes: deps.fileMaxBytes() },
            onResult,
          );
        for (const f of failures)
          rows.push({ url: f.url, ok: false, reason: f.reason });

        // 有经代理的新请求才写审计：只写 origin 的 host，不写路径与查询串。
        if (requested > 0) {
          const hosts: string[] = [];
          for (const r of rows) {
            if (!r.ok || r.viaRequest !== true) continue;
            const host = new URL(r.url).hostname;
            if (!hosts.includes(host)) hosts.push(host);
          }
          deps.audit?.({
            tool: "browser_assets",
            pageId,
            summary: `保存 ${rows.filter((r) => r.ok).length} 个资源（其中 ${requested} 个新请求：${hosts.join("、")}）`,
          });
        }
        return text(renderSaveResult(rows));
      });
    },
  });
}
