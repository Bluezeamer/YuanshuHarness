// 审计面板（对话标签的第二视图）：左栏是模型调用序列，右栏是所选调用的完整请求与响应。
// 只读分析面，没有输入框。筛选 / 搜索 / 视图 / 宽度 / 折叠全部经 afx 读写，不另存全局状态。

import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Empty, SplitHandle } from "../../../ui";
import type { TabAfx } from "../../workspace/model/types";
import { Detail } from "./Detail";
import {
  clampSplit,
  countByFilter,
  filterOf,
  NARROW_BELOW,
  SPLIT,
  selectCalls,
  splitMax,
  summarize,
} from "./model";
import { Rail } from "./Rail";
import {
  useCallDetail,
  useCallList,
  useCompactionList,
  useCompactionSegments,
  useSubCallList,
} from "./useAuditData";

export interface AuditPaneProps {
  /** 要审计的会话 */
  sessionId: string;
  /** 所在标签的 afx；用到 filter / mode / q / w / fold */
  afx?: TabAfx | undefined;
  /** 浅合并写回 afx（与 TabRenderProps.patchAfx 同形） */
  patchAfx(patch: Partial<TabAfx>): void;
}

// 容器宽度（面板自己的宽度，不是视口）。首帧同步量一次，避免窄容器先按宽布局闪一下。
function useBoxWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const last = entries.at(-1);
      if (last) setW(last.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

const LOAD_FAIL: Record<string, string> = {
  not_found: "会话不存在，或已被删除。",
  network: "网络不通。",
  unauthorized: "令牌无效，请重新登录。",
  forbidden: "没有权限查看这个会话的调用记录。",
};

export function AuditPane({ sessionId, afx, patchAfx }: AuditPaneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const boxW = useBoxWidth(rootRef);
  const narrow = boxW > 0 && boxW < NARROW_BELOW;

  const own = useCallList(sessionId);
  // 子代理的调用记在子会话名下，单独一路；只有「子代理」档读它，其余档位的数字与列表不受影响
  const subs = useSubCallList(sessionId);
  // 上下文压缩历史：左栏底部的折叠区；展开某段时才去补这一段的调用
  const comp = useCompactionList(sessionId);
  const segs = useCompactionSegments(sessionId, own.calls);
  const filter = filterOf(afx?.filter);
  // 当前档位读哪一路：翻页、载入更多都跟着它走
  const lane = filter === "sub" ? subs : own;
  const q = afx?.q ?? "";
  const mode = afx?.mode === "json" ? "json" : "struct";
  const w = clampSplit(afx?.w ?? SPLIT.def, boxW);

  // 手动选中的调用；按会话记，换会话就作废
  const [picked, setPicked] = useState<{ sid: string; id: string } | null>(
    null,
  );
  const selId = picked?.sid === sessionId ? picked.id : null;
  const shown = useMemo(
    () => selectCalls(lane.calls, filter, q),
    [lane.calls, filter, q],
  );
  const counts = useMemo(
    () => ({ ...countByFilter(own.calls), sub: subs.total }),
    [own.calls, subs.total],
  );
  const scoped = filter !== "all" || q.trim() !== "";
  const totals = useMemo(
    () => summarize(scoped ? shown : lane.calls),
    [scoped, shown, lane.calls],
  );
  const estimated = useMemo(
    () => (scoped ? shown : lane.calls).some((c) => c.tokens.estimated),
    [scoped, shown, lane.calls],
  );
  // 所选调用在任意已载入的调用里找：压缩历史里的调用可能不在当前筛选后的列表里
  const pickedCall =
    selId === null
      ? null
      : (own.calls.find((c) => c.id === selId) ??
        subs.calls.find((c) => c.id === selId) ??
        segs.all().find((c) => c.id === selId) ??
        null);
  // 所选调用被筛掉（或还没选）时落到当前列表的第一条；从压缩历史里点选的那条允许绕过滤镜
  const sel =
    shown.find((c) => c.id === selId) ??
    (pickedCall !== null && pickedCall.segment > 0 ? pickedCall : null) ??
    shown[0] ??
    null;
  // 还没选过就把当前这条钉住，之后刷新进来的新调用不会把正在看的详情顶走
  useEffect(() => {
    if (selId === null && sel) setPicked({ sid: sessionId, id: sel.id });
  }, [selId, sel, sessionId]);
  const detail = useCallDetail(
    sessionId,
    sel?.id ?? null,
    sel?.subagent?.sessionId,
  );

  // 拖动中只改 --au-w，不让整个面板跟着重绘；松手才写进 afx。键盘 / 双击没有「松手」，直接写。
  const dragging = useRef(false);
  const onSplit = (v: number) => {
    if (dragging.current)
      rootRef.current?.style.setProperty("--au-w", `${v}px`);
    else patchAfx({ w: v });
  };

  // 子代理那一路还没载好 / 载入失败时，列表区如实说，而不是回「没有符合条件的调用」
  const laneNote: ReactNode =
    filter !== "sub" || subs.phase === "ready" ? undefined : subs.phase ===
      "loading" ? (
      "载入中…"
    ) : (
      <>
        {LOAD_FAIL[subs.error ?? ""] ?? "服务端出错。"}
        <Button size="sm" onClick={subs.reload}>
          重试
        </Button>
      </>
    );

  let body: ReactNode;
  if (own.phase === "loading") {
    body = <p className="au-state">载入中…</p>;
  } else if (own.phase === "error") {
    body = (
      <Empty
        tone="danger"
        className="au-full"
        title="无法载入调用记录"
        description={LOAD_FAIL[own.error ?? ""] ?? "服务端出错，请稍后重试。"}
        action={
          <Button size="sm" onClick={own.reload}>
            重试
          </Button>
        }
      />
    );
  } else if (own.calls.length === 0) {
    body = <Empty className="au-full" title="此会话没有模型调用记录" />;
  } else {
    body = (
      <>
        <Rail
          key={sessionId}
          shown={shown}
          counts={counts}
          totals={totals}
          scoped={scoped}
          estimated={estimated}
          filter={filter}
          q={q}
          selectedId={sel?.id ?? null}
          hasMore={lane.nextBefore !== null}
          busy={lane.busy}
          moreFailed={lane.moreFailed}
          emptyNote={laneNote}
          compactions={comp.compactions}
          segment={segs.get}
          onSegment={segs.ensure}
          onFilter={(f) => patchAfx({ filter: f })}
          onQuery={(v) => patchAfx({ q: v })}
          onSelect={(id) => setPicked({ sid: sessionId, id })}
          onMore={lane.loadMore}
          onRefresh={() => {
            own.refresh();
            subs.refresh();
            comp.refresh();
          }}
        />
        {!narrow && (
          <SplitHandle
            className="au-split"
            aria-label="调整调用序列宽度"
            value={w}
            min={SPLIT.min}
            max={splitMax(boxW)}
            defaultValue={SPLIT.def}
            onChange={onSplit}
            onDragStart={() => {
              dragging.current = true;
            }}
            onDragEnd={(v) => {
              dragging.current = false;
              if (v !== w) patchAfx({ w: v });
            }}
          />
        )}
        {sel ? (
          <Detail
            call={sel}
            detail={detail}
            mode={mode}
            fold={afx?.fold}
            onMode={(m) => patchAfx({ mode: m })}
            onFold={(fold) => patchAfx({ fold })}
          />
        ) : (
          <div className="au-detail">
            <p className="au-state">这条筛选下没有可展开的调用。</p>
          </div>
        )}
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      className="au"
      data-audit
      data-narrow={narrow || undefined}
      style={{ "--au-w": `${w}px` } as CSSProperties}
    >
      {body}
    </div>
  );
}
