// 对话导航的数据与行为：节点 = 当前会话全部用户输入，滚动时算当前位置，点击按 scrollTop 定位（更早的先加载历史）。
// 全量节点来自 GET /user-messages（长会话里本地只渲染了一部分）；取不到就退回本地已渲染的指令。

import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { loadToken } from "../../../api/http";
import { getUserMessages, type UserMessageEntry } from "../../../api/sessions";
import type { ChatSession } from "../hooks";
import {
  activeUserIndex,
  jumpToUser,
  localNodes,
  mapRenderedToNodes,
  type NavNode,
  renderedUsers,
  userRects,
} from "./conversationNav";
import { stripAttachLines } from "./format";

export function useConversationNav({
  sessionId,
  session,
  scrollRef,
}: {
  sessionId: string;
  session: ChatSession;
  /** 对话流的滚动容器（useStickyScroll 的 ref） */
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { state, actions } = session;
  const users = useMemo(
    () => renderedUsers(state.loaded.older, state.messages),
    [state.loaded.older, state.messages],
  );
  const [list, setList] = useState<UserMessageEntry[] | null>(null);
  // DOM 里滚过视口顶边最近的一条用户消息；-1 表示都还在视口里。
  const [activeLocal, setActiveLocal] = useState(-1);
  // 待定位的全量节点序位：目标消息还没渲染时先加载更早历史，出现后自动滚过去。
  const [pending, setPending] = useState<number | null>(null);
  const alive = useRef(true);
  const loading = useRef(false);
  const stall = useRef(0);
  const lastRendered = useRef(-1);

  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // 节点：接口列表优先；没取到时用已渲染的本地指令兜底。
  // 接口给的是落盘原文（附件消息带 [attach_file] 标记），剥掉后与流里的消息文本对齐。
  const nodes = useMemo<NavNode[]>(
    () =>
      list && list.length > 0
        ? list.map((m) => ({
            entryId: m.entryId,
            text: stripAttachLines(m.text),
            timestamp: m.timestamp,
          }))
        : localNodes(users),
    [list, users],
  );
  const map = useMemo(() => mapRenderedToNodes(users, nodes), [users, nodes]);
  const reverse = useMemo(() => {
    const out = new Map<number, number>();
    map.forEach((nodeIndex, renderedIndex) => {
      if (nodeIndex >= 0) out.set(nodeIndex, renderedIndex);
    });
    return out;
  }, [map]);

  // 接口列表过期：已渲染的最新一条不在列表尾部（取列表之后又发了新指令）。
  const stale =
    list !== null &&
    list.length > 0 &&
    users.length > 0 &&
    (users[users.length - 1] ?? "").slice(0, 120) !==
      stripAttachLines(list[list.length - 1]?.text ?? "").slice(0, 120);

  const load = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
    void getUserMessages(sessionId, loadToken()).then((r) => {
      loading.current = false;
      // 失败保留旧列表（或继续用本地节点），下次指令数变化时再试
      if (alive.current && r.ok) setList(r.data);
    });
  }, [sessionId]);

  // 进来取一次；之后只在指令数变化且列表落后时再取
  const need = list === null || stale;
  // biome-ignore lint/correctness/useExhaustiveDependencies: users.length 是「又发了一条指令」的触发信号
  useEffect(() => {
    if (need) load();
  }, [need, load, users.length]);

  // 滚动时重新测量当前节点。
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rects = userRects(el);
    if (!rects) return;
    const next = activeUserIndex(rects);
    setActiveLocal((prev) => (prev === next ? prev : next));
  }, [scrollRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: users.length 只是「内容变了」的触发信号
  useEffect(() => {
    measure();
  }, [measure, users.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    return () => el.removeEventListener("scroll", measure);
  }, [scrollRef, measure]);

  // 点击节点：已渲染的立刻定位；更早的逐页加载历史，等它出现再定位。
  useEffect(() => {
    if (pending === null) return;
    const rendered = reverse.get(pending);
    if (rendered !== undefined) {
      if (jumpToUser(scrollRef.current, rendered)) setPending(null);
      return;
    }
    if (state.loadingEarlier || state.historyLoading) {
      stall.current = 0;
      return;
    }
    if (state.earlierFailed || state.loaded.nextBefore === null) {
      setPending(null);
      return;
    }
    // 加载成功但历史没往前延伸（游标对不上等）：重试几次后放弃，避免死循环。
    if (lastRendered.current === users.length) {
      stall.current += 1;
      if (stall.current > 3) {
        setPending(null);
        return;
      }
    } else {
      lastRendered.current = users.length;
      stall.current = 0;
    }
    actions.loadEarlier();
  }, [
    pending,
    reverse,
    users.length,
    state.loadingEarlier,
    state.historyLoading,
    state.earlierFailed,
    state.loaded.nextBefore,
    actions,
    scrollRef,
  ]);

  // 当前节点：滚动位置对应的全量序位；还没滚过去的初始状态是首条可见指令。
  const activeNode = useMemo(() => {
    if (nodes.length === 0) return -1;
    const start = Math.min(users.length - 1, Math.max(0, activeLocal));
    if (users.length === 0) return 0;
    for (let i = start; i >= 0; i--) {
      const node = map[i];
      if (node !== undefined && node >= 0) return node;
    }
    return reverse.size > 0 ? Math.min(...reverse.keys()) : 0;
  }, [activeLocal, map, nodes.length, reverse, users.length]);

  return {
    nodes,
    /** 当前位置（正在定位时是目标） */
    active: pending ?? activeNode,
    jump: setPending,
  };
}
