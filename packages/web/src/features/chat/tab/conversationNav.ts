// 对话导航的几何与序位工具：已渲染用户消息、滚动测量、按 scrollTop 定位。
// 只用 scrollTop + getBoundingClientRect 计算，不用 scrollIntoView（会带动嵌入预览整页滚动）。

import type { ChatEntry, Known } from "../../../api";
import { firstLine, fmtClock } from "./format";

// 视口顶边的容差：消息刚好顶到视口顶边也算「已滚过去」。
export const VIEW_TOP = 2;
// 定位后目标消息停在视口顶边（0 = 贴着顶边，padding 之上）：当前位置随之落在目标上。
export const JUMP_OFFSET = 0;
// 定位后短暂高亮目标消息的时长（只做视觉确认，不需要与动效时长严格对齐）。
export const JUMP_FLASH_MS = 1200;

/** 导航节点：一条用户输入（更早的历史在前的序位）。 */
export interface NavNode {
  entryId?: string;
  text: string;
  timestamp: string | null;
}

// 节点文本从尾部对齐时的比较长度：快照里的长文本会被截断，比开头一段就够。
const MATCH_KEY = 120;
const matchKey = (text: string): string => text.slice(0, MATCH_KEY);

export interface UserRect {
  top: number;
  bottom: number;
}

/** 已渲染的用户消息原文，按 DOM 里 .ch-you 的顺序：更早历史在前、当前窗口在后。 */
export function renderedUsers(
  older: readonly ChatEntry[],
  messages: readonly Known[],
): string[] {
  const out: string[] = [];
  for (const m of older) if (m.role === "user") out.push(m.text);
  for (const m of messages) if (m.role === "user") out.push(m.text);
  return out;
}

/** 本地已渲染的用户消息转成导航节点（本地没有时间戳，只有全量接口才有）。 */
export const localNodes = (users: readonly string[]): NavNode[] =>
  users.map((text) => ({ text, timestamp: null }));

/**
 * 测量已渲染用户消息相对滚动容器视口顶边的位置。
 * jsdom 没有布局、以及流区还没铺开（高度为 0）时返回 null：宁可不更新当前位置，也不要按假位置乱跳。
 */
export function userRects(scrollEl: HTMLElement): UserRect[] | null {
  const stream = scrollEl.getBoundingClientRect();
  if (stream.height <= 0) return null;
  return [...scrollEl.querySelectorAll<HTMLElement>(".ch-you")].map((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top - stream.top, bottom: r.bottom - stream.top };
  });
}

/** 视口顶边之上最近的一条用户消息序位；一条都没有返回 -1。 */
export function activeUserIndex(rects: readonly UserRect[]): number {
  let active = -1;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r && r.top <= VIEW_TOP) active = i;
  }
  return active;
}

/** 目标消息对齐到视口顶边时滚动容器应有的 scrollTop。 */
export function scrollTopFor(
  target: HTMLElement,
  scrollEl: HTMLElement,
): number {
  const stream = scrollEl.getBoundingClientRect();
  const top =
    scrollEl.scrollTop + target.getBoundingClientRect().top - stream.top;
  return Math.max(0, Math.round(top - JUMP_OFFSET));
}

// 定位后高亮的目标元素与它的清理定时器：重复点同一条时只留最后一次。
const flashes = new WeakMap<HTMLElement, number>();

function highlight(el: HTMLElement): void {
  el.classList.add("is-jump");
  const prev = flashes.get(el);
  if (prev !== undefined) window.clearTimeout(prev);
  flashes.set(
    el,
    window.setTimeout(() => {
      el.classList.remove("is-jump");
      flashes.delete(el);
    }, JUMP_FLASH_MS),
  );
}

/** 平滑滚动到容器内的像素位置；没有 scrollTo（jsdom）时退回直接设 scrollTop。 */
export function scrollToOffset(scrollEl: HTMLElement, top: number): void {
  const y = Math.max(0, Math.round(top));
  const smooth = (scrollEl as { scrollTo?: unknown }).scrollTo;
  if (typeof smooth === "function") {
    try {
      (smooth as (options: ScrollToOptions) => void).call(scrollEl, {
        top: y,
        behavior: "smooth",
      });
      return;
    } catch {
      // 某些环境声明了 scrollTo 却没有实现，退回直接赋值
    }
  }
  scrollEl.scrollTop = y;
}

/** 滚动到第 index 条已渲染的用户消息并短暂高亮；目标不存在返回 false。 */
export function jumpToUser(
  scrollEl: HTMLElement | null,
  index: number,
): boolean {
  if (!scrollEl || index < 0) return false;
  const el = scrollEl.querySelectorAll<HTMLElement>(".ch-you")[index];
  if (!el) return false;
  scrollToOffset(scrollEl, scrollTopFor(el, scrollEl));
  highlight(el);
  return true;
}

/**
 * 已渲染用户消息 → 全量节点序位。-1 表示这一条没有对应节点
 * （接口列表不含无文字的附件消息，或列表还没刷新到最新）。
 * 从尾部往前对齐：两边都是分支的最后一段用户消息，新的在后。
 */
export function mapRenderedToNodes(
  users: readonly string[],
  nodes: readonly NavNode[],
): number[] {
  const map = users.map(() => -1);
  let node = nodes.length - 1;
  for (let i = users.length - 1; i >= 0 && node >= 0; i--) {
    if (matchKey(users[i] ?? "") === matchKey(nodes[node]?.text ?? "")) {
      map[i] = node;
      node -= 1;
    }
  }
  return map;
}

/** 节点时间：今天只给时分，跨天补月/日；没有时间戳就不显示。 */
export function fmtNodeTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toDateString() === new Date().toDateString()
    ? fmtClock(d)
    : `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 列表里的一行预览：取首行，超长截断（完整原文放 title）。 */
export function previewLine(text: string, max = 60): string {
  const line = firstLine(text);
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
