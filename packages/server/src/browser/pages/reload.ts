// agent 控制的文件页跟着文件变化自动刷新：监听文件所在的目录（同目录的 css / js / 图片变了也该刷新），
// 目录里任何变化都刷新，不做扩展名过滤。
// 只刷新 agent 控制且激活着的页面：用户正在操作的页面不自动刷新（免得冲掉填了一半的表单），
// 休眠的页面唤醒时本来就重新加载。
import { posix } from "node:path";
import { parseVirtualHost } from "../net/hostnames.js";
import type { PageView } from "./types.js";

export interface FileReload {
  /** 页面状态变了（added / updated 都调）：该监听就监听、不该就退订。幂等。 */
  track(page: PageView): void;
  /** 页面被移除：退订。 */
  forget(pageId: string): void;
}

/** 与 WatchHub 订阅者共用一把：key 带这个前缀，和会话的 key 互不串。 */
const PREFIX = "browser:";

/** 页面地址是文件页时给出（环境, 绝对路径）；不是文件页、或地址解不出返回 null。 */
function fileOf(url: string): { envId: string; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const virtual = parseVirtualHost(parsed.hostname);
  if (virtual?.kind !== "file") return null;
  try {
    return { envId: virtual.envId, path: decodeURIComponent(parsed.pathname) };
  } catch {
    return null;
  }
}

export function createFileReload(deps: {
  watch: {
    set(key: string, envId: string, paths: readonly string[]): void;
    release(key: string): void;
    onChanged(
      listener: (key: string, env: string, paths: string[]) => void,
    ): () => void;
  };
  /** 刷新这个页面（registry 自己判断还该不该刷、失败就静默）。 */
  reload(pageId: string): Promise<void>;
}): FileReload {
  deps.watch.onChanged((key) => {
    if (!key.startsWith(PREFIX)) return;
    void deps.reload(key.slice(PREFIX.length));
  });

  return {
    track(page) {
      const key = `${PREFIX}${page.id}`;
      const file =
        page.state === "active" && page.controller === "agent"
          ? fileOf(page.url)
          : null;
      if (!file) {
        deps.watch.release(key);
        return;
      }
      deps.watch.set(key, file.envId, [posix.dirname(file.path)]);
    },
    forget(pageId) {
      deps.watch.release(`${PREFIX}${pageId}`);
    },
  };
}
