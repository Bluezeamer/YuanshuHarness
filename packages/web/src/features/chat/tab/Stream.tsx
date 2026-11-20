import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type JobSnapshot, type Known, noticeKey } from "../../../api";
import { loadToken } from "../../../api/http";
import { listTurnChanges, type StoredTurn } from "../../../api/turnChanges";
import { Button } from "../../../ui";
import { copyStreamAsMarkdown } from "../../markdown/copySource";
import type { ChatSession } from "../hooks";
import type { Prompt } from "../model/conversation";
import { CompactionCard } from "./Compaction";
import type { FlowLog } from "./flowLog";
import { GoalNoticeCard } from "./GoalNotice";
import { JobNoticeCard } from "./JobNotice";
import { LiveLineRow } from "./LiveLine";
import { liveLineOf } from "./liveLine";
import { Partial, Typing } from "./Messages";
import { ConversationNav } from "./NavTicks";
import { placeNotices } from "./notices";
import { type Answer, PromptCard } from "./PromptCards";
import { PromptPager } from "./PromptPager";
import { Receipt } from "./Receipt";
import { useStickyScroll } from "./scroll";
import { ToolRuns } from "./ToolGroups";
import { TurnChangesCard } from "./TurnChangesCard";
import { TurnMessage } from "./TurnMessage";
import { rowOfTool } from "./toolRows";

export interface StreamProps {
  sessionId: string;
  session: ChatSession;
  log: FlowLog;
  onAnswer(prompt: Prompt, answer: Answer, label: string): void;
  /** 本端发送的次数；变了就回到底部 */
  sent?: number;
  /** 左缘导航（对话标签有，执行体视图没有） */
  nav?: boolean;
  /** 点后台任务回调卡：开任务标签或执行体标签；不给就是只读的一行 */
  onOpenJob?(job: JobSnapshot): void;
}

type Event = { at: number; seq: number; node: ReactNode };
// 按绝对消息序位插进对话流的卡片：压缩边界与后台任务回调；同一位置压缩边界在前
type Card = { at: number; rank: number; order: number; node: ReactNode };

// 轮末清单的补拉：服务端写库晚于 run.ended，拉空就退避重试（最多这么多次 / 每次间隔这么久）
const TURNS_RETRY = 5;
const TURNS_RETRY_MS = 700;

// 把回执 / 已落定的弹窗卡按锚点（当时已有多少条消息）插进消息序列。
function eventsOf(
  log: FlowLog,
  props: Pick<StreamProps, "sessionId" | "onAnswer">,
  errorOf: (id: string) => string | null,
): Event[] {
  const out: Event[] = log.receipts.map((r) => ({
    at: r.at,
    seq: r.seq,
    node: <Receipt key={`r${r.seq}`} r={r} />,
  }));
  for (const e of log.prompts)
    if (e.status !== "pending")
      out.push({
        at: e.at,
        seq: e.seq,
        node: (
          <PromptCard
            key={`p${e.prompt.promptId}`}
            sessionId={props.sessionId}
            entry={e}
            error={errorOf(e.prompt.promptId)}
            onAnswer={props.onAnswer}
          />
        ),
      });
  return out.sort((a, b) => a.at - b.at || a.seq - b.seq);
}

export function Stream({
  sessionId,
  session,
  log,
  onAnswer,
  sent = 0,
  nav = false,
  onOpenJob,
}: StreamProps) {
  const { state, actions } = session;
  const older = state.loaded.older;
  const hasEarlier = state.loaded.nextBefore !== null;
  const anchoring = useRef(false);
  const lastHeight = useRef(0);
  const firstIndex = useRef(Number.POSITIVE_INFINITY);

  const loadEarlier = () => {
    if (state.loadingEarlier || state.earlierFailed) return;
    anchoring.current = true;
    actions.loadEarlier();
  };

  const pending = log.prompts.filter((e) => e.status === "pending");
  const liveIds = new Set(
    state.messages.flatMap((m) =>
      (m.blocks ?? []).flatMap((b) => (b.type === "tool" ? [b.id] : [])),
    ),
  );
  // 嵌套调用（有 parentId）不并列渲染：只在父行下面挂一层
  const kidsOf = new Map<string, typeof state.tools>();
  for (const t of state.tools) {
    if (!t.parentId) continue;
    const list = kidsOf.get(t.parentId) ?? [];
    list.push(t);
    kidsOf.set(t.parentId, list);
  }
  const withKids = <T extends { id: string }>(row: T) => {
    const kids = kidsOf.get(row.id);
    return kids?.length ? { ...row, children: kids.map(rowOfTool) } : row;
  };
  // 消息里的工具块按 id 取子行（TurnMessage → AgentMessage 用）
  const kidsRows = new Map(
    [...kidsOf].map(([id, list]) => [id, list.map(rowOfTool)]),
  );
  const liveTools = state.tools.filter(
    (t) => !liveIds.has(t.id) && !t.parentId,
  );
  // 还在执行的那一步只露一行预览；已经有结果的才折成组
  const running = liveTools.filter((t) => t.status === "running");
  const settled = liveTools.filter((t) => t.status !== "running");
  const live = liveLineOf({
    partial: state.partial,
    partialThinking: state.partialThinking,
    pendingTools: state.pendingTools,
    running,
  });
  const idle =
    state.partial === null &&
    !liveTools.some((t) => t.status === "running") &&
    pending.length === 0;

  // 各轮的改动清单：按「该轮最后一条助手消息的 ts」索引，卡片挂到对应消息下面
  const [turns, setTurns] = useState<StoredTurn[]>([]);
  useEffect(() => {
    setTurns([]);
    let alive = true;
    void listTurnChanges(loadToken(), sessionId).then((r) => {
      if (alive && r.ok) setTurns(r.data);
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);
  // 一轮结束后服务端才写清单：收尾（git 树对比、副本落盘、写库）是 run.ended 之后异步做的，
  // 所以「空闲那一刻拉一次」必然常常拉空。服务端落库后会推 turn.changes 触发重取，但这一帧
  // 不能当唯一依赖（推送链路出问题就又回到「要刷新页面」）。这里再兜一层短退避重试：
  // 拉空就等一会再试，最多 RETRY_MS 次，拿到非空清单即停。
  // biome-ignore lint/correctness/useExhaustiveDependencies: turnRev 是触发重取的版本号，函数体里不读它
  useEffect(() => {
    if (!idle) return;
    let alive = true;
    let timer: number | null = null;
    let tries = 0;
    const pull = async () => {
      const r = await listTurnChanges(loadToken(), sessionId);
      if (!alive) return;
      if (!r.ok) return;
      setTurns(r.data);
      if (r.data.length > 0 || ++tries >= TURNS_RETRY) return;
      timer = window.setTimeout(() => void pull(), TURNS_RETRY_MS);
    };
    void pull();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [idle, sessionId, state.turnRev]);
  const changesByTs = useMemo(() => {
    const m = new Map<string, StoredTurn>();
    for (const t of turns) if (t.anchorTs) m.set(t.anchorTs, t);
    return m;
  }, [turns]);

  const signal = [
    older.length,
    state.messages.length,
    state.loaded.compactions.length,
    state.loaded.notices.length,
    state.notices.length,
    state.partial?.length,
    state.partialThinking.length,
    state.pendingTools.map((t) => `${t.id}${t.args.length}`).join(),
    liveTools.map((t) => `${t.id}${t.status}${t.output?.length ?? 0}`).join(),
    state.queue.length,
    log.receipts.length,
    log.prompts.map((e) => `${e.seq}${e.status}${e.answer ? 1 : 0}`).join(),
    state.running,
    state.error,
    state.notice,
  ].join("|");
  const { ref, onScroll, away, toBottom, hold } = useStickyScroll(
    signal,
    hasEarlier ? loadEarlier : undefined,
    sent,
  );

  // 用户上翻加载更早的历史后，补偿新增高度，视口停在原来的消息上。
  const first = older[0]?.index ?? Number.POSITIVE_INFINITY;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在历史块向前延伸时补偿一次
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && anchoring.current && first < firstIndex.current) {
      el.scrollTop += el.scrollHeight - lastHeight.current;
      anchoring.current = false;
    }
    firstIndex.current = first;
  }, [first]);
  useLayoutEffect(() => {
    if (!state.loadingEarlier) anchoring.current = false;
  }, [state.loadingEarlier]);
  // 每次提交后记下高度，作为下一次补偿的基准（必须排在补偿 effect 之后）。
  useLayoutEffect(() => {
    if (ref.current) lastHeight.current = ref.current.scrollHeight;
  });

  const errorOf = (id: string) =>
    state.promptError?.promptId === id ? state.promptError.message : null;
  const events = eventsOf(log, { sessionId, onAnswer }, errorOf);
  // 压缩边界卡与后台任务回调卡按绝对消息序位插入：更早历史带 index，窗口从「最后一条历史 + 1」连续编号。
  // 落在已显示区间之外的锚点属于还没载入的部分，先不插入。
  const windowStart = (older.at(-1)?.index ?? -1) + 1;
  const windowEnd = windowStart + state.messages.length;
  const firstShown = older[0]?.index ?? windowStart;
  const cards: Card[] = [
    ...state.loaded.compactions.map((c) => ({
      at: c.afterIndex,
      rank: 0,
      order: c.seq,
      node: <CompactionCard key={`k${c.seq}`} c={c} />,
    })),
    ...placeNotices(state.loaded.notices, state.notices, windowStart).map(
      (n, i) => ({
        at: n.at,
        rank: 1,
        order: i,
        node:
          n.kind === "job" ? (
            <JobNoticeCard
              key={`j${noticeKey(n)}`}
              job={n.job}
              {...(onOpenJob ? { onOpen: onOpenJob } : {})}
            />
          ) : (
            <GoalNoticeCard key={`g${noticeKey(n)}`} goal={n.goal} ts={n.ts} />
          ),
      }),
    ),
  ]
    .filter((c) => c.at >= firstShown && c.at <= windowEnd)
    .sort((a, b) => a.at - b.at || a.rank - b.rank || a.order - b.order);
  // 轮次判断跨「更早历史 + 快照窗口」：assistant 消息后面没有 assistant 消息（下一条是 user 或没有）
  // 才是本轮最后一条，只有它渲染操作行（原文切换 / 分叉 / 时间）。
  const historyLen = older.length;
  const roleAt = (at: number): string | undefined =>
    at < historyLen ? older[at]?.role : state.messages[at - historyLen]?.role;
  const turnEndAt = (at: number): boolean =>
    roleAt(at) === "assistant" && roleAt(at + 1) !== "assistant";

  const body: ReactNode[] = [];
  const history: ReactNode[] = [];
  let ei = 0;
  let ci = 0;
  const flushEvents = (upTo: number) => {
    for (let e = events[ei]; e && e.at <= upTo; e = events[++ei])
      body.push(e.node);
  };
  const flushCards = (upTo: number, into: ReactNode[] = body) => {
    for (let c = cards[ci]; c && c.at <= upTo; c = cards[++ci])
      into.push(c.node);
  };
  for (let i = 0; i < older.length; i++) {
    const m = older[i];
    if (!m) continue;
    flushCards(m.index, history);
    const chg = turnEndAt(i) && m.ts ? changesByTs.get(m.ts) : undefined;
    history.push(
      <TurnMessage
        key={`h${m.index}`}
        m={m}
        sessionId={sessionId}
        turnEnd={turnEndAt(i)}
        kids={kidsRows}
      />,
    );
    if (chg)
      history.push(
        <TurnChangesCard
          key={`c${m.index}`}
          sessionId={sessionId}
          turn={chg}
        />,
      );
  }
  for (let i = 0; i < state.messages.length; i++) {
    flushCards(windowStart + i);
    flushEvents(i);
    const wm = state.messages[i] as Known;
    const chg =
      turnEndAt(historyLen + i) && wm.ts ? changesByTs.get(wm.ts) : undefined;
    body.push(
      <TurnMessage
        key={`w${i}`}
        m={wm}
        sessionId={sessionId}
        turnEnd={turnEndAt(historyLen + i)}
        kids={kidsRows}
      />,
    );
    if (chg)
      body.push(
        <TurnChangesCard key={`c${i}`} sessionId={sessionId} turn={chg} />,
      );
  }
  flushEvents(Number.POSITIVE_INFINITY);
  flushCards(windowEnd);

  const empty =
    state.conn === "open" &&
    !state.historyLoading &&
    !hasEarlier &&
    older.length === 0 &&
    state.messages.length === 0 &&
    cards.length === 0 &&
    state.partial === null &&
    state.tools.length === 0 &&
    state.queue.length === 0 &&
    events.length === 0 &&
    pending.length === 0;

  return (
    <div className="ch-stream-wrap">
      <div
        ref={ref}
        role="log"
        aria-label="对话记录"
        className="ch-stream"
        data-chat-stream=""
        onScroll={onScroll}
        onCopy={copyStreamAsMarkdown}
        onClickCapture={(e) => {
          // 运行态那一行点开时要跟到底（里面是在长的输出），不留位置
          const t = (e.target as Element).closest("[aria-expanded]");
          if (t && !t.closest("[data-live]")) hold();
        }}
      >
        {state.historyFailed && (
          <p className="ch-note is-bad t-aux">历史加载失败，只显示当前窗口</p>
        )}
        {hasEarlier && (
          <div className="ch-earlier">
            <Button
              size="sm"
              onClick={loadEarlier}
              disabled={state.loadingEarlier}
            >
              {state.loadingEarlier ? "加载中…" : "加载更早"}
            </Button>
            {state.earlierFailed && (
              <span className="ch-note is-bad t-aux">
                更早的消息加载失败，请重试
              </span>
            )}
          </div>
        )}
        {empty && <p className="ch-note t-aux">还没有消息</p>}
        {history}
        {body}
        {state.partial !== null && (
          <Partial
            text={state.partial}
            thinking={live?.kind === "thinking" ? "" : state.partialThinking}
            caret={live === null}
            sessionId={sessionId}
          />
        )}
        {(settled.length > 0 || live) && (
          <div className="ch-msg ch-agent">
            {settled.length > 0 && (
              <ToolRuns rows={settled.map((t) => withKids(rowOfTool(t)))} />
            )}
            {live && <LiveLineRow line={live} />}
          </div>
        )}
        <PromptPager
          entries={pending}
          sessionId={sessionId}
          errorOf={errorOf}
          onAnswer={onAnswer}
        />
        {state.running && idle && <Typing />}
        {state.error && <p className="ch-note is-bad t-aux">{state.error}</p>}
        {state.notice && <p className="ch-note is-bad t-aux">{state.notice}</p>}
      </div>
      {nav && (
        <ConversationNav
          sessionId={sessionId}
          session={session}
          scrollRef={ref}
        />
      )}
      {away && (
        <Button size="sm" className="ch-tobottom" onClick={toBottom}>
          回到底部
        </Button>
      )}
    </div>
  );
}
