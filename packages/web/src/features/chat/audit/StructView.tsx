// 结构视图：系统提示词 / 工具定义 / 历史 / 本轮新增 / 响应 五段，各是一张可折叠的卡片。
// 目的是看清「这次请求是怎么拼出来的」：历史按轮次、逐条一行摘要，点开看全文；本轮新增与响应直接展开。
// 块的拆解见 payload.ts；这里只管展示。展示用的标记（角色、cache）不会回写进任何数据。

import { Fragment, type ReactNode, useMemo, useState } from "react";
import type { CallRecord } from "../../../api/calls";
import { Button, InlineNotice, ListRow } from "../../../ui";
import { ChevronDownIcon, ChevronRightIcon } from "../../../ui/icons";
import type { TabAfx } from "../../workspace/model/types";
import { fmtK } from "./model";
import {
  type Block,
  messageCount,
  rangeBlockIndex,
  structOfRequest,
  structOfResponse,
} from "./payload";

export type FoldKey =
  | "system"
  | "tools"
  | "history"
  | "scope"
  | "later"
  | "messages"
  | "response";

const KEYS: readonly FoldKey[] = [
  "system",
  "tools",
  "history",
  "scope",
  "later",
  "messages",
  "response",
];

// 默认折叠大而稳定的部分（系统、工具、历史）；本轮新增与响应是看这次调用要看的，默认展开。
// fold[key] 为 true 表示折叠；没有范围时的「消息」整段默认展开（没有谁是新增的可分）。
const DEFAULT_FOLDED: Record<FoldKey, boolean> = {
  system: true,
  tools: true,
  history: true,
  scope: false,
  later: true,
  messages: false,
  response: false,
};

export const isFolded = (fold: TabAfx["fold"], key: FoldKey): boolean =>
  fold?.[key] ?? DEFAULT_FOLDED[key];

const SWATCH = {
  system: "system",
  tools: "tools",
  history: "history",
  current: "current",
  none: "none",
} as const;
type Swatch = keyof typeof SWATCH;

const firstLine = (t: string) => t.split("\n").join(" ").slice(0, 80);

function BlockView({ b }: { b: Block }) {
  return (
    <div className="au-blk">
      <div className="au-blk-h t-mono">
        <span className="au-role">{b.role}</span>
        <span className="au-kind">{b.kind}</span>
        {b.cache && <span className="au-cache">{b.cache}</span>}
      </div>
      <pre className="au-blk-b t-code">{b.body}</pre>
    </div>
  );
}

// 一段：标题行（色块 + 名称 + 数量 + token）点开看内容
function Section(props: {
  swatch: Swatch;
  title: string;
  note?: string;
  tok?: number | undefined;
  folded: boolean;
  onToggle(): void;
  scope?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className="au-sec"
      data-folded={props.folded || undefined}
      data-scope={props.scope || undefined}
    >
      <ListRow
        size="compact"
        lead={props.folded ? <ChevronRightIcon /> : <ChevronDownIcon />}
        expanded={!props.folded}
        label={
          <span className="au-sec-line">
            <svg className="au-sw" viewBox="0 0 8 8" aria-hidden="true">
              <rect
                className={`au-seg-${SWATCH[props.swatch]}`}
                x="0.5"
                y="0.5"
                width="7"
                height="7"
                rx="2"
              />
            </svg>
            <span className="au-sec-t">{props.title}</span>
            {props.note && <span className="au-sec-n t-aux">{props.note}</span>}
          </span>
        }
        trail={
          props.tok === undefined ? undefined : (
            <span className="t-mono">{fmtK(props.tok)} tok</span>
          )
        }
        onClick={props.onToggle}
      />
      {!props.folded && <div className="au-sec-b">{props.children}</div>}
    </section>
  );
}

// 历史里的一条：一行摘要，点开看全文
function Row({
  b,
  open,
  onToggle,
}: {
  b: Block;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <div className="au-msg">
      <ListRow
        size="compact"
        lead={open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        expanded={open}
        label={
          <span className="au-msg-line">
            <span className="au-msg-k t-mono">
              {b.role} · {b.kind}
            </span>
            <span className="au-msg-t t-plain">{firstLine(b.body)}</span>
          </span>
        }
        onClick={onToggle}
      />
      {open && <pre className="au-msg-b t-code">{b.body}</pre>}
    </div>
  );
}

interface Round {
  title: string | null;
  items: { b: Block; id: string }[];
}

// 按用户消息切轮次：每条 user 文本块开一轮（序号是这一段里的第几轮，不是会话的轮次号）。
// 一条用户消息都没有（认不出形状 / 只有响应侧）就是一整组，不画轮次头。
function roundsOf(blocks: readonly Block[], prefix: string): Round[] {
  const out: Round[] = [];
  let n = 0;
  blocks.forEach((b, i) => {
    const start = b.role === "user" && b.kind === "text";
    if (start) n += 1;
    let cur = out.at(-1);
    if (!cur || start) {
      cur = { title: start ? `第 ${n} 轮` : null, items: [] };
      out.push(cur);
    }
    cur.items.push({ b, id: `${prefix}${i}` });
  });
  return out;
}

export function StructView(props: {
  record: CallRecord;
  fold: TabAfx["fold"];
  onFold(fold: Record<string, boolean>): void;
}) {
  const { record: r, fold } = props;
  const req = useMemo(() => structOfRequest(r.request), [r.request]);
  // 消息项区间 → 消息块区间；请求认不出时没有可标的范围
  const range = useMemo(
    () => rangeBlockIndex(r.request, r.range),
    [r.request, r.range],
  );
  const res = useMemo(() => structOfResponse(r.response), [r.response]);
  const n = messageCount(r.request);
  // 请求认不出 / 没有消息时没有可标的范围
  const marked = range !== null && req.messages.length > 0 ? range : null;
  const t = r.tokens;

  const history = marked ? req.messages.slice(0, marked.from) : [];
  const scope = marked ? req.messages.slice(marked.from, marked.to) : [];
  const later = marked ? req.messages.slice(marked.to) : [];
  const historyRounds = roundsOf(history, "h");
  const laterRounds = roundsOf(later, "l");
  const allRounds = roundsOf(req.messages, "m");

  // 哪些历史行点开了全文：只在这一次调用的详情里有效（外层按调用 id 重建）
  const [rows, setRows] = useState<ReadonlySet<string>>(() => new Set());
  const flipRow = (id: string) =>
    setRows((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const toggle = (key: FoldKey) =>
    props.onFold({ ...fold, [key]: !isFolded(fold, key) });
  const expandAll = () => {
    props.onFold(Object.fromEntries(KEYS.map((k) => [k, false])));
    const ids = [historyRounds, laterRounds, allRounds].flatMap((rs) =>
      rs.flatMap((rd) => rd.items.map((x) => x.id)),
    );
    setRows(new Set(ids));
  };
  const collapseAll = () => {
    props.onFold({});
    setRows(new Set());
  };

  const rounds = (list: Round[]) =>
    list.map((rd, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: 轮次来自只读 payload，顺序固定
      <Fragment key={i}>
        {rd.title && <div className="au-hround t-group">{rd.title}</div>}
        {rd.items.map(({ b, id }) => (
          <Row
            key={id}
            b={b}
            open={rows.has(id)}
            onToggle={() => flipRow(id)}
          />
        ))}
      </Fragment>
    ));
  const roundsNote = (list: Round[], blocks: number) =>
    `${list.filter((x) => x.title).length} 轮 · ${blocks} 块`;

  return (
    <>
      {!req.recognized && (
        <p className="au-hint t-aux">
          请求的形状无法识别，结构视图没有可展示的内容；完整请求见 JSON 视图。
        </p>
      )}

      <div className="au-sbar">
        <span className="au-sbar-t t-group">这次请求的完整内容</span>
        <Button variant="ghost" size="sm" onClick={expandAll}>
          全部展开
        </Button>
        <Button variant="ghost" size="sm" onClick={collapseAll}>
          全部收起
        </Button>
      </div>

      <Section
        swatch="system"
        title="系统提示词"
        note={`${req.system.length} 块`}
        tok={t.system}
        folded={isFolded(fold, "system")}
        onToggle={() => toggle("system")}
      >
        {req.system.length === 0 ? (
          <p className="au-none t-aux">请求里没有系统提示词</p>
        ) : (
          req.system.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 块来自只读 payload，顺序固定
            <BlockView key={i} b={b} />
          ))
        )}
      </Section>

      <Section
        swatch="tools"
        title="工具定义"
        note={`${req.tools.length} 个`}
        tok={t.tools}
        folded={isFolded(fold, "tools")}
        onToggle={() => toggle("tools")}
      >
        {req.tools.length === 0 ? (
          <p className="au-none t-aux">请求里没有工具定义</p>
        ) : (
          req.tools.map((tool, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 同名工具可能重复，payload 只读
            <div key={i} className="au-toolrow">
              <span className="au-toolname t-code">{tool.name}</span>
              <span className="au-tooldesc t-aux">{tool.description}</span>
            </div>
          ))
        )}
      </Section>

      {marked ? (
        <>
          <Section
            swatch="history"
            title="历史"
            note={
              history.length > 0
                ? roundsNote(historyRounds, history.length)
                : "没有（这是第一次请求）"
            }
            tok={t.history}
            folded={isFolded(fold, "history") || history.length === 0}
            onToggle={() => history.length > 0 && toggle("history")}
          >
            {rounds(historyRounds)}
          </Section>
          <Section
            swatch="current"
            title="本轮新增"
            note={scope.length > 0 ? `${scope.length} 块` : undefined}
            tok={t.current}
            scope
            folded={isFolded(fold, "scope")}
            onToggle={() => toggle("scope")}
          >
            {scope.length === 0 ? (
              <p className="au-none au-range-empty t-aux">
                该事件没有新增请求消息，新增内容都在响应里。
              </p>
            ) : (
              scope.map((b, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 块来自只读 payload，顺序固定
                <BlockView key={i} b={b} />
              ))
            )}
          </Section>
          {later.length > 0 && (
            <Section
              swatch="none"
              title="之后的消息"
              note={`${later.length} 块 · 不属于这次请求`}
              folded={isFolded(fold, "later")}
              onToggle={() => toggle("later")}
            >
              {rounds(laterRounds)}
            </Section>
          )}
        </>
      ) : (
        <Section
          swatch="history"
          title="消息"
          note={`${n} 条`}
          tok={t.history + t.current}
          folded={isFolded(fold, "messages")}
          onToggle={() => toggle("messages")}
        >
          {req.messages.length === 0 ? (
            <p className="au-none t-aux">请求里没有消息</p>
          ) : (
            rounds(allRounds)
          )}
        </Section>
      )}

      <Section
        swatch="none"
        title="响应"
        note={res.stopReason ?? r.stopReason}
        tok={t.out}
        folded={isFolded(fold, "response")}
        onToggle={() => toggle("response")}
      >
        {res.error && (
          <InlineNotice tone="danger" className="au-err">
            {res.error}
          </InlineNotice>
        )}
        {res.blocks.length === 0 ? (
          <p className="au-none t-aux">响应没有内容</p>
        ) : (
          res.blocks.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 块来自只读 payload，顺序固定
            <BlockView key={i} b={b} />
          ))
        )}
      </Section>

      {req.other.length > 0 && (
        <p className="au-hint t-aux">
          其余请求字段（{req.other.join("、")}）未在结构视图展示，见 JSON 视图。
        </p>
      )}
    </>
  );
}
