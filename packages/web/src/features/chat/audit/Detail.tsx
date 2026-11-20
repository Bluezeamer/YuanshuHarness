// 审计右栏：所选调用的详情头（序号 / 类型 / 视图切换 / 复制）、一行事实、组成条与正文。
// 头部与组成条只用列表里已有的摘要，请求 / 响应原文按需拉取后才渲染正文。

import { useLayoutEffect, useMemo, useRef } from "react";
import type { CallSummary } from "../../../api/calls";
import {
  Button,
  Chip,
  HoverCard,
  IconButton,
  PeekCard,
  Segmented,
  toast,
} from "../../../ui";
import { CopyIcon } from "../../../ui/icons";
import type { TabAfx } from "../../workspace/model/types";
import { copyText } from "./copy";
import {
  composition,
  fmtInt,
  fmtK,
  fmtSec,
  fmtTime,
  inputOf,
  pad2,
  TRIGGER_LABEL,
} from "./model";
import { exportJson, jsonRangeSpans } from "./payload";
import { StructView } from "./StructView";
import type { CallDetail } from "./useAuditData";

const VIEWS = [
  { value: "struct", label: "结构" },
  { value: "json", label: "JSON" },
] as const;

const ESTIMATE_TIP =
  "供应商没有上报用量时按约 3 字符 / token 估算，只用来比较调用之间的大小，不当作账单";
const SPLIT_TIP =
  "四段按请求体字符数占比分摊整次请求的输入量，用于比较大小，不是供应商的分项计数";

const FAIL_TEXT: Record<string, string> = {
  not_found: "这条记录已不存在。",
  network: "网络不通，无法载入这条调用。",
};

// 四段之间留的缝（viewBox 单位，总宽 1000），相邻两段才分得开
const GAP = 3;

function Composition({ call }: { call: CallSummary }) {
  const segs = composition(call.tokens).filter((s) => s.tokens > 0);
  const room = 1000 - GAP * Math.max(0, segs.length - 1);
  let x = 0;
  const label = composition(call.tokens)
    .map((s) => `${s.label} ${fmtInt(s.tokens)}`)
    .join(" · ");
  return (
    <HoverCard
      width={216}
      card={
        <PeekCard
          title="这次请求的组成"
          text={SPLIT_TIP}
          facts={composition(call.tokens).map(
            (s) => [s.label, `${fmtInt(s.tokens)} tok`] as const,
          )}
        />
      }
    >
      <div className="au-comp-bar">
        <svg
          viewBox="0 0 1000 6"
          preserveAspectRatio="none"
          role="img"
          aria-label={`请求的组成：${label}`}
        >
          {segs.map((s) => {
            const w = Math.max((s.pct / 100) * room, 6);
            const rect = (
              <rect
                key={s.id}
                className={`au-seg-${s.id}`}
                data-pct={s.pct}
                x={x}
                width={w}
                height="6"
              />
            );
            x += w + GAP;
            return rect;
          })}
        </svg>
      </div>
    </HoverCard>
  );
}

function Facts({ call }: { call: CallSummary }) {
  const t = call.tokens;
  const cache =
    t.cacheRead > 0 || t.cacheWrite > 0
      ? [
          t.cacheRead > 0 ? `读 ${fmtK(t.cacheRead)}` : null,
          t.cacheWrite > 0 ? `写 ${fmtK(t.cacheWrite)}` : null,
        ]
          .filter(Boolean)
          .join(" ")
      : "无";
  return (
    <div className="au-facts t-aux">
      <span className="au-dtime t-mono">{fmtTime(call.createdAt)}</span>
      {" · "}
      <span className="t-mono">{call.model}</span>
      {" · 入 "}
      <span className="t-mono">{fmtInt(inputOf(t))}</span>
      {" · 出 "}
      <span className="t-mono">{fmtInt(t.out)}</span>
      {" · 延迟 "}
      <span className="t-mono">{fmtSec(call.durationMs, 2)}</span>
      {" · stop_reason "}
      <span className="t-mono">{call.stopReason}</span>
      {" · 缓存 "}
      <span className="t-mono">{cache}</span>
      {t.estimated && (
        <Chip className="au-est" title={ESTIMATE_TIP}>
          估算
        </Chip>
      )}
    </div>
  );
}

export interface DetailProps {
  call: CallSummary;
  detail: CallDetail;
  mode: "struct" | "json";
  fold: TabAfx["fold"];
  onMode(mode: "struct" | "json"): void;
  onFold(fold: Record<string, boolean>): void;
}

export function Detail({
  call,
  detail,
  mode,
  fold,
  onMode,
  onFold,
}: DetailProps) {
  const rec = detail.record;
  const json = useMemo(() => (rec ? exportJson(rec) : ""), [rec]);
  // JSON 视图里本事件范围的字符区间：切成前 / 范围内 / 后三段，算不出时整段展示。
  const spans = useMemo(
    () => (rec ? jsonRangeSpans(rec.request, json, rec.range) : null),
    [rec, json],
  );
  const body = useRef<HTMLDivElement>(null);

  // 选中调用 / 切换视图后，JSON 视图把正文滚到范围起点（结构视图里「本轮新增」是现成的一张卡，不用滚）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: mode / rec 变化会换掉正文，必须重新滚到范围起点
  useLayoutEffect(() => {
    const box = body.current;
    if (!box) return;
    const mark = box.querySelector<HTMLElement>(".au-range, .au-range-note");
    if (!mark) return;
    box.scrollTop = Math.max(
      0,
      mark.getBoundingClientRect().top -
        box.getBoundingClientRect().top +
        box.scrollTop -
        8,
    );
  }, [call.id, mode, rec]);

  const copy = async () => {
    if (!rec) return;
    const ok = await copyText(json);
    toast(
      ok
        ? `已复制调用 ${pad2(call.seq)} · 入 ${fmtK(inputOf(call.tokens))}`
        : "复制失败，请改用 JSON 视图手动选取",
      { tone: ok ? "ok" : "danger" },
    );
  };

  return (
    <div className="au-detail">
      <div className="au-dhead">
        <div className="au-dtop">
          <span className="au-dn t-block">调用 {pad2(call.seq)}</span>
          <Chip>
            {TRIGGER_LABEL[call.trigger]}
            {call.toolName ? ` · ${call.toolName}` : ""}
          </Chip>
          {call.subagent && (
            <Chip title={`子会话 ${call.subagent.sessionId}`}>
              来自子会话 · {call.subagent.name}
            </Chip>
          )}
          {call.segment > 0 && (
            <Chip title="请求取自这次压缩前的完整快照，范围是其中属于本事件的消息">
              压缩前快照 · 第 {call.segment} 段
            </Chip>
          )}
          <span className="au-dacts">
            <Segmented
              size="sm"
              aria-label="详情视图"
              options={VIEWS}
              value={mode}
              onChange={onMode}
            />
            <IconButton
              label="复制请求与响应"
              icon={<CopyIcon />}
              disabled={!rec}
              onClick={() => void copy()}
            />
          </span>
        </div>
        <Facts call={call} />
        <Composition call={call} />
      </div>

      <div className="au-dbody" ref={body}>
        {detail.phase === "loading" && (
          <p className="au-state t-aux">载入中…</p>
        )}
        {detail.phase === "error" && (
          <div className="au-state t-aux">
            <p>{FAIL_TEXT[detail.error ?? ""] ?? "无法载入这条调用。"}</p>
            {detail.error !== "not_found" && (
              <Button size="sm" onClick={detail.retry}>
                重试
              </Button>
            )}
          </div>
        )}
        {rec &&
          (mode === "json" ? (
            // 与 API 同形的 {request, response}；复制的也是这一份。
            // 按 range 切成前 / 范围内 / 后三段，范围内那段加蓝底。
            <div className="au-json-wrap" data-ajson>
              {spans === null ? (
                <pre className="au-json t-code">{json}</pre>
              ) : spans.end === spans.start ? (
                <>
                  {spans.start > 0 && (
                    <pre className="au-json t-code">
                      {json.slice(0, spans.start)}
                    </pre>
                  )}
                  <p className="au-range-note t-aux">
                    该事件没有新增请求消息，新增内容都在响应里。
                  </p>
                  {spans.start < json.length && (
                    <pre className="au-json t-code">
                      {json.slice(spans.start)}
                    </pre>
                  )}
                </>
              ) : (
                <>
                  {spans.start > 0 && (
                    <pre className="au-json t-code">
                      {json.slice(0, spans.start)}
                    </pre>
                  )}
                  <pre className="au-json is-range au-range t-code">
                    {json.slice(spans.start, spans.end)}
                  </pre>
                  {spans.end < json.length && (
                    <pre className="au-json t-code">
                      {json.slice(spans.end)}
                    </pre>
                  )}
                </>
              )}
            </div>
          ) : (
            <StructView
              key={call.id}
              record={rec}
              fold={fold}
              onFold={onFold}
            />
          ))}
      </div>
    </div>
  );
}
