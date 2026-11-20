// L2 层纯逻辑：每会话的窗口 → 窗格树 → 标签（IMPLEMENTATION §8.9）。
// 约定：全部不可变更新；会被拒绝的操作返回 Result，查询与构造直接返回值；
// 无变化的成功操作返回原引用。拖放移动在 l2move.ts。

import {
  type EdgeZone,
  insertBeside,
  leaves,
  mapLeaves,
  removeLeaf,
  setSizesAt,
} from "../../../ui/tiling/tree";
import { hasHost, isHostType } from "./tabKinds";
import type {
  HostId,
  L2Node,
  Pane,
  Result,
  Tab,
  TabAfx,
  TabType,
  Window,
  WindowState,
  WinMap,
} from "./types";
import { fail, ok } from "./types";

/** 一个窗口里最多的窗格数 */
export const MAX_PANES = 6;

// ── 发号 ──

export type IdGen = (prefix: "t" | "p" | "w") => string;

/** 创建新对象所需的上下文：会话 id（chat 标签归属，缺省 = 不绑会话）与发号器 */
export interface Ctx {
  sid?: string;
  ids: IdGen;
}

/** 避开已有 id 的顺序发号器：t1、p2、w3 … */
export function idGenFrom(used: Iterable<string>): IdGen {
  const taken = new Set(used);
  let n = 0;
  return (prefix) => {
    let id = "";
    do id = `${prefix}${(++n).toString(36)}`;
    while (taken.has(id));
    taken.add(id);
    return id;
  };
}

/** 一份 WinMap 里已占用的窗口 / 窗格 / 标签 id */
export function usedIds(wins: WinMap): string[] {
  const out: string[] = [];
  for (const st of Object.values(wins)) {
    for (const w of st.list) {
      out.push(w.id);
      for (const p of leaves<Pane>(w.root))
        out.push(p.pid, ...p.tabs.map((t) => t.id));
    }
  }
  return out;
}

// ── 查询 ──

export const panesOf = (win: Window): Pane[] => leaves<Pane>(win.root);
export const paneCount = (win: Window): number => panesOf(win).length;
export const findPane = (win: Window, pid: string): Pane | undefined =>
  panesOf(win).find((p) => p.pid === pid);

export function findTab(
  win: Window,
  tid: string,
): { pane: Pane; tab: Tab } | undefined {
  for (const pane of panesOf(win)) {
    const tab = pane.tabs.find((t) => t.id === tid);
    if (tab) return { pane, tab };
  }
  return undefined;
}

/** 在一份 WinMap 里按窗格 id 定位（pid 全局唯一） */
export function locatePane(
  wins: WinMap,
  pid: string,
): { sid: string; index: number; window: Window; pane: Pane } | undefined {
  for (const [sid, st] of Object.entries(wins)) {
    for (const [index, window] of st.list.entries()) {
      const pane = findPane(window, pid);
      if (pane) return { sid, index, window, pane };
    }
  }
  return undefined;
}

// ── 主机规则 ──

/** 窗格按主机隔离的标签（pane 档：term/files/preview）；其余档位的标签放进任何窗格，见 tabKinds.ts */
export const isHostTab = (tab: Tab): boolean => isHostType(tab.type);

/** 窗格已绑定主机且标签属于另一台主机 → 不能并入 */
export const hostConflict = (pane: Pane, tab: Tab): boolean =>
  isHostTab(tab) && pane.host !== null && pane.host !== tab.host;

const hostMsg = (a: HostId, b: HostId) => `窗格已绑定 ${a}，标签属于 ${b}`;
export const MERGE_HINT = " · 拖到窗格边缘可贴靠拆分";

/** 并入被主机隔离拒绝时的统一错误（点名两台主机并指路） */
export function hostConflictError<T>(
  paneHost: HostId,
  tabHost: HostId,
): Result<T> {
  return fail("host-conflict", hostMsg(paneHost, tabHost) + MERGE_HINT, [
    paneHost,
    tabHost,
  ]);
}

/** 窗格主机 = 有主机级标签时沿用/取第一个主机标签的主机，否则解绑 */
function settleHost(pane: Pane): Pane {
  const first = pane.tabs.find(isHostTab);
  const host = first ? (pane.host ?? first.host ?? null) : null;
  return host === pane.host ? pane : { ...pane, host };
}

/** 新建主机级标签时的主机候选：本窗格主机在前，其余保持原序、去重 */
export function orderHostChoices(
  paneHost: HostId | null,
  hosts: readonly HostId[],
): HostId[] {
  const rest = hosts.filter((h) => h !== paneHost);
  return paneHost ? [paneHost, ...new Set(rest)] : [...new Set(rest)];
}

/** 同一会话内主机色（1..6）按窗格出现顺序分配，用尽后循环 */
export function hostTones(win: Window): Record<HostId, number> {
  const out: Record<HostId, number> = {};
  for (const p of panesOf(win)) {
    if (p.host && out[p.host] === undefined)
      out[p.host] = (Object.keys(out).length % 6) + 1;
  }
  return out;
}

/** 主机在这个窗口里的颜色：窗格里已有它就沿用；还没有窗格的，取它将分到的下一个颜色（与 hostTones 一致） */
export function hostToneOf(win: Window, host: HostId): number {
  const tones = hostTones(win);
  return tones[host] ?? (Object.keys(tones).length % 6) + 1;
}

// ── 构造 ──

export interface TabInit {
  sid?: string;
  sub?: string;
  job?: string;
  host?: HostId;
  cwd?: string;
  path?: string;
  canvas?: string;
  page?: string;
  termId?: string;
  /** preview 标签的 diff 形态（轮末改动卡片 / git 面板 / 团队块打开；turn 为 null 且无 team 表示工作区） */
  diff?: { turn: number | null; path: string; team?: true };
}

/** 新建标签：只写有值的字段，保持文档小；带主机的标签（data / pane 档）主机缺省为 server */
export function newTab(ctx: Ctx, type: TabType, init: TabInit = {}): Tab {
  const tab: Tab = { id: ctx.ids("t"), type };
  if (type === "chat") {
    tab.ctab = "chat";
    const sid = init.sid ?? ctx.sid;
    if (sid !== undefined) tab.sid = sid;
  } else if (type === "sub" || type === "job") {
    const sid = init.sid ?? ctx.sid;
    if (sid !== undefined) tab.sid = sid;
    if (type === "sub" && init.sub !== undefined) tab.sub = init.sub;
    if (type === "job" && init.job !== undefined) tab.job = init.job;
  } else {
    if (hasHost(type)) tab.host = init.host ?? "server";
    if (init.cwd !== undefined) tab.cwd = init.cwd;
    if (init.diff !== undefined) tab.diff = init.diff;
    if (type === "files" || type === "preview" || type === "canvas")
      tab.path = init.path ?? "";
    if (type === "canvas" && init.canvas !== undefined)
      tab.canvas = init.canvas;
    if (type === "web" && init.page !== undefined) tab.page = init.page;
    // 轮末 diff 要知道是哪个会话的哪一轮
    if (type === "preview" && init.sid !== undefined) tab.sid = init.sid;
    if (type === "term" && init.termId !== undefined) tab.termId = init.termId;
  }
  return tab;
}

export function newPane(
  ctx: Ctx,
  tabs: readonly [Tab, ...Tab[]],
  host: HostId | null = null,
): Pane {
  return { pid: ctx.ids("p"), host, tabs: [...tabs], active: tabs[0].id };
}

export interface Directory {
  host: HostId;
  path: string;
}

/**
 * 工作区的默认窗口：对话窗格 + 目录清单里每台不同的主机一个窗格（窗格不混主机，总数不超过 MAX_PANES）。
 * directories 为空 = 只放一个对话窗格。
 */
export function defaultWindow(
  ctx: Ctx,
  directories: readonly Directory[],
  /** 对话标签绑的会话；缺省用 ctx.sid，两者都没有则是空对话标签 */
  chatSid?: string,
): Window {
  const chatTab = newTab(ctx, "chat", { sid: chatSid });
  // 默认带出来的会话只是起点：标成临时，单击别的会话时直接替换它
  const chat = newPane(ctx, [
    chatSid === undefined ? chatTab : { ...chatTab, temp: true },
  ]);
  const [local, ...others] = directories;
  if (!local) return { id: ctx.ids("w"), root: chat, focus: chat.pid };
  const work = newPane(
    ctx,
    [
      newTab(ctx, "files", { host: local.host, cwd: local.path }),
      newTab(ctx, "term", { host: local.host, cwd: local.path }),
    ],
    local.host,
  );
  const extra = [
    ...new Map(
      others.filter((d) => d.host !== local.host).map((d) => [d.host, d]),
    ).values(),
  ]
    .slice(0, MAX_PANES - 2)
    .map((d) =>
      newPane(
        ctx,
        [
          newTab(ctx, "term", { host: d.host, cwd: d.path }),
          newTab(ctx, "files", { host: d.host, cwd: d.path }),
        ],
        d.host,
      ),
    );
  const root: L2Node = {
    dir: "row",
    sizes: extra.length === 0 ? [1.42, 1] : [1.15, 1.3, ...extra.map(() => 1)],
    children: [chat, work, ...extra],
  };
  return { id: ctx.ids("w"), root, focus: chat.pid };
}

export function initialWindows(
  ctx: Ctx,
  directories: readonly Directory[],
  chatSid?: string,
): WindowState {
  return { list: [defaultWindow(ctx, directories, chatSid)], active: 0 };
}

// ── 窗口列表（每会话一套 WindowState）──

export function switchWindow(
  st: WindowState,
  index: number,
): Result<WindowState> {
  if (!Number.isInteger(index) || index < 0 || index >= st.list.length) {
    return fail("not-found", `窗口 ${index + 1} 不存在`);
  }
  return ok(index === st.active ? st : { ...st, active: index });
}

/** 新建窗口并切过去 */
export function addWindow(
  st: WindowState,
  ctx: Ctx,
  directories: readonly Directory[],
  chatSid?: string,
): WindowState {
  return {
    list: [...st.list, defaultWindow(ctx, directories, chatSid)],
    active: st.list.length,
  };
}

/** 关闭窗口，至少保留一个。关掉当前窗口时落到前一个 */
export function closeWindow(
  st: WindowState,
  index: number,
): Result<WindowState> {
  if (!Number.isInteger(index) || index < 0 || index >= st.list.length) {
    return fail("not-found", `窗口 ${index + 1} 不存在`);
  }
  if (st.list.length <= 1) return fail("last", "这是最后一个窗口");
  const list = st.list.filter((_, i) => i !== index);
  const active =
    index === st.active
      ? Math.max(0, index - 1)
      : index < st.active
        ? st.active - 1
        : st.active;
  return ok({ list, active });
}

/** 对某会话的某个窗口（缺省当前窗口）应用一个窗口级操作 */
export function updateWindow(
  wins: WinMap,
  sid: string,
  fn: (w: Window) => Result<Window>,
  index?: number,
): Result<WinMap> {
  const st = wins[sid];
  if (!st) return fail("not-found", `会话 ${sid} 没有窗口`);
  const at = index ?? st.active;
  const win = st.list[at];
  if (!win) return fail("not-found", `窗口 ${at + 1} 不存在`);
  const r = fn(win);
  if (!r.ok) return r;
  if (r.value === win) return ok(wins);
  const list = st.list.map((w, i) => (i === at ? r.value : w));
  return ok({ ...wins, [sid]: { ...st, list } });
}

// ── 窗格树内部工具 ──

export function mapPane(
  win: Window,
  pid: string,
  fn: (p: Pane) => Pane,
): Window {
  return {
    ...win,
    root: mapLeaves<Pane>(win.root, (p) => (p.pid === pid ? fn(p) : p)),
  };
}

/** 摘掉一个窗格并折叠分支；被摘的是焦点窗格时焦点移到第一个窗格。窗口已无窗格返回 null */
export function dropPane(win: Window, pid: string): Window | null {
  const root = removeLeaf<Pane>(win.root, (p) => p.pid === pid);
  if (!root) return null;
  const focus =
    win.focus === pid ? (leaves<Pane>(root)[0]?.pid ?? "") : win.focus;
  return { ...win, root, focus };
}

// ── 标签 ──

export function activateTab(
  win: Window,
  pid: string,
  tid: string,
): Result<Window> {
  const pane = findPane(win, pid);
  if (!pane) return fail("not-found", `窗格 ${pid} 不存在`);
  if (!pane.tabs.some((t) => t.id === tid))
    return fail("not-found", `标签 ${tid} 不在窗格 ${pid}`);
  if (pane.active === tid && win.focus === pid) return ok(win);
  return ok({
    ...mapPane(win, pid, (p) => ({ ...p, active: tid })),
    focus: pid,
  });
}

/**
 * 关闭标签：关掉当前标签落到前一个；窗格空了则关窗格，
 * 窗口里只剩这一个窗格时改放一个新的对话标签并解绑主机。
 */
export function closeTab(
  win: Window,
  pid: string,
  tid: string,
  ctx: Ctx,
): Result<Window> {
  const pane = findPane(win, pid);
  if (!pane) return fail("not-found", `窗格 ${pid} 不存在`);
  const idx = pane.tabs.findIndex((t) => t.id === tid);
  if (idx < 0) return fail("not-found", `标签 ${tid} 不在窗格 ${pid}`);
  const tabs = pane.tabs.filter((t) => t.id !== tid);
  if (tabs.length === 0) {
    if (paneCount(win) > 1) {
      const next = dropPane(win, pid);
      return next ? ok(next) : fail("invalid", "窗口里没有窗格");
    }
    const fresh = newTab(ctx, "chat");
    return ok(
      mapPane(win, pid, (p) => ({
        ...p,
        tabs: [fresh],
        active: fresh.id,
        host: null,
      })),
    );
  }
  const near = tabs[Math.max(0, idx - 1)] ?? tabs[0];
  const active = pane.active === tid ? (near?.id ?? pane.active) : pane.active;
  return ok(mapPane(win, pid, (p) => settleHost({ ...p, tabs, active })));
}

/** 严格加入：窗格已绑定其他主机时拒绝（不自动拆窗格） */
export function addTabToPane(
  win: Window,
  pid: string,
  tab: Tab,
): Result<Window> {
  const pane = findPane(win, pid);
  if (!pane) return fail("not-found", `窗格 ${pid} 不存在`);
  if (findTab(win, tab.id)) return fail("invalid", `标签 id 重复：${tab.id}`);
  if (hostConflict(pane, tab)) {
    return fail("host-conflict", hostMsg(pane.host ?? "", tab.host ?? ""), [
      pane.host ?? "",
      tab.host ?? "",
    ]);
  }
  const host = isHostTab(tab) && !pane.host ? (tab.host ?? null) : pane.host;
  const next = mapPane(win, pid, (p) => ({
    ...p,
    tabs: [...p.tabs, tab],
    active: tab.id,
    host,
  }));
  return ok({ ...next, focus: pid });
}

/** 新建标签的路由：主机与窗格主机不同 → 在窗格右侧自动新建窗格，否则并入本窗格 */
export function addTab(
  win: Window,
  pid: string,
  tab: Tab,
  ctx: Ctx,
): Result<Window> {
  const pane = findPane(win, pid);
  if (!pane) return fail("not-found", `窗格 ${pid} 不存在`);
  if (!hostConflict(pane, tab)) return addTabToPane(win, pid, tab);
  return splitPane(win, pid, "right", tab, ctx);
}

/** 在目标窗格某侧新建窗格装下 tab；窗格属 tab 的主机 */
export function splitPane(
  win: Window,
  targetPid: string,
  zone: EdgeZone,
  tab: Tab,
  ctx: Ctx,
): Result<Window> {
  if (!findPane(win, targetPid))
    return fail("not-found", `窗格 ${targetPid} 不存在`);
  if (paneCount(win) >= MAX_PANES)
    return fail("limit", `最多 ${MAX_PANES} 个窗格`);
  if (findTab(win, tab.id)) return fail("invalid", `标签 id 重复：${tab.id}`);
  const leaf = newPane(ctx, [tab], isHostTab(tab) ? (tab.host ?? null) : null);
  const root = insertBeside<Pane>(
    win.root,
    (p) => p.pid === targetPid,
    zone,
    leaf,
  );
  return ok({ ...win, root, focus: leaf.pid });
}

/** 关闭窗格，窗口里至少留一个 */
export function closePane(win: Window, pid: string): Result<Window> {
  if (!findPane(win, pid)) return fail("not-found", `窗格 ${pid} 不存在`);
  if (paneCount(win) <= 1) return fail("last", "这是窗口里最后一个窗格");
  const next = dropPane(win, pid);
  return next ? ok(next) : fail("invalid", "窗口里没有窗格");
}

export function setFocus(win: Window, pid: string): Result<Window> {
  if (!findPane(win, pid)) return fail("not-found", `窗格 ${pid} 不存在`);
  return ok(win.focus === pid ? win : { ...win, focus: pid });
}

/** 拖分隔条后写回某个分支的比例（path 为从根起的 children 下标序列） */
export function setPaneSizes(
  win: Window,
  path: readonly number[],
  sizes: readonly number[],
): Result<Window> {
  const root = setSizesAt<Pane>(win.root, path, sizes);
  return root ? ok({ ...win, root }) : fail("invalid", "分隔条路径或比例无效");
}

// ── 标签字段与 afx ──

/** 不涉及结构/主机的可改字段；值为 undefined 表示删除该字段 */
export type TabPatch = Partial<
  Pick<Tab, "ctab" | "cwd" | "path" | "page" | "termId" | "termEnded" | "temp">
>;

function patched<T extends object>(
  base: T,
  patch: Partial<Record<string, unknown>>,
): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

function updateTab(
  win: Window,
  tid: string,
  fn: (t: Tab) => Tab,
): Result<Window> {
  const hit = findTab(win, tid);
  if (!hit) return fail("not-found", `标签 ${tid} 不存在`);
  return ok(
    mapPane(win, hit.pane.pid, (p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t.id === tid ? fn(t) : t)),
    })),
  );
}

export const patchTab = (
  win: Window,
  tid: string,
  patch: TabPatch,
): Result<Window> => updateTab(win, tid, (t) => patched(t, patch));

/** 标签的界面附属状态（宽度、展开、筛选…）；没有则为空对象 */
export const afxOf = (win: Window, tid: string): TabAfx =>
  findTab(win, tid)?.tab.afx ?? {};

/** 浅合并 afx；值为 undefined 删除该键；合并后为空则整个 afx 字段移除 */
export function patchAfx(
  win: Window,
  tid: string,
  patch: Partial<TabAfx>,
): Result<Window> {
  return updateTab(win, tid, (t) => {
    const afx = patched<TabAfx>(t.afx ?? {}, patch);
    const { afx: _drop, ...rest } = t;
    return Object.keys(afx).length ? { ...rest, afx } : rest;
  });
}

// ── 文件打开路由 ──

/**
 * 打开文件预览：同主机同路径已开 → 只聚焦；窗口里有同主机的预览窗格 → 在里面开新标签；
 * 否则在来源窗格新开。主机取来源标签的主机，其次来源窗格，最后 server。
 */
/**
 * 打开某一轮某文件的改动 diff（preview 标签的 diff 形态）。
 * 选中顺序：已开的同轮同文件标签 → 有同主机 preview 标签的窗格 → 新开一个窗格。
 */
export function openDiff(
  win: Window,
  fromPid: string,
  fromTabId: string | null,
  /** null = 工作区 vs HEAD（git 面板），有值 = 某一轮 */
  turn: number | null,
  path: string,
  ctx: Ctx,
  /** 某一轮属于哪个会话；工作区 vs HEAD（turn 为 null）不需要 */
  sid?: string,
): Result<Window> {
  return openDiffTab(win, fromPid, fromTabId, { turn, path }, ctx, sid);
}

/** 打开团队建队以来某文件的改动 diff；sid 是团队所属的会话（lead） */
export function openTeamDiff(
  win: Window,
  fromPid: string,
  fromTabId: string | null,
  path: string,
  ctx: Ctx,
  sid: string,
): Result<Window> {
  return openDiffTab(
    win,
    fromPid,
    fromTabId,
    { turn: null, path, team: true },
    ctx,
    sid,
  );
}

function openDiffTab(
  win: Window,
  fromPid: string,
  fromTabId: string | null,
  diff: NonNullable<Tab["diff"]>,
  ctx: Ctx,
  sid: string | undefined,
): Result<Window> {
  const from = findPane(win, fromPid);
  if (!from) return fail("not-found", `窗格 ${fromPid} 不存在`);
  const host =
    from.tabs.find((t) => t.id === fromTabId)?.host ?? from.host ?? "server";
  const panes = panesOf(win);
  for (const p of panes) {
    const hit = p.tabs.find(
      (t) =>
        t.diff?.turn === diff.turn &&
        t.diff.path === diff.path &&
        t.diff.team === diff.team &&
        t.sid === sid,
    );
    if (hit) return activateTab(win, p.pid, hit.id);
  }
  const tab = newTab(ctx, "preview", {
    host,
    path: diff.path,
    diff,
    ...(sid === undefined ? {} : { sid }),
  });
  const target = panes.find(
    (p) => p.host === host && p.tabs.some((t) => t.type === "preview"),
  );
  if (target) return addTabToPane(win, target.pid, tab);
  return splitPane(win, from.pid, "right", tab, ctx);
}

/**
 * 文件管理器点文件。temp = 单击：开（或把同主机已有的临时预览就地换成）临时预览标签；
 * 不 temp = 双击 / Enter：开固定的预览标签，已开着同一文件的临时预览就把它固定下来。
 * 已开同主机同路径的预览一律只激活。
 */
export function openPreview(
  win: Window,
  fromPid: string,
  fromTabId: string | null,
  path: string,
  ctx: Ctx,
  temp: boolean,
): Result<Window> {
  const from = findPane(win, fromPid);
  if (!from) return fail("not-found", `窗格 ${fromPid} 不存在`);
  const host =
    from.tabs.find((t) => t.id === fromTabId)?.host ?? from.host ?? "server";
  const panes = panesOf(win);
  for (const p of panes) {
    const hit = p.tabs.find(
      (t) => t.type === "preview" && t.path === path && t.host === host,
    );
    if (!hit) continue;
    // 双击 / Enter 要固定的文件，正好是临时预览：先去掉临时标记
    if (!temp && hit.temp) {
      const pinned = patchTab(win, hit.id, { temp: undefined });
      return pinned.ok ? activateTab(pinned.value, p.pid, hit.id) : pinned;
    }
    return activateTab(win, p.pid, hit.id);
  }
  const fresh = newTab(ctx, "preview", { host, path });
  if (temp) {
    for (const p of panes) {
      const old = p.tabs.find(
        (t) => t.type === "preview" && t.temp === true && t.host === host,
      );
      if (!old) continue;
      // 换成新标签（新 id）：预览组件按标签 id 重建，不带着旧文件的状态
      const swapped = mapPane(win, p.pid, (q) => ({
        ...q,
        tabs: q.tabs.map((t) =>
          t.id === old.id ? { ...fresh, temp: true } : t,
        ),
        active: q.active === old.id ? fresh.id : q.active,
      }));
      return activateTab(swapped, p.pid, fresh.id);
    }
  }
  const tab = temp ? { ...fresh, temp: true } : fresh;
  const target = panes.find(
    (p) => p.host === host && p.tabs.some((t) => t.type === "preview"),
  );
  if (target) return addTabToPane(win, target.pid, tab);
  // 没有同主机的预览窗格就新开一个：塞进当前窗格会把文件管理器挤掉
  return splitPane(win, from.pid, "right", tab, ctx);
}

/**
 * 对话里点文件引用：落点规则与 diff 一致 —— 已开的同文件预览就激活，有该主机的预览窗格就放进去，
 * 都没有就右侧新开一个窗格（不要把预览塞进对话窗格，那会把对话挤掉）。
 */
export function openFilePreview(
  win: Window,
  fromPid: string,
  fromTabId: string | null,
  host: string,
  path: string,
  ctx: Ctx,
): Result<Window> {
  const from = findPane(win, fromPid);
  if (!from) return fail("not-found", `窗格 ${fromPid} 不存在`);
  const panes = panesOf(win);
  for (const p of panes) {
    const hit = p.tabs.find(
      (t) => t.type === "preview" && t.host === host && t.path === path,
    );
    if (hit) return activateTab(win, p.pid, hit.id);
  }
  const tab = newTab(ctx, "preview", { host, path });
  const target = panes.find(
    (p) => p.host === host && p.tabs.some((t) => t.type === "preview"),
  );
  if (target) return addTabToPane(win, target.pid, tab);
  return splitPane(win, from.pid, "right", tab, ctx);
}

/**
 * agent 开始用浏览器：把它在用的页面摆到用户面前（自动出标签）。
 * 窗口里没有浏览器标签 → 在焦点窗格右侧新开窗格放它；有但都在后台（所在窗格当前标签不是它）→ 切到第一个并让它显示这个页面；
 * 已有一个在前台 → 窗口不动（它自己在工具条上提示新页面）。
 * 都不动焦点窗格：用户可能正在别处输入。
 */
export function revealBrowser(
  win: Window,
  pageId: string,
  ctx: Ctx,
): Result<Window> {
  const hits = panesOf(win).flatMap((p) =>
    p.tabs.filter((t) => t.type === "web").map((tab) => ({ pane: p, tab })),
  );
  if (hits.some((h) => h.pane.active === h.tab.id)) return ok(win);
  const first = hits[0];
  if (first) {
    const shown = patchTab(win, first.tab.id, { page: pageId });
    if (!shown.ok) return shown;
    return ok({
      ...mapPane(shown.value, first.pane.pid, (p) => ({
        ...p,
        active: first.tab.id,
      })),
      focus: win.focus,
    });
  }
  const split = splitPane(
    win,
    win.focus,
    "right",
    newTab(ctx, "web", { page: pageId }),
    ctx,
  );
  return split.ok ? ok({ ...split.value, focus: win.focus }) : split;
}

/**
 * 用户主动要在浏览器里看某个页面（如预览标签的「在浏览器中打开」）：已有浏览器标签就让它显示这一页并切过去，
 * 没有就在来源窗格右侧新开窗格。与自动出标签（revealBrowser）不同，这是用户的操作，焦点跟过去。
 */
export function openInBrowser(
  win: Window,
  fromPid: string,
  pageId: string,
  ctx: Ctx,
): Result<Window> {
  if (!findPane(win, fromPid))
    return fail("not-found", `窗格 ${fromPid} 不存在`);
  const hit = panesOf(win)
    .flatMap((p) => p.tabs.map((tab) => ({ pane: p, tab })))
    .find((h) => h.tab.type === "web");
  if (!hit)
    return splitPane(
      win,
      fromPid,
      "right",
      newTab(ctx, "web", { page: pageId }),
      ctx,
    );
  const shown = patchTab(win, hit.tab.id, { page: pageId });
  return shown.ok ? activateTab(shown.value, hit.pane.pid, hit.tab.id) : shown;
}
