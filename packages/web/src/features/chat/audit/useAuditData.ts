// 审计页的数据钩子：调用序列的分页载入与单次调用详情的按需拉取。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CallCompaction,
  type CallRecord,
  type CallSummary,
  type CallsPage,
  getCall,
  getCompactions,
  listCalls,
  listSubagentCalls,
} from "../../../api/calls";
import { loadToken } from "../../../api/http";
import { mergeFirstPage } from "./model";

const PAGE = 100;

export type ListPhase = "loading" | "ready" | "error";

export interface CallList {
  calls: CallSummary[];
  nextBefore: number | null;
  phase: ListPhase;
  /** 首页失败的原因（CallResult 的 kind） */
  error: string | null;
  /** 载入更早 / 刷新 的进行态 */
  busy: "more" | "refresh" | null;
  moreFailed: boolean;
  loadMore(): void;
  refresh(): void;
  reload(): void;
}

export function useCallList(sessionId: string): CallList {
  const [page, setPage] = useState<CallsPage>({ calls: [], nextBefore: null });
  const [phase, setPhase] = useState<ListPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"more" | "refresh" | null>(null);
  const [moreFailed, setMoreFailed] = useState(false);
  // 会话切换或卸载后，晚到的响应一律丢弃
  const gen = useRef(0);
  // 同一帧里多次触发（连续 scroll 事件）时，state 还没来得及更新，靠 ref 防重入
  const inflight = useRef(false);
  const nextRef = useRef<number | null>(null);
  nextRef.current = page.nextBefore;

  const reload = useCallback(() => {
    const g = ++gen.current;
    setPage({ calls: [], nextBefore: null });
    setPhase("loading");
    setError(null);
    setBusy(null);
    setMoreFailed(false);
    inflight.current = false;
    void listCalls(loadToken(), sessionId, { limit: PAGE }).then((r) => {
      if (g !== gen.current) return;
      if (r.ok) {
        setPage(r.data);
        setPhase("ready");
      } else {
        setError(r.kind);
        setPhase("error");
      }
    });
  }, [sessionId]);

  useEffect(() => {
    reload();
    return () => {
      gen.current++;
    };
  }, [reload]);

  const loadMore = useCallback(() => {
    const before = nextRef.current;
    if (inflight.current || before === null) return;
    inflight.current = true;
    const g = gen.current;
    setBusy("more");
    setMoreFailed(false);
    void listCalls(loadToken(), sessionId, { before, limit: PAGE }).then(
      (r) => {
        if (g !== gen.current) return;
        inflight.current = false;
        setBusy(null);
        if (!r.ok) return setMoreFailed(true);
        setPage((cur) => ({
          calls: [...cur.calls, ...r.data.calls],
          nextBefore: r.data.nextBefore,
        }));
      },
    );
  }, [sessionId]);

  // 取最新一页并入已载入的部分；失败不动现有列表
  const refresh = useCallback(() => {
    if (inflight.current) return;
    inflight.current = true;
    const g = gen.current;
    setBusy("refresh");
    void listCalls(loadToken(), sessionId, { limit: PAGE }).then((r) => {
      if (g !== gen.current) return;
      inflight.current = false;
      setBusy(null);
      if (r.ok) setPage((cur) => mergeFirstPage(cur, r.data));
    });
  }, [sessionId]);

  return {
    calls: page.calls,
    nextBefore: page.nextBefore,
    phase,
    error,
    busy,
    moreFailed,
    loadMore,
    refresh,
    reload,
  };
}

// ── 子代理调用 ──

export interface SubCallList extends Omit<CallList, "nextBefore"> {
  /** 下一页游标（调用 id）；没有更早的为 null */
  nextBefore: string | null;
  /** 整棵子树的调用总数（不随分页变化），「子代理」档的计数 */
  total: number;
}

// 父会话派发出的子会话的调用，单独一路：序号与轮次是各子会话自己的，不能和本会话的 seq 并成一列。
// 刷新直接以最新一页为准（游标是 id，没有 seq 那样可判断「接得上」的邻接关系）。
export function useSubCallList(sessionId: string): SubCallList {
  const [page, setPage] = useState({
    calls: [] as CallSummary[],
    nextBefore: null as string | null,
    total: 0,
  });
  const [phase, setPhase] = useState<ListPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"more" | "refresh" | null>(null);
  const [moreFailed, setMoreFailed] = useState(false);
  const gen = useRef(0);
  const inflight = useRef(false);
  const nextRef = useRef<string | null>(null);
  nextRef.current = page.nextBefore;

  const load = useCallback(
    (kind: "first" | "refresh") => {
      const g = ++gen.current;
      inflight.current = true;
      if (kind === "first") {
        setPage({ calls: [], nextBefore: null, total: 0 });
        setPhase("loading");
        setError(null);
        setBusy(null);
      } else setBusy("refresh");
      setMoreFailed(false);
      void listSubagentCalls(loadToken(), sessionId, { limit: PAGE }).then(
        (r) => {
          if (g !== gen.current) return;
          inflight.current = false;
          setBusy(null);
          if (r.ok) {
            setPage(r.data);
            setPhase("ready");
          } else if (kind === "first") {
            setError(r.kind);
            setPhase("error");
          }
        },
      );
    },
    [sessionId],
  );

  useEffect(() => {
    load("first");
    return () => {
      gen.current++;
    };
  }, [load]);

  const loadMore = useCallback(() => {
    const before = nextRef.current;
    if (inflight.current || before === null) return;
    inflight.current = true;
    const g = gen.current;
    setBusy("more");
    setMoreFailed(false);
    void listSubagentCalls(loadToken(), sessionId, {
      before,
      limit: PAGE,
    }).then((r) => {
      if (g !== gen.current) return;
      inflight.current = false;
      setBusy(null);
      if (!r.ok) return setMoreFailed(true);
      setPage((cur) => ({
        calls: [...cur.calls, ...r.data.calls],
        nextBefore: r.data.nextBefore,
        total: r.data.total,
      }));
    });
  }, [sessionId]);

  const refresh = useCallback(() => {
    if (!inflight.current) load("refresh");
  }, [load]);
  const reload = useCallback(() => load("first"), [load]);

  return {
    calls: page.calls,
    nextBefore: page.nextBefore,
    total: page.total,
    phase,
    error,
    busy,
    moreFailed,
    loadMore,
    refresh,
    reload,
  };
}

// ── 压缩历史 ──

/** 会话的压缩历史；左栏底部的「压缩历史」区用它，取不到时整区不显示。 */
export interface CompactionList {
  compactions: CallCompaction[];
  refresh(): void;
}

export function useCompactionList(sessionId: string): CompactionList {
  const [compactions, setCompactions] = useState<CallCompaction[]>([]);
  const gen = useRef(0);

  const refresh = useCallback(() => {
    const g = ++gen.current;
    void getCompactions(loadToken(), sessionId).then((r) => {
      if (g === gen.current && r.ok) setCompactions(r.data);
    });
  }, [sessionId]);

  useEffect(() => {
    refresh();
    return () => {
      gen.current++;
    };
  }, [refresh]);

  return { compactions, refresh };
}

// 一段压缩历史的调用记录：可能远早于已载入的调用，展开时按 before 游标往回补。
export type SegmentPhase = "loading" | "ready" | "error";

export interface SegmentCalls {
  phase: SegmentPhase;
  /** seq 升序（事件发生的顺序） */
  calls: CallSummary[];
}

interface SegmentHolder {
  sid: string;
  map: Map<number, SegmentCalls>;
}

const SEGMENT_PAGE = 200;
// 往回翻的上限：压缩历史通常在很久以前，翻了这么多页还没到就停下来，交给左栏的「载入更早的调用」
const SEGMENT_MAX_PAGES = 10;

async function loadSegment(
  holder: SegmentHolder,
  c: CallCompaction,
  known: readonly CallSummary[],
  changed: () => void,
): Promise<void> {
  const finish = (phase: SegmentPhase, calls: CallSummary[]) => {
    holder.map.set(c.seq, { phase, calls });
    changed();
  };
  const from = c.callSeqFrom;
  if (from === null || c.callSeqTo === null) return finish("ready", []);
  // 已载入的调用是连续的 seq 区间；最旧的一条不晚于这一段就说明这一段的调用都在手里
  const minKnown = known.at(-1)?.seq;
  if (minKnown !== undefined && minKnown <= from)
    return finish(
      "ready",
      known.filter((x) => x.segment === c.seq).sort((a, b) => a.seq - b.seq),
    );
  const byId = new Map(
    known.filter((x) => x.segment === c.seq).map((x) => [x.id, x]),
  );
  let before = minKnown;
  for (let page = 0; page < SEGMENT_MAX_PAGES; page += 1) {
    const r = await listCalls(loadToken(), holder.sid, {
      limit: SEGMENT_PAGE,
      ...(before === undefined ? {} : { before }),
    });
    if (!r.ok) return finish("error", []);
    for (const call of r.data.calls)
      if (call.segment === c.seq) byId.set(call.id, call);
    const minPage = r.data.calls.at(-1)?.seq;
    if (minPage === undefined || minPage <= from || r.data.nextBefore === null)
      break;
    before = r.data.nextBefore;
  }
  finish(
    "ready",
    [...byId.values()].sort((a, b) => a.seq - b.seq),
  );
}

export interface CompactionSegments {
  get(seq: number): SegmentCalls | undefined;
  /** 已载入的压缩历史段里的调用（右栏选中时用来还原摘要） */
  all(): CallSummary[];
  /** 展开某条压缩历史时补齐这一段的调用 */
  ensure(c: CallCompaction): void;
}

export function useCompactionSegments(
  sessionId: string,
  loaded: readonly CallSummary[],
): CompactionSegments {
  // 已载入的各段调用按会话隔离：换会话时整体作废
  const cache = useRef<SegmentHolder>({ sid: sessionId, map: new Map() });
  if (cache.current.sid !== sessionId)
    cache.current = { sid: sessionId, map: new Map() };
  const [, bump] = useState(0);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const ensure = useCallback((c: CallCompaction) => {
    const holder = cache.current;
    const cur = holder.map.get(c.seq);
    if (cur && cur.phase !== "error") return;
    holder.map.set(c.seq, { phase: "loading", calls: [] });
    bump((n) => n + 1);
    void loadSegment(holder, c, loadedRef.current, () => bump((n) => n + 1));
  }, []);

  return {
    get: (seq) => cache.current.map.get(seq),
    all: () => [...cache.current.map.values()].flatMap((s) => s.calls),
    ensure,
  };
}

// ── 详情 ──

// 最多留这么多条已打开的详情：单条请求体可能很大，切回刚看过的几条够用了。
const CACHE_MAX = 16;

export type DetailPhase = "idle" | "loading" | "ready" | "error";

export interface CallDetail {
  phase: DetailPhase;
  record: CallRecord | null;
  /** 失败原因（CallResult 的 kind） */
  error: string | null;
  retry(): void;
}

/** owner：这条调用实际所属的会话；子代理的调用在子会话名下，缺省就是 sessionId。缓存仍按 sessionId 分。 */
export function useCallDetail(
  sessionId: string,
  callId: string | null,
  owner: string = sessionId,
): CallDetail {
  const cache = useRef({ sid: sessionId, map: new Map<string, CallRecord>() });
  if (cache.current.sid !== sessionId)
    cache.current = { sid: sessionId, map: new Map() };
  const [, bump] = useState(0);
  const [fail, setFail] = useState<{ id: string; kind: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  const cached = callId ? cache.current.map.get(callId) : undefined;
  const failed = callId !== null && fail?.id === callId ? fail : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 只用来在「重试」时重跑；cached 来自 ref，不能进依赖
  useEffect(() => {
    if (!callId || cache.current.map.has(callId)) return;
    let live = true;
    const { map } = cache.current;
    setFail(null);
    void getCall(loadToken(), owner, callId).then((r) => {
      if (!live) return;
      if (r.ok) {
        map.set(callId, r.data);
        if (map.size > CACHE_MAX) map.delete(map.keys().next().value as string);
      } else setFail({ id: callId, kind: r.kind });
      bump((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [sessionId, callId, owner, attempt]);

  return {
    phase: !callId ? "idle" : cached ? "ready" : failed ? "error" : "loading",
    record: cached ?? null,
    error: failed?.kind ?? null,
    retry: () => setAttempt((n) => n + 1),
  };
}
