// 工具层对下载的处理：逐个审批 → 存进会话附件区 → 生成给模型的文字行。
// 审批卡片在 approve.ts；这里只管顺序、文字与「拒绝就取消」。
import type { PageDownload } from "../engine/types.js";
import { type Verdict, withNote } from "./approve.js";

// 动作返回后还等下载事件的时间：点击的下载常在 click 返回前后才到。
export const DOWNLOAD_GRACE_MS = 400;
export const DOWNLOAD_TIMEOUT_MS = 120_000;
// 卡片里的地址上限：再长就截断，卡片放不下也没人看得完。
const URL_MAX = 200;

const EXECUTABLE_EXT = new Set(
  "exe msi bat cmd com scr ps1 vbs js jse wsf lnk reg sh jar app dmg pkg deb rpm apk".split(
    " ",
  ),
);

/** 可执行类扩展名（大小写不敏感，只看最后一个扩展名）。 */
export function isExecutableName(name: string): boolean {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && EXECUTABLE_EXT.has(lower.slice(dot + 1));
}

/** 卡片里的地址：太长就截断。 */
export const cutUrl = (url: string): string =>
  url.length > URL_MAX ? `${url.slice(0, URL_MAX)}…` : url;

/** 处理一次动作收集到的下载：逐个审批 → 存附件 → 生成给模型的文字行。 */
export async function settleDownloads(
  downloads: PageDownload[],
  dropped: number,
  ctx: {
    pageUrl: string;
    approve(a: {
      filename: string;
      pageUrl: string;
      fileUrl: string;
      executable: boolean;
    }): Promise<Verdict>;
    saveFile(a: {
      name: string;
      write(abs: string): Promise<void>;
    }): Promise<{ marker: string; size: number; sizeText: string }>;
    maxBytes(): number;
    audit?(summary: string): void;
  },
): Promise<string[]> {
  const lines: string[] = [];
  // 逐个处理：并发出卡片会一次弹好几张，用户不知道先点哪个。
  for (const d of downloads) {
    const verdict = await ctx.approve({
      filename: d.filename,
      pageUrl: cutUrl(ctx.pageUrl),
      fileUrl: cutUrl(d.url),
      executable: isExecutableName(d.filename),
    });
    if (!verdict.allowed) {
      await d.cancel("用户没有批准");
      lines.push(
        withNote(`用户没有批准下载 ${d.filename}，已取消。`, verdict.note),
      );
      continue;
    }
    try {
      const saved = await ctx.saveFile({
        name: d.filename,
        write: (abs) =>
          d
            .saveTo(abs, {
              maxBytes: ctx.maxBytes(),
              timeoutMs: DOWNLOAD_TIMEOUT_MS,
            })
            .then(() => {}),
      });
      lines.push(
        `Downloaded: ${d.filename} (${saved.sizeText}) -> ${saved.marker}\nRead it with the file tools or copy it into a working directory with transfer_files.`,
      );
      ctx.audit?.(`保存下载 ${d.filename}（${saved.sizeText}）`);
    } catch (err) {
      lines.push(
        `下载 ${d.filename} 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (dropped > 0)
    lines.push(
      `这次动作还触发了 ${dropped} 个下载，一次最多处理 3 个，其余已取消。`,
    );
  return lines;
}
