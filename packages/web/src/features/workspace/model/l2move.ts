// L2 拖放移动：标签 / 窗格在窗格之间、窗口之间的移动，以及落点几何与主机隔离判定。
// 主机隔离只管「并」不管「摆」：并入（center/strip）受限，贴靠拆分（四边）一律放行。

import { insertBeside } from "../../../ui/tiling/tree";
import { type DropZone, isEdge } from "../../../ui/tiling/zones";
import {
  type Ctx,
  dropPane,
  findPane,
  hostConflict,
  hostConflictError,
  type IdGen,
  isHostTab,
  locatePane,
  MAX_PANES,
  MERGE_HINT,
  mapPane,
  newPane,
  paneCount,
  panesOf,
} from "./l2";
import type {
  HostId,
  Pane,
  Result,
  Tab,
  Window,
  WindowState,
  WinMap,
} from "./types";
import { fail, ok } from "./types";

/** 被拖的东西属于哪台主机：只有按主机隔离的标签（pane 档）有，其余为 null */
export const tabDragHost = (tab: Tab): HostId | null =>
  isHostTab(tab) ? (tab.host ?? null) : null;

/**
 * 落点预览：跨主机时并格（center）与并标签（strip）禁用，四向拆分照常可用。
 * dragHost 为 null（对话、浏览器、画布等）或目标窗格未绑主机时没有限制。
 */
export function dropBlocked(
  target: Pane,
  dragHost: HostId | null,
  zone: DropZone,
): boolean {
  const clash =
    dragHost !== null && target.host !== null && dragHost !== target.host;
  return clash && (zone === "center" || zone === "strip");
}

/** 摘掉标签后的窗格：当前标签被摘走则落到前一个，主机随主机级标签重算 */
function without(pane: Pane, tid: string): Pane {
  const idx = pane.tabs.findIndex((t) => t.id === tid);
  const tabs = pane.tabs.filter((t) => t.id !== tid);
  const near = tabs[Math.max(0, idx - 1)] ?? tabs[0];
  const active = pane.active === tid ? (near?.id ?? pane.active) : pane.active;
  const hasHost = tabs.some(isHostTab);
  return { ...pane, tabs, active, host: hasHost ? pane.host : null };
}

/** 把 tab 放进 tabs 的 beforeId 之前（找不到或缺省放末尾） */
function placed(tabs: readonly Tab[], tab: Tab, beforeId?: string): Tab[] {
  const rest = tabs.filter((t) => t.id !== tab.id);
  const at = beforeId ? rest.findIndex((t) => t.id === beforeId) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, tab);
  return rest;
}

/**
 * 移动标签。
 * - 四边：从源窗格摘出，在目标窗格旁新建窗格（属于标签自己的主机，目标不变）
 * - 同窗格 center/strip：重排（beforeTabId 之前，缺省末尾）
 * - 跨窗格 center/strip：并入目标窗格；主机冲突拒绝并点名两台主机
 */
export function moveTab(
  win: Window,
  fromPid: string,
  tid: string,
  toPid: string,
  zone: DropZone,
  ctx: Ctx,
  beforeTabId?: string,
): Result<Window> {
  const from = findPane(win, fromPid);
  const to = findPane(win, toPid);
  if (!from || !to) return fail("not-found", "窗格不存在");
  const tab = from.tabs.find((t) => t.id === tid);
  if (!tab) return fail("not-found", `标签 ${tid} 不在窗格 ${fromPid}`);
  const emptied = from.tabs.length === 1;

  if (isEdge(zone)) {
    if (from.pid === to.pid && emptied)
      return fail("invalid", "窗格只有这一个标签，无法拆出");
    if (paneCount(win) - (emptied ? 1 : 0) + 1 > MAX_PANES) {
      return fail("limit", `最多 ${MAX_PANES} 个窗格`);
    }
    const base = emptied
      ? dropPane(win, fromPid)
      : mapPane(win, fromPid, (p) => without(p, tid));
    if (!base) return fail("invalid", "窗口里没有窗格");
    const leaf = newPane(ctx, [tab], tabDragHost(tab));
    const root = insertBeside<Pane>(
      base.root,
      (p) => p.pid === toPid,
      zone,
      leaf,
    );
    return ok({ ...base, root, focus: leaf.pid });
  }

  if (from.pid === to.pid) {
    const tabs = placed(from.tabs, tab, beforeTabId);
    return ok({
      ...mapPane(win, fromPid, (p) => ({ ...p, tabs, active: tid })),
      focus: fromPid,
    });
  }

  if (hostConflict(to, tab))
    return hostConflictError(to.host ?? "", tab.host ?? "");
  const host = isHostTab(tab) && !to.host ? (tab.host ?? null) : to.host;
  const merged = mapPane(win, toPid, (p) => ({
    ...p,
    tabs: placed(p.tabs, tab, beforeTabId),
    active: tid,
    host,
  }));
  const base = emptied
    ? dropPane(merged, fromPid)
    : mapPane(merged, fromPid, (p) => without(p, tid));
  return base
    ? ok({ ...base, focus: toPid })
    : fail("invalid", "窗口里没有窗格");
}

/**
 * 移动窗格。
 * - 四边：摘下后在目标旁重新插入（窗格总数不变，不受上限限制）
 * - center/strip：把全部标签并入目标窗格；两窗格主机不同拒绝
 * 拖到自己的中心是空操作，拖到自己的边缘非法。
 */
export function movePane(
  win: Window,
  fromPid: string,
  toPid: string,
  zone: DropZone,
): Result<Window> {
  const from = findPane(win, fromPid);
  const to = findPane(win, toPid);
  if (!from || !to) return fail("not-found", "窗格不存在");
  if (fromPid === toPid) {
    return isEdge(zone) ? fail("invalid", "不能把窗格拖到自己的边缘") : ok(win);
  }

  if (isEdge(zone)) {
    const base = dropPane(win, fromPid);
    if (!base) return fail("invalid", "窗口里没有窗格");
    const root = insertBeside<Pane>(
      base.root,
      (p) => p.pid === toPid,
      zone,
      from,
    );
    return ok({ ...base, root, focus: fromPid });
  }

  if (from.host && to.host && from.host !== to.host) {
    return fail(
      "host-conflict",
      `两个窗格分属 ${to.host} 与 ${from.host}，无法并成一格${MERGE_HINT}`,
      [to.host, from.host],
    );
  }
  const bad = from.tabs.find((t) => hostConflict(to, t));
  if (bad) return hostConflictError(to.host ?? "", bad.host ?? "");
  const merged = mapPane(win, toPid, (p) => ({
    ...p,
    tabs: [...p.tabs, ...from.tabs],
    active: from.active,
    host: p.host ?? from.host,
  }));
  const base = dropPane(merged, fromPid);
  return base
    ? ok({ ...base, focus: toPid })
    : fail("invalid", "窗口里没有窗格");
}

// ── 窗口之间 ──

const windowIndexOf = (st: WindowState, pid: string): number =>
  st.list.findIndex((w) => findPane(w, pid));

/** 把窗格移到同会话的另一个窗口：落在目标窗口焦点窗格（缺省最后一个）的右侧，并切过去 */
export function movePaneToWindow(
  st: WindowState,
  pid: string,
  winIndex: number,
): Result<WindowState> {
  const si = windowIndexOf(st, pid);
  const source = st.list[si];
  const pane = source ? findPane(source, pid) : undefined;
  if (!source || !pane) return fail("not-found", `窗格 ${pid} 不存在`);
  const target = st.list[winIndex];
  if (!Number.isInteger(winIndex) || !target)
    return fail("not-found", `窗口 ${winIndex + 1} 不存在`);
  if (si === winIndex) return ok(st);
  if (paneCount(target) >= MAX_PANES)
    return fail("limit", `最多 ${MAX_PANES} 个窗格`);
  const anchor = findPane(target, target.focus) ?? panesOf(target).at(-1);
  if (!anchor) return fail("invalid", "目标窗口里没有窗格");

  const root = insertBeside<Pane>(
    target.root,
    (p) => p.pid === anchor.pid,
    "right",
    pane,
  );
  const moved: Window = { ...target, root, focus: pane.pid };
  const left = dropPane(source, pid);
  const list = st.list.flatMap((w) => {
    if (w === target) return [moved];
    if (w === source) return left ? [left] : [];
    return [w];
  });
  return ok({ list, active: list.indexOf(moved) });
}

/** 把窗格拆到一个新窗口并切过去；窗口里只剩这一个窗格时拒绝 */
export function detachPane(
  st: WindowState,
  pid: string,
  ids: IdGen,
): Result<WindowState> {
  const si = windowIndexOf(st, pid);
  const source = st.list[si];
  const pane = source ? findPane(source, pid) : undefined;
  if (!source || !pane) return fail("not-found", `窗格 ${pid} 不存在`);
  if (paneCount(source) <= 1) return fail("last", "窗口里只剩这一个窗格");
  const left = dropPane(source, pid);
  if (!left) return fail("invalid", "窗口里没有窗格");
  const fresh: Window = { id: ids("w"), root: pane, focus: pane.pid };
  const list = [...st.list.map((w) => (w === source ? left : w)), fresh];
  return ok({ list, active: list.length - 1 });
}

// ── 跨会话容器的拒绝（作用在整份 WinMap 上）──

/** 两个窗格必须在同一会话的同一窗口，否则返回对应拒绝；通过时给出会话 id 与窗口下标 */
function sameWindow(
  wins: WinMap,
  a: string,
  b: string,
  what: string,
): Result<{ sid: string; index: number }> {
  const la = locatePane(wins, a);
  const lb = locatePane(wins, b);
  if (!la || !lb) return fail("not-found", "窗格不存在");
  if (la.sid !== lb.sid)
    return fail("cross-session", `${what}不能跨会话容器搬运`);
  if (la.index !== lb.index) return fail("invalid", `${what}不在同一个窗口`);
  return ok({ sid: la.sid, index: la.index });
}

function applyAt(
  wins: WinMap,
  at: { sid: string; index: number },
  fn: (w: Window) => Result<Window>,
): Result<WinMap> {
  const st = wins[at.sid];
  const win = st?.list[at.index];
  if (!st || !win) return fail("not-found", "窗口不存在");
  const r = fn(win);
  if (!r.ok) return r;
  const list = st.list.map((w, i) => (i === at.index ? r.value : w));
  return ok({ ...wins, [at.sid]: { ...st, list } });
}

/** 标签移动（整份窗口表）：来源与目标窗格不在同一会话/窗口时拒绝 */
export function moveTabIn(
  wins: WinMap,
  fromPid: string,
  tid: string,
  toPid: string,
  zone: DropZone,
  ids: IdGen,
  beforeTabId?: string,
): Result<WinMap> {
  const at = sameWindow(wins, fromPid, toPid, "标签页");
  if (!at.ok) return at;
  const { sid } = at.value;
  return applyAt(wins, at.value, (w) =>
    moveTab(w, fromPid, tid, toPid, zone, { sid, ids }, beforeTabId),
  );
}

/** 窗格移动（整份窗口表）：来源与目标窗格不在同一会话/窗口时拒绝 */
export function movePaneIn(
  wins: WinMap,
  fromPid: string,
  toPid: string,
  zone: DropZone,
): Result<WinMap> {
  const at = sameWindow(wins, fromPid, toPid, "窗格");
  return at.ok
    ? applyAt(wins, at.value, (w) => movePane(w, fromPid, toPid, zone))
    : at;
}

/** 把窗格移到某会话容器的窗口条上：窗格不属于该会话时拒绝 */
export function movePaneToWindowIn(
  wins: WinMap,
  sid: string,
  pid: string,
  winIndex: number,
): Result<WinMap> {
  const hit = locatePane(wins, pid);
  const st = wins[sid];
  if (!hit || !st) return fail("not-found", `窗格 ${pid} 不存在`);
  if (hit.sid !== sid)
    return fail("cross-session", "窗格不能跨会话容器移到别的窗口");
  const r = movePaneToWindow(st, pid, winIndex);
  return r.ok ? ok(r.value === st ? wins : { ...wins, [sid]: r.value }) : r;
}
