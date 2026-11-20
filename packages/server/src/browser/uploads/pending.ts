// 用户页上挂起、等用户选本机文件的选择器：只记内存清单，不碰 HTTP 也不碰磁盘。
// 已知并接受的局限：挂起项不跨 Server 重启；页面导航后旧选择器失效，setFiles 会报错，
// 错误原样给用户看并丢掉这一项。
import { randomBytes } from "node:crypto";
import { HttpError } from "../../lib/http-error.js";
import { formatSize } from "../../session/attachments.js";
import type { PageFileChooser } from "../engine/types.js";
import type { PendingUploadView } from "../pages/types.js";
import { checkUploadTotal } from "./limits.js";

// 一个待处理项最多挂这么久，超时静默丢弃。
const DEFAULT_TTL_MS = 10 * 60_000;

export interface PendingUploads {
  /** 挂起一个用户页上的选择器；这一页已有的被顶掉（用户只关心最近一次点击）。变化时调用 deps.onChange。 */
  add(pageId: string, c: PageFileChooser): void;
  /**
   * 把用户的文件交给页面：先校验，通过就把这一项取走（并发的第二次得 404）再 setFiles。
   * 校验（任一不满足抛 HttpError，**这一项仍留着**，用户可以改选后再来）：不存在 404 `not_found`「这个文件选择已经不在了」；
   * files 为空 400 `bad_files`「没有收到文件」；入口只收一个文件却给了多个 400 `too_many`「这个上传入口只接受一个文件」；
   * 单个文件超过 maxBytes 413 `too_large`；合计超限 413 `too_large`（用 checkUploadTotal，保留它的消息）。
   * setFiles 抛错（比如页面已导航、选择器失效）：这一项已经取走，包成 HttpError("upload_failed", 原消息, 502) 抛出。
   */
  fill(
    pageId: string,
    id: string,
    files: { name: string; buffer: Buffer }[],
    maxBytes: number,
  ): Promise<void>;
  /** 用户取消：什么都不交，只从清单去掉。不存在返回 false。 */
  cancel(pageId: string, id: string): boolean;
  /** 页面关闭：丢掉这一页挂着的。 */
  dropPage(pageId: string): void;
}

interface Item {
  id: string;
  pageId: string;
  chooser: PageFileChooser;
  timer: NodeJS.Timeout;
}

export function createPendingUploads(deps: {
  /** 这一页的挂起项变了（null = 没有了）：service 用它更新页面状态。 */
  onChange(pageId: string, item: PendingUploadView | null): void;
  /** 挂起上限，默认 10 分钟；测试里调小。 */
  ttlMs?: number;
}): PendingUploads {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const items = new Map<string, Item>();

  /** 这一页当前的挂起项（每页最多一个）。 */
  const current = (pageId: string): Item | null =>
    [...items.values()].find((i) => i.pageId === pageId) ?? null;

  const find = (pageId: string, id: string): Item | null => {
    const item = items.get(id);
    return item && item.pageId === pageId ? item : null;
  };

  /** 静默丢掉一项（不交文件），并通知页面状态。 */
  const discard = (item: Item): void => {
    if (!items.delete(item.id)) return;
    clearTimeout(item.timer);
    const next = current(item.pageId);
    deps.onChange(
      item.pageId,
      next === null ? null : { id: next.id, multiple: next.chooser.multiple },
    );
  };

  return {
    add(pageId, chooser) {
      // 新的顶掉旧的：用户只关心最近一次点击。旧的静默丢弃，只报一次最新的值。
      const old = current(pageId);
      if (old) {
        items.delete(old.id);
        clearTimeout(old.timer);
      }
      const id = randomBytes(6).toString("hex");
      const timer = setTimeout(() => {
        const item = find(pageId, id);
        if (item) discard(item);
      }, ttlMs);
      timer.unref();
      items.set(id, { id, pageId, chooser, timer });
      deps.onChange(pageId, { id, multiple: chooser.multiple });
    },

    async fill(pageId, id, files, maxBytes) {
      const item = find(pageId, id);
      if (!item)
        throw new HttpError("not_found", "这个文件选择已经不在了", 404);
      // 校验失败时这一项还留着：用户可以改选再来。
      if (files.length === 0)
        throw new HttpError("bad_files", "没有收到文件", 400);
      if (files.length > 1 && !item.chooser.multiple)
        throw new HttpError("too_many", "这个上传入口只接受一个文件", 400);
      for (const f of files)
        if (f.buffer.length > maxBytes)
          throw new HttpError(
            "too_large",
            `文件太大（${formatSize(f.buffer.length)}，上限 ${formatSize(maxBytes)}）：${f.name}`,
            413,
          );
      try {
        checkUploadTotal(files.map((f) => ({ size: f.buffer.length })));
      } catch (err) {
        // 合计超限：保留原消息，只换成带状态的业务错误。
        throw new HttpError(
          "too_large",
          err instanceof Error ? err.message : String(err),
          413,
        );
      }
      // 校验过了就取走：setFiles 是异步的，并发的第二次（双击）不能再交一遍；
      // 成功或失败这一项都用完了（失败多半是选择器已失效，页面导航过）。
      discard(item);
      try {
        await item.chooser.setFiles(files);
      } catch (err) {
        throw new HttpError(
          "upload_failed",
          err instanceof Error ? err.message : String(err),
          502,
        );
      }
    },

    cancel(pageId, id) {
      const item = find(pageId, id);
      if (!item) return false;
      discard(item);
      return true;
    },

    dropPage(pageId) {
      for (const item of [...items.values()])
        if (item.pageId === pageId) discard(item);
    },
  };
}
