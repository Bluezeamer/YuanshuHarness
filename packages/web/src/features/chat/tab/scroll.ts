import { useLayoutEffect, useRef, useState } from "react";

// 距底不足这么多像素就算「在底部」
export const STICK_GAP = 24;
// 距顶不足这么多像素就去加载更早的消息
export const TOP_GAP = 48;

// 距底还有多少像素（负数表示内容还没铺满视口）
const gapOf = (el: HTMLElement) =>
  el.scrollHeight - el.scrollTop - el.clientHeight;

interface Box<T> {
  current: T;
}

// 钉到底，并记下钉到的位置（下面判断「这次滚动是不是我们自己造的」要用）。
const pin = (el: HTMLElement, at: Box<number | null>) => {
  el.scrollTop = el.scrollHeight;
  at.current = el.scrollTop;
};

// 还在跟随才补滚：内容长高但用户已经上翻时不能抢回去。
const pinIfStuck = (
  el: HTMLElement,
  stuck: Box<boolean>,
  at: Box<number | null>,
) => {
  if (stuck.current && gapOf(el) > 1) pin(el, at);
};

// 自动贴底：用 scrollTop 计算（不用 scrollIntoView，那会带动嵌入预览整页滚动）。
//
// 判定「是否还在跟随」要区分两种 scrollTop 变化：
// - 用户自己往上滑 → 停止跟随，露出「回到底部」；
// - 我们钉到底之后内容又长高（流式追加、图片/svg 载入、代码块展开、异步高亮）→ 继续跟随。
//   后者的顺序是「先钉住、内容再长高」，浏览器随后才派发 scroll 事件，此时算出来的 gap 已经很大；
//   若只看 gap 就会误判成「用户上滑」，一次之后再也不跟了——长内容流式不跟底就是这么来的。
// 所以记下自己钉到的位置：位置一动没动，就算我们自己的滚动。
export function useStickyScroll(signal: unknown, onTop?: () => void, sent = 0) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const pinnedTop = useRef<number | null>(null);
  const [away, setAway] = useState(false);
  const topCb = useRef(onTop);
  topCb.current = onTop;

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const gap = gapOf(el);
    const at = pinnedTop.current;
    const ours = at !== null && Math.abs(el.scrollTop - at) <= 1;
    if (gap < STICK_GAP) {
      stuck.current = true;
      pinnedTop.current = el.scrollTop;
      setAway(false);
    } else if (!ours) {
      stuck.current = false;
      setAway(true);
    } else if (stuck.current) {
      // 上次贴底之后内容又长高了：补滚到底，不算「离开底部」
      pin(el, pinnedTop);
    }
    if (el.scrollTop < TOP_GAP) topCb.current?.();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: signal 只是「内容变了」的触发信号
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) pin(el, pinnedTop);
  }, [signal]);

  // 内容长高不一定伴随新 signal（图片载入、代码块展开、高亮落地），逐个子元素观察盒高补滚。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => pinIfStuck(el, stuck, pinnedTop));
    const seen = new Set<Element>();
    const sync = () => {
      for (const c of el.children)
        if (!seen.has(c)) {
          seen.add(c);
          ro.observe(c);
        }
      for (const c of seen)
        if (!c.isConnected) {
          ro.unobserve(c);
          seen.delete(c);
        }
    };
    sync();
    const mo =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(sync);
    mo?.observe(el, { childList: true });
    return () => {
      mo?.disconnect();
      ro.disconnect();
    };
  }, []);

  // 停靠区（状态条）展开/收起、窗口缩放只改变滚动容器的高度，不触发 signal；
  // 仍贴底时补滚到底（状态条的 grid 过渡会连续触发），离开状态不抢回。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const gap = gapOf(el);
      if (stuck.current) {
        if (gap > 1) pin(el, pinnedTop);
      } else if (gap < STICK_GAP) {
        // 容器变高后内容已经放得下：收回「回到底部」，但不主动滚动。
        stuck.current = true;
        setAway(false);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toBottom = () => {
    const el = ref.current;
    if (!el) return;
    stuck.current = true;
    pin(el, pinnedTop);
    setAway(false);
  };

  // 用户点开 / 收起某一项：位置留给用户，不让跟随把它顶走；下一帧按实际距底决定是否继续跟随
  const hold = () => {
    stuck.current = false;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const near = gapOf(el) < STICK_GAP;
      stuck.current = near;
      if (near) pinnedTop.current = el.scrollTop;
      setAway(!near);
    });
  };

  // 本端发送：不管之前翻到哪都回到底部并恢复跟随
  // biome-ignore lint/correctness/useExhaustiveDependencies: sent 只是「刚发送过」的触发信号
  useLayoutEffect(() => {
    if (sent > 0) toBottom();
  }, [sent]);

  return { ref, onScroll, away, toBottom, hold };
}
