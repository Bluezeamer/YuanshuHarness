// 审计左栏：汇总 → 类型下拉与搜索 → 按轮次分组的调用序列 → 压缩历史。样式见 audit.css。
// 行的信息：序号、摘要、「触发 · 入 token · 耗时」；其余（时间、模型、发起的工具、结束原因）在悬停卡里。

import { type ReactNode, type UIEvent, useState } from "react";
import type { CallCompaction, CallSummary } from "../../../api/calls";
import {
  Button,
  IconButton,
  ListRow,
  PeekCard,
  SearchBox,
  Select,
} from "../../../ui";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  RefreshIcon,
} from "../../../ui/icons";
import {
  type AuditFilter,
  actionOf,
  FILTERS,
  fmtInt,
  fmtK,
  fmtSec,
  fmtTime,
  groupByTurn,
  inputOf,
  pad2,
  type Totals,
  TRIGGER_LABEL,
} from "./model";
import type { SegmentCalls } from "./useAuditData";

// 距末端不足这么多像素就算「滚到底」，开始载入更早的调用
const NEAR_END = 80;

const est = (c: CallSummary) => (c.tokens.estimated ? "~" : "");

const triggerOf = (c: CallSummary) =>
  `${TRIGGER_LABEL[c.trigger]}${c.toolName ? ` · ${c.toolName}` : ""}`;

function CallRow({
  c,
  selected,
  attr,
  onSelect,
}: {
  c: CallSummary;
  selected: boolean;
  attr: "data-call" | "data-seg-call";
  onSelect(id: string): void;
}) {
  return (
    <ListRow
      {...{ [attr]: c.id }}
      lead={<span className="au-seq t-mono">{pad2(c.seq)}</span>}
      label={c.summary || "（无摘要）"}
      sub={`${triggerOf(c)} · ${est(c)}${fmtK(inputOf(c.tokens))} 入 · ${fmtSec(c.durationMs)}`}
      current={selected}
      onClick={() => onSelect(c.id)}
      peek={
        <PeekCard
          title={c.summary || "（无摘要）"}
          facts={[
            ["时间", fmtTime(c.createdAt)],
            ["触发", triggerOf(c)],
            ["发起", actionOf(c)],
            ["模型", c.model],
            ["输入", `${est(c)}${fmtInt(inputOf(c.tokens))} tok`],
            ["输出", `${est(c)}${fmtInt(c.tokens.out)} tok`],
            ["耗时", fmtSec(c.durationMs, 2)],
            ["结束原因", c.stopReason],
          ]}
        />
      }
    />
  );
}

export interface RailProps {
  /** 当前筛选 / 搜索后的调用（seq 倒序） */
  shown: readonly CallSummary[];
  counts: Record<AuditFilter, number>;
  totals: Totals;
  /** 有筛选或搜索在生效：统计改显筛后合计 */
  scoped: boolean;
  /** 汇总里有估算值 */
  estimated: boolean;
  filter: AuditFilter;
  q: string;
  selectedId: string | null;
  hasMore: boolean;
  busy: "more" | "refresh" | null;
  moreFailed: boolean;
  /** 列表为空时替换默认的「没有符合条件的调用」（这一路还在载入 / 载入失败时用） */
  emptyNote?: ReactNode | undefined;
  /** 压缩历史（seq 升序）；为空时不显示底部这一区 */
  compactions: readonly CallCompaction[];
  /** 某段压缩历史的调用；展开后才去载入，未载入时是 undefined */
  segment(seq: number): SegmentCalls | undefined;
  /** 展开某段压缩历史时补齐它的调用 */
  onSegment(c: CallCompaction): void;
  onFilter(f: AuditFilter): void;
  onQuery(q: string): void;
  onSelect(id: string): void;
  onMore(): void;
  onRefresh(): void;
}

export function Rail(p: RailProps) {
  // 压缩历史整区默认折叠；展开哪几段也是本地状态（换会话时由外层重新挂载）
  const [historyOpen, setHistoryOpen] = useState(false);
  const [openedSeqs, setOpenedSeqs] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const toggleSegment = (c: CallCompaction) => {
    const open = !openedSeqs.has(c.seq);
    setOpenedSeqs((cur) => {
      const next = new Set(cur);
      if (open) next.add(c.seq);
      else next.delete(c.seq);
      return next;
    });
    if (open) p.onSegment(c);
  };
  const near = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END) p.onMore();
  };
  const tilde = p.estimated ? "~" : "";

  return (
    <div className="au-rail">
      <div className="au-sum t-aux" data-asum>
        <span className="au-sum-t">
          <span className="t-mono">{p.totals.count}</span> 次调用
          {p.scoped && " · 筛后"}
          {p.hasMore && (
            <span title="只统计已载入的调用，向下滚动载入更早的">
              {" "}
              · 已载入
            </span>
          )}{" "}
          · 入{" "}
          <span className="t-mono">
            {tilde}
            {fmtK(p.totals.input)}
          </span>{" "}
          · 出{" "}
          <span className="t-mono">
            {tilde}
            {fmtK(p.totals.output)}
          </span>
        </span>
        <IconButton
          size="sm"
          label="刷新"
          icon={<RefreshIcon />}
          disabled={p.busy === "refresh"}
          onClick={p.onRefresh}
        />
      </div>

      <div className="au-ctl">
        <Select
          aria-label="按调用类型筛选"
          value={p.filter}
          onChange={(v) => p.onFilter(v as AuditFilter)}
          options={FILTERS.map((f) => ({
            value: f.id,
            label: f.label,
            hint: p.counts[f.id],
          }))}
        />
        <SearchBox
          value={p.q}
          onChange={p.onQuery}
          placeholder="搜摘要或工具名"
          aria-label="搜索调用记录"
        />
      </div>

      <div className="au-list" data-alist onScroll={near}>
        {p.shown.length === 0 ? (
          <p className="au-none t-aux">
            {p.emptyNote ?? "没有符合条件的调用。清掉搜索或换个筛选。"}
          </p>
        ) : (
          groupByTurn(p.shown).map((g) => (
            <section key={g.calls[0]?.id} className="au-group">
              <div className="au-turn t-group">
                <span
                  title={g.source ? `子会话 ${g.source.sessionId}` : undefined}
                >
                  {g.source ? `${g.source.name} · ` : ""}
                  {g.turn === null ? "未归属轮次" : `轮次 ${g.turn}`}
                </span>
                <span className="t-mono">
                  {fmtTime(g.calls.at(-1)?.createdAt ?? "")}
                </span>
              </div>
              {g.calls.map((c) => (
                <CallRow
                  key={c.id}
                  c={c}
                  attr="data-call"
                  selected={c.id === p.selectedId}
                  onSelect={p.onSelect}
                />
              ))}
            </section>
          ))
        )}
        {p.hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="au-more"
            disabled={p.busy === "more"}
            onClick={p.onMore}
          >
            {p.busy === "more"
              ? "载入中…"
              : p.moreFailed
                ? "载入失败，点此重试"
                : "载入更早的调用"}
          </Button>
        )}
      </div>

      {p.compactions.length > 0 && (
        <div className="au-comp" data-acomp>
          <ListRow
            size="compact"
            lead={historyOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
            label="压缩历史"
            trail={<span className="t-mono">{p.compactions.length}</span>}
            expanded={historyOpen}
            onClick={() => setHistoryOpen((v) => !v)}
          />
          {historyOpen && (
            <div className="au-comp-body">
              {p.compactions.map((c) => {
                const open = openedSeqs.has(c.seq);
                const seg = open ? p.segment(c.seq) : undefined;
                return (
                  <div className="au-comp-item" key={c.seq}>
                    <ListRow
                      data-comp={c.seq}
                      lead={open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                      label={`压缩历史 ${c.seq}`}
                      expanded={open}
                      sub={`${fmtTime(c.createdAt)} · ${c.messageCount} 条 · 压缩前 ${fmtK(c.tokensBefore)} tok`}
                      onClick={() => toggleSegment(c)}
                      {...(c.summary
                        ? {
                            peek: (
                              <PeekCard
                                title={`压缩历史 ${c.seq}`}
                                text={c.summary}
                              />
                            ),
                          }
                        : {})}
                    />
                    {open && (
                      <div className="au-comp-calls">
                        {!seg || seg.phase === "loading" ? (
                          <p className="au-none t-aux">载入中…</p>
                        ) : seg.phase === "error" ? (
                          <p className="au-none t-aux">
                            这一段的调用载入失败，
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => p.onSegment(c)}
                            >
                              重试
                            </Button>
                          </p>
                        ) : seg.calls.length === 0 ? (
                          <p className="au-none t-aux">
                            这一段没有留下调用记录
                          </p>
                        ) : (
                          seg.calls.map((call) => (
                            <CallRow
                              key={call.id}
                              c={call}
                              attr="data-seg-call"
                              selected={call.id === p.selectedId}
                              onSelect={p.onSelect}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
