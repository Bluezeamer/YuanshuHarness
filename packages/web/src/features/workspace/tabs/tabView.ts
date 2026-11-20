// 标签的视图状态（选中、滚动、预览 / 编辑模式、版本视图）存浏览器本地：设备相关、丢了无害，不进布局文档
// （滚动一动就写布局，会和别的设备抢版本号）。键 = 工作区 id + 标签 id。
// 标签 id 会复用（关掉的 id 被新标签拿走），所以关标签时要清：watchLiveTabs 在每次布局变化后把不在文档里的记录删掉；
// 各标签还在自己的记录里带「属于哪个文件 / 目录」，对不上就不恢复。读写走 app/localState。
import {
  localKey,
  localPrefix,
  readLocal,
  sweepLocal,
  writeLocalSoon,
} from "../../../app/localState";
import { layoutIds } from "../model/layoutDoc";
import type { LayoutStore } from "../store/layoutStore";

const NS = "tab.view";
// 标签的内容缩放（tabZoom.tsx），与视图状态同样按标签存、同样随标签消失清理
const ZOOM_NS = "tab.zoom";
const MAX_AGE_MS = 30 * 24 * 3600_000;

interface Rec {
  savedAt: number;
  v: unknown;
}

const parseRec = (v: unknown): Rec | null => {
  const r = v as Partial<Rec> | null;
  return typeof r?.savedAt === "number" && r.v !== undefined
    ? (r as Rec)
    : null;
};

export function readTabView<T>(
  workspaceId: string,
  tabId: string,
  parse: (v: unknown) => T | null,
): T | null {
  const rec = readLocal(localKey(NS, workspaceId, tabId), parseRec);
  return rec === null ? null : parse(rec.v);
}

export function readTabZoom(workspaceId: string, tabId: string): number | null {
  const rec = readLocal(localKey(ZOOM_NS, workspaceId, tabId), parseRec);
  return typeof rec?.v === "number" ? rec.v : null;
}

export const writeTabZoom = (
  workspaceId: string,
  tabId: string,
  zoom: number,
): void =>
  writeLocalSoon(localKey(ZOOM_NS, workspaceId, tabId), {
    savedAt: Date.now(),
    v: zoom,
  } satisfies Rec);

/** 防抖写：滚动、选择都频繁，落最后一次；关页面前会先落下 */
export const writeTabView = (
  workspaceId: string,
  tabId: string,
  v: unknown,
): void =>
  writeLocalSoon(localKey(NS, workspaceId, tabId), {
    savedAt: Date.now(),
    v,
  } satisfies Rec);

/** 这个工作区里不在 live 里的标签，记录一律删 */
export const reconcileTabViews = (
  workspaceId: string,
  live: ReadonlySet<string>,
): void => {
  for (const ns of [NS, ZOOM_NS])
    sweepLocal(localPrefix(ns, workspaceId), (key) => {
      const tabId = decodeURIComponent(key.slice(key.lastIndexOf(":") + 1));
      return !live.has(tabId);
    });
};

/** 启动时清掉超过 30 天没动过的记录（含已删除工作区留下的）和坏记录 */
export const sweepStaleTabViews = (now = Date.now()): void => {
  for (const ns of [NS, ZOOM_NS])
    sweepLocal(localPrefix(ns), (_key, v) => {
      const r = parseRec(v);
      return r === null || now - r.savedAt > MAX_AGE_MS;
    });
};

/**
 * 布局一变，就把当前工作区里已经不存在的标签的记录删掉（关标签、关窗格、关窗口、别处同步来的新布局都走这一处）。
 * 只在载入完成的文档上做，并且只在有 id 消失、或刚换工作区时才扫。返回取消订阅。
 */
export function watchLiveTabs(store: LayoutStore): () => void {
  let seenWs: string | null = null;
  let seen = new Set<string>();
  return store.subscribe(() => {
    const s = store.getState();
    if (s.status !== "ready" || s.workspaceId === null) return;
    const live = new Set(layoutIds(s.doc));
    const gone =
      s.workspaceId !== seenWs || [...seen].some((id) => !live.has(id));
    seenWs = s.workspaceId;
    seen = live;
    if (gone) reconcileTabViews(s.workspaceId, live);
  });
}
