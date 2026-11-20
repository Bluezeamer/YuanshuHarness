// Playwright 的 Download 包成引擎层的 PageDownload：不碰页面，只做「等完成 → 查大小 → 存到指定位置」。
// 已知并接受的局限：Playwright 不能暂停下载，审批期间文件已经在浏览器的临时目录里下着；
// 取消或丢弃时只能事后删掉，大小也只能等下完才知道。
import { stat } from "node:fs/promises";
import type { Download } from "playwright-core";
import { formatSize } from "../../session/attachments.js";
import { redactUrl } from "./console.js";
import type { PageDownload } from "./types.js";

type DownloadLike = Pick<
  Download,
  | "suggestedFilename"
  | "url"
  | "path"
  | "saveAs"
  | "failure"
  | "cancel"
  | "delete"
>;

const noop = () => {};

// running：还能存；其余都是终态，再调 cancel / saveTo 都不再动浏览器。
type State = "running" | "saved" | "cancelled" | "dropped";

export function wrapDownload(
  d: DownloadLike,
  note: (text: string) => void,
): PageDownload {
  const filename = d.suggestedFilename();
  let state: State = "running";

  const drop = async (reason: string): Promise<void> => {
    if (state !== "running") return;
    state = "cancelled";
    note(`已取消下载 ${filename}：${reason}`);
    await d.cancel().catch(noop);
    // 已经下完的小文件 cancel 不会动临时文件，再删一次；下到一半的 cancel 自己就删了，delete 会报 canceled。
    await d.delete().catch(noop);
  };

  return {
    filename,
    url: redactUrl(d.url()),
    async saveTo(dest, opts) {
      if (state !== "running")
        throw new Error(`下载 ${filename} 已取消，不能再保存。`);
      // 超时的哨兵：d.path() 自己也会因取消 / 失败而 reject，两者要分开报。
      let timedOut = false;
      const timer = new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          timedOut = true;
          reject(new Error("timeout"));
        }, opts.timeoutMs);
        t.unref();
      });
      let src: string;
      try {
        src = await Promise.race([d.path(), timer]);
      } catch (err) {
        if (timedOut) {
          await drop(`下载超时（${opts.timeoutMs / 1000} 秒）`);
          throw new Error(`下载超时（${opts.timeoutMs / 1000} 秒）`);
        }
        // 浏览器自己报的失败（取消、连接断等）：页面的控制台里已有记录，这里不再写一条。
        state = "dropped";
        throw new Error(
          `下载失败：${err instanceof Error ? firstLine(err.message) : String(err)}`,
        );
      }
      const failure = await d.failure();
      if (failure !== null) {
        state = "dropped";
        throw new Error(`下载失败：${firstLine(failure)}`);
      }
      const size = (await stat(src)).size;
      if (size > opts.maxBytes) {
        state = "dropped";
        await d.delete().catch(noop);
        throw new Error(
          `文件太大（${formatSize(size)}，上限 ${formatSize(opts.maxBytes)}）`,
        );
      }
      await d.saveAs(dest);
      state = "saved";
      // saveAs 是复制：浏览器的临时文件还在，存完就删，不然每个下载在磁盘上多留一份直到浏览器退出
      await d.delete().catch(noop);
      return size;
    },
    cancel: drop,
  };
}

function firstLine(m: string): string {
  return (
    m
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? m
  );
}
