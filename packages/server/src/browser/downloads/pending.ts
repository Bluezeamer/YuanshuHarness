// 用户页上挂起、等用户决定存到哪的下载：只记内存清单与 Server 本机的暂存文件，不碰 HTTP、不认识 directory。
// 已知并接受的局限：Playwright 不能暂停下载，挂起期间文件已经在浏览器的临时目录里下着；
// 挂起项不跨 Server 重启（上次留下的暂存残留由 sweep 清掉）；页面休眠会让还没存的下载失败，
// saveTo 的错误原样交给用户看。暂存只写 Server 自己的数据目录（Server 私有暂存，不是「当前目录」，不必走 ExecEnv）。
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HttpError } from "../../lib/http-error.js";
import type { PageDownload } from "../engine/types.js";
import type { PendingDownloadView } from "../pages/types.js";

// 每页最多同时挂这么多个待处理下载，多的立刻取消。
const MAX_PER_PAGE = 3;
// 一个待处理项最多挂这么久，超时取消。
const DEFAULT_TTL_MS = 10 * 60_000;
// 暂存超时：用户自己点的，等得起，上限与挂起时长一致。
const STAGE_TIMEOUT_MS = 10 * 60_000;

export interface PendingDownloads {
  /** 挂起一个用户页上的下载；这一页已有 3 个待处理时返回 false（调用方去取消这一个）。变化时调用 deps.onChange。 */
  add(pageId: string, d: PageDownload): boolean;
  list(pageId: string): PendingDownloadView[];
  /**
   * 暂存到 Server 本机临时文件并返回：首次调用才真的 d.saveTo(<root>/<随机>/file, { maxBytes, timeoutMs })，
   * 之后（同一项再次调用）直接复用；并发调用共享同一次暂存。
   * 该项不存在抛 HttpError("not_found", …, 404)；saveTo 抛错（超限、失败、超时）：这一项就没了（saveTo 已取消 / 删除），
   * 从清单去掉，错误包成 HttpError("download_failed", 原消息, 502) 抛出。
   * filename 是 d.filename 原样（清洗由交付方做）。
   */
  stage(
    pageId: string,
    id: string,
    maxBytes: number,
  ): Promise<{ filename: string; path: string; size: number }>;
  /** 交付完成或用户丢弃：从清单去掉、删暂存文件、没存的下载 cancel(reason)。幂等；不存在返回 false。 */
  settle(pageId: string, id: string, reason: string): Promise<boolean>;
  /** 页面关闭：这一页的全部 settle。 */
  dropPage(pageId: string): Promise<void>;
  /** 清掉暂存根目录下的残留（Server 异常退出留下的）；目录不存在不报错。 */
  sweep(): Promise<void>;
}

interface Staged {
  /** 暂存文件路径：<root>/<随机>/file；这个目录只装这一项。 */
  path: string;
  size: number;
}

interface Item {
  id: string;
  pageId: string;
  download: PageDownload;
  /** 已经开始的暂存；并发的 stage 共用同一个 Promise。 */
  staged: Promise<Staged> | null;
  timer: NodeJS.Timeout;
}

export function createPendingDownloads(deps: {
  /** 暂存根目录（Server 数据目录下，由 service 给）。目录 0700。 */
  root: string;
  /** 清单变化时回调（service 用它更新页面状态）。 */
  onChange(pageId: string, items: PendingDownloadView[]): void;
  /** 挂起上限，默认 10 分钟；测试里调小。 */
  ttlMs?: number;
}): PendingDownloads {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const items = new Map<string, Item>();

  const list = (pageId: string): PendingDownloadView[] =>
    [...items.values()]
      .filter((i) => i.pageId === pageId)
      .map((i) => ({ id: i.id, filename: i.download.filename }));

  const changed = (pageId: string): void => deps.onChange(pageId, list(pageId));

  const find = (pageId: string, id: string): Item | null => {
    const item = items.get(id);
    return item && item.pageId === pageId ? item : null;
  };

  /** 暂存目录下的随机子目录（0700）：一项一个，名字不跟用户给的文件名走。 */
  const stageInto = async (
    id: string,
    d: PageDownload,
    maxBytes: number,
  ): Promise<Staged> => {
    const dir = join(deps.root, `${id}-${randomBytes(6).toString("hex")}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir 的 mode 会被 umask 收窄，这里补一次，保证只有本用户能读。
    await chmod(dir, 0o700).catch(noop);
    try {
      const path = join(dir, "file");
      const size = await d.saveTo(path, {
        maxBytes,
        timeoutMs: STAGE_TIMEOUT_MS,
      });
      return { path, size };
    } catch (err) {
      // saveTo 失败时已经取消或删掉了下载；我们建的暂存目录也一起清掉。
      await rm(dir, { recursive: true, force: true }).catch(noop);
      throw err;
    }
  };

  const remove = async (item: Item, reason: string): Promise<void> => {
    if (!items.delete(item.id)) return;
    clearTimeout(item.timer);
    const staged = item.staged;
    if (staged) {
      // 暂存过的：删暂存目录。不 await（GET 正在读大文件时丢弃不该卡住这次请求），
      // 暂存还在写的话等它写完再删，否则会留下半截文件。
      void staged.then(
        (s) => rm(dirname(s.path), { recursive: true, force: true }),
        noop,
      );
    } else {
      // 还没暂存过：取消浏览器的这次下载。saveTo 之后再 cancel 已无意义，所以按有没有暂存分支。
      await item.download.cancel(reason).catch(noop);
    }
    changed(item.pageId);
  };

  const settle = async (
    pageId: string,
    id: string,
    reason: string,
  ): Promise<boolean> => {
    const item = find(pageId, id);
    if (!item) return false;
    await remove(item, reason);
    return true;
  };

  return {
    add(pageId, d) {
      if (list(pageId).length >= MAX_PER_PAGE) return false;
      const id = randomBytes(6).toString("hex");
      const timer = setTimeout(() => {
        const item = find(pageId, id);
        if (item) {
          void remove(item, `等太久没人处理，已取消（${ttlMs / 60_000} 分钟）`);
        }
      }, ttlMs);
      timer.unref();
      items.set(id, { id, pageId, download: d, staged: null, timer });
      changed(pageId);
      return true;
    },

    list,

    async stage(pageId, id, maxBytes) {
      const item = find(pageId, id);
      if (!item) throw new HttpError("not_found", "这个下载已经不在了", 404);
      // 首次调用才真的暂存；并发调用共享同一次。
      item.staged ??= stageInto(id, item.download, maxBytes);
      const staging = item.staged;
      try {
        const staged = await staging;
        return { filename: item.download.filename, ...staged };
      } catch (err) {
        // 暂存失败：下载已被 saveTo 取消或删除，这一项就没了。
        await remove(item, "暂存失败");
        throw new HttpError(
          "download_failed",
          err instanceof Error ? err.message : String(err),
          502,
        );
      }
    },

    settle,

    async dropPage(pageId) {
      for (const item of [...items.values()])
        if (item.pageId === pageId) await remove(item, "页面已关闭");
    },

    async sweep() {
      await rm(deps.root, { recursive: true, force: true }).catch(noop);
    },
  };
}

const noop = () => {};
