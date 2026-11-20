// 工作区布局上的纯函数：会话行单击 / 双击落到对话标签，以及在会话列表变化后收敛标签。
// 约定与 model/l2.ts 一致：不可变更新，被拒绝的操作返回 Result，无变化返回原引用。
// ctx 不带 sid：这里所有会话归属都由入参显式给出。

import { type DropZone, isEdge } from "../../../ui/tiling/zones";
import type { Ctx } from "./l2";
import * as L2 from "./l2";
import { moveTab } from "./l2move";
import { TAB_KINDS } from "./tabKinds";
import type { Pane, Result, Tab, Window, WindowState } from "./types";
import { fail } from "./types";

const isChat = (t: Tab) => t.type === "chat";
const isTemp = (t: Tab) => isChat(t) && t.temp === true;
const isEmptyChat = (t: Tab) => isChat(t) && t.sid === undefined;
const showsSid = (t: Tab, sid: string) => isChat(t) && t.sid === sid;

/** 「我在看」：当前窗口里每个窗格的当前标签若是绑了会话的对话标签，按窗格顺序去重给出 */
export function viewingSids(st: WindowState): string[] {
  const win = st.list[st.active];
  if (!win) return [];
  const out: string[] = [];
  for (const p of L2.panesOf(win)) {
    const tab = p.tabs.find((t) => t.id === p.active);
    const sid = tab?.type === "chat" ? tab.sid : undefined;
    if (sid !== undefined && !out.includes(sid)) out.push(sid);
  }
  return out;
}

/** 聚焦窗格里当前标签的会话（它是绑了会话的对话标签才有）：左轨的「当前会话」 */
export function focusedSid(st: WindowState): string | null {
  const win = st.list[st.active];
  const pane = win && L2.findPane(win, win.focus);
  const tab = pane?.tabs.find((t) => t.id === pane.active);
  return tab && isChat(tab) ? (tab.sid ?? null) : null;
}

/** 当前窗口里所有对话标签的会话（任一窗格、含不是当前标签的），按窗格顺序去重 */
export function chatSids(st: WindowState): string[] {
  const win = st.list[st.active];
  if (!win) return [];
  const out: string[] = [];
  for (const p of L2.panesOf(win))
    for (const t of p.tabs)
      if (isChat(t) && t.sid !== undefined && !out.includes(t.sid))
        out.push(t.sid);
  return out;
}

// ── 单击 / 双击会话行 ──

/** 显示该会话的对话标签（任一窗格，含临时标签） */
const findShowing = (
  win: Window,
  sid: string,
): { pane: Pane; tab: Tab } | undefined => {
  for (const pane of L2.panesOf(win)) {
    const tab = pane.tabs.find((t) => showsSid(t, sid));
    if (tab) return { pane, tab };
  }
  return undefined;
};

/** 临时对话标签：先看聚焦窗格，再按窗格顺序看其他窗格 */
const findTemp = (win: Window): { pane: Pane; tab: Tab } | undefined => {
  const focus = L2.findPane(win, win.focus);
  const hit = focus?.tabs.find(isTemp);
  if (focus && hit) return { pane: focus, tab: hit };
  for (const pane of L2.panesOf(win)) {
    const tab = pane.tabs.find(isTemp);
    if (tab) return { pane, tab };
  }
  return undefined;
};

/** 新对话标签的落点窗格：聚焦窗格里有对话标签就用它，否则第一个含对话标签的窗格，再否则聚焦窗格 */
const chatLanding = (win: Window): Pane | undefined => {
  const focus = L2.findPane(win, win.focus);
  if (focus?.tabs.some(isChat)) return focus;
  return L2.panesOf(win).find((p) => p.tabs.some(isChat)) ?? focus;
};

/** 把标签改挂到 sid 并激活、聚焦它所在窗格；pinned 时同时去掉临时标记 */
function bindTab(
  win: Window,
  pane: Pane,
  tab: Tab,
  sid: string,
  pinned: boolean,
): Result<Window> {
  const changed = tab.sid !== sid || (pinned && tab.temp === true);
  if (!changed) return L2.activateTab(win, pane.pid, tab.id);
  const next = L2.mapPane(win, pane.pid, (p) => ({
    ...p,
    tabs: p.tabs.map((t) => {
      if (t.id !== tab.id) return t;
      if (!pinned) return { ...t, sid };
      const { temp: _drop, ...rest } = t;
      return { ...rest, sid };
    }),
  }));
  return L2.activateTab(next, pane.pid, tab.id);
}

function addChatTab(
  win: Window,
  sid: string,
  temp: boolean,
  ctx: Ctx,
): Result<Window> {
  const landing = chatLanding(win);
  if (!landing) return fail("invalid", "窗口里没有窗格");
  const tab = L2.newTab(ctx, "chat", { sid });
  return L2.addTabToPane(win, landing.pid, temp ? { ...tab, temp: true } : tab);
}

/** 单击会话行：已显示就激活；否则把临时标签换成它；再否则新增一个临时标签 */
export function showSession(
  win: Window,
  sid: string,
  ctx: Ctx,
): Result<Window> {
  const showing = findShowing(win, sid);
  if (showing) return L2.activateTab(win, showing.pane.pid, showing.tab.id);
  const temp = findTemp(win);
  if (temp) return bindTab(win, temp.pane, temp.tab, sid, false);
  return addChatTab(win, sid, true, ctx);
}

/** 双击会话行 / 明确的「固定」：已显示就去掉临时标记；否则换成它并固定；再否则新增固定标签 */
export function pinSession(win: Window, sid: string, ctx: Ctx): Result<Window> {
  const showing = findShowing(win, sid);
  if (showing) return bindTab(win, showing.pane, showing.tab, sid, true);
  const temp = findTemp(win);
  if (temp) return bindTab(win, temp.pane, temp.tab, sid, true);
  return addChatTab(win, sid, false, ctx);
}

/**
 * 把一个会话拖进窗格（左轨的会话行拖到窗格上）：落点处放它的对话标签，固定的。
 * 窗口里已经有显示它的对话标签就把那个标签移过来（别重复开）；否则新建一个。
 * 四边在目标窗格旁新开窗格，中部 / 标签条并入目标窗格。
 */
export function placeSession(
  win: Window,
  sid: string,
  toPid: string,
  zone: DropZone,
  ctx: Ctx,
  beforeTabId?: string,
): Result<Window> {
  const showing = findShowing(win, sid);
  if (showing) {
    // 已有就移动它；去掉临时标记（拖进来是明确的摆放，不该再被单击顶掉）
    const fixed = bindTab(win, showing.pane, showing.tab, sid, true);
    if (!fixed.ok) return fixed;
    return moveTab(
      fixed.value,
      showing.pane.pid,
      showing.tab.id,
      toPid,
      zone,
      ctx,
      beforeTabId,
    );
  }
  const tab = L2.newTab(ctx, "chat", { sid });
  if (isEdge(zone)) return L2.splitPane(win, toPid, zone, tab, ctx);
  const added = L2.addTabToPane(win, toPid, tab);
  if (!added.ok || beforeTabId === undefined) return added;
  return moveTab(added.value, toPid, tab.id, toPid, "strip", ctx, beforeTabId);
}

// ── 会话列表变化后收敛 ──

/** 关掉一个窗口里所有指向已不存在会话的标签（closeTab 已处理空窗格 / 最后一个窗格） */
function dropGone(win: Window, known: ReadonlySet<string>, ctx: Ctx): Window {
  let cur = win;
  for (const pane of L2.panesOf(win)) {
    for (const tab of pane.tabs) {
      if (!tab.sid || !TAB_KINDS[tab.type].sid || known.has(tab.sid)) continue;
      const r = L2.closeTab(cur, pane.pid, tab.id, ctx);
      if (r.ok) cur = r.value;
    }
  }
  return cur;
}

/** 窗口里没有任何指向存活会话的对话标签时，把第一个空对话标签绑成 latest 并标临时 */
function bindLatest(
  win: Window,
  known: ReadonlySet<string>,
  latest: string,
): Window {
  const live = L2.panesOf(win).some((p) =>
    p.tabs.some((t) => isChat(t) && t.sid !== undefined && known.has(t.sid)),
  );
  if (live) return win;
  for (const pane of L2.panesOf(win)) {
    const tab = pane.tabs.find(isEmptyChat);
    if (!tab) continue;
    return L2.mapPane(win, pane.pid, (p) => ({
      ...p,
      tabs: p.tabs.map((t) =>
        t.id === tab.id ? { ...t, sid: latest, temp: true } : t,
      ),
    }));
  }
  return win;
}

/**
 * 会话列表变化后收敛整份窗口状态；没有变化时返回入参本身。
 * 关掉指向已删会话的标签；空对话标签回落到 latest 只在两种时刻做：fill（刚载入的第一次收敛）
 * 或这个窗口刚关掉过失效标签——否则用户自己新开的空对话标签会在下一次列表推送时被顶掉。
 */
export function reconcileSessions(
  st: WindowState,
  known: ReadonlySet<string>,
  latest: string | null,
  ctx: Ctx,
  fill: boolean,
): WindowState {
  let changed = false;
  const list = st.list.map((w) => {
    const kept = dropGone(w, known, ctx);
    const next =
      latest !== null && (fill || kept !== w)
        ? bindLatest(kept, known, latest)
        : kept;
    if (next !== w) changed = true;
    return next;
  });
  return changed ? { ...st, list } : st;
}
